// data/character_works.json: which works (Danbooru copyright tags) a character
// belongs to, and the works' names in other languages. Built offline by
// scripts/buildCharacterWorks.mjs; the picker searches and shows them.
//
//   { characters: { 'kaga (kancolle)': ['kantai collection'] },
//     works: { 'kantai collection': { en: 'kantai collection', ja: '艦隊これくしょん', aliases: ['艦これ', …] } } }

const MAX_ALIASES = 12;

export function worksOf(characterWorks, tag) {
    const list = characterWorks?.characters?.[String(tag ?? '').trim()];
    return Array.isArray(list) ? list.filter(work => typeof work === 'string' && work) : [];
}

// The title to show for a work in the UI language: Japanese when known, else
// the tag itself ("fate/grand order").
export function workTitle(characterWorks, work, language = 'en-US') {
    const entry = characterWorks?.works?.[work];
    if (language === 'ja-JP' && typeof entry?.ja === 'string' && entry.ja.trim()) return entry.ja.trim();
    return typeof entry?.en === 'string' && entry.en.trim() ? entry.en.trim() : String(work ?? '');
}

export function characterWorkTitles(characterWorks, tag, language = 'en-US') {
    return worksOf(characterWorks, tag).map(work => workTitle(characterWorks, work, language));
}

// Everything a work can be searched by: the tag, its Japanese title and the
// Danbooru other names (Japanese, Chinese, Korean and abbreviations).
export function characterWorkSearchTerms(characterWorks, tag) {
    const terms = new Set();
    for (const work of worksOf(characterWorks, tag)) {
        terms.add(work);
        const entry = characterWorks?.works?.[work];
        if (typeof entry?.en === 'string') terms.add(entry.en);
        if (typeof entry?.ja === 'string') terms.add(entry.ja);
        for (const alias of (Array.isArray(entry?.aliases) ? entry.aliases : []).slice(0, MAX_ALIASES)) terms.add(alias);
    }
    return [...terms].map(term => String(term).trim()).filter(Boolean);
}
