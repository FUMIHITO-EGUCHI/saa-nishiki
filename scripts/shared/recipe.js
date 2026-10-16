// The recipe of one generated image: the editor state it was queued with (the prompt,
// generation, LoRA and ADetailer sections as settingsPersistence collects them, plus the
// model keys that live in the app section) and what the run itself decided (the seed,
// the character a "Random" slot picked, the Prose paragraph, what Fast mode sent).
//
// It is written into the PNG as the "saa_recipe" text chunk (the main process hands it
// to ComfyUI as extra_data.extra_pnginfo, which the saver node writes out), read back by
// the viewer and the Library, and is what "Use settings…" loads from. An image without
// one still has its A1111 "parameters" text: parseParameters reads that much.
//
// Pure: no DOM, no Electron.

export const RECIPE_CHUNK = 'saa_recipe';
export const TIME_CHUNK = 'saa_time';
export const RECIPE_VERSION = 1;

export const RECIPE_SECTIONS = Object.freeze(['prompt', 'generation', 'lora', 'adetailer']);

// the model a picture was made with is partly kept in the app section (not a preset)
export const RECIPE_APP_KEYS = Object.freeze([
    'api_model_type', 'api_model_file_vpred',
    'api_vae_sdxl_model', 'api_vae_sdxl_override', 'api_vae_unet_model',
    'api_model_file_diffusion_weight_dtype', 'api_model_file_text_encoder',
    'api_model_file_text_encoder_type', 'api_model_file_text_encoder_device',
    'api_fast_enable',
]);

