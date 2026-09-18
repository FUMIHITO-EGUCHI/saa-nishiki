// Tag fields -> one English paragraph, for models whose text encoder is a language model
// (Anima / WAI-ANIMA through the Diffusion model type). Pure: no DOM, no I/O.
//
// On the regional bench those models read "A does X to B" from a plain sentence (12-14 of
// 15 directed cases) and lose it when the same content goes out as tags plus a sentence
// (7-9 of 15). A local LLM writes the paragraph from SAA's fields; the tags stay as they
// are for Checkpoint models. Anima also needs English: its conditioning follows the T5
// token ids and a Japanese sentence becomes a single <unk> there, so a paragraph that
// still carries non-Latin text is rejected and the tags go out instead.
//
// The action is the one field the LLM must rewrite rather than copy. A pose named in
// English ("piggyback ride", "stands over her") is copied through and the picture follows
// the model's prior; a description of where the bodies are wins. Japanese input forces
// that paraphrase, which is why the rule below spells it out for English input too.

import { castReferences } from './castMembers.js';

export const PROSE_SYSTEM_PROMPT = `You rewrite an image-generation prompt written as Danbooru tags into the form a language-model text encoder reads best: the quality tags, then one English paragraph.

The input is JSON with these fields; any of them may be empty:
- common: quality tags, the number of people, anything shared by the whole picture
- characters: a list, one entry per character, either the tags of that character as one string, or {"ref": "@1", "tags": "..."} where ref is the handle the action uses for this character and tags are its name, series, hair, eyes, clothes
- view, background, style: how the scene is framed, where it is, and its colour, lighting and rendering
- positive: further tags that belong to the whole picture
- action: who does what to whom, in English or Japanese; "@1", "@2" in it mean the characters with that ref

Write:
1. The quality tags from common first, unchanged and comma-separated.
2. Then one paragraph of plain English sentences in this order: how many people and where they are; each character in the order given; the action; the background, colour and light.
   Each characters entry is reproduced word for word, in its original case, as the opening of that character's sentence — a character name or series name is how the image model recognises the character, so it is never dropped, translated or re-capitalised. Continue the sentence in prose: "gotoh hitori, a girl with long pink hair and a pink track jacket, ...". Tags describing appearance that sit in positive belong to the characters in the order given when the count matches.
3. Write the action once, in the active voice, with the character who acts as the grammatical subject. Do not restate it in the passive. Refer to each character by their appearance, for example "the girl with short black hair". Never call them left, right, A or B, and never write a ref such as "@1" in the output: a ref in the action stands for that character, so name them by their appearance instead.
4. Write the action as what the bodies do, not as the name of the act or pose: where each character is relative to the other, what holds or touches what, and who looks at whom. For example, instead of "lap pillow" write "the girl with short brown hair sits on the floor, and the girl with long red hair lies on her back with her head resting on her lap, looking up at her". The action field is a description to rewrite, never text to keep: do not use the name of the act or pose even when the input does.
5. Use only what the input says and the positions and gaze its action implies. Do not add clothing, expressions, props, lighting or background that are not in it. Do not say that anyone stands, sits or walks unless the action requires it. Keep the direction of the action exactly as given.
6. Copy character names, series names, LoRA trigger words and any token with parentheses, underscores or weights such as (word:1.2) exactly.
7. English only. Translate Japanese input. The output must not contain Japanese or any other non-English characters.
8. Describe only what is in the picture. Never mention that a field is empty or that something is unspecified. Do not describe the framing as a shot or a frame; give the view tags as they are.

Return JSON: {"prompt": "<quality tags>, <paragraph>"}`;

export const PROSE_RESPONSE_FORMAT = Object.freeze({
    type: 'object',
    properties: { prompt: { type: 'string' } },
    required: ['prompt'],
});

export const PROSE_MODE = 'Prose';

