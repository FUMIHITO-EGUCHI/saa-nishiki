// The LoRA catalog: what SAA knows of each LoRA beyond its file name. Most of it is read
// from the file's own training metadata (ss_tag_frequency, the base model); the rest is
// the user's: the trigger words kept, the tags it is suggested for, the weight range its
// samples span, a star and a category. Pure; the store is scripts/main/loraCatalog.js.
//
// A trigger word is a word the training captions used on nearly every image that is not
// an ordinary Danbooru tag ("charturn", "odinturn"), or one that is but is rare enough to
// name the concept itself ("after sex" in a LoRA about it). The tags a LoRA is suggested
// for are the common ones of its captions that are real tags but not generic ones
// ("multiple views", "turnaround"; never "1girl" or "solo").

export const LORA_SECTION = 'loras';
export const LORA_SCHEMA = 1;
export const LORA_CATEGORIES = Object.freeze(['Composition', 'Character', 'Style', 'Concept', 'Pose', 'Clothing', 'Speed', 'Unsorted']);
export const DEFAULT_RANGE = Object.freeze({ min: 0.2, max: 1, def: 0.8 });
// a tag with more posts than this says nothing about any one LoRA
export const GENERIC_HEAT = 200000;
// at most this common in the captions (share of the most common caption tag) to count
const TRIGGER_SHARE = 0.5;
const LINK_SHARE = 0.3;
const SPEED_NAMES = /dmd2|turbo|lcm|lightning|hyper[-_]?sd|flash/i;
// the quality and rating words captions are padded with: no tag of the dictionary, no
// trigger either
const CAPTION_FILLER = /^(masterpiece|(best|high|highest|amazing|good|normal|low|worst) quality|very aesthetic|aesthetic|absurdres|highres|newest|recent|safe|sensitive|nsfw|explicit|questionable|general|score \d+(?: up)?|year \d{4}|rating:.*)$/;

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function finite(value, fallback = null) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
}

/** "subdir\\CharTurnIL.safetensors" → "CharTurnIL" */
export function loraLabel(name) {
    return String(name ?? '').split(/[\\/]/).pop().replace(/\.(safetensors|ckpt|pt)$/i, '');
}

/** A tag as the catalog compares it: lower case, spaces for underscores, trimmed. */
export function tagKey(tag) {
    return String(tag ?? '').trim().toLowerCase().replaceAll('_', ' ').replace(/\s+/g, ' ');
}

