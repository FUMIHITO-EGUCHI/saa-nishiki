// The locks at run time (the rules are scripts/shared/promptLocks.js): what each random
// source drew last, the draws of the image being built, and the lock switches.
//
// The generate paths call drawField / drawCharacter / drawAi where a source draws; each
// records what it drew for the image (its recipe) and as "last" (what a lock holds when it
// is switched on), and a locked source holds what it drew. The rows and slots draw their
// lock buttons from here (promptLocksUi.js), redrawn on LOCKS_CHANGED_EVENT.

import {
    createDrawRecord, describePartDraws, fieldLock, hasRandomSource, heldAiText, heldCharacter, heldFieldDraws,
    holdCharacter, holdFieldDraws, isFieldLocked, isListRandom, aiLock, characterLock, pruneCharacterLocks,
    setAiLock, setCharacterLock, setFieldLock, drawsEachImage, pruneFieldLocks,
} from '../shared/promptLocks.js';
import { isOriginalKey } from '../shared/characterKeys.js';

export const LOCKS_CHANGED_EVENT = 'saa-locks-changed';
const CAT = '[promptLocks]';

const last = {
    fields: new Map(),      // row id -> { [part]: Draws } of the last image that drew there
    characters: new Map(),  // slot index -> the key a Random slot drew last
    ai: null,               // the last AI answer
};

const settings = () => globalThis.globalSettings ?? {};

// A draw the run holds is not an edit: kept out of undo. A switch the person flips is one.
function write(patch, { edit = false } = {}) {
    if (!patch) return;
    const target = globalThis.globalSettings;
    if (!target) return;
    const assign = () => { for (const [key, value] of Object.entries(patch)) target[key] = value; };
    const history = globalThis.editHistory;
    if (!edit && history?.suspendRecording && !history.isRecordingSuspended?.()) {
        history.suspendRecording(assign).catch(error => console.error(CAT, 'hold failed', error));
    } else {
        assign();
    }
}

let notifyQueued = false;
function changed() {
    if (notifyQueued || typeof document === 'undefined') return;
    notifyQueued = true;
    queueMicrotask(() => {
        notifyQueued = false;
        document.dispatchEvent(new CustomEvent(LOCKS_CHANGED_EVENT));
    });
}

/** The draws one image makes, for its recipe: { fields: { [id]: { [part]: Draws } } }. */
export function beginImageDraws() {
    return { fields: {} };
}

/**
 * A prompt row's text with its random sources drawn. Unlocked, they draw as they always
 * did; locked, they take what the row holds for `part` (a source it holds nothing for
 * draws and is held from then on). `list` names the row's view list when the whole row
 * may be `random` (Background / Style; `drawList` picks from it). `wildcards` and
 * `choices` are replaceWildcardsAsync and processRandomString (generate.js).
 */
export async function drawField(id, text, { part = 'left', list = false, seed, image = null, drawList = () => '', wildcards, choices } = {}) {
    const value = String(text ?? '');
    const locked = isFieldLocked(settings(), id);
    if (!hasRandomSource(value, { list })) {
        // nothing draws here any more: nothing to hold either (the lock itself stays)
        last.fields.delete(id);
        if (locked) write(holdFieldDraws(settings(), id, part, null));
        return value;
    }
    const record = createDrawRecord(locked ? heldFieldDraws(settings(), id, part) : null);
    let out = value;
    if (list && isListRandom(out)) out = record.list(drawList);
    out = await wildcards(out, seed, record);
    out = choices(out, record);
    const draws = record.result();
    last.fields.set(id, { ...last.fields.get(id), [part]: draws });
    if (image) image.fields[id] = { ...image.fields[id], [part]: draws };
    if (locked) write(holdFieldDraws(settings(), id, part, draws));
    changed();
    return out;
}

/** A Random slot's held character, when it is locked and holds one of this kind (standard / original). */
export function heldCharacterKey(index, { original = false } = {}) {
    const key = heldCharacter(settings(), index);
    if (!key || isOriginalKey(key) !== original) return null;
    return key;
}