// How much of the prompt is dissolved into the paragraph. What is not dissolved stays
// in `common`, which rule 1 copies first, unchanged: the composition and quality tags
// keep their exact form (a sentence like "framed as an upper body shot" letterboxed
// 3 of 12 bench images), and only the cast and the action are written as prose.
//   cast  - characters + action (view, background, style, positive stay tags)
//   scene - characters + action + background + style (view and positive stay tags)
//   all   - everything
export const PROSE_SCOPES = Object.freeze(['cast', 'scene', 'all']);

export function normalizeProseScope(value) {
    return PROSE_SCOPES.includes(value) ? value : 'cast';
}

/** Prose applies to the Diffusion model type only, and only when switched on. */
export function proseEnabled(settings = {}) {
    return settings?.api_model_type === 'Diffusion' && settings?.ai_prose_enable === true;
}

export function isProseMode(mode) {
    return String(mode ?? '').trim().toLowerCase() === 'prose';
}

const fragment = value => String(value ?? '').trim().replace(/[,\s]+$/, '').trim();

function isActionField(field) {
    return /^action$/i.test(String(field?.name ?? '').trim());
}

/**
 * The fields the LLM receives, built from the ordered units the prompt was assembled from
 * (`refineContext.chain`) and the per-character tags. `aiText` is the resolved Expand
 * result, which the chain still holds as its marker.
 *
 * With a cast (`cast` = the roster from castMembers.js) each character is one entry
 * `{ ref: "@n", tags }`: the slot's own tags followed by its "@alias" prompt row, and the
 * action's "@alias" references become "@n". Without a cast the entries are the slot tags.
 *
 * `jsonSlots` are the JSON slot texts the tag prompt wraps around the chain: `before`
 * (BOP) opens common, `after` (EOP) closes positive, and `beforeCharacters` /
 * `afterCharacters` (BOC / EOC) go to positive whenever the characters come from the
 * slots rather than from the characters unit, which already holds them.
 */
export function buildProseFields({ chain = [], characterTags = [], customFields = [], aiText = '', cast = [], scope = 'all', jsonSlots = {} } = {}) {
    const unit = id => fragment(chain.find(entry => entry?.id === id)?.text);
    const customs = Array.isArray(customFields) ? customFields : [];
    const actionIds = new Set(customs.filter(isActionField).map(field => field.id));
    const roster = Array.isArray(cast) ? cast : [];
    const castIds = new Set(roster.map(member => member.fieldId));
    const positiveParts = [unit('positive'), fragment(aiText)];
    const actionParts = [];
    for (const entry of chain) {
        if (!entry?.id || ['common', 'views', 'background', 'style', 'artist', 'ai', 'characters', 'positive'].includes(entry.id)) continue;
        if (castIds.has(entry.id)) continue;
        const text = fragment(entry.text);
        if (text === '') continue;
        (actionIds.has(entry.id) ? actionParts : positiveParts).push(text);
    }
    const slotTags = Array.isArray(characterTags) ? characterTags : [];
    let characters;
    if (roster.length > 0) {
        characters = roster.map(member => {
            const tags = [fragment(slotTags[member.index - 1]), unit(member.fieldId)].filter(Boolean).join(', ');
            return tags === '' ? null : { ref: `@${member.index}`, tags };
        }).filter(Boolean);
    } else {
        const plain = slotTags.map(fragment).filter(Boolean);
        characters = plain.length > 0 ? plain : [unit('characters')].filter(Boolean);
    }
    const slots = jsonSlots && typeof jsonSlots === 'object' ? jsonSlots : {};
    if (roster.length > 0 || slotTags.some(tags => fragment(tags) !== '')) {
        positiveParts.push(fragment(slots.beforeCharacters), fragment(slots.afterCharacters));
    }
    positiveParts.push(fragment(slots.after));
    const fields = {
        // an "@artist" is a style trigger the image model reads as a tag: never prose
        common: [fragment(slots.before), unit('common'), unit('artist')].filter(Boolean).join(', '),
        characters,
        view: unit('views'),
        background: unit('background'),
        style: unit('style'),
        positive: positiveParts.filter(Boolean).join(', '),
        action: castReferences(actionParts.join(' '), roster),
    };
    // what stays tags moves into common (copied first, verbatim) and leaves its field
    const keep = { cast: ['view', 'background', 'style', 'positive'], scene: ['view', 'positive'], all: [] }[normalizeProseScope(scope)];
    const kept = [fields.common, ...keep.map(key => fields[key])].filter(Boolean).join(', ');
    for (const key of keep) fields[key] = '';
    fields.common = kept;
    return fields;
}

