// Translations for the chips' alias line ("white background · 白背景").
//
// Values are looked up at the tag backend in batches (one request per burst of
// renders) and cached for the session; when an answer arrives the capsule fields
// re-render through the `saa:tag-aliases-updated` event. A language change clears
// the cache (the dictionary was reloaded in the other language). Without a tag
// dictionary every value simply has no alias.

import { sendWebSocketMessage } from '../webserver/front/wsRequest.js';

export const TAG_ALIASES_EVENT = 'saa:tag-aliases-updated';

const aliases = new Map();   // chip value -> alias ('' when none)
const pending = new Set();
let timer = null;
let unavailable = false;   // this build has no lookup API at all
let retryAt = 0;           // a failed lookup (e.g. the web socket reconnecting) pauses requests until then
const RETRY_DELAY_MS = 30_000;

function enabled() {
    return globalThis.globalSettings?.tag_chip_alias !== false;
}

/** The cached translation of a chip value; '' while unknown (a request is queued). */
export function aliasFor(value) {
    if (unavailable || !enabled()) return '';
    const key = String(value ?? '').trim();
    if (!key) return '';
    if (aliases.has(key)) return aliases.get(key);
    request(key);
    return '';
}

/** Queue the values that have no cached answer yet. */
export function ensureAliases(values = []) {
    if (unavailable || !enabled()) return;
    for (const value of values) {
        const key = String(value ?? '').trim();
        if (key && !aliases.has(key)) request(key);
    }
}

function request(key) {
    const hasApi = typeof globalThis.api?.tagAliases === 'function' || globalThis.inBrowser;
    if (!hasApi) { unavailable = true; return; }
    if (Date.now() < retryAt) return;
    pending.add(key);
    timer ??= setTimeout(flush, 60);
}

async function flush() {
    timer = null;
    const keys = [...pending];
    pending.clear();
    if (keys.length === 0) return;
    try {
        const result = globalThis.inBrowser
            ? await sendWebSocketMessage({ type: 'API', method: 'tagAliases', params: [keys] })
            : await globalThis.api.tagAliases(keys);
        if (!result || result.loaded !== true) return;   // no dictionary yet: ask again on the next render
        for (const key of keys) aliases.set(key, String(result.aliases?.[key] ?? ''));
    } catch (error) {
        console.warn('[tagAliasClient] alias lookup failed:', error?.message ?? error);
        // not for the whole session: the next render after the pause asks again
        retryAt = Date.now() + RETRY_DELAY_MS;
        return;
    }
    document.dispatchEvent(new CustomEvent(TAG_ALIASES_EVENT));
}

/** Forget every answer (the dictionary was reloaded, e.g. after a language change). */
export function clearTagAliasCache() {
    aliases.clear();
    pending.clear();
    unavailable = false;
    retryAt = 0;
    document.dispatchEvent(new CustomEvent(TAG_ALIASES_EVENT));
}
