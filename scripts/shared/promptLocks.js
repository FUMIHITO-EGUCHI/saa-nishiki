// Locks: what a random source drew, held for the runs that follow (the Batch (Last) button's
// successor, docs/sequence-batch-plan.md D33).
//
// A random source is a character slot set to "Random", a prompt row whose whole text is
// `random` (Background / Style: one tag of that view list), a __wildcard__ or a "{a|b}"
// choice in a row, and the AI prompt's answer. Unlocked, each draws as it always did (from
// the seed, or freshly). Locked, it takes the value it holds; a lock that holds nothing yet
// ("next draw") takes the next draw and holds that.
//
// What a row drew is kept per source: a wildcard by its name, a choice by its content (in
// order, so two identical choices stay two draws), the view-list pick as `list`. Editing a
// row's fixed tags keeps everything it holds; a changed or added source finds nothing held
// under its name and draws, and from then on holds that. Nothing here ever unlocks.
//
// The settings (all in the prompt section, so scenes and presets carry the rows' locks):
//   prompt_locks    { [fieldId]: { draws: { [part]: Draws } } }   a key present = locked
//   character_locks { [slotIndex]: { key } }                       key null = next draw
//   ai_prompt_lock  { text } | null                                text null = next draw
// `part` is the prompt a row's draw went into: 'left' for the one prompt of a normal run
// and the left side of Regional, 'right' for Regional's right side.
//
// Pure: no DOM, no Electron.

export const FIELD_LOCKS = 'prompt_locks';
export const CHARACTER_LOCKS = 'character_locks';
export const AI_LOCK = 'ai_prompt_lock';

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const copy = value => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));
const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

const WILDCARD = /__([a-zA-Z0-9_-]+)__/;
// a "{…|…}" (nested or not) is enough of a hint; the parser (nestedBraceParsing.js) decides
const CHOICE = /\{[^]*?\|[^]*?\}/;

/** The whole row is `random`: one tag of its view list (Background / Style). */
export function isListRandom(text) {
    return String(text ?? '').trim().toLowerCase() === 'random';
}

/** A row's text holds something that draws. `list`: the row knows `random` (Background / Style). */
export function hasRandomSource(text, { list = false } = {}) {
    const value = String(text ?? '');
    if (list && isListRandom(value)) return true;
    return WILDCARD.test(value) || CHOICE.test(value);
}

/** Something that draws anew for each image even with the seed fixed: a "{a|b}" (always), a wildcard (with Wildcard seed on). */
export function drawsEachImage(text, { freshWildcards = false } = {}) {
    const value = String(text ?? '');
    return CHOICE.test(value) || (freshWildcards && WILDCARD.test(value));
}

function cleanDraws(draws) {
    if (!isObject(draws)) return null;
    const out = {};
    if (typeof draws.list === 'string') out.list = draws.list;
    if (isObject(draws.wildcards)) {
        const wildcards = Object.fromEntries(Object.entries(draws.wildcards).filter(([, value]) => typeof value === 'string'));
        if (Object.keys(wildcards).length) out.wildcards = wildcards;
    }
    if (isObject(draws.choices)) {
        const choices = Object.fromEntries(Object.entries(draws.choices)
            .map(([content, options]) => [content, Array.isArray(options) ? options.filter(option => typeof option === 'string') : []])
            .filter(([, options]) => options.length));
        if (Object.keys(choices).length) out.choices = choices;
    }
    return Object.keys(out).length ? out : null;
}

/**
 * One row's draws for one image, replaying `held` where it has the source. It speaks the
 * `materials` interface of replaceWildcardsAsync and processRandomString (promptMaterials.js),
 * plus `list(draw)` for the view-list pick. `result()` is what this image drew: the held
 * values it used and the fresh ones, and nothing a source no longer in the row had.
 */
export function createDrawRecord(held = null) {
    const source = cleanDraws(held) ?? {};
    const out = { wildcards: {}, choices: {} };
    const cursor = new Map();
    const push = (content, option) => {
        (out.choices[content] ??= []).push(option);
    };
    return {
        pick(content) {
            const options = source.choices?.[content];
            const index = cursor.get(content) ?? 0;
            cursor.set(content, index + 1);
            if (!Array.isArray(options) || index >= options.length) return null;
            push(content, options[index]);
            return options[index];
        },
        remember(content, option) {
            push(content, option);
        },
        wildcard(name) {
            if (!source.wildcards || !Object.hasOwn(source.wildcards, name)) return undefined;
            out.wildcards[name] = source.wildcards[name];
            return source.wildcards[name];
        },
        rememberWildcard(name, value) {
            if (!Object.hasOwn(out.wildcards, name)) out.wildcards[name] = String(value ?? '');
        },
        list(draw) {
            const value = typeof source.list === 'string' ? source.list : String(draw() ?? '');
            out.list = value;
            return value;
        },
        result() {
            return cleanDraws(out);
        },
    };
}

/** What a row's draws read as, in the order a person reads them: [value, …]. */
export function describeDraws(draws) {
    const clean = cleanDraws(draws);
    if (!clean) return [];
    return [
        ...(typeof clean.list === 'string' ? [clean.list] : []),
        ...Object.values(clean.wildcards ?? {}),
        ...Object.values(clean.choices ?? {}).flat(),
    ].map(value => String(value).trim()).filter(Boolean);
}

/** All parts of a row's draws in one list (left before right). */
export function describePartDraws(parts) {
    if (!isObject(parts)) return [];
    return ['left', 'right', ...Object.keys(parts).filter(part => part !== 'left' && part !== 'right')]
        .filter((part, index, list) => list.indexOf(part) === index && Object.hasOwn(parts, part))
        .flatMap(part => describeDraws(parts[part]));
}

