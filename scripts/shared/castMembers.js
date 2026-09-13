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

/** The cast in slot order: `{ index (1-based), alias, key, weight, fieldId }`. */
export function castRoster(settings = {}, LANG = {}) {
    const slots = Array.isArray(settings?.character_slots) ? settings.character_slots.slice(0, MAX_CAST) : [];
    return slots.map((slot, i) => ({
        index: i + 1,
        alias: castAlias(slot, i, LANG),
        key: typeof slot?.key === 'string' ? slot.key : 'None',
        weight: Number.isFinite(Number(slot?.weight)) ? Number(slot.weight) : 1,
        fieldId: castFieldId(i + 1),
    }));
}

/**
 * The custom fields and positive order with one cast row per slot and the Action row:
 * cast rows are added for new slots (right after the characters block, in slot order),
 * renamed to the current alias, and dropped for slots that no longer exist; the Action
 * row is added at the end of the chain unless a field named Action already exists.
 * Returns the patch and whether anything changed.
 */
export function syncCastFields(settings = {}, LANG = {}) {
    const roster = castRoster(settings, LANG);
    const before = normalizeCustomFields(settings?.prompt_custom_fields);
    const wanted = new Set(roster.map(member => member.fieldId));
    const fields = before.filter(field => !isCastFieldId(field.id) || wanted.has(field.id)).map(field => ({ ...field }));
    const added = [];
    for (const member of roster) {
        const name = castLabel(member.alias);
        const existing = fields.find(field => field.id === member.fieldId);
        if (existing) {
            existing.name = name;
            existing.polarity = 'positive';
            delete existing.side;
        } else {
            fields.push({ id: member.fieldId, name, polarity: 'positive', text: '' });
            added.push(member.fieldId);
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
    return { prompt_custom_fields: fields, prompt_positive_order: order, changed };
}

/**
 * "@alias" references in an action, rewritten to "@<slot number>" for the LLM. Longer
 * aliases go first so "@姫様" is not eaten by "@姫"; a bare "@2" is left as it is.
 */
export function castReferences(action, roster = []) {
    let text = String(action ?? '');
    const members = [...roster].filter(member => member.alias).sort((a, b) => b.alias.length - a.alias.length);
    for (const member of members) {
        text = text.split(`@${member.alias}`).join(`@${member.index}`);
    }
    return text;
}