/** ss_tag_frequency (a JSON text of { dataset: { tag: count } }) summed over the datasets, most common first. */
export function tagFrequency(raw) {
    let data = raw;
    if (typeof raw === 'string') {
        try { data = JSON.parse(raw); } catch { return []; }
    }
    if (!isObject(data)) return [];
    const counts = new Map();
    for (const dataset of Object.values(data)) {
        if (!isObject(dataset)) continue;
        for (const [tag, count] of Object.entries(dataset)) {
            const key = tagKey(tag);
            if (key) counts.set(key, (counts.get(key) ?? 0) + (finite(count, 0) ?? 0));
        }
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

/** What the file says it was trained on: 'sdxl', 'anima' or 'unknown'. */
export function loraBase(metadata = {}, name = '') {
    const version = String(metadata?.ss_base_model_version ?? '').toLowerCase();
    const architecture = String(metadata?.['modelspec.architecture'] ?? '').toLowerCase();
    if (/anima|cosmos/.test(version) || /anima|cosmos/.test(architecture) || /anima/i.test(loraLabel(name))) return 'anima';
    if (version.startsWith('sdxl') || /stable-diffusion-xl|sdxl/.test(architecture)) return 'sdxl';
    return 'unknown';
}

/** Whether a LoRA of this base belongs with the model type in use (an unknown base belongs anywhere). */
export function loraFitsModel(base, modelType) {
    if (base === 'unknown') return true;
    return modelType === 'Diffusion' ? base === 'anima' : base === 'sdxl';
}

const squash = text => String(text ?? '').toLowerCase().replaceAll(/[^a-z0-9]+/g, '');

/**
 * The trigger words and the tags to suggest it for, from the caption frequency. `known`
 * (tag key → post count) is the tag dictionary; without one the common words all count
 * as candidates and nothing is suggested. A common word that the file's name spells out
 * ("charturn" in CharTurnIL_…, "after sex" in after-sex-v6) is the likeliest trigger; then
 * a word that is no tag at all, then a rare tag.
 */
export function deriveWords(frequency = [], known = null, { name = '' } = {}) {
    const words = frequency.filter(([tag]) => !CAPTION_FILLER.test(tag));
    const top = words[0]?.[1] ?? 0;
    if (top <= 0) return { triggers: [], candidates: [], linked: [] };
    const heat = tag => (known instanceof Map ? known.get(tag) : undefined);
    const isGeneric = tag => (heat(tag) ?? 0) > GENERIC_HEAT;
    const unknownWord = tag => known instanceof Map && !known.has(tag);
    const rareTag = tag => known instanceof Map && known.has(tag) && (heat(tag) ?? 0) < 5000;
    const fileName = squash(loraLabel(name));
    const inName = tag => squash(tag).length >= 4 && fileName.includes(squash(tag));
    const common = words.filter(([tag, count]) => count >= top * TRIGGER_SHARE && !isGeneric(tag)).map(([tag]) => tag);
    const named = common.filter(inName).slice(0, 2);
    const triggers = named.length > 0 ? named : [common.find(unknownWord) ?? common.find(rareTag)].filter(Boolean);
    const candidates = words
        .filter(([tag, count]) => count >= top * 0.2 && !triggers.includes(tag) && !isGeneric(tag))
        .map(([tag]) => tag)
        .slice(0, 8);
    const linked = known instanceof Map
        ? words
            // a tag too rare to have a meaning of its own ("side") is no suggestion either
            .filter(([tag, count]) => count >= top * LINK_SHARE && (heat(tag) ?? 0) >= 1000 && !isGeneric(tag))
            .map(([tag]) => tag)
            .slice(0, 3)
        : [];
    return { triggers, candidates, linked };
}

/** The category a LoRA starts in when the user has not set one. */
export function defaultCategory(name) {
    return SPEED_NAMES.test(loraLabel(name)) ? 'Speed' : 'Unsorted';
}

function cleanRange(range) {
    if (!isObject(range)) return null;
    const min = finite(range.min);
    const max = finite(range.max);
    if (min === null || max === null || max <= min) return null;
    const def = finite(range.def, (min + max) / 2);
    return { min, max, def: Math.min(max, Math.max(min, def)), src: ['Civitai', 'default', 'custom'].includes(range.src) ? range.src : 'custom' };
}

function cleanSample(sample) {
    if (!isObject(sample) || !sample.id || !sample.file) return null;
    return {
        id: String(sample.id),
        file: String(sample.file),
        weight: finite(sample.weight, 0),
        model: String(sample.model ?? ''),
        modelType: sample.modelType === 'Diffusion' ? 'Diffusion' : 'Checkpoint',
        created: String(sample.created ?? ''),
    };
}

const cleanWords = list => [...new Set((Array.isArray(list) ? list : []).map(tagKey).filter(Boolean))];

/** One stored entry, what the user set (missing parts mean "as derived"). */
export function cleanLoraEntry(entry = {}) {
    if (!isObject(entry)) return {};
    const next = {};
    if (Array.isArray(entry.triggers)) next.triggers = cleanWords(entry.triggers);
    if (Array.isArray(entry.linked)) next.linked = cleanWords(entry.linked);
    const range = cleanRange(entry.range);
    if (range) next.range = range;
    if (entry.favorite === true) next.favorite = true;
    if (LORA_CATEGORIES.includes(entry.category)) next.category = entry.category;
    if (typeof entry.sha256 === 'string' && /^[0-9a-f]{64}$/i.test(entry.sha256)) next.sha256 = entry.sha256.toLowerCase();
    if (isObject(entry.civitai)) {
        next.civitai = {
            modelId: finite(entry.civitai.modelId),
            versionId: finite(entry.civitai.versionId),
            name: String(entry.civitai.name ?? ''),
            baseModel: String(entry.civitai.baseModel ?? ''),
            url: String(entry.civitai.url ?? ''),
        };
    }
    const samples = (Array.isArray(entry.samples) ? entry.samples : []).map(cleanSample).filter(Boolean);
    if (samples.length) next.samples = samples;
    return next;
}

export function normalizeLoraDoc(doc) {
    const loras = {};
    for (const [name, entry] of Object.entries(isObject(doc?.loras) ? doc.loras : {})) {
        if (!name) continue;
        const clean = cleanLoraEntry(entry);
        if (Object.keys(clean).length) loras[name] = clean;
    }
    const range = cleanRange({ ...DEFAULT_RANGE, ...(isObject(doc?.defaults) ? doc.defaults : {}), src: 'default' }) ?? { ...DEFAULT_RANGE, src: 'default' };
    return { loras, defaults: { min: range.min, max: range.max, def: range.def } };
}

/**
 * One change to the catalog: { action: 'set', name, patch } (the user's fields), 'clear'
 * (back to what is derived), 'add-sample' / 'remove-samples' (by weight set). Returns the
 * new document, or null when the change makes no sense.
 */
export function applyLoraChange(doc, change = {}) {
    const current = normalizeLoraDoc(doc);
    const name = String(change.name ?? '');
    if (change.action === 'defaults') {
        const range = cleanRange({ ...change.patch, src: 'default' });
        return range ? { ...current, defaults: { min: range.min, max: range.max, def: range.def } } : null;
    }
    if (!name) return null;
    const entry = current.loras[name] ?? {};
    let next;
    if (change.action === 'set') {
        next = cleanLoraEntry({ ...entry, ...(isObject(change.patch) ? change.patch : {}) });
        if (change.patch?.favorite === false) delete next.favorite;
    } else if (change.action === 'clear') {
        next = cleanLoraEntry({ samples: entry.samples, sha256: entry.sha256, civitai: entry.civitai, favorite: entry.favorite, category: entry.category });
    } else if (change.action === 'add-sample') {
        const sample = cleanSample(change.sample);
        if (!sample) return null;
        // one sample per weight and model: a retake replaces it
        const samples = (entry.samples ?? []).filter(old => !(old.weight === sample.weight && old.model === sample.model));
        next = cleanLoraEntry({ ...entry, samples: [...samples, sample] });
    } else if (change.action === 'remove-samples') {
        next = cleanLoraEntry({ ...entry, samples: (entry.samples ?? []).filter(old => old.model !== String(change.model ?? '')) });
    } else {
        return null;
    }
    const loras = { ...current.loras };
    if (Object.keys(next).length) loras[name] = next;
    else delete loras[name];
    return { ...current, loras };
}

/** The six weights a sample grid shows: off, then five even steps over the range. */
export function sampleWeights(range = DEFAULT_RANGE) {
    const min = finite(range.min, DEFAULT_RANGE.min);
    const max = finite(range.max, DEFAULT_RANGE.max);
    return [0, ...[0, 1, 2, 3, 4].map(step => Math.round((min + ((max - min) * step) / 4) * 100) / 100)];
}

/** The index (in sampleWeights) of the cell nearest the default weight. */
export function defaultCell(range = DEFAULT_RANGE) {
    const weights = sampleWeights(range);
    let best = 1;
    for (let index = 1; index < weights.length; index++) {
        if (Math.abs(weights[index] - range.def) < Math.abs(weights[best] - range.def)) best = index;
    }
    return best;
}

/**
 * What the renderer shows of one LoRA: the file's facts (`file`: { name, base, dim, alpha,
 * images, frequency }) under the user's choices (`stored`), with the catalog defaults.
 */
export function loraView(file, stored = {}, { defaults = DEFAULT_RANGE, known = null } = {}) {
    const derived = deriveWords(file.frequency ?? [], known, { name: file.name });
    const range = stored.range ?? { ...defaults, src: 'default' };
    const triggers = stored.triggers ?? derived.triggers;
    return {
        name: file.name,
        label: loraLabel(file.name),
        base: file.base ?? 'unknown',
        dim: file.dim ?? null,
        alpha: file.alpha ?? null,
        images: file.images ?? null,
        size: file.size ?? null,
        mtime: file.mtime ?? null,
        triggers,
        // the guessed trigger the user replaced is still on offer
        candidates: [...new Set([...derived.triggers, ...derived.candidates])].filter(word => !triggers.includes(word)),
        linked: stored.linked ?? derived.linked,
        range,
        favorite: stored.favorite === true,
        category: stored.category ?? defaultCategory(file.name),
        samples: stored.samples ?? [],
        sha256: stored.sha256 ?? '',
        civitai: stored.civitai ?? null,
        hasMetadata: (file.frequency ?? []).length > 0,
    };
}

// ------------------------------------------------------------------ samples

export const LORA_SAMPLE_SIZE = Object.freeze({ width: 512, height: 704 });
export const LORA_SAMPLE_SEED = 3;
// a sample looks the same whatever the run bar says (Fast mode skips samples, fastMode.js)
export const LORA_SAMPLE_GENERATION = Object.freeze({
    Diffusion: Object.freeze({ steps: 20, cfg: 4.5, sampler: 'er_sde', scheduler: 'simple' }),
    Checkpoint: Object.freeze({ steps: 24, cfg: 5, sampler: 'euler_ancestral', scheduler: 'normal' }),
});
const SAMPLE_QUALITY = Object.freeze({
    Diffusion: 'masterpiece, best quality, score_7, safe',
    Checkpoint: 'masterpiece, best quality, very aesthetic, absurdres',
});
const SAMPLE_NEGATIVE = Object.freeze({
    Diffusion: 'worst quality, low quality, score_1, score_2, score_3, artist name, signature, watermark, text, logo',
    Checkpoint: 'worst quality, low quality, bad anatomy, bad hands, artist name, signature, watermark, text, logo',
});

/**
 * One cell of a LoRA's sample grid: a girl with the LoRA's trigger words and the tags it
 * is suggested for, at `weight` (0 = the LoRA left out, the same prompt otherwise), so
 * the cells differ by the LoRA alone.
 */
export function loraSamplePrompt({ modelType, name, triggers = [], linked = [], weight = 0 }) {
    const type = modelType === 'Diffusion' ? 'Diffusion' : 'Checkpoint';
    const words = [...new Set([...triggers, ...linked])];
    // a framing of its own: with none, the model drifted into close-ups (2026-10-17 bench)
    const positive = [SAMPLE_QUALITY[type], '1girl, solo, full body, standing, looking at viewer', ...words, 'simple background, white background'].filter(Boolean).join(', ');
    const tag = weight > 0 ? `\n<lora:${name}:${weight}:${weight}>` : '';
    return { positive: `${positive}${tag}`, negative: SAMPLE_NEGATIVE[type] };
}

/** The samples of the model in use, by weight; another model's only when it has none. */
export function samplesForModel(entry, model) {
    const all = Array.isArray(entry?.samples) ? entry.samples : [];
    const own = all.filter(sample => sample.model === model);
    const chosen = own.length > 0 ? own : all;
    const byWeight = new Map();
    for (const sample of chosen) {
        const known = byWeight.get(sample.weight);
        if (!known || String(sample.created) > String(known.created)) byWeight.set(sample.weight, sample);
    }
    return { samples: byWeight, foreign: own.length === 0 && all.length > 0 };
}
