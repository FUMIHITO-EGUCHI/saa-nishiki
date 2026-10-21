// "Use settings…": what loading an image's recipe into the editor changes, row by row,
// and the merged settings that loading writes. Pure; useSettingsDialog.js draws the rows
// and does the writing.
//
// The prompt fields are matched the way the recipe keeps them: a built-in field by its
// fixed key, a custom field by its id and then by its name. A field the image had and the
// editor lacks is made again; one only the editor has is muted, never deleted. The
// character slots grow to the image's count, and a slot that said "Random" takes the
// character the image's run picked.

import { recipeLoras } from './recipe.js';

// built-in prompt fields: id (the chain's name for it) -> setting key, default label
export const BUILTIN_FIELDS = Object.freeze([
    ['common', 'custom_prompt', 'Common'],
    ['views', 'view_tags', 'View'],
    ['background', 'prompt_background', 'Background'],
    ['style', 'prompt_style', 'Style'],
    ['ai', 'ai_prompt', 'AI'],
    ['positive', 'api_prompt', 'Positive'],
    ['positive_right', 'api_prompt_right', 'Positive (right)'],
    ['negative', 'api_neg_prompt', 'Negative'],
    ['negative_left', 'api_neg_prompt_left', 'Negative (left)'],
    ['negative_right', 'api_neg_prompt_right', 'Negative (right)'],
    ['exclude', 'prompt_ban', 'Exclude'],
]);
const PLANNED_FIELDS = ['common', 'positive', 'positive_right', 'negative', 'exclude', 'views', 'background', 'style', 'negative_left', 'negative_right'];
// the prompt section's keys that are the prompt itself (not the AI card, not the editor's furniture)
const LEGACY_PROMPT_KEYS = ['character_left', 'character_right', 'view_angle', 'view_camera', 'view_background', 'view_style', 'weights4dropdownlist', 'artist_slots', 'artist_signature_guard'];

// the rows of the dialog and the keys each one loads
export const RECIPE_ROWS = Object.freeze({
    model: {
        generation: ['api_model_file_select', 'api_model_file_diffusion_select', 'api_model_sampler', 'api_model_scheduler', 'step', 'cfg',
            'api_refiner_enable', 'api_refiner_add_noise', 'api_refiner_model', 'api_refiner_model_vpred', 'api_refiner_ratio'],
        app: ['api_model_type', 'api_model_file_vpred', 'api_vae_sdxl_model', 'api_vae_sdxl_override', 'api_vae_unet_model',
            'api_model_file_diffusion_weight_dtype', 'api_model_file_text_encoder', 'api_model_file_text_encoder_type',
            'api_model_file_text_encoder_device', 'api_fast_enable'],
    },
    size: {
        generation: ['width', 'height', 'api_image_landscape', 'api_hf_enable', 'api_hf_scale', 'api_hf_denoise', 'api_hf_upscaler_selected',
            'api_hf_colortransfer', 'api_hf_random_seed', 'api_hf_steps'],
        adetailer: ['api_adetailer_enable', 'api_adetailer_prompt_mode', 'api_adetailer_seed', 'ad_slot'],
    },
    regional: {
        generation: ['regional_condition', 'regional_swap', 'regional_overlap_ratio', 'regional_image_ratio', 'regional_str_left',
            'regional_str_right', 'regional_option_left', 'regional_option_right', 'regional_split', 'regional_panels'],
    },
    lora: { lora: ['lora_slot'] },
    seed: { generation: ['random_seed'] },
});

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const text = value => String(value ?? '');
const nameKey = value => text(value).trim().toLowerCase();

function customFields(prompt) {
    return Array.isArray(prompt?.prompt_custom_fields) ? prompt.prompt_custom_fields.filter(field => isObject(field) && field.id) : [];
}

/** A slot list with each "Random" replaced by the character the run picked for it. */
export function resolveRandomSlots(slots, picked = []) {
    return (Array.isArray(slots) ? slots : []).map((slot, index) => {
        const key = text(slot?.key);
        const choice = picked[index];
        const random = key === 'Random' || key === 'oc:Random';
        return random && choice && choice !== 'None' ? { ...slot, key: choice } : { ...slot };
    });
}

