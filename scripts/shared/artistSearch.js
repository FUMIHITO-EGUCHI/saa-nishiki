// Ranking for the artist picker's single search box. One typed word is matched against
// artist names, their aliases, and the tags each artist's profile says they draw, so
// "sakura" finds both the artists called sakura and the ones known for the Sakuragaoka
// uniform. Pure functions: the caller supplies the artist list and the profile map.

import { profileKey } from './artistProfiles.js';

export const NAME_GROUP = 'name';
export const TAG_GROUP = 'tag';

// How a name matched, best first. Tag hits rank below every name hit.
const PREFIX = 0;
const WORD_START = 1;
const SUBSTRING = 2;
const ALIAS = 3;

export function searchKey(value) {
    return String(value ?? '')
        .trim()
        .toLowerCase()
        .replace(/^@+/, '')
        .replaceAll(/\s+/g, '_');
}

function nameRank(name, query) {
    if (!query) return null;
    const index = name.indexOf(query);
    if (index < 0) return null;
    if (index === 0) return PREFIX;
    return name[index - 1] === '_' ? WORD_START : SUBSTRING;
}

function aliasRank(aliases, query) {
    for (const alias of aliases ?? []) {
        if (searchKey(alias).includes(query)) return ALIAS;
    }
    return null;
}

// Where the query sits inside a string, so the caller can highlight it. Null when absent.
export function matchRange(value, query) {
    const haystack = searchKey(value);
    const needle = searchKey(query);
    if (!needle) return null;
    const start = haystack.indexOf(needle);
    return start < 0 ? null : { start, length: needle.length };
}

function entryFor(artist, profiles) {
    const key = searchKey(artist.tag);
    const profile = profiles?.get?.(profileKey(key)) ?? null;
    return {
        key,
        tag: artist.tag,
        heat: Number(artist.heat) || 0,
        posts: profile?.posts ?? 0,
        draws: profile?.draws ?? [],
        series: profile?.series ?? [],
        aliases: artist.aliases ?? [],
    };
}

/**
 * Rank the artists for one query.
 *
 * `artists` is [{tag, heat, aliases}], `profiles` the Map from parseArtistProfiles.
 * With no query the list is what the picker shows on open: favourites, then the artists
 * used recently, then the busiest. With a query it is the name hits followed by the
 * artists whose profile carries the word, each with the tags that matched.
 */
export function rankArtists(query, { artists = [], profiles = null, favorites = [], recent = [], limit = 50 } = {}) {
    const needle = searchKey(query);
    const favorite = new Set(favorites.map(searchKey));
    const isFavorite = key => favorite.has(key);

    if (!needle) {
        const recentKeys = recent.map(searchKey);
        const byKey = new Map(artists.map(artist => [searchKey(artist.tag), artist]));
        const groups = [];
        const taken = new Set();
        const push = (group, keys) => {
            const entries = [];
            for (const key of keys) {
                if (taken.has(key)) continue;
                const artist = byKey.get(key);
                if (!artist) continue;
                taken.add(key);
                entries.push({ ...entryFor(artist, profiles), group, favorite: isFavorite(key), matchedTags: [] });
            }
            if (entries.length > 0) groups.push({ group, entries });
        };
        push('favorite', [...favorite]);
        push('recent', recentKeys);
        push('top', artists
            .slice()
            .sort((a, b) => (Number(b.heat) || 0) - (Number(a.heat) || 0))
            .slice(0, limit)
            .map(artist => searchKey(artist.tag)));
        return groups;
    }

    const names = [];
    const tags = [];
    for (const artist of artists) {
        const entry = entryFor(artist, profiles);
        const rank = nameRank(entry.key, needle) ?? aliasRank(entry.aliases, needle);
        if (rank !== null) {
            names.push({ ...entry, group: NAME_GROUP, rank, favorite: isFavorite(entry.key), matchedTags: [] });
            continue;
        }
        const matchedTags = entry.draws.filter(draw => searchKey(draw.tag).includes(needle));
        if (matchedTags.length > 0) {
            const best = Math.max(...matchedTags.map(draw => draw.percent || 0));
            tags.push({ ...entry, group: TAG_GROUP, rank: -best, favorite: isFavorite(entry.key), matchedTags });
        }
    }

    // Better match first; within the same match, the artist with more posts behind it.
    const order = (a, b) => a.rank - b.rank || b.heat - a.heat;
    names.sort(order);
    tags.sort(order);

    const groups = [];
    if (names.length > 0) groups.push({ group: NAME_GROUP, entries: names.slice(0, limit) });
    if (tags.length > 0) groups.push({ group: TAG_GROUP, entries: tags.slice(0, limit) });
    return groups;
}

// Flat list, for callers that only want "the next result" (keyboard navigation).
export function flattenGroups(groups = []) {
    return groups.flatMap(group => group.entries);
}