/**
 * The fallback when the assembled prompt was rewritten as a whole (AI Refine): the LLM
 * gets the finished tag list plus the action, with no per-character split. The list still
 * holds the Action as written, so its "@alias" references become "@n" there too.
 */
export function buildProseFieldsFromPositive(positive, { customFields = [], chain = [], cast = [] } = {}) {
    const structured = buildProseFields({ chain, customFields, cast });
    return {
        common: '',
        characters: [],
        view: '',
        background: '',
        style: '',
        positive: castReferences(fragment(splitLoraLines(positive).text), Array.isArray(cast) ? cast : []),
        action: structured.action,
    };
}

export function buildProseUserContent(fields) {
    return JSON.stringify(fields, null, 2);
}

/**
 * The cache key: the fields plus the instructions, so a changed prompt is not served stale,
 * and the `target` (endpoint and model), so another model writes its own paragraph.
 */
export function proseCacheKey(fields, target = '') {
    return JSON.stringify({ rules: PROSE_SYSTEM_PROMPT.length, target: String(target ?? ''), fields });
}

/** The text the rules tell the LLM to copy unchanged (common and the character entries). */
export function proseVerbatimText(fields = {}) {
    const characters = Array.isArray(fields?.characters) ? fields.characters : [];
    return [fields?.common, ...characters.map(entry => (typeof entry === 'string' ? entry : entry?.tags))]
        .filter(value => typeof value === 'string' && value !== '').join('\n');
}

// A character handle: "@" plus a slot number that is not part of a longer token, so
// "@10" is one handle and never the handle "@1".
const HANDLE = /@\d+(?![A-Za-z0-9_])/g;

const handlesIn = text => [...String(text ?? '').matchAll(HANDLE)].map(match => match[0]);

/** The "@n" handles the fields use (the character refs and any in the action). */
export function proseRefs(fields = {}) {
    const characters = Array.isArray(fields?.characters) ? fields.characters : [];
    const refs = characters.map(entry => entry?.ref).filter(ref => typeof ref === 'string');
    refs.push(...handlesIn(fields?.action));
    return [...new Set(refs)];
}

/** LoRA lines ride below the tags; the paragraph replaces the tags, not them. */
export function splitLoraLines(positive) {
    const lines = String(positive ?? '').split('\n');
    const loraLines = lines.filter(line => /^\s*<lora:/i.test(line));
    const text = lines.filter(line => !/^\s*<lora:/i.test(line)).join('\n').trim();
    return { text, loraLines };
}

export function composeProsePositive(prose, loraLines = []) {
    const paragraph = String(prose ?? '').trim();
    return loraLines.length > 0 ? `${paragraph}\n${loraLines.join('\n')}` : paragraph;
}

// CJK (every plane), kana, hangul, full-width forms, and the other non-Latin scripts an LLM
// falls back to (Cyrillic, Hebrew, Arabic, Devanagari, Thai): none of these survive the T5
// tokenizer. Greek stays allowed ("μ's" is a tag).
const NON_ENGLISH_CHAR = String.raw`[　-鿿가-힯＀-￯ᄀ-ᇿЀ-ԯ֐-׿؀-ۿऀ-ॿ฀-๿]|\p{Script=Han}`;
const NON_ENGLISH = new RegExp(NON_ENGLISH_CHAR, 'u');
const NON_ENGLISH_RUNS = new RegExp(`(?:${NON_ENGLISH_CHAR})+`, 'gu');