function slotKeys(slots) {
    return (Array.isArray(slots) ? slots : []).map(slot => text(slot?.key)).filter(key => key && key !== 'None');
}

function status(image, now) {
    return same(image, now) ? 'same' : 'differs';
}

/**
 * The prompt fields side by side: [{ id, name, kind, image, now, status }]. `kind` is
 * 'text' (image / now are the field texts), 'characters' or 'artists' (lists of keys).
 * A field empty on both sides is left out. `status` is same | differs | new field | muted.
 */
export function compareRecipeFields(image = {}, now = {}, { picked = [], labels = {} } = {}) {
    const rows = [];
    const imageSlots = slotKeys(resolveRandomSlots(image.character_slots, picked));
    const nowSlots = slotKeys(now.character_slots);
    if (imageSlots.length || nowSlots.length) {
        rows.push({ id: 'characters', name: labels.characters ?? 'Characters', kind: 'characters', image: imageSlots, now: nowSlots, status: status(imageSlots, nowSlots) });
    }
    const imageArtists = slotKeys(image.artist_slots);
    const nowArtists = slotKeys(now.artist_slots);
    if (imageArtists.length || nowArtists.length) {
        rows.push({ id: 'artist', name: labels.artist ?? 'Artist', kind: 'artists', image: imageArtists, now: nowArtists, status: status(imageArtists, nowArtists) });
    }
    for (const [id, key, fallback] of BUILTIN_FIELDS) {
        const imageText = text(image[key]).trim();
        const nowText = text(now[key]).trim();
        if (!imageText && !nowText) continue;
        rows.push({ id, name: labels[id] ?? fallback, kind: 'text', image: imageText, now: nowText, status: status(imageText, nowText) });
    }
    const nowFields = customFields(now);
    const used = new Set();
    for (const field of customFields(image)) {
        const match = nowFields.find(candidate => candidate.id === field.id) ?? nowFields.find(candidate => !used.has(candidate.id) && nameKey(candidate.name) === nameKey(field.name));
        if (match) used.add(match.id);
        const imageText = text(field.text).trim();
        const nowText = match ? text(match.text).trim() : '';
        if (!imageText && !nowText) continue;
        rows.push({ id: field.id, name: text(field.name) || 'Custom', kind: 'text', image: imageText, now: match ? nowText : null, status: match ? status(imageText, nowText) : 'new field' });
    }
    for (const field of nowFields) {
        if (used.has(field.id) || !text(field.text).trim()) continue;
        rows.push({ id: field.id, name: text(field.name) || 'Custom', kind: 'text', image: null, now: text(field.text).trim(), status: field.muted ? 'same' : 'muted' });
    }
    return rows;
}

function mergedOrder(imageOrder, currentOrder, extraIds) {
    const order = Array.isArray(imageOrder) ? [...imageOrder] : (Array.isArray(currentOrder) ? [...currentOrder] : []);
    for (const id of extraIds) if (!order.includes(id)) order.push(id);
    return order;
}

/**
 * The prompt section after loading the image's fields into `current` (both are collected
 * prompt sections). Everything that is not the prompt itself (the AI card, the field
 * presets, the collapsed rows) stays as `current` has it.
 */
