// Related-tag dictionary helpers shared by the build script (scripts/buildTagRelated.mjs),
// the main-process backend and the tests. Pure functions only.
//
// Dictionary line format (data/tag_related.txt, one line per base tag):
//   base_tag<TAB>neighbour:score neighbour:score ...
// `score` is the normalized PMI × 1000 rounded to an integer (see npmi below), neighbours
// are sorted by score descending. Tags use Danbooru spelling (underscores).

export const RELATED_SCORE_SCALE = 1000;

// Prompt text → dictionary key: weight / disabled markers off, spaces → underscores.
export function lookupKey(value) {
    let token = String(value ?? '').trim();
    if (token.startsWith('~')) token = token.slice(1).trim();
    const weighted = /^\((.*):\s*(-?(?:\d+(?:\.\d+)?|\.\d+))\)$/.exec(token);
    if (weighted) token = weighted[1].trim();
    return token.toLowerCase().replaceAll(/\s+/g, '_');
}

// The word a tag "belongs to": the last underscore-separated part (long_hair → hair,
// smile → smile). Single-character trailing parts (e.g. "v") are kept as they are.
export function familyWord(tag) {
    const parts = lookupKey(tag).split('_').filter(Boolean);
    return parts.length === 0 ? '' : parts.at(-1);
}

export function jaccard(countA, countB, both) {
    const union = Number(countA) + Number(countB) - Number(both);
    if (!(union > 0)) return 0;
    return Number(both) / union;
}

// Normalized pointwise mutual information in [-1, 1]: 1 = the tags only ever appear
// together, 0 = independent, < 0 = they avoid each other. `total` is the post count.
export function npmi(countA, countB, both, total) {
    const a = Number(countA);
    const b = Number(countB);
    const ab = Number(both);
    const n = Number(total);
    if (!(a > 0) || !(b > 0) || !(ab > 0) || !(n > 0)) return 0;
    const pab = Math.min(1, ab / n);
    if (pab >= 1) return 1;
    const pmi = Math.log((ab * n) / (a * b));
    return pmi / -Math.log(pab);
}

export function formatRelatedLine(tag, entries = []) {
    const body = entries
        .map(entry => `${entry.tag}:${Math.round(Number(entry.score) || 0)}`)
        .join(' ');
    return `${tag}\t${body}`;
}

export function parseRelatedLine(line) {
    const raw = String(line ?? '');
    const tab = raw.indexOf('\t');
    if (tab <= 0) return null;
    const tag = raw.slice(0, tab).trim();
    const related = [];
    for (const part of raw.slice(tab + 1).trim().split(' ')) {
        if (!part) continue;
        const colon = part.lastIndexOf(':');
        if (colon <= 0) continue;
        const score = Number.parseInt(part.slice(colon + 1), 10);
        if (!Number.isFinite(score)) continue;
        related.push({ tag: part.slice(0, colon), score });
    }
    return { tag, related };
}

// Same-family candidates from the autocomplete tag list: tags that contain `word` as a
// whole underscore-separated part (hair → long_hair, hair_ornament, …), most used first.
// `candidates` are { prompt, heat } like tagAutoComplete_backend's entries.
export function familyMatches(word, candidates = [], options = {}) {
    const { limit = 20, exclude = new Set(), allowGroups = null } = options;
    const target = lookupKey(word);
    if (!target) return [];
    const out = [];
    for (const candidate of candidates) {
        const prompt = String(candidate?.prompt ?? '');
        if (!prompt || exclude.has(prompt)) continue;
        if (allowGroups && !allowGroups.has(Number(candidate.group))) continue;
        if (!prompt.includes(target)) continue;
        if (!prompt.split('_').includes(target)) continue;
        out.push({ tag: prompt, count: Number(candidate.heat) || 0 });
    }
    out.sort((a, b) => b.count - a.count);
    return out.slice(0, limit);
}

// Keeps the strongest `limit` entries of a neighbour list (used while streaming pairs).
export function trimTop(entries, limit) {
    if (entries.length <= limit) return entries;
    entries.sort((a, b) => b.score - a.score);
    entries.length = limit;
    return entries;
}