export function hasNonEnglish(text) {
    return NON_ENGLISH.test(String(text ?? ''));
}

// An answer that declines instead of writing (plain-text endpoints have no schema).
const REFUSAL = /^(?:i['’]m sorry|i am sorry|sorry[,.!]|i can(?:no|['’])t\b|i cannot\b|i won['’]t\b|i will not\b|as an ai\b)/i;

/**
 * The JSON object a reply carries, wherever the model put it: on its own, inside a code
 * fence, or with a line of chat before or after it. Scans from the first "{", aware of
 * strings and escapes; `complete` is false for an object that stops early (a reply cut
 * off at n_predict), which is never a paragraph.
 */
function findJsonObject(text) {
    const start = text.indexOf('{');
    if (start < 0) return null;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = start; index < text.length; index++) {
        const char = text[index];
        if (inString) {
            if (escaped) escaped = false;
            else if (char === '\\') escaped = true;
            else if (char === '"') inString = false;
            continue;
        }
        if (char === '"') inString = true;
        else if (char === '{') depth++;
        else if (char === '}' && --depth === 0) return { text: text.slice(start, index + 1), complete: true };
    }
    return { text: text.slice(start), complete: false };
}

/**
 * The paragraph out of an LLM reply: the JSON the schema asks for, or the raw text when
 * the model answered without it. `ok` is false, with a `reason`, for an answer that is
 * empty; cut off (an unclosed <think>, or schema JSON that stops early); JSON that does
 * not parse or has no string prompt; a refusal; non-English text that is not in
 * `verbatim` (the text the LLM copies, which may carry it); or a handle from `refs`
 * ("@1") that is not in `verbatim`.
 */
export function parseProseResponse(content, { verbatim = '', refs = [] } = {}) {
    let text = String(content ?? '').replace(/<think>[\s\S]*?<\/think>\s*/g, '').trim();
    if (text === '') return { ok: false, reason: 'empty', prompt: '' };
    if (/<think>/i.test(text)) return { ok: false, reason: 'invalid', prompt: text };
    const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(text);
    if (fenced) text = fenced[1].trim();
    const object = findJsonObject(text);
    // an answer meant as the schema's JSON: it opens with the object, or names the field.
    // A stray "{" inside a paragraph is not one, and is left as the text it is.
    if (object && (text.startsWith('{') || /"prompt"\s*:/.test(object.text))) {
        let parsed = null;
        if (object.complete) {
            try {
                parsed = JSON.parse(object.text);
            } catch {
                // not the JSON that was asked for
            }
        }
        if (!parsed || typeof parsed !== 'object' || typeof parsed.prompt !== 'string') return { ok: false, reason: 'invalid', prompt: text };
        text = parsed.prompt.trim();
    }
    if (text === '') return { ok: false, reason: 'empty', prompt: '' };
    if (REFUSAL.test(text)) return { ok: false, reason: 'refusal', prompt: text };
    const copied = String(verbatim ?? '');
    const foreign = [...text.matchAll(NON_ENGLISH_RUNS)].map(match => match[0]).filter(run => !copied.includes(run));
    if (foreign.length > 0) return { ok: false, reason: 'non-english', prompt: text };
    const handles = new Set(refs);
    // whole handles, not substrings: an artist token "@10" in common is not a copied "@1"
    const copiedHandles = new Set(handlesIn(copied));
    const leaked = handlesIn(text).filter(ref => handles.has(ref) && !copiedHandles.has(ref));
    if (leaked.length > 0) return { ok: false, reason: 'refs', prompt: text };
    return { ok: true, reason: '', prompt: text };
}
