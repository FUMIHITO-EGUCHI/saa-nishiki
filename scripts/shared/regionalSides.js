// Regional (left / right) side model for the prompt fields (pure, shared by the
// renderer and tests).
//
// While Regional Condition is on, every prompt unit belongs to one of three sides:
//   both  - written into the left and the right prompt (Common, Background, Style,
//           the shared Negative, custom fields marked "both")
//   left  - the left prompt only (Positive, Negative (left), custom fields marked
//           "left")
//   right - the right prompt only (Positive (right), Negative (right), custom
//           fields marked "right")
// With Regional off the side is ignored and the chain is the single ordered list.

import { STRUCTURAL_UNITS, normalizeCustomFields } from './promptFieldOrder.js';

export const SIDES = Object.freeze(['both', 'left', 'right']);

// Built-in units with a fixed side. `exclude` applies to everything and never joins a chain.
const BUILTIN_SIDES = Object.freeze({
    common: 'both',
    background: 'both',
    style: 'both',
    negative: 'both',
    positive: 'left',
    negative_left: 'left',
    positive_right: 'right',
    negative_right: 'right',
});

// Fields that only exist while Regional is on.
export const REGIONAL_ONLY_FIELDS = Object.freeze(['positive_right', 'negative_left', 'negative_right']);

export function normalizeSide(value) {
    return value === 'left' || value === 'right' ? value : 'both';
}

export function sideOf(id, customFields) {
    if (Object.hasOwn(BUILTIN_SIDES, id)) return BUILTIN_SIDES[id];
    const custom = normalizeCustomFields(customFields).find(field => field.id === id);
    return custom ? normalizeSide(custom.side) : 'both';
}

// Expands a chain order into the unit ids that make up one side's prompt, in chain
// order. Side-specific built-ins that are not part of the stored order follow their
// shared counterpart: positive_right after positive, negative_left / negative_right
// after negative. Structural units (views, ai, characters) are kept so the caller
// can splice in their text.
export function sideOrder(order, side, customFields) {
    const result = [];
    for (const id of Array.isArray(order) ? order : []) {
        if (STRUCTURAL_UNITS.has(id)) { result.push(id); continue; }
        if (id === 'positive') {
            if (side === 'left') result.push('positive');
            if (side === 'right') result.push('positive_right');
            continue;
        }
        if (id === 'negative') {
            result.push('negative');
            if (side === 'left') result.push('negative_left');
            if (side === 'right') result.push('negative_right');
            continue;
        }
        const unitSide = sideOf(id, customFields);
        if (unitSide === 'both' || unitSide === side) result.push(id);
    }
    return result;
}

// The settings that change places when the sides are swapped. Returns a patch
// (only the keys that move) to assign onto the flat settings object.
export function swapSidesPatch(settings = {}) {
    const patch = {};
    const pairs = [
        ['api_prompt', 'api_prompt_right'],
        ['api_neg_prompt_left', 'api_neg_prompt_right'],
        ['positive_weight_plans', 'positive_right_weight_plans'],
        ['positive_batch', 'positive_right_batch'],
        ['negative_left_weight_plans', 'negative_right_weight_plans'],
        ['negative_left_batch', 'negative_right_batch'],
        ['character_left', 'character_right'],
        ['regional_str_left', 'regional_str_right'],
        ['regional_option_left', 'regional_option_right'],
    ];
    for (const [left, right] of pairs) {
        if (!Object.hasOwn(settings, left) && !Object.hasOwn(settings, right)) continue;
        patch[left] = clone(settings[right]);
        patch[right] = clone(settings[left]);
    }
    if (Array.isArray(settings.prompt_custom_fields)) {
        patch.prompt_custom_fields = normalizeCustomFields(settings.prompt_custom_fields).map(field => {
            const side = normalizeSide(field.side);
            if (side === 'both') return field;
            return { ...field, side: side === 'left' ? 'right' : 'left' };
        });
    }
    return patch;
}

// Pre-Nishiki settings carried a "Swap Character" flag that swapped the assembled
// prompts at generation time. The flag is retired: swapping is now a data edit.
// A stored `true` is applied once here so the user keeps the layout they saw.
export function migrateRegionalSwap(settings) {
    if (!settings || settings.regional_swap !== true) return false;
    Object.assign(settings, swapSidesPatch(settings));
    settings.regional_swap = false;
    return true;
}

function clone(value) {
    if (Array.isArray(value)) return value.map(clone);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, clone(child)]));
    return value;
}