// per-field presets and the collapsed rows are the editor's furniture, not the picture's
const SKIPPED_KEYS = new Set(['prompt_field_presets', 'prompt_field_collapsed']);

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function copy(value) {
    return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function finite(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
}

function cleanRun(run = {}) {
    const text = value => (typeof value === 'string' ? value : '');
    const prose = isObject(run.prose) ? {
        applied: run.prose.applied === true,
        paragraph: text(run.prose.paragraph),
        writer: text(run.prose.writer),
        fields: isObject(run.prose.fields) ? copy(run.prose.fields) : null,
    } : null;
    const ai = isObject(run.ai) ? { mode: text(run.ai.mode), text: text(run.ai.text) } : null;
    const sent = isObject(run.sent) ? {
        steps: finite(run.sent.steps),
        cfg: finite(run.sent.cfg),
        sampler: text(run.sent.sampler),
        scheduler: text(run.sent.scheduler),
        fast: isObject(run.sent.fast) ? { lora: text(run.sent.fast.lora), strength: finite(run.sent.fast.strength) } : null,
    } : null;
    return {
        seed: finite(run.seed),
        width: finite(run.width),
        height: finite(run.height),
        interface: text(run.interface),
regional: run.regional === true,
        characters: Array.isArray(run.characters) ? run.characters.map(key => String(key ?? 'None')) : [],
        names: text(run.names),
        positive: text(run.positive),
        negative: text(run.negative),
        prose,
        ai,
        sent,
    };
}

/**
 * A recipe from the collected sections (`collectSection` of each RECIPE_SECTIONS entry),
 * the settings (for the app keys) and the run's own facts.
 */
export function buildRecipe({ sections = {}, settings = {}, run = {}, saaVersion = '', now = Date.now() } = {}) {
    const kept = {};
    for (const section of RECIPE_SECTIONS) {
        const data = isObject(sections[section]) ? sections[section] : {};
        kept[section] = Object.fromEntries(Object.entries(data)
            .filter(([key, value]) => !SKIPPED_KEYS.has(key) && value !== undefined)
            .map(([key, value]) => [key, copy(value)]));
    }
    const app = {};
    for (const key of RECIPE_APP_KEYS) if (settings[key] !== undefined) app[key] = copy(settings[key]);
    return {
        v: RECIPE_VERSION,
        saa: String(saaVersion ?? ''),
        created: new Date(now).toISOString(),
        sections: kept,
        app,
        run: cleanRun(run),
    };
}

/** The recipe a text chunk (or an already parsed value) holds, or null. */
export function parseRecipe(value) {
    let data = value;
    if (typeof value === 'string') {
        try { data = JSON.parse(value); } catch { return null; }
    }
    if (!isObject(data) || !Number.isInteger(data.v) || data.v < 1 || !isObject(data.sections)) return null;
    return {
        ...data,
        sections: Object.fromEntries(RECIPE_SECTIONS.map(section => [section, isObject(data.sections[section]) ? data.sections[section] : {}])),
        app: isObject(data.app) ? data.app : {},
        run: cleanRun(isObject(data.run) ? data.run : {}),
    };
}

const STAGES = new Set(['ALL', 'Base', 'HiFix', 'OFF']);

/** The LoRA rows of a recipe: [{ name, model, clip, stage }]. */
export function recipeLoras(recipe) {
    const rows = recipe?.sections?.lora?.lora_slot;
    if (!Array.isArray(rows)) return [];
    return rows
        .filter(row => Array.isArray(row) && String(row[0] ?? '').trim() !== '' && String(row[0]).toLowerCase() !== 'none')
        .map(([name, model, clip, stage]) => ({
            name: String(name),
            model: finite(model) ?? 1,
            clip: finite(clip) ?? 1,
            stage: STAGES.has(stage) ? stage : 'ALL',
        }));
}

/** The model side of a recipe, as the viewer shows it. */
export function recipeModel(recipe) {
    const generation = recipe?.sections?.generation ?? {};
    const type = recipe?.app?.api_model_type === 'Diffusion' ? 'Diffusion' : 'Checkpoint';
    return {
        type,
        model: String((type === 'Diffusion' ? generation.api_model_file_diffusion_select : generation.api_model_file_select) ?? ''),
        sampler: String(generation.api_model_sampler ?? ''),
        scheduler: String(generation.api_model_scheduler ?? ''),
        steps: finite(generation.step),
        cfg: finite(generation.cfg),
        sent: recipe?.run?.sent ?? null,
        refiner: generation.api_refiner_enable === true ? { model: String(generation.api_refiner_model ?? ''), ratio: finite(generation.api_refiner_ratio) } : null,
    };
}

/** Size and the passes after the base one. */
export function recipeSize(recipe) {
    const generation = recipe?.sections?.generation ?? {};
    const adetailer = recipe?.sections?.adetailer ?? {};
    const landscape = generation.api_image_landscape === true;
    const width = recipe?.run?.width ?? finite(landscape ? generation.height : generation.width);
    const height = recipe?.run?.height ?? finite(landscape ? generation.width : generation.height);
    // ad_slot rows: [model, confidence, mask_k, mask filter ('Off' skips the row), …]
    const detailers = adetailer.api_adetailer_enable === true && Array.isArray(adetailer.ad_slot)
        ? adetailer.ad_slot
            .filter(row => Array.isArray(row) && row[3] !== 'Off')
            .map(row => String(row[0] ?? ''))
            .filter(name => name && name.toLowerCase() !== 'none')
        : [];
    return {
        width,
        height,
        hires: generation.api_hf_enable === true ? {
            scale: finite(generation.api_hf_scale),
            denoise: finite(generation.api_hf_denoise),
            upscaler: String(generation.api_hf_upscaler_selected ?? ''),
            steps: finite(generation.api_hf_steps),
        } : null,
        detailers,
    };
}

// ------------------------------------------------------------------ "parameters"

// the saver writes Civitai's sampler / schedule names; SAA's lists hold ComfyUI's
const SAMPLER_NAMES = Object.freeze({
    'euler a': 'euler_ancestral', euler: 'euler', lms: 'lms', heun: 'heun', dpm2: 'dpm_2', 'dpm2 a': 'dpm_2_ancestral',
    'dpm++ 2s a': 'dpmpp_2s_ancestral', 'dpm++ 2m': 'dpmpp_2m', 'dpm++ sde': 'dpmpp_sde', 'dpm++ 2m sde': 'dpmpp_2m_sde',
    'dpm++ 3m sde': 'dpmpp_3m_sde', 'dpm fast': 'dpm_fast', 'dpm adaptive': 'dpm_adaptive', ddim: 'ddim', plms: 'plms',
    unipc: 'uni_pc', lcm: 'lcm',
});

function comfySampler(name) {
    const plain = String(name ?? '').trim();
    const lower = plain.toLowerCase().replace(/ (karras|exponential)$/, '');
    return SAMPLER_NAMES[lower] ?? plain;
}

function comfyScheduler(name, sampler) {
    const plain = String(name ?? '').trim().toLowerCase();
    if (plain) return plain === 'ddim' ? 'ddim_uniform' : plain.replaceAll(' ', '_');
    const suffix = /\s(karras|exponential)$/i.exec(String(sampler ?? ''));
    return suffix ? suffix[1].toLowerCase() : '';
}

/**
 * A recipe-shaped stand-in for an image that only has its "parameters" text: the whole
 * positive prompt in the Positive field (characters included, so the character slots are
 * emptied), the negative in Negative, the sampler values, size and seed, and the
 * <lora:…> tags as LoRA rows. `partial: true` marks it. The model is named without its
 * folder or extension there: it is looked up in `checkpoints` / `diffusion` (the model
 * lists) and kept when one of them has it.
 */
export function recipeFromParameters(text, { checkpoints = [], diffusion = [] } = {}) {
    const parsed = parseParameters(text);
    if (!parsed) return null;
    const generation = {};
    const app = {};
    const label = name => String(name ?? '').split(/[\\/]/).pop().replace(/\.[^.]+$/, '').toLowerCase();
    const wanted = label(parsed.model);
    const checkpoint = wanted ? checkpoints.find(name => label(name) === wanted) : null;
    const unet = wanted && !checkpoint ? diffusion.find(name => label(name) === wanted) : null;
    if (checkpoint) {
        app.api_model_type = 'Checkpoint';
        generation.api_model_file_select = checkpoint;
    } else if (unet) {
        app.api_model_type = 'Diffusion';
        generation.api_model_file_diffusion_select = unet;
    }
    if (Number.isFinite(parsed.steps)) generation.step = parsed.steps;
    if (Number.isFinite(parsed.cfg)) generation.cfg = parsed.cfg;
    if (parsed.sampler) generation.api_model_sampler = comfySampler(parsed.sampler);
    const scheduler = comfyScheduler(parsed.scheduler, parsed.sampler);
    if (scheduler) generation.api_model_scheduler = scheduler;
    if (Number.isFinite(parsed.width) && Number.isFinite(parsed.height)) Object.assign(generation, { width: parsed.width, height: parsed.height, api_image_landscape: false });
    return {
        v: RECIPE_VERSION,
        partial: true,
        saa: '',
        created: '',
        sections: {
            prompt: { api_prompt: parsed.positive, api_neg_prompt: parsed.negative, character_slots: [{ key: 'None', weight: 1 }], artist_slots: [{ key: '', weight: 1 }] },
            generation,
            lora: { lora_slot: parsed.loras.map(row => [row.name, String(row.model), String(row.clip), 'ALL']) },
            adetailer: {},
        },
        app,
        run: cleanRun({ seed: parsed.seed, width: parsed.width, height: parsed.height, positive: parsed.positive, negative: parsed.negative }),
    };
}

const LORA_TAG = /<lora:([^:>]+)(?::([^:>]*))?(?::([^:>]*))?(?::[^>]*)?>/gi;

/**
 * The A1111-style "parameters" text every saver writes: positive, negative and the
 * "Key: value" line. `loras` are the <lora:…> tags of the positive, which is returned
 * without them.
 */
export function parseParameters(text) {
    const source = String(text ?? '').replace(/\r\n/g, '\n');
    if (!source.trim()) return null;
    const lines = source.split('\n');
    let settingsAt = -1;
    for (let index = lines.length - 1; index >= 0; index--) {
        if (/^\s*Steps:\s*\d+/.test(lines[index])) { settingsAt = index; break; }
    }
    const body = settingsAt >= 0 ? lines.slice(0, settingsAt) : lines;
    const negativeAt = body.findIndex(line => line.startsWith('Negative prompt:'));
    const positiveRaw = (negativeAt >= 0 ? body.slice(0, negativeAt) : body).join('\n');
    const negative = negativeAt >= 0 ? body.slice(negativeAt).join('\n').replace(/^Negative prompt:\s?/, '') : '';
    const values = {};
    if (settingsAt >= 0) {
        // values may hold commas inside quotes or braces (Hashes: {...}); split on ", Key: "
        const line = lines.slice(settingsAt).join(' ');
        for (const match of line.matchAll(/(?:^|,\s*)([A-Za-z][A-Za-z0-9 _-]*):\s*("(?:[^"\\]|\\.)*"|\{[^}]*\}|[^,]*)/g)) {
            values[match[1].trim()] = match[2].trim();
        }
    }
    const loras = [...positiveRaw.matchAll(LORA_TAG)].map(match => ({
        name: match[1].trim(),
        model: finite(match[2]) ?? 1,
        clip: finite(match[3] ?? match[2]) ?? 1,
    }));
    const size = /^(\d+)\s*x\s*(\d+)$/.exec(values.Size ?? '');
    return {
        positive: positiveRaw.replace(LORA_TAG, '').replace(/\n{2,}/g, '\n').trim(),
        negative: negative.trim(),
        steps: finite(values.Steps),
        sampler: values.Sampler ?? '',
        scheduler: values['Schedule type'] ?? values.Scheduler ?? '',
        cfg: finite(values['CFG scale']),
        seed: finite(values.Seed),
        width: size ? Number(size[1]) : null,
        height: size ? Number(size[2]) : null,
        model: values.Model ?? '',
        loras,
    };
}
