// Artist slots: the Artist card holds up to three Danbooru artist tags, the same shape as
// a character slot, and they only exist for the Diffusion (Anima) model type. Pure
// functions shared by the renderer, the prompt builders and the tests.
//
// Anima reads an artist as "@name": lower case, spaces rather than underscores, and the
// parentheses inside a disambiguated name escaped so they are not read as emphasis
// (hammer_(sunset_beach) → @hammer \(sunset beach\)). A weight wraps the whole token,
// the leading "@" included, because that is what the model is trained on.

export const MAX_ARTIST_SLOTS = 3;
export const DEFAULT_ARTIST_SLOTS = 1;
export const ARTIST_PREFIX = '@';

// The card, and everything downstream of it, exists for Diffusion only. Checkpoint keeps
// its stored slots so switching back finds them again.
export function artistEnabled(settings = {}) {
    return settings?.api_model_type === 'Diffusion';
}

function coerceWeight(value) {
    const weight = Number.parseFloat(value);
    if (!Number.isFinite(weight) || weight <= 0) return 1;
    return Math.round(weight * 100) / 100;
}

function coerceKey(value) {
    const key = String(value ?? '').trim();
    return key.toLowerCase() === 'none' ? '' : key;
}

// Settings → the array the card renders. Always at least one slot, never more than three,
// never an entry that is not {key, weight}.
export function normalizeArtistSlots(value) {
    const list = Array.isArray(value) ? value : [];
    const slots = [];
    for (const entry of list.slice(0, MAX_ARTIST_SLOTS)) {
        const source = entry && typeof entry === 'object' ? entry : { key: entry };
        slots.push({ key: coerceKey(source.key), weight: coerceWeight(source.weight) });
    }
    while (slots.length < DEFAULT_ARTIST_SLOTS) slots.push({ key: '', weight: 1 });
    return slots;
}

// The artists actually going into a prompt: filled slots, in order, no duplicates.
export function filledArtistSlots(value) {
    const seen = new Set();
    const filled = [];
    for (const slot of normalizeArtistSlots(value)) {
        if (!slot.key) continue;
        const key = slot.key.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        filled.push(slot);
    }
    return filled;
}

// Danbooru spelling → what the model reads. Underscores become spaces, parentheses are
// escaped, and the "@" goes on before any weight wraps the token.
export function artistToken(key, weight = 1) {
    const name = coerceKey(key).replaceAll('_', ' ').trim();
    if (!name) return '';
    const escaped = name
        .replaceAll('\\', '\\\\')
        .replaceAll('(', String.raw`\(`)
        .replaceAll(')', String.raw`\)`);
    const token = `${ARTIST_PREFIX}${escaped}`;
    const value = coerceWeight(weight);
    return value === 1 ? token : `(${token}:${value})`;
}

// The whole unit's text, comma separated, ready to join the prompt chain. Empty when the
// model type is not Diffusion or no slot is filled.
export function artistPrompt(settings = {}) {
    if (!artistEnabled(settings)) return '';
    return filledArtistSlots(settings.artist_slots)
        .map(slot => artistToken(slot.key, slot.weight))
        .filter(Boolean)
        .join(', ');
}

// Tags that stop an artist signing the picture. Added at generation time while an artist
// is set, never stored in the user's own Negative field.
export const SIGNATURE_GUARD_TAGS = ['artist name', 'signature', 'watermark'];

export function signatureGuard(settings = {}) {
    if (!artistEnabled(settings) || settings?.artist_signature_guard === false) return '';
    return filledArtistSlots(settings.artist_slots).length > 0 ? SIGNATURE_GUARD_TAGS.join(', ') : '';
}
