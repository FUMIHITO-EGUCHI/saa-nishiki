// Sequence batch (docs/sequence-batch-plan.md): one Generate click runs every picked
// character through an ordered list of scenes, K candidates each. A scene holds its own
// prompts (every field of the Prompts card, the custom fields and their order included),
// its LoRA rows and its generation settings (size, steps, CFG, sampler, Hires); the
// character, the model and ADetailer come from the run and the screen.
//
// Pure: no DOM, no Electron, no I/O. The renderer and the main-process store share it.

export const MAX_CANDIDATES = 16;
export const NAME_LIMIT = 40;
export const THUMB_PREFIX = 'data:image/jpeg;base64,';
export const HISTORY_LIMIT = 60;
const SEED_RANGE = 2 ** 32;

/**
 * The settings a scene owns, per settings section. Everything else (the characters, the
 * model and its files, ADetailer, ControlNet, Regional, the AI / Prose options, the seed,
 * the batch size) stays as the screen has it.
 */
export const SCENE_KEYS = Object.freeze({
    prompt: Object.freeze([
        'artist_slots', 'artist_signature_guard',
        'view_tags', 'view_angle', 'view_camera', 'view_background', 'view_style',
        'custom_prompt', 'api_prompt', 'api_prompt_right', 'api_neg_prompt', 'api_neg_prompt_left', 'api_neg_prompt_right',
        'prompt_background', 'prompt_style', 'prompt_ban',
        'prompt_custom_fields', 'prompt_positive_order', 'prompt_negative_order', 'prompt_field_muted',
        'prompt_locks',
    ]),
    generation: Object.freeze([
        'cfg', 'step', 'width', 'height', 'api_image_landscape', 'api_image_ratio', 'api_image_ratio_linked',
        'api_model_sampler', 'api_model_scheduler',
        'api_hf_enable', 'api_hf_scale', 'api_hf_denoise', 'api_hf_upscaler_selected', 'api_hf_colortransfer', 'api_hf_random_seed', 'api_hf_steps',
    ]),
    lora: Object.freeze(['lora_slot']),
});
export const SCENE_SECTIONS = Object.freeze(Object.keys(SCENE_KEYS));

// Before scenes held their own settings, a scene was the text of one or more fields
// ({ <fieldKey>: text }); the built-in fields and the setting each one's text lived in.
// Used to carry such scenes over (sequenceBatchUi.js).
export const BUILTIN_SCENE_FIELDS = Object.freeze({
    views: 'view_tags',
    background: 'prompt_background',
    style: 'prompt_style',
    positive: 'api_prompt',
});

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = value => (typeof value === 'string' ? value : '');
const clone = value => JSON.parse(JSON.stringify(value));

/** The setting key that holds a built-in field's text, or null for a custom field. */
export function builtinSceneSetting(fieldKey) {
    return BUILTIN_SCENE_FIELDS[fieldKey] ?? null;
}

/**
 * The scene's part of a set of sections ({ prompt, generation, lora }, as collectSection
 * or a recipe's `sections` hold them): only SCENE_KEYS, deep-copied; null when none is there.
 */
export function pickSceneSettings(sections) {
    if (!isObject(sections)) return null;
    const out = {};
    let any = false;
    for (const [section, keys] of Object.entries(SCENE_KEYS)) {
        const source = isObject(sections[section]) ? sections[section] : {};
        const picked = {};
        for (const key of keys) {
            if (Object.hasOwn(source, key) && source[key] !== undefined) {
                picked[key] = clone(source[key]);
                any = true;
            }
        }
        out[section] = picked;
    }
    return any ? out : null;
}

/** Old scene texts ({ <fieldKey>: text }) written over a scene's settings (a copy). */
export function applyLegacyTexts(settings, texts) {
    const out = clone(settings);
    out.prompt = isObject(out.prompt) ? out.prompt : {};
    for (const [fieldKey, value] of Object.entries(isObject(texts) ? texts : {})) {
        if (typeof value !== 'string') continue;
        const setting = builtinSceneSetting(fieldKey);
        if (setting) {
            out.prompt[setting] = value;
        } else if (Array.isArray(out.prompt.prompt_custom_fields)) {
            out.prompt.prompt_custom_fields = out.prompt.prompt_custom_fields.map(field => (isObject(field) && field.id === fieldKey ? { ...field, text: value } : field));
        }
    }
    return out;
}

let sceneCounter = 0;
/** A fresh scene id. */
export function makeSceneId(now = Date.now()) {
    sceneCounter = (sceneCounter + 1) % 1000;
    return `s${now.toString(36)}${sceneCounter.toString(36)}`;
}

/** A saved file's path as a comparison key (no case, one slash direction). */
export function pathKey(value) {
    return String(value ?? '').replaceAll('/', '\\').toLowerCase();
}

// the scene's images made in edit mode: saved file paths, oldest first, distinct, the
// newest HISTORY_LIMIT
function normalizeHistory(list) {
    if (!Array.isArray(list)) return [];
    const out = [];
    for (const entry of list) {
        const file = text(entry).trim();
        if (!file) continue;
        const index = out.findIndex(item => pathKey(item) === pathKey(file));
        if (index >= 0) out.splice(index, 1);
        out.push(file);
    }
    return out.slice(-HISTORY_LIMIT);
}

