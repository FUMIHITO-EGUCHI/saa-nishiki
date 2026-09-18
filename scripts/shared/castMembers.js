// The cast: one entry per character slot, each with a display alias and a prompt row
// of its own for the attribute tags (pure, shared by the renderer and tests).
//
// For the Diffusion model type (Anima) the picture is written as one paragraph and the
// LLM has to know which tags belong to which character. The tags of a character stay
// tags, in a prompt row labelled "@alias" that lives next to the other prompt fields
// (same rows as the LEFT / RIGHT ones), so the row order stays the order the paragraph
// follows. The rows are custom fields with a reserved id, `cf_cast<n>` for slot n, so
// they ride through the field order, the presets and the capsule editor unchanged; the
// field manager only refuses to rename or delete them, and hides them for Checkpoint.
//
// The Action refers to a character by its alias, "@姫", and the LLM receives the slot
// number instead, "@1": a random slot has no name to refer to, and a name in the action
// would tempt the LLM to copy it.

import { normalizeCustomFields, normalizeOrder } from './promptFieldOrder.js';

export const MAX_CAST = 6;
const CAST_ID = /^cf_cast([1-6])$/;
const ALIAS_MAX = 20;

export function castFieldId(index) {
    return `cf_cast${index}`;
}

/** Slot number (1-based) of a cast row id, 0 for any other id. */
export function castIndexOf(id) {
    const match = CAST_ID.exec(String(id ?? ''));
    return match ? Number(match[1]) : 0;
}

export function isCastFieldId(id) {
    return castIndexOf(id) > 0;
}

// The Action row: one sentence saying who does what to whom, referring to the cast
// by "@alias". It is kept for the Diffusion model type like the cast rows are (a user
// may still add Action fields of their own through the field editor for Checkpoint).
export const ACTION_FIELD_ID = 'cf_action';
export const ACTION_FIELD_NAME = 'Action';

export function isActionFieldId(id) {
    return id === ACTION_FIELD_ID;
}

/** A field that exists for the Diffusion model type only: a cast row or the Action row. */
export function isDiffusionFieldId(id) {
    return isCastFieldId(id) || isActionFieldId(id);
}

export function isActionNamed(field) {
    return /^action$/i.test(String(field?.name ?? '').trim());
}

/** Cast rows exist for the Diffusion model type only. */
export function castEnabled(settings = {}) {
    return settings?.api_model_type === 'Diffusion';
}

export function normalizeAlias(value) {
    return String(value ?? '').trim().replace(/\s+/g, ' ').slice(0, ALIAS_MAX);
}

/** The alias shown for a slot: the stored one, else "<word><n>" from the language file. */
export function castAlias(slot, index, LANG = {}) {
    const alias = normalizeAlias(slot?.alias);
    if (alias !== '') return alias;
    return `${LANG?.cast_default_alias ?? 'char'}${index + 1}`;
}

export function castLabel(alias) {
    return `@${alias}`;
}

/**
 * The cast in slot order: `{ index (1-based), alias, key, weight, fieldId }`. Two slots
 * never share an alias (both would become the same "@n"): a later duplicate falls back to
 * its default alias, and a default that a stored alias already took gets "_<n>".
 */
export function castRoster(settings = {}, LANG = {}) {
    const slots = Array.isArray(settings?.character_slots) ? settings.character_slots.slice(0, MAX_CAST) : [];
    const used = new Set();
    return slots.map((slot, i) => {
        let alias = castAlias(slot, i, LANG);
        if (used.has(alias)) alias = castAlias({}, i, LANG);
        while (used.has(alias)) alias = `${alias}_${i + 1}`;
        used.add(alias);
        return {
            index: i + 1,
            alias,
            key: typeof slot?.key === 'string' ? slot.key : 'None',
            weight: Number.isFinite(Number(slot?.weight)) ? Number(slot.weight) : 1,
            fieldId: castFieldId(i + 1),
        };
    });
}

