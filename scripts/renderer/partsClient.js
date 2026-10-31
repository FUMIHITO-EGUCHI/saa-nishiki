// Renderer side of the Parts (scripts/shared/parts.js): the loaded document, the
// "parts:<name>" expansion the prompt readers call, and the calls that change the
// store (Electron IPC, or the web socket API in browser mode). One document for the
// session; every change replaces it and fires PARTS_CHANGED_EVENT on the document so
// the chips, the picker and the Lists tab repaint.
import {
    expandPartTokens, listParts, normalizePartsDoc, partId, partLorasIn, pickSample,
} from '../shared/parts.js';

export const PARTS_CHANGED_EVENT = 'saa:parts-changed';

let doc = normalizePartsDoc(null);
let loaded = false;
let loading = null;
const imageCache = new Map();
const IMAGE_CACHE_LIMIT = 96;

async function call(method, params = []) {
    if (globalThis.inBrowser) {
        const { sendWebSocketMessage } = await import('../webserver/front/wsRequest.js');
        return sendWebSocketMessage({ type: 'API', method, params });
    }
    const api = globalThis.api;
    switch (method) {
        case 'partsGet': return api?.partsGet?.();
        case 'partsApply': return api?.partsApply?.(...params);
        case 'partsAddSample': return api?.partsAddSample?.(...params);
        case 'partsSampleImage': return api?.partsSampleImage?.(...params);
        default: return null;
    }
}

function replaceDoc(next) {
    doc = normalizePartsDoc(next);
    loaded = true;
    globalThis.document?.dispatchEvent?.(new CustomEvent(PARTS_CHANGED_EVENT, { detail: { doc } }));
    return doc;
}

/** True when the app can store parts (Electron, or a web session with the API). */
export function partsAvailable() {
    return Boolean(globalThis.inBrowser || typeof globalThis.api?.partsGet === 'function');
}

/** Load the document once (later calls answer the cached one). */
export async function loadParts() {
    if (loaded) return doc;
    if (!loading) {
        loading = (async () => {
            try {
                const result = await call('partsGet');
                if (result && typeof result === 'object') replaceDoc(result);
                else loaded = true;
            } catch (error) {
                console.warn('[Parts] load failed:', error?.message ?? error);
                loaded = true;
            }
            return doc;
        })();
    }
    return loading;
}

export function partsDoc() {
    return doc;
}

export function getPart(id) {
    return doc.parts[partId(id)] ?? null;
}

export function partList(category = '') {
    return listParts(doc, category);
}

// A part as the prompt expands it: its tags, and the trigger words of the LoRAs it carries
// when it says so and those LoRAs run on this model (loraUi.js decides that)
function expandable(id) {
    const entry = doc.parts[id] ?? null;
    if (!entry?.loras?.length || entry.loraTriggers === false) return entry;
    const words = globalThis.loraUi?.partTriggers?.(entry) ?? [];
    return words.length ? { ...entry, tags: [entry.tags, words.join(', ')].filter(Boolean).join(', ') } : entry;
}

/** The prompt text with every "parts:<name>" token expanded (the store as loaded now). */
export function expandParts(text) {
    return expandPartTokens(text, expandable);
}

/** The LoRAs the part tokens of `text` bring: [{ name, weight, part }]. */
export function partLoras(text) {
    return partLorasIn(text, id => doc.parts[id] ?? null);
}

export async function applyPartsChange(change) {
    const result = await call('partsApply', [change]);
    if (!result || typeof result !== 'object') return null;
    return replaceDoc(result);
}

/** Store one sample image (a data URL from the generator) on a part. */
export async function addPartSample(id, meta, dataUrl) {
    const result = await call('partsAddSample', [partId(id), meta, dataUrl]);
    if (!result || typeof result !== 'object') return null;
    return replaceDoc(result);
}

/** The data URL of one sample image (cached), or null. */
export async function sampleImage(id, sampleId) {
    const key = `${partId(id)}/${sampleId}`;
    if (imageCache.has(key)) return imageCache.get(key);
    const url = await call('partsSampleImage', [partId(id), sampleId]);
    const value = typeof url === 'string' && url.startsWith('data:image/') ? url : null;
    if (imageCache.size >= IMAGE_CACHE_LIMIT) imageCache.delete(imageCache.keys().next().value);
    imageCache.set(key, value);
    return value;
}

/** The sample a tile shows for the current model type (scripts/shared/parts.js pickSample). */
export function tileSample(id, modelType = globalThis.globalSettings?.api_model_type) {
    return pickSample(getPart(id), modelType === 'Diffusion' ? 'Diffusion' : 'Checkpoint');
}

/** For the chips: { exists, count } of the part a token names, or null for a plain tag. */
export function partInfo(value) {
    const id = partId(String(value ?? '').replace(/^parts:/i, ''));
    const entry = doc.parts[id] ?? null;
    if (!entry) return { exists: false, count: 0 };
    return { exists: true, count: entry.tags ? entry.tags.split(',').filter(piece => piece.trim()).length : 0 };
}
