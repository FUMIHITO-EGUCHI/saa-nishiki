// The Prompts card remembered per model type (pure, shared by the renderer and tests).
// A checkpoint (Illustrious) wants tag lists; a diffusion model (Anima) wants a cast, an
// action sentence and an artist. Switching used to empty the card, which threw away
// whatever the other type had. Instead the card is stored under the type being left and
// put back when that type is entered again.
//
// The store lives in `model_type_prompts`: { Checkpoint: {...}, Diffusion: {...} }. It
// sits in the app section, like `model_type_generation`, so an unrelated undo cannot
// rewind it.

import { MODEL_TYPES } from './modelTypeSettings.js';
import { PROMPT_PLAN_KEYS, PROMPT_TEXT_KEYS, clearedPromptPatch } from './promptReset.js';
import { normalizeCustomFields } from './promptFieldOrder.js';

// Everything the card holds: the texts, the per-image weight plans, the View row, the
// row order and the custom rows themselves, plus the two slot lists the cards above it
// own (a Diffusion cast and its artists are part of "the prompt" as far as a switch
// is concerned).
export const PROMPT_STATE_KEYS = Object.freeze([
    ...PROMPT_TEXT_KEYS,
    ...PROMPT_PLAN_KEYS,
    'view_angle', 'view_camera',
    'prompt_custom_fields', 'prompt_positive_order', 'prompt_negative_order',
    'prompt_field_muted', 'prompt_field_collapsed',
    'character_slots', 'artist_slots',
]);

function clone(value) {
    return value === undefined ? undefined : structuredClone(value);
}

function isType(value) {
    return MODEL_TYPES.includes(value);
}

export function snapshotPrompts(settings = {}) {
    const snapshot = {};
    for (const key of PROMPT_STATE_KEYS) {
        if (Object.hasOwn(settings, key)) snapshot[key] = clone(settings[key]);
    }
    return snapshot;
}

// The store with `type`'s entry replaced by a snapshot of the card as it stands.
export function rememberPrompts(store, type, settings = {}) {
    const next = store && typeof store === 'object' ? { ...store } : {};
    if (isType(type)) next[type] = snapshotPrompts(settings);
    return next;
}

// The patch to apply when entering `type`: what was stored for it, else an empty card.
// The first switch into a type has nothing stored, so it still starts clean — the old
// behaviour, now only where it makes sense.
export function promptsFor(store, type, settings = {}) {
    const stored = store && typeof store === 'object' && isType(type) ? store[type] : null;
    if (!stored || typeof stored !== 'object') return clearedPromptPatch(settings);
    const patch = {};
    for (const key of PROMPT_STATE_KEYS) {
        if (Object.hasOwn(stored, key)) patch[key] = clone(stored[key]);
    }
    // A stored card can predate a custom row the user added since; normalizing keeps the
    // shape the field manager expects rather than trusting whatever was written.
    if (Object.hasOwn(patch, 'prompt_custom_fields')) {
        patch.prompt_custom_fields = normalizeCustomFields(patch.prompt_custom_fields);
    }
    return patch;
}

// Whether entering `type` would restore something rather than clear the card.
export function hasStoredPrompts(store, type) {
    return Boolean(store && typeof store === 'object' && isType(type) && store[type]);
}
