// Sequence batch (docs/sequence-batch-plan.md): one Generate click runs every picked
// character through an ordered list of scenes, K candidates each. A scene is the text of
// one prompt field (the "scene field"); everything else comes from the screen as it is.
//
// Pure: no DOM, no Electron, no I/O. The renderer and the main-process store share it.

export const MAX_CANDIDATES = 16;
export const NAME_LIMIT = 40;
export const THUMB_PREFIX = 'data:image/jpeg;base64,';
const SEED_RANGE = 2 ** 32;

// Built-in fields a scene can hold, and the setting each one's text lives in. Every other
// scene field is a custom field (prompt_custom_fields[].id, "cf_…").
export const BUILTIN_SCENE_FIELDS = Object.freeze({
    views: 'view_tags',
    background: 'prompt_background',
    style: 'prompt_style',
});

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = value => (typeof value === 'string' ? value : '');

/** The setting key that holds a built-in scene field's text, or null for a custom field. */
export function builtinSceneSetting(fieldKey) {
    return BUILTIN_SCENE_FIELDS[fieldKey] ?? null;
}

let sceneCounter = 0;
/** A fresh scene id. */
export function makeSceneId(now = Date.now()) {
    sceneCounter = (sceneCounter + 1) % 1000;
    return `s${now.toString(36)}${sceneCounter.toString(36)}`;
}

/**
 * Scenes as stored: { id, name, text, thumb }. Each gets an id, a name ("Scene <n>"
 * when blank), its text as a string, and a thumb only when it is a JPEG data URL.
 */
export function normalizeScenes(list, { makeId = makeSceneId } = {}) {
    if (!Array.isArray(list)) return [];
    const seen = new Set();
    return list.filter(isObject).map((scene, index) => {
        let id = text(scene.id).trim();
        if (!id || seen.has(id)) id = makeId();
        seen.add(id);
        const name = text(scene.name).trim() || `Scene ${index + 1}`;
        const thumb = text(scene.thumb).startsWith(THUMB_PREFIX) ? scene.thumb : '';
        return { id, name, text: text(scene.text), thumb };
    });
}

/** One sequence: the scene field and its scenes. */
export function normalizeSequence(value) {
    const data = isObject(value) ? value : {};
    return { field: text(data.field).trim(), scenes: normalizeScenes(data.scenes) };
}

/**
 * The store's document (settings/sequences.json):
 *   sequences  { <name>: { field, scenes } }   the saved ones
 *   current    { name, field, scenes }         what the dialog holds, unsaved changes included
 *   editBackup { fieldKey, text } | null       the scene field's own text while edit mode runs
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
        : { name: '', field: '', scenes: [] };
    const backup = isObject(data.editBackup) && text(data.editBackup.fieldKey)
        ? { fieldKey: data.editBackup.fieldKey, text: text(data.editBackup.text) }
        : null;
    return { sequences, current, editBackup: backup };
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
 * The queue rows of one run, character by character, then scene by scene, then
 * candidate: [{ characterKey, characterIndex, sceneIndex, sceneId, sceneName, sceneText,
 * candidate, seed }].
 */
export function expandSequenceRows({ characters = [], scenes = [], candidates = 1, baseSeed = 0 } = {}) {
    const k = Math.max(1, Math.min(MAX_CANDIDATES, Math.floor(Number(candidates) || 1)));
    const rows = [];
    characters.forEach((characterKey, characterIndex) => {
        scenes.forEach((scene, sceneIndex) => {
            for (let candidate = 0; candidate < k; candidate++) {
                rows.push({
                    characterKey,
                    characterIndex,
                    sceneIndex,
                    sceneId: scene.id,
                    sceneName: scene.name,
                    sceneText: scene.text,
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
 * run, seq-<runId>, and <character>_s<NN>-<scene>_c<K> in it.
 */
export function sequenceSaveTarget({ runId, characterName, sceneIndex, sceneName, candidate }) {
    const nn = String(sceneIndex + 1).padStart(2, '0');
    return { path: `seq-${runId}`, filename: `${sanitizeName(characterName)}_s${nn}-${sanitizeName(sceneName)}_c${candidate + 1}` };
}

/** The queue's label of one row: "[Seq] <character> / <scene> #<candidate>". */
export function sequenceQueueLabel({ characterName, sceneName, candidate }) {
    return `[Seq] ${characterName} / ${sceneName} #${candidate + 1}`;
}

/**
 * The prompt section of an image's recipe as the row ran it: slot 1 holds the row's
 * character, every other slot None, and the scene field holds the scene's text.
 */
export function patchRecipePrompt(prompt, { characterKey, sceneText, fieldKey }) {
    const data = isObject(prompt) ? JSON.parse(JSON.stringify(prompt)) : {};
    const slots = Array.isArray(data.character_slots) && data.character_slots.length ? data.character_slots : [{ key: 'None', weight: 1 }];
    data.character_slots = slots.map((slot, index) => ({ ...(isObject(slot) ? slot : {}), key: index === 0 ? characterKey : 'None' }));
    if ('character1' in data || 'character2' in data || 'character3' in data) {
        data.character1 = characterKey;
        data.character2 = 'None';
        data.character3 = 'None';
    }
    const setting = builtinSceneSetting(fieldKey);
    if (setting) {
        data[setting] = sceneText;
    } else if (Array.isArray(data.prompt_custom_fields)) {
        data.prompt_custom_fields = data.prompt_custom_fields.map(field => (isObject(field) && field.id === fieldKey ? { ...field, text: sceneText } : field));
    }
    return data;
}

/** The scene field's text in a recipe's prompt section, or null when the recipe lacks the field. */
export function readSceneText(prompt, fieldKey) {
    if (!isObject(prompt) || !fieldKey) return null;
    const setting = builtinSceneSetting(fieldKey);
    if (setting) return typeof prompt[setting] === 'string' ? prompt[setting] : null;
    const field = Array.isArray(prompt.prompt_custom_fields) ? prompt.prompt_custom_fields.find(entry => isObject(entry) && entry.id === fieldKey) : null;
    return field && typeof field.text === 'string' ? field.text : null;
}

/** The text of a scene field as the settings hold it now, or null when the field is not there. */
export function fieldTextInSettings(settings, fieldKey) {
    return readSceneText(settings, fieldKey);
}

/**
 * Why the run cannot start, in the order the dialog shows them (ids; the dialog words them):
 * no-characters, no-scenes, empty-scene, no-field, field-muted, regional, controlnet,
 * webui, diffusion, busy.
 */
export function sequenceStartBlockers({
    characters = 0, scenes = [], fieldExists = true, fieldMuted = false,
    regional = false, controlNet = 0, backend = 'ComfyUI', modelType = 'Checkpoint', busy = false,
} = {}) {
    const reasons = [];
    if (!characters) reasons.push('no-characters');
    if (!scenes.length) reasons.push('no-scenes');
    if (scenes.some(scene => !text(scene?.text).trim())) reasons.push('empty-scene');
    if (!fieldExists) reasons.push('no-field');
    else if (fieldMuted) reasons.push('field-muted');
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
