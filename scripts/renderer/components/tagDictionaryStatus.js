// Dictionary status of capsule values for the chip marks (unknown tag / sentence).
//
// Lookups go to the tag backend in batches (one IPC per burst of renders) and are
// cached for the session; when an answer arrives the capsule fields re-render through
// the `saa:tag-dictionary-updated` event. Without a tag dictionary (the file is
// missing, or the backend has no handler) every value is left unmarked.

import { classifyTag, lintKey } from '../../shared/tagLint.js';

export const TAG_DICTIONARY_EVENT = 'saa:tag-dictionary-updated';

const known = new Map();   // dictionary key -> boolean
const pending = new Set();
let timer = null;
let unavailable = false;

export function tagStatus(value) {
    if (unavailable) return 'skip';
    // A language-model encoder (Diffusion / Anima) reads phrases and sentences as
    // written, so neither mark means anything there.
    if (globalThis.globalSettings?.api_model_type === 'Diffusion') return 'skip';
    return classifyTag(value, key => {
        if (known.has(key)) return known.get(key);
        request(key);
        return undefined;
    });
}

function request(key) {
    if (typeof globalThis.api?.tagLookup !== 'function') { unavailable = true; return; }
    pending.add(key);
    timer ??= setTimeout(flush, 60);
}

async function flush() {
    timer = null;
    const keys = [...pending];
    pending.clear();
    if (keys.length === 0) return;
    try {
        const result = await globalThis.api.tagLookup(keys);
        if (!result || result.loaded !== true) { unavailable = true; return; }
        const hits = new Set(result.known);
        for (const key of keys) known.set(key, hits.has(key));
    } catch {
        unavailable = true;
        return;
    }
    document.dispatchEvent(new CustomEvent(TAG_DICTIONARY_EVENT));
}

/** Forget every answer (the dictionary was reloaded). */
export function resetTagStatus() {
    known.clear();
    unavailable = false;
}

export { lintKey };