/** The scene's history with `file` added as its newest image. */
export function addToHistory(history, file) {
    return normalizeHistory([...(Array.isArray(history) ? history : []), file]);
}

// the text per field of a scene stored before scenes held their own settings
function legacyTexts(scene, legacyField) {
    const texts = {};
    if (isObject(scene.texts)) {
        for (const [key, value] of Object.entries(scene.texts)) {
            const id = text(key).trim();
            if (id && typeof value === 'string') texts[id] = value;
        }
    } else if (legacyField && typeof scene.text === 'string') {
        texts[legacyField] = scene.text;
    }
    return texts;
}

/**
 * Scenes as stored: { id, name, settings, thumb, image, history }. Each gets an id, a name
 * ("Scene <n>" when blank), its settings (SCENE_KEYS only; null when it has none yet), a
 * thumb only when it is a JPEG data URL, the adopted image's saved file (`image`, '' when
 * none) and the images made for it in edit mode (`history`). A scene from before scenes
 * held settings keeps its old texts as `texts` until it gets settings.
 */
export function normalizeScenes(list, { makeId = makeSceneId, legacyField = '' } = {}) {
    if (!Array.isArray(list)) return [];
    const seen = new Set();
    return list.filter(isObject).map((scene, index) => {
        let id = text(scene.id).trim();
        if (!id || seen.has(id)) id = makeId();
        seen.add(id);
        const name = text(scene.name).trim() || `Scene ${index + 1}`;
        const thumb = text(scene.thumb).startsWith(THUMB_PREFIX) ? scene.thumb : '';
        const settings = pickSceneSettings(scene.settings);
        const out = { id, name, settings, thumb, image: text(scene.image).trim(), history: normalizeHistory(scene.history) };
        if (!settings) out.texts = legacyTexts(scene, legacyField);
        return out;
    });
}

/** One sequence: its scenes. */
export function normalizeSequence(value) {
    const data = isObject(value) ? value : {};
    const legacyField = Array.isArray(data.fields) ? '' : text(data.field).trim();
    return { scenes: normalizeScenes(data.scenes, { legacyField }) };
}

/**
 * The store's document (settings/sequences.json):
 *   sequences  { <name>: { scenes } }   the saved ones
 *   current    { name, scenes }         what the dialog holds, unsaved changes included
 *   editBackup { settings, sceneId } | null
 *                                       the screen's own settings while edit mode runs, and
 *                                       the scene on it (the mode comes back on start)
 */
export function normalizeSequenceDocument(value) {
    const data = isObject(value) ? value : {};
    const sequences = {};
    if (isObject(data.sequences)) {
        for (const [name, sequence] of Object.entries(data.sequences)) {
            const key = text(name).trim();
            if (key) sequences[key] = normalizeSequence(sequence);
        }
    }
    const current = isObject(data.current)
        ? { name: text(data.current.name).trim(), ...normalizeSequence(data.current) }
        : { name: '', scenes: [] };
    return { sequences, current, editBackup: normalizeEditBackup(data.editBackup) };
}

/**
 * The edit backup: { settings, sceneId } (the screen's own scene settings and the scene the
 * mode has on the screen; sceneId '' when unknown), or { texts } from an edit mode of the
 * older kind ({ texts: { <fieldKey>: text } } or { fieldKey, text }); null when there is
 * nothing to give back.
 */
export function normalizeEditBackup(value) {
    if (!isObject(value)) return null;
    const settings = pickSceneSettings(value.settings);
    if (settings) return { settings, sceneId: text(value.sceneId).trim() };
    const texts = {};
    if (isObject(value.texts)) {
        for (const [key, entry] of Object.entries(value.texts)) {
            const id = text(key).trim();
            if (id) texts[id] = text(entry);
        }
    } else if (text(value.fieldKey).trim()) {
        texts[value.fieldKey.trim()] = text(value.text);
    }
    return Object.keys(texts).length ? { texts } : null;
}

/** `count` distinct entries of `pool`, drawn with `rng` (returns [0, 1)). */
export function pickRandomCharacters(pool, count, rng = Math.random) {
    const list = Array.isArray(pool) ? [...pool] : [];
    const n = Math.max(0, Math.min(list.length, Math.floor(Number(count) || 0)));
    for (let i = list.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        [list[i], list[j]] = [list[j], list[i]];
    }
    return list.slice(0, n);
}

/** Candidate `c` (0-based) of every character and scene takes seed (base + c) mod 2^32. */
export function candidateSeed(baseSeed, candidate) {
    const base = Math.floor(Number(baseSeed) || 0);
    return (((base + candidate) % SEED_RANGE) + SEED_RANGE) % SEED_RANGE;
}

/**
 * The queue rows of one run, scene by scene (a scene's settings go on the screen once),
 * then character, then candidate: [{ characterKey, characterIndex, sceneIndex, sceneId,
 * sceneName, candidate, seed }].
 */
