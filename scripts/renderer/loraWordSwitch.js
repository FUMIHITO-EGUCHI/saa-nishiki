// A LoRA switched off in its slot row takes its trigger words out of the positive rows;
// switched on again, it puts them back where they stood. Texts in, texts out: loraUi.js
// reads the rows and commits what comes back.
import { appendTagsToText, mapPromptTokens, parsePromptToCapsules, splitPromptTokens } from './components/tagCapsuleLogic.js';
import { tagKey } from '../shared/loraCatalog.js';

const wordOf = token => tagKey(parsePromptToCapsules(token)[0]?.value ?? '');

// the commas a dropped tag leaves behind ("a,, b", "a, b,")
const tidy = text => String(text).split('\n')
    .map(line => line.replace(/,(\s*,)+/g, ',').replace(/^\s*,\s*/, '').replace(/\s*,\s*$/, ''))
    .join('\n');

/**
 * The rows' texts ({ id: text }) without the words, only the rows that changed, and what
 * was taken: [{ id, index, token, next }], the tag as it was written (its weight and ~
 * kept), its place among the row's tags and the word of the tag that followed it ('' at
 * the end).
 */
export function takeWordsOut(texts, words) {
    const keys = new Set([...words].map(tagKey).filter(Boolean));
    const next = {};
    const taken = [];
    if (keys.size === 0) return { texts: next, taken };
    for (const [id, text] of Object.entries(texts)) {
        const tokens = splitPromptTokens(text);
        const found = [];
        tokens.forEach((token, index) => {
            if (!keys.has(wordOf(token))) return;
            const after = tokens.slice(index + 1).find(other => !keys.has(wordOf(other)));
            found.push({ id, index, token, next: after ? wordOf(after) : '' });
        });
        if (found.length === 0) continue;
        const at = new Set(found.map(item => item.index));
        next[id] = tidy(mapPromptTokens(text, (token, index) => (at.has(index) ? '' : null)));
        taken.push(...found);
    }
    return { texts: next, taken };
}

/**
 * The rows' texts with what takeWordsOut took put back (only the rows that changed): each
 * tag in front of the one that followed it, at its old place when that one is gone, at the
 * end when it was last. A word written in any row again since is not put back twice.
 */
export function putWordsBack(texts, taken) {
    const present = new Set(Object.values(texts).flatMap(text => splitPromptTokens(text).map(wordOf)));
    const rows = new Map();
    for (const item of taken) if (item.id in texts) rows.set(item.id, [...(rows.get(item.id) ?? []), item]);
    const next = {};
    for (const [id, items] of rows) {
        const words = splitPromptTokens(texts[id]).map(wordOf);
        const before = new Map();
        const tail = [];
        // every tag taken in front of one is gone from the row: its old place moves up by them
        items.sort((a, b) => a.index - b.index).forEach((item, gone) => {
            if (present.has(wordOf(item.token))) return;
            const found = item.next ? words.indexOf(item.next) : -1;
            const at = found >= 0 ? found : item.next ? item.index - gone : words.length;
            if (at >= words.length) tail.push(item.token);
            else before.set(at, [...(before.get(at) ?? []), item.token]);
        });
        if (before.size === 0 && tail.length === 0) continue;
        const text = mapPromptTokens(texts[id], (token, index) => (before.has(index) ? `${before.get(index).join(', ')}, ${token}` : null));
        // a word that stood on a line of its own goes back on it
        next[id] = tail.length > 0 && text.endsWith('\n') ? `${text}${tail.join(', ')}` : appendTagsToText(text, tail);
    }
    return next;
}

/**
 * A Batch (Last) prompt: the last run's prompt without the words taken out of the rows now
 * and with the ones that were taken then and are back since (their LoRA switched on again).
 * `then` and `now` are takeWordsOut's lists; a word put back stands in front of the one it
 * stood before in its row, at the end when that is not in the prompt.
 */
export function retakeWords(prompt, then = [], now = []) {
    const text = String(prompt ?? '');
    const taken = new Set(now.map(item => wordOf(item.token)));
    const back = then
        .filter(item => !taken.has(wordOf(item.token)))
        .map(item => ({ ...item, id: 'prompt', index: Number.MAX_SAFE_INTEGER }));
    const without = takeWordsOut({ prompt: text }, taken).texts.prompt ?? text;
    return putWordsBack({ prompt: without }, back).prompt ?? without;
}
