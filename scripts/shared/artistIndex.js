// The artist half of the merged tag dictionary. data/danbooru_e621_merged.csv holds every
// tag as `tag,category,heat,"alias,alias"`; category 1 is a Danbooru artist. The picker
// searches these rows, so they are parsed once and kept as {tag, heat, aliases}.
//
// e621 artists (category 8) are deliberately left out: the Anima models are trained on
// Danbooru spellings, and the two sets overlap under different names.

export const DANBOORU_ARTIST_CATEGORY = 1;

// One CSV line. The alias field is quoted and may hold commas, so it is taken whole.
export function parseArtistRow(line) {
    const raw = String(line ?? '');
    const first = raw.indexOf(',');
    const second = raw.indexOf(',', first + 1);
    if (first <= 0 || second <= first) return null;
    const category = Number.parseInt(raw.slice(first + 1, second), 10);
    if (category !== DANBOORU_ARTIST_CATEGORY) return null;
    const tag = raw.slice(0, first).trim();
    if (!tag) return null;
    const third = raw.indexOf(',', second + 1);
    const heat = Number.parseInt(third < 0 ? raw.slice(second + 1) : raw.slice(second + 1, third), 10);
    const aliasField = third < 0 ? '' : raw.slice(third + 1).trim().replace(/^"|"$/g, '');
    const aliases = aliasField ? aliasField.split(',').map(alias => alias.trim()).filter(Boolean) : [];
    return { tag, heat: Number.isFinite(heat) ? heat : 0, aliases };
}

export function parseArtistIndex(text) {
    const artists = [];
    for (const line of String(text ?? '').split('\n')) {
        if (!line.trim()) continue;
        const artist = parseArtistRow(line);
        if (artist) artists.push(artist);
    }
    return artists;
}
