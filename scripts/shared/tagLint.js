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

// Quality, aesthetic, rating, date and score tags the SDXL anime checkpoints were trained on
// that are not Danbooru tags, so the dictionary does not list them (the default prompts are
// made of them). They are model vocabulary, never marked unknown. Keys in dictionary form.
const MODEL_VOCABULARY = new Set([
    'masterpiece', 'best_quality', 'amazing_quality', 'great_quality', 'high_quality', 'good_quality',
    'normal_quality', 'average_quality', 'medium_quality', 'low_quality', 'bad_quality', 'worst_quality',
    'best_detail', 'bad_detail', 'worst_detail',
    'very_aesthetic', 'aesthetic', 'displeasing', 'very_displeasing', 'very_awa',
    'newest', 'recent', 'mid', 'early', 'old', 'oldest',
    'general', 'sensitive', 'questionable', 'explicit', 'safe', 'nsfw', 'sfw',
]);
const MODEL_VOCABULARY_PATTERNS = [
    /^score_\d(?:_up)?$/,                                  // score_9, score_8_up (Pony)
    /^rating_(?:general|safe|sensitive|questionable|explicit)$/,
    /^source_(?:anime|cartoon|furry|pony)$/,
    /^year_\d{4}$/,
];

/** True for a dictionary key the checkpoints know although the tag dictionary does not. */
export function isModelVocabulary(key) {
    const text = String(key ?? '');
    return MODEL_VOCABULARY.has(text) || MODEL_VOCABULARY_PATTERNS.some(pattern => pattern.test(text));
}

/** The dictionary key for a capsule value, or null when the value is not a tag at all. */
export function lintKey(value) {
    let text = String(value ?? '').trim();
    if (text === '' || text === 'BREAK') return null;
    if (/<[^>]*>/.test(text)) return null;                 // <lora:...>, <hypernet:...>
    if (text.includes('__')) return null;                 // __wildcard__
    if (/[{}|[\]]/.test(text)) return null;               // {a|b} random groups, [from:to:step]
    if (/^embedding:/i.test(text)) return null;
    // stray emphasis parentheses around a bare tag: "((masterpiece))"
    const unwrapped = text.replace(/^\(+/, '').replace(/(?<!\\)\)+$/, '');
    // ... and the weight they carry: "((long hair:1.3))", or the "blue eyes:1.2)" end of the
    // group "(red hair, blue eyes:1.2)" that the comma split into two chips. Only when
    // parentheses were stripped, and never when what is left is a number, so "4:3" and
    // ":3" stay as written.
    const weighted = unwrapped === text ? null : /^(.*?):\s*-?(?:\d+(?:\.\d*)?|\.\d+)\s*$/.exec(unwrapped);
    text = weighted && /[^\d\s]/.test(weighted[1]) ? weighted[1] : unwrapped;
    text = text.replaceAll('\\(', '(').replaceAll('\\)', ')').trim();
    if (text === '') return null;
    // a weighted group kept as one chip, "(red hair, blue eyes:1.2)", holds several tags
    // and no single key can vouch for it
    if (text.includes(',')) return null;
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
    if (isModelVocabulary(key)) return 'known';
    const known = lookup(key);
    if (known === undefined) return 'pending';
    if (known) return 'known';
    return looksLikeSentence(value) ? 'sentence' : 'unknown';
}