// A reference is "@" plus an alias, or "@" plus a slot number. An alias (or number) that
// ends in an ASCII letter, digit or underscore only counts when the next character is not
// one of those, so "@Ann" is not the start of "@Annabel"; Japanese has no word breaks, so
// an alias ending in any other character counts wherever it stands ("@姫を").
const ASCII_WORD = /[A-Za-z0-9_]/;

function endsCleanly(name, next) {
    return !(ASCII_WORD.test(name.at(-1) ?? '') && ASCII_WORD.test(next));
}

/**
 * Walks `text` once, left to right, and hands each reference to `replace`: `{ alias }` for
 * the longest alias in `aliases` that starts at the "@", else `{ number }`. `replace` returns
 * the text to put in its place, or null to keep it as written. `verbatim` strings (an
 * Artist token such as "@wlop") are copied through untouched, at the same word boundary
 * the aliases use, so an artist "@ask" does not swallow the reference "@askari". A
 * replacement is never scanned again, so "@2" -> "@1" cannot be rewritten a second time.
 */
function rewriteCastReferences(text, aliases = [], replace = () => null, { verbatim = [] } = {}) {
    const source = String(text ?? '');
    const names = [...new Set(aliases)].filter(Boolean).sort((a, b) => b.length - a.length);
    const kept = [...new Set(verbatim)].filter(token => String(token).startsWith('@')).sort((a, b) => b.length - a.length);
    let out = '';
    let i = 0;
    while (i < source.length) {
        const at = source.indexOf('@', i);
        if (at < 0) { out += source.slice(i); break; }
        out += source.slice(i, at);
        const token = kept.find(value => source.startsWith(value, at) && endsCleanly(value, source.charAt(at + value.length)));
        if (token) { out += token; i = at + token.length; continue; }
        const rest = source.slice(at + 1);
        const alias = names.find(name => rest.startsWith(name) && endsCleanly(name, rest.charAt(name.length)));
        const number = alias === undefined ? /^\d+/.exec(rest)?.[0] : undefined;
        const match = alias ?? (number && endsCleanly(number, rest.charAt(number.length)) ? number : undefined);
        if (match === undefined) { out += '@'; i = at + 1; continue; }
        const value = replace(alias !== undefined ? { alias } : { number: Number(number) });
        out += value ?? `@${match}`;
        i = at + 1 + match.length;
    }
    return out;
}

/**
 * The custom fields and positive order with one cast row per slot and the Action row:
 * cast rows are added for new slots (right after the characters block, in slot order),
 * renamed to the current alias, and dropped for slots that no longer exist; the Action
 * row is added at the end of the chain unless a field named Action already exists.
 * A renamed row carries its old "@alias" in its name: the Action text follows the rename
 * (a changed alias, or a default alias in another language). `stash` (row id -> field)
 * gives a new row the text of the row a removed slot left behind; the dropped rows come
 * back as `dropped`. Returns the patch and whether anything changed.
 */
