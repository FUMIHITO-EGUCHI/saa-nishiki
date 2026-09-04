// Renderer side of the offline related-tag dictionary (Electron IPC or the web socket
// API in browser mode). Results are cached per tag for the session.
import { sendWebSocketMessage } from '../webserver/front/wsRequest.js';

const cache = new Map();
const CACHE_LIMIT = 512;

export async function fetchRelatedTags(value, options = {}) {
    const key = String(value ?? '').trim().toLowerCase();
    if (!key) return { tag: '', related: [], family: [], familyWord: '' };
    if (cache.has(key)) return cache.get(key);
    const result = globalThis.inBrowser
        ? await sendWebSocketMessage({ type: 'API', method: 'tagRelated', params: [value, options] })
        : await globalThis.api.tagRelated(value, options);
    const normalized = {
        tag: String(result?.tag ?? key),
        related: Array.isArray(result?.related) ? result.related : [],
        family: Array.isArray(result?.family) ? result.family : [],
        familyWord: String(result?.familyWord ?? ''),
    };
    if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value);
    cache.set(key, normalized);
    return normalized;
}

export function clearRelatedTagCache() {
    cache.clear();
}
