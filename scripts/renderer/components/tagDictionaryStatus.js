// Dictionary status of capsule values for the chip marks (unknown tag / sentence).
//
// Lookups go to the tag backend in batches (one IPC per burst of renders) and are
// cached for the session; when an answer arrives the capsule fields re-render through
// the `saa:tag-dictionary-updated` event. Without a tag dictionary (the file is
// missing, or the backend has no handler) every value is left unmarked.

import { classifyTag, lintKey } from '../../shared/tagLint.js';
import { sendWebSocketMessage } from '../../webserver/front/wsRequest.js';

export const TAG_DICTIONARY_EVENT = 'saa:tag-dictionary-updated';

// The backend answers at most this many keys per call (tagAutoComplete_backend.js tagLookup);
// a bigger burst goes out in several calls instead of losing the keys past the cap.
export const LOOKUP_BATCH = 2000;
// A failed lookup (IPC error, dictionary not loaded) leaves values unmarked for this long and
// is then tried again, instead of switching the marks off for the rest of the session.
export const RETRY_AFTER_MS = 30000;

const known = new Map();   // dictionary key -> boolean
const pending = new Set();
let timer = null;
let unavailableUntil = 0;  // Date.now() before which every value is left unmarked

export function tagStatus(value) {
    if (Date.now() < unavailableUntil) return 'skip';
    // A language-model encoder (Diffusion / Anima) reads phrases and sentences as
    // written, so neither mark means anything there.
    if (globalThis.globalSettings?.api_model_type === 'Diffusion') return 'skip';
    return classifyTag(value, key => {
        if (known.has(key)) return known.get(key);
        request(key);
        return undefined;
    });
}

// The Electron preload handler, or the same handler over the web front's websocket
// (webserver/back/wsService.js); null when neither exists.
function lookupFunction() {
    if (globalThis.inBrowser) return keys => sendWebSocketMessage({ type: 'API', method: 'tagLookup', params: [keys] });
    if (typeof globalThis.api?.tagLookup === 'function') return keys => globalThis.api.tagLookup(keys);
    return null;
}

function request(key) {
    if (!lookupFunction()) { unavailableUntil = Infinity; return; }
    pending.add(key);
    timer ??= setTimeout(flush, 60);
}

function pause() {
    unavailableUntil = Date.now() + RETRY_AFTER_MS;
    pending.clear();
    // the values asked for are answered by 'skip' now: repaint, or they keep the waiting
    // mark of a lookup that will not come
    document.dispatchEvent(new CustomEvent(TAG_DICTIONARY_EVENT));
}

async function flush() {
    timer = null;
    const keys = [...pending].slice(0, LOOKUP_BATCH);
    for (const key of keys) pending.delete(key);
    if (pending.size > 0) timer = setTimeout(flush, 0);
    if (keys.length === 0) return;
    try {
        const lookup = lookupFunction();
        const result = lookup ? await lookup(keys) : null;
        if (!result || result.loaded !== true) { pause(); return; }
        const hits = new Set(result.known);
        for (const key of keys) known.set(key, hits.has(key));
    } catch {
        pause();
        return;
    }
    document.dispatchEvent(new CustomEvent(TAG_DICTIONARY_EVENT));
}

/** Forget every answer (the dictionary was reloaded). */
export function resetTagStatus() {
    known.clear();
    unavailableUntil = 0;
}

export { lintKey };
