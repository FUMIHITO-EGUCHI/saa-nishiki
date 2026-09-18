// The translation of a dictionary entry (pure, shared by the tag backend and its tests):
// the language file's own text for the tag, which the backend keeps on the entry as
// `translation` (tagAutoComplete_backend.js parseTranslateData). The merged `aliases`
// field is not a source: the CSV's English synonyms in it can be non-ASCII themselves
// ("legendary_pokémon", "cookie☆") and a translation with a comma in it would be cut
// there. '' when the language file has no line for the tag (or no file is loaded).

export function translationOf(entry) {
    return typeof entry?.translation === 'string' ? entry.translation.trim() : '';
}

// Dictionary key of a chip value: lower case, prompt escapes off ("\(" → "("), spaces as
// underscores (the CSV's form).
export function aliasKey(value) {
    return String(value ?? '').trim().replaceAll(/\\([\\()])/g, '$1').toLocaleLowerCase().replaceAll(/\s+/g, '_');
}

// { value: translation } for the given values from a Map/object of key -> entry
// ({ prompt, aliases, translation }); values with no entry or no translation map to ''.
export function aliasMapFor(entries, values = []) {
    const lookup = typeof entries?.get === 'function' ? key => entries.get(key) : key => entries?.[key];
    const result = {};
    for (const value of values) {
        if (typeof value !== 'string') continue;
        const entry = lookup(aliasKey(value));
        result[value] = translationOf(entry);
    }
    return result;
}