export function mergeRecipePrompt(current = {}, image = {}, { picked = [] } = {}) {
    const next = { ...current };
    for (const [, key] of BUILTIN_FIELDS) next[key] = text(image[key]);
    for (const id of PLANNED_FIELDS) {
        for (const key of [`${id}_weight_plans`, `${id}_batch`]) if (Object.hasOwn(image, key)) next[key] = image[key];
    }
    for (const key of LEGACY_PROMPT_KEYS) if (Object.hasOwn(image, key)) next[key] = image[key];
    if (Object.hasOwn(image, 'prompt_field_muted')) next.prompt_field_muted = image.prompt_field_muted;

    // the image's slots, its Random ones resolved; the editor's extra slots stay, emptied
    const slots = resolveRandomSlots(image.character_slots, picked);
    const currentSlots = Array.isArray(current.character_slots) ? current.character_slots : [];
    for (let index = slots.length; index < currentSlots.length; index++) slots.push({ ...currentSlots[index], key: 'None' });
    if (slots.length > 0) next.character_slots = slots;

    // custom fields: the image's, then the editor's own ones muted
    const imageFields = customFields(image);
    const currentFields = customFields(current);
    const replaced = new Set();
    for (const field of imageFields) {
        const match = currentFields.find(candidate => candidate.id === field.id) ?? currentFields.find(candidate => !replaced.has(candidate.id) && nameKey(candidate.name) === nameKey(field.name));
        if (match) replaced.add(match.id);
    }
    const kept = currentFields.filter(field => !replaced.has(field.id) && !imageFields.some(own => own.id === field.id))
        .map(field => ({ ...field, muted: true }));
    next.prompt_custom_fields = [...imageFields.map(field => ({ ...field })), ...kept];
    next.prompt_positive_order = mergedOrder(image.prompt_positive_order, current.prompt_positive_order, kept.filter(field => field.polarity !== 'negative').map(field => field.id));
    next.prompt_negative_order = mergedOrder(image.prompt_negative_order, current.prompt_negative_order, kept.filter(field => field.polarity === 'negative').map(field => field.id));
    return next;
}

function pick(source, keys) {
    return Object.fromEntries(keys.filter(key => Object.hasOwn(source ?? {}, key)).map(key => [key, source[key]]));
}

/** Same or not, for one row: the row's keys of the image against the editor's. */
export function rowDiffers(row, recipe, current) {
    const spec = RECIPE_ROWS[row];
    if (!spec) return false;
    if (row === 'seed') return Number(recipe?.run?.seed) !== Number(current?.sections?.generation?.random_seed);
    for (const [section, keys] of Object.entries(spec)) {
        const image = section === 'app' ? recipe?.app : recipe?.sections?.[section];
        const now = section === 'app' ? current?.app : current?.sections?.[section];
        const imageValues = pick(image, keys);
        if (!same(imageValues, pick(now, Object.keys(imageValues)))) return true;
    }
    return false;
}

/** The LoRA rows of the image with whether this editor has each file: [{ ...row, found }]. */
export function recipeLoraRows(recipe, loraList = []) {
    const normalize = name => text(name).replaceAll('\\', '/').toLowerCase();
    const known = new Set((Array.isArray(loraList) ? loraList : []).map(normalize));
    const unknownList = known.size === 0;
    return recipeLoras(recipe).map(row => ({ ...row, found: unknownList || known.has(normalize(row.name)) }));
}

/**
 * What loading writes: `rows` names the checked rows (tags, prose, lora, model, size,
 * regional, seed). Returns { sections, app, prose } - sections for applySectionsData,
 * app keys for the settings (not undoable), the Prose paragraph to pin, or null.
 */
export function planRecipeLoad(recipe, current, rows = []) {
    const on = new Set(rows);
    const sections = {};
    const app = {};
    if (on.has('tags')) sections.prompt = mergeRecipePrompt(current?.sections?.prompt ?? {}, recipe?.sections?.prompt ?? {}, { picked: recipe?.run?.characters ?? [] });
    for (const row of ['model', 'size', 'regional', 'lora']) {
        if (!on.has(row)) continue;
        for (const [section, keys] of Object.entries(RECIPE_ROWS[row])) {
            const source = section === 'app' ? recipe?.app : recipe?.sections?.[section];
            const values = pick(source, keys);
            if (section === 'app') Object.assign(app, values);
            else sections[section] = { ...(sections[section] ?? current?.sections?.[section] ?? {}), ...values };
        }
    }
    if (on.has('seed') && Number.isFinite(recipe?.run?.seed)) {
        sections.generation = { ...(sections.generation ?? current?.sections?.generation ?? {}), random_seed: recipe.run.seed };
    }
    let prose = null;
    if (on.has('prose') && recipe?.run?.prose?.applied && recipe.run.prose.paragraph) {
        prose = { paragraph: recipe.run.prose.paragraph, fields: recipe.run.prose.fields ?? null };
        sections.prompt = { ...(sections.prompt ?? current?.sections?.prompt ?? {}), ai_prose_enable: true };
    }
    return { sections, app, prose };
}