/** What a Random slot drew: remembered, and held when the slot is locked. */
export function noteCharacter(index, key) {
    if (typeof key !== 'string' || !key || key === 'None') return;
    last.characters.set(index, key);
    write(holdCharacter(settings(), index, key));
    changed();
}

/**
 * The AI answer for a job: the held one when the AI prompt is locked and holds one, else
 * `request()` (getAiPromptResult), whose answer a lock that holds nothing yet keeps.
 */
export async function drawAi(request, { role = 0, aiInterface = 'None' } = {}) {
    const off = Number(role) === 0 || String(role).toLowerCase() === 'none' || String(aiInterface).toLowerCase() === 'none';
    if (off) return request();
    const lock = aiLock(settings());
    const held = lock ? heldAiText(settings()) : null;
    if (held !== null) return { content: held, fresh: false, source: 'locked' };
    const result = await request();
    if (typeof result?.content === 'string' && result.content !== '') {
        last.ai = result.content;
        if (lock) write(setAiLock(true, result.content));
        changed();
    }
    return result;
}

// ---------------------------------------------------------------- the switches

export function isLocked(id) {
    return isFieldLocked(settings(), id);
}

/** A row's lock: on, holding what it drew last (or the next draw); off. */
export function toggleFieldLock(id) {
    const locked = isFieldLocked(settings(), id);
    write(setFieldLock(settings(), id, !locked, locked ? null : last.fields.get(id) ?? null), { edit: true });
    changed();
}

export function toggleCharacterLock(index) {
    const locked = characterLock(settings(), index) !== null;
    write(setCharacterLock(settings(), index, !locked, locked ? null : last.characters.get(index) ?? null), { edit: true });
    changed();
}

export function toggleAiLock() {
    const locked = aiLock(settings()) !== null;
    write(setAiLock(!locked, locked ? null : last.ai), { edit: true });
    changed();
}

/** A deleted row takes its lock with it. */
export function forgetField(id) {
    last.fields.delete(id);
    const ids = Object.keys(settings().prompt_locks ?? {}).filter(other => other !== id);
    write(pruneFieldLocks(settings(), ids), { edit: true });
}

/** Slots past `count` are gone, and their locks with them. */
export function pruneCharacters(count) {
    for (const index of [...last.characters.keys()]) if (index >= count) last.characters.delete(index);
    write(pruneCharacterLocks(settings(), count));
}

// ---------------------------------------------------------------- what the UI shows

/** A row's lock state and what it drew (held when locked, else the last draw): { locked, values }. */
export function fieldState(id) {
    const lock = fieldLock(settings(), id);
    return { locked: lock !== null, values: describePartDraws(lock ? lock.draws : last.fields.get(id)) };
}

/** A slot's lock state and the key it drew (held when locked, else the last draw). */
export function characterState(index) {
    const lock = characterLock(settings(), index);
    const key = lock ? (typeof lock.key === 'string' ? lock.key : null) : (last.characters.get(index) ?? null);
    return { locked: lock !== null, key };
}

export function aiState() {
    const lock = aiLock(settings());
    return { locked: lock !== null, text: lock ? heldAiText(settings()) : last.ai };
}

/**
 * Something in the prompt draws anew for every image even with the seed fixed: an unlocked
 * row with a "{a|b}" (or a wildcard, with Wildcard seed on), or an unlocked AI prompt that
 * asks the AI for each image. `rows` is [{ id, text }] of the rows that go into the prompt.
 */
export function somethingVaries(rows, { freshWildcards = false, aiRole = 0, aiInterface = 'None' } = {}) {
    for (const row of rows) {
        if (isFieldLocked(settings(), row.id)) continue;
        if (drawsEachImage(row.text, { freshWildcards })) return true;
    }
    const aiOn = Number(aiRole) === 2 && String(aiInterface).toLowerCase() !== 'none';
    return aiOn && aiLock(settings()) === null;
}

export function setupPromptLocks() {
    globalThis.promptLocks = {
        fieldState, characterState, aiState, toggleFieldLock, toggleCharacterLock, toggleAiLock,
        isLocked, forgetField, pruneCharacters, somethingVaries,
    };
    return globalThis.promptLocks;
}
