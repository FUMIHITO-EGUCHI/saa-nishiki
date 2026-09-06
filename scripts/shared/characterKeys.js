// Character slot keys. A slot holds either a booru character (its key as in
// the character list) or an original character; the latter is stored with an
// `oc:` prefix so both kinds share one slot list, one settings shape and one
// picker (Characters card, regional Left / Right, presets).
//
//   'hatsune_miku'  -> character list entry
//   'oc:Alice'      -> original character "Alice" (data/original_character.json)
//   'Random' / 'oc:Random' -> a random pick from that kind; 'None' -> empty slot

export const ORIGINAL_KEY_PREFIX = 'oc:';

export function isOriginalKey(key) {
    return typeof key === 'string' && key.startsWith(ORIGINAL_KEY_PREFIX);
}

export function originalKey(name) {
    const text = String(name ?? '').trim();
    if (!text) return 'None';
    return isOriginalKey(text) ? text : `${ORIGINAL_KEY_PREFIX}${text}`;
}

// 'oc:Alice' -> 'Alice'; a non-original key comes back unchanged.
export function originalCharacterName(key) {
    return isOriginalKey(key) ? key.slice(ORIGINAL_KEY_PREFIX.length) : String(key ?? '');
}

export function isNoneKey(key) {
    return String(key ?? '').trim().toLowerCase() === 'none';
}
