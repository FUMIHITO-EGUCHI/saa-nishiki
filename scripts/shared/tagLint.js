// Which capsule values the tag dictionary can vouch for (pure, shared by the renderer,
// the tag backend and tests).
//
// SDXL anime checkpoints learned Danbooru tags, and CLIP gives a phrase it never saw as
// a tag almost nothing to hold on to: in the regional bench "long staff" and "ancient
// staff" (no such tags) changed nothing, while "wooden staff" (a real tag) changed the
// staff on every seed. A value missing from the dictionary therefore gets a quiet mark.
//
// Tokens that are not meant to be tags are never looked up: LoRA / embedding tokens,
// wildcards, random groups, BREAK. A value the dictionary does not know that reads like
// a sentence is reported as a sentence, not as a mistake - a short action sentence is
// deliberate, and the bench showed it does steer who does what to whom.

export const SENTENCE_MIN_WORDS = 4;

/** The dictionary key for a capsule value, or null when the value is not a tag at all. */
export function lintKey(value) {
    let text = String(value ?? '').trim();
    if (text === '' || text === 'BREAK') return null;
    if (/<[^>]*>/.test(text)) return null;                 // <lora:...>, <hypernet:...>
    if (text.includes('__')) return null;                 // __wildcard__
    if (/[{}|[\]]/.test(text)) return null;               // {a|b} random groups, [from:to:step]
    if (/^embedding:/i.test(text)) return null;
    // stray emphasis parentheses around a bare tag: "((masterpiece))"
    text = text.replace(/^\(+/, '').replace(/(?<!\\)\)+$/, '');
    text = text.replaceAll('\\(', '(').replaceAll('\\)', ')').trim();
    if (text === '') return null;
    return text.toLocaleLowerCase().replaceAll(/\s+/g, '_');
}

/** A phrase long enough, or punctuated like one, to be read as a sentence. */
export function looksLikeSentence(value) {
    const text = String(value ?? '').trim();
    if (text.includes('_')) return false;
    if (/[.!?]$/.test(text)) return true;
    return text.split(/\s+/).filter(Boolean).length >= SENTENCE_MIN_WORDS;
}

/**
 * The mark a capsule gets: 'skip' (not a tag), 'pending' (not looked up yet),
 * 'known', 'sentence' or 'unknown'. `lookup(key)` answers true / false / undefined.
 */
export function classifyTag(value, lookup) {
    const key = lintKey(value);
    if (key === null) return 'skip';
    const known = lookup(key);
    if (known === undefined) return 'pending';
    if (known) return 'known';
    return looksLikeSentence(value) ? 'sentence' : 'unknown';
}
