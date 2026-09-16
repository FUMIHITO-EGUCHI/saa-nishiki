// Artist profile helpers shared by the build script (scripts/buildArtistProfiles.mjs),
// the main-process backend and the tests. Pure functions only.
//
// Profile line format (data/artist_profiles.txt, one line per artist tag):
//   artist_tag<TAB>post_count<TAB>tag:pct,tag:pct,...<TAB>series:pct,series:pct,...
// `pct` is the share of that artist's posts carrying the tag, rounded to a whole percent.
// The drawn tags are ordered by how far they beat the site-wide rate (see profileLift),
// the series by share. Tags keep Danbooru spelling (underscores).

// Prompt text or display name → profile key: lower case, spaces → underscores, the
// leading "@" an Anima prompt uses stripped.
export function profileKey(value) {
    let token = String(value ?? '').trim();
    if (token.startsWith('@')) token = token.slice(1).trim();
    return token.toLowerCase().replaceAll(/\s+/g, '_');
}

// How much more often this artist uses a tag than the site as a whole. 1 = the site
// average, 2 = twice as often. Mega tags (1girl, solo) sit near 1 and are dropped.
export function profileLift(frequency, tagPostCount, totalPosts) {
    const freq = Number(frequency);
    const tagCount = Number(tagPostCount);
    const total = Number(totalPosts);
    if (!(freq > 0) || !(tagCount > 0) || !(total > 0)) return 0;
    const siteShare = Math.min(1, tagCount / total);
    if (!(siteShare > 0)) return 0;
    return freq / siteShare;
}

function formatEntries(entries = []) {
    return entries
        .map(entry => `${entry.tag}:${Math.max(0, Math.round(Number(entry.percent) || 0))}`)
        .join(',');
}

function parseEntries(text) {
    const entries = [];
    for (const part of String(text ?? '').split(',')) {
        const token = part.trim();
        if (!token) continue;
        const colon = token.lastIndexOf(':');
        if (colon <= 0) continue;
        const tag = token.slice(0, colon).trim();
        const percent = Number.parseInt(token.slice(colon + 1), 10);
        if (!tag || !Number.isFinite(percent)) continue;
        entries.push({ tag, percent });
    }
    return entries;
}

export function formatArtistProfileLine({ artist, posts = 0, draws = [], series = [] } = {}) {
    const count = Math.max(0, Math.round(Number(posts) || 0));
    return `${artist}\t${count}\t${formatEntries(draws)}\t${formatEntries(series)}`;
}

export function parseArtistProfileLine(line) {
    const parts = String(line ?? '').split('\t');
    if (parts.length < 2) return null;
    const artist = parts[0].trim();
    if (!artist) return null;
    const posts = Number.parseInt(parts[1], 10);
    return {
        artist,
        posts: Number.isFinite(posts) ? posts : 0,
        draws: parseEntries(parts[2]),
        series: parseEntries(parts[3]),
    };
}

// Whole file → Map keyed by profileKey, so a lookup can take the prompt spelling.
export function parseArtistProfiles(text) {
    const profiles = new Map();
    for (const line of String(text ?? '').split('\n')) {
        if (!line.trim()) continue;
        const profile = parseArtistProfileLine(line);
        if (profile) profiles.set(profileKey(profile.artist), profile);
    }
    return profiles;
}