export function syncCastFields(settings = {}, LANG = {}, { stash = null } = {}) {
    const roster = castRoster(settings, LANG);
    const before = normalizeCustomFields(settings?.prompt_custom_fields);
    const wanted = new Set(roster.map(member => member.fieldId));
    const dropped = before.filter(field => isCastFieldId(field.id) && !wanted.has(field.id));
    const fields = before.filter(field => !isCastFieldId(field.id) || wanted.has(field.id)).map(field => ({ ...field }));
    const added = [];
    const renamed = new Map();   // old alias -> new alias
    const kept = new Set();      // aliases a row still answers to
    for (const member of roster) {
        const name = castLabel(member.alias);
        const existing = fields.find(field => field.id === member.fieldId);
        if (existing) {
            const previous = String(existing.name ?? '');
            if (previous === name) kept.add(member.alias);
            else if (previous.startsWith('@') && previous.length > 1) renamed.set(previous.slice(1), member.alias);
            existing.name = name;
            existing.polarity = 'positive';
            delete existing.side;
        } else {
            const stashed = stash?.[member.fieldId];
            fields.push(stashed ? { ...stashed, id: member.fieldId, name, polarity: 'positive' } : { id: member.fieldId, name, polarity: 'positive', text: '' });
            added.push(member.fieldId);
        }
    }
    // an old alias a row kept (two slots stored with one alias) still means that row's slot
    for (const alias of kept) renamed.delete(alias);
    if (renamed.size > 0) {
        for (const field of fields) {
            if (!isActionNamed(field) || typeof field.text !== 'string') continue;
            field.text = rewriteCastReferences(field.text, [...renamed.keys()], ({ alias }) => (alias ? `@${renamed.get(alias)}` : null));
        }
    }
    let actionAdded = false;
    const action = fields.find(field => field.id === ACTION_FIELD_ID);
    if (action) {
        action.name = ACTION_FIELD_NAME;
        action.polarity = 'positive';
        delete action.side;
    } else if (!fields.some(field => field.polarity === 'positive' && isActionNamed(field))) {
        fields.push({ id: ACTION_FIELD_ID, name: ACTION_FIELD_NAME, polarity: 'positive', text: '' });
        actionAdded = true;
    }
    let order = normalizeOrder(settings?.prompt_positive_order, 'positive', fields)
        .filter(id => !added.includes(id) && !(actionAdded && id === ACTION_FIELD_ID));
    if (added.length) {
        // new rows follow the characters block, after any cast row already there
        let at = order.indexOf('characters');
        for (const id of order) if (isCastFieldId(id)) at = Math.max(at, order.indexOf(id));
        order.splice(at + 1, 0, ...added);
    }
    if (actionAdded) order.push(ACTION_FIELD_ID); // the sentence follows the tags
    const changed = JSON.stringify(fields) !== JSON.stringify(before)
        || JSON.stringify(order) !== JSON.stringify(normalizeOrder(settings?.prompt_positive_order, 'positive', before));
    return { prompt_custom_fields: fields, prompt_positive_order: order, changed, dropped };
}

/**
 * "@alias" references in an action, rewritten to "@<slot number>" for the LLM. Longer
 * aliases go first so "@姫様" is not eaten by "@姫"; a bare "@2" is left as it is.
 */
export function castReferences(action, roster = []) {
    const byAlias = new Map([...roster].filter(member => member.alias).map(member => [member.alias, member.index]));
    return rewriteCastReferences(action, [...byAlias.keys()], ({ alias }) => (alias ? `@${byAlias.get(alias)}` : null));
}

/**
 * The same references with the "@" dropped, for text that goes to the image model as it is
 * (Prose off, or its paragraph rejected): Anima reads "@name" as an artist, so "@姫" and a
 * bare "@2" become the alias. `verbatim` are the Artist tokens, which keep their "@".
 */
export function castPlainReferences(text, roster = [], { verbatim = [] } = {}) {
    const members = [...roster].filter(member => member.alias);
    const byIndex = new Map(members.map(member => [member.index, member.alias]));
    return rewriteCastReferences(text, members.map(member => member.alias),
        ({ alias, number }) => alias ?? byIndex.get(number) ?? null, { verbatim });
}

/**
 * References in an action (after `castReferences`) that name no character the LLM gets:
 * an "@word" that is no alias, or "@n" with no entry in `refs` ("@1", ...).
 */
export function unknownCastReferences(action, refs = []) {
    const known = new Set(refs);
    const unknown = [];
    for (const match of String(action ?? '').matchAll(/@[^\s@,、。.!?;:()（）]+/gu)) {
        const ref = /^@\d+(?![A-Za-z0-9_])/.exec(match[0])?.[0];
        if (ref ? !known.has(ref) : true) unknown.push(ref ?? match[0]);
    }
    return [...new Set(unknown)];
}