// ---------------------------------------------------------------- prompt rows

function fieldLocks(settings) {
    return isObject(settings?.[FIELD_LOCKS]) ? settings[FIELD_LOCKS] : {};
}

/** The row's lock ({ draws: { [part]: Draws } }) or null when it is not locked. */
export function fieldLock(settings, id) {
    const lock = fieldLocks(settings)[id];
    return isObject(lock) ? lock : null;
}

export function isFieldLocked(settings, id) {
    return fieldLock(settings, id) !== null;
}

/** What a locked row holds for one part, or null (not locked, or next draw). */
export function heldFieldDraws(settings, id, part = 'left') {
    const draws = fieldLock(settings, id)?.draws;
    return isObject(draws) ? cleanDraws(draws[part]) : null;
}

/** Lock a row on `draws` ({ [part]: Draws }, or null = next draw), or unlock it. A settings patch. */
export function setFieldLock(settings, id, locked, draws = null) {
    const next = { ...fieldLocks(settings) };
    if (locked) {
        const parts = isObject(draws)
            ? Object.fromEntries(Object.entries(draws).map(([part, value]) => [part, cleanDraws(value)]).filter(([, value]) => value))
            : {};
        next[id] = { draws: parts };
    } else {
        delete next[id];
    }
    return { [FIELD_LOCKS]: next };
}

/** A locked row keeps what this image drew for `part`; null when there is nothing to change. */
export function holdFieldDraws(settings, id, part, draws) {
    const lock = fieldLock(settings, id);
    if (!lock) return null;
    const current = isObject(lock.draws) ? lock.draws : {};
    const clean = cleanDraws(draws);
    if (same(cleanDraws(current[part]), clean)) return null;
    const parts = { ...current };
    if (clean) parts[part] = clean; else delete parts[part];
    return { [FIELD_LOCKS]: { ...fieldLocks(settings), [id]: { draws: parts } } };
}

/** Locks of rows that no longer exist go; null when every lock still has its row. */
export function pruneFieldLocks(settings, ids) {
    const keep = new Set(ids);
    const locks = fieldLocks(settings);
    const gone = Object.keys(locks).filter(id => !keep.has(id));
    if (gone.length === 0) return null;
    const next = { ...locks };
    for (const id of gone) delete next[id];
    return { [FIELD_LOCKS]: next };
}

// ---------------------------------------------------------------- character slots

function characterLocks(settings) {
    return isObject(settings?.[CHARACTER_LOCKS]) ? settings[CHARACTER_LOCKS] : {};
}

export function characterLock(settings, index) {
    const lock = characterLocks(settings)[String(index)];
    return isObject(lock) ? lock : null;
}

/** The character a locked slot holds, or null (not locked, or next draw). */
export function heldCharacter(settings, index) {
    const key = characterLock(settings, index)?.key;
    return typeof key === 'string' && key ? key : null;
}

export function setCharacterLock(settings, index, locked, key = null) {
    const next = { ...characterLocks(settings) };
    if (locked) next[String(index)] = { key: typeof key === 'string' && key ? key : null };
    else delete next[String(index)];
    return { [CHARACTER_LOCKS]: next };
}

export function holdCharacter(settings, index, key) {
    const lock = characterLock(settings, index);
    if (!lock || lock.key === key) return null;
    return setCharacterLock(settings, index, true, key);
}

/** Locks of slots past `count` go (a removed slot takes its lock with it). */
export function pruneCharacterLocks(settings, count) {
    const locks = characterLocks(settings);
    const gone = Object.keys(locks).filter(index => !(Number(index) >= 0 && Number(index) < count));
    if (gone.length === 0) return null;
    const next = { ...locks };
    for (const index of gone) delete next[index];
    return { [CHARACTER_LOCKS]: next };
}

// ---------------------------------------------------------------- the AI answer

export function aiLock(settings) {
    const lock = settings?.[AI_LOCK];
    return isObject(lock) ? lock : null;
}

export function heldAiText(settings) {
    const text = aiLock(settings)?.text;
    return typeof text === 'string' && text !== '' ? text : null;
}

export function setAiLock(locked, text = null) {
    return { [AI_LOCK]: locked ? { text: typeof text === 'string' && text !== '' ? text : null } : null };
}

// ---------------------------------------------------------------- recipes

/** What an image's run drew, for its recipe: { fields: { [id]: { [part]: Draws } } } or null. */
export function cleanRunDraws(value) {
    if (!isObject(value) || !isObject(value.fields)) return null;
    const fields = {};
    for (const [id, parts] of Object.entries(value.fields)) {
        if (!isObject(parts)) continue;
        const clean = Object.fromEntries(Object.entries(parts).map(([part, draws]) => [part, cleanDraws(draws)]).filter(([, draws]) => draws));
        if (Object.keys(clean).length) fields[id] = clean;
    }
    return Object.keys(fields).length ? { fields } : null;
}

/**
 * The locks an image's recipe loads ("Use settings…"): every row that drew, locked on what
 * it drew, and the AI answer locked on the image's. An image from before the draws were
 * recorded gives the AI answer only (its Random characters are written in as they were).
 */
export function recipeLocks(run = {}) {
    const patch = {};
    const draws = cleanRunDraws(run?.draws);
    if (draws) patch[FIELD_LOCKS] = Object.fromEntries(Object.entries(draws.fields).map(([id, parts]) => [id, { draws: copy(parts) }]));
    const aiText = typeof run?.ai?.text === 'string' ? run.ai.text : '';
    if (aiText && run.ai.mode && run.ai.mode !== 'off') patch[AI_LOCK] = { text: aiText };
    return patch;
}