export function expandSequenceRows({ characters = [], scenes = [], candidates = 1, baseSeed = 0 } = {}) {
    const k = Math.max(1, Math.min(MAX_CANDIDATES, Math.floor(Number(candidates) || 1)));
    const rows = [];
    scenes.forEach((scene, sceneIndex) => {
        characters.forEach((characterKey, characterIndex) => {
            for (let candidate = 0; candidate < k; candidate++) {
                rows.push({
                    characterKey,
                    characterIndex,
                    sceneIndex,
                    sceneId: scene.id,
                    sceneName: scene.name,
                    candidate,
                    seed: candidateSeed(baseSeed, candidate),
                });
            }
        });
    });
    return rows;
}

/** A file-name-safe piece: Windows' forbidden characters and control characters become "_". */
export function sanitizeName(value, limit = NAME_LIMIT) {
    // eslint-disable-next-line no-control-regex
    const cleaned = String(value ?? '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/\s+/g, ' ').trim();
    const cut = [...cleaned].slice(0, limit).join('').replace(/[. ]+$/, '');
    return cut || '_';
}

/** "YYYYMMDD-HHmmss" of the click, local time. */
export function sequenceRunId(date = new Date()) {
    const pad = value => String(value).padStart(2, '0');
    return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

/**
 * Where one row's image is saved (the saver node's `path` and `filename`): one folder per
 * run, seq-<runId>, and <character>_p<NN>_s<NN>-<scene> in it, so the files sort character
 * by character, then candidate ("pattern") by candidate, then scene by scene: one
 * candidate's scenes read as a story.
 */
export function sequenceSaveTarget({ runId, characterName, sceneIndex, sceneName, candidate }) {
    const pattern = String(candidate + 1).padStart(2, '0');
    const scene = String(sceneIndex + 1).padStart(2, '0');
    return { path: `seq-${runId}`, filename: `${sanitizeName(characterName)}_p${pattern}_s${scene}-${sanitizeName(sceneName)}` };
}

/** A Library folder of one sequence run (sequenceSaveTarget's `path`). */
export function isSequenceRunFolder(name) {
    return /^seq-\d{8}-\d{6}$/.test(String(name ?? ''));
}

/** The queue's label of one row: "[Seq] <character> / <scene> #<candidate>". */
export function sequenceQueueLabel({ characterName, sceneName, candidate }) {
    return `[Seq] ${characterName} / ${sceneName} #${candidate + 1}`;
}

/**
 * The prompt section of an image's recipe as the row ran it: slot 1 holds the row's
 * character, every other slot None (the scene's own prompts are on the screen already).
 */
export function patchRecipePrompt(prompt, { characterKey }) {
    const data = isObject(prompt) ? JSON.parse(JSON.stringify(prompt)) : {};
    const slots = Array.isArray(data.character_slots) && data.character_slots.length ? data.character_slots : [{ key: 'None', weight: 1 }];
    data.character_slots = slots.map((slot, index) => ({ ...(isObject(slot) ? slot : {}), key: index === 0 ? characterKey : 'None' }));
    if ('character1' in data || 'character2' in data || 'character3' in data) {
        data.character1 = characterKey;
        data.character2 = 'None';
        data.character3 = 'None';
    }
    return data;
}

/** A field's text in a prompt section (settings or a recipe's), or null when the field is not there. */
export function readSceneText(prompt, fieldKey) {
    if (!isObject(prompt) || !fieldKey) return null;
    const setting = builtinSceneSetting(fieldKey);
    if (setting) return typeof prompt[setting] === 'string' ? prompt[setting] : null;
    const field = Array.isArray(prompt.prompt_custom_fields) ? prompt.prompt_custom_fields.find(entry => isObject(entry) && entry.id === fieldKey) : null;
    return field && typeof field.text === 'string' ? field.text : null;
}

/**
 * Why the run cannot start, in the order the dialog shows them (ids; the dialog words them):
 * no-characters, no-scenes, empty-scene (a scene without settings), regional, controlnet,
 * webui, diffusion, busy.
 */
export function sequenceStartBlockers({
    characters = 0, scenes = [],
    regional = false, controlNet = 0, backend = 'ComfyUI', modelType = 'Checkpoint', busy = false,
} = {}) {
    const reasons = [];
    if (!characters) reasons.push('no-characters');
    if (!scenes.length) reasons.push('no-scenes');
    if (scenes.some(scene => !scene?.settings)) reasons.push('empty-scene');
    if (regional) reasons.push('regional');
    if (controlNet > 0) reasons.push('controlnet');
    if (backend !== 'ComfyUI') reasons.push('webui');
    if (modelType !== 'Checkpoint') reasons.push('diffusion');
    if (busy) reasons.push('busy');
    return reasons;
}

/** The scene list after moving the scene at `from` so that it lands before index `to` (drag and drop). */
export function moveScene(scenes, from, to) {
    const list = Array.isArray(scenes) ? [...scenes] : [];
    if (from < 0 || from >= list.length || to < 0 || to > list.length || from === to || from + 1 === to) return list;
    const [item] = list.splice(from, 1);
    list.splice(from < to ? to - 1 : to, 0, item);
    return list;
}
