// The renderer's copy of the LoRA catalog (scripts/main/lora_backend.js): every listed
// LoRA with what its file says and what the user chose, the sample images (kept here
// once read), and the changes, after which LORA_CHANGED_EVENT tells the LoRA tab and the
// tag chips to repaint. Over the web socket for a browser client, as the Parts are.

import { sendWebSocketMessage } from '../webserver/front/wsRequest.js';
import { DEFAULT_RANGE, LORA_CATEGORIES, loraLabel, tagKey } from '../shared/loraCatalog.js';

export const LORA_CHANGED_EVENT = 'saa:loras-changed';

let catalog = null;          // { loras, defaults, samplePrompt, categories }
let loading = null;
const byName = new Map();
const samples = new Map();   // name|sampleId -> data URL
const SAMPLE_CACHE = 192;

function call(method, ...params) {
    if (globalThis.inBrowser) return sendWebSocketMessage({ type: 'API', method, params });
    const api = globalThis.api;
    return typeof api?.[method] === 'function' ? api[method](...params) : Promise.resolve(null);
}

function replace(next) {
    if (!next || !Array.isArray(next.loras)) return catalog;
    catalog = next;
    byName.clear();
    for (const entry of next.loras) byName.set(entry.name, entry);
    document.dispatchEvent(new CustomEvent(LORA_CHANGED_EVENT));
    return catalog;
}

/** The catalog, read once (or again with `force`, after the LoRA list was reloaded). */
export function loadLoraCatalog({ force = false } = {}) {
    if (catalog && !force) return Promise.resolve(catalog);
    if (!loading || force) {
        loading = Promise.resolve(call('loraCatalog'))
            .then(replace)
            .catch(error => {
                console.warn('[LoRA] catalog not read:', error?.message ?? error);
                return catalog;
            })
            .finally(() => { loading = null; });
    }
    return loading;
}

export function loraCatalog() {
    return catalog ?? { loras: [], defaults: { ...DEFAULT_RANGE }, samplePrompt: null, categories: LORA_CATEGORIES };
}

export function loraEntry(name) {
    return byName.get(name) ?? null;
}

/** One change (shared/loraCatalog.js applyLoraChange), stored and spread to every view. */
export async function changeLora(change) {
    return replace(await call('loraApply', change));
}

export async function addLoraSample(name, meta, dataUrl) {
    return replace(await call('loraAddSample', name, meta, dataUrl));
}

export async function askCivitai(name) {
    const answer = await call('loraCivitai', name);
    if (answer?.catalog) replace(answer.catalog);
    return answer;
}

/** A sample image, read once and kept. */
export async function loraSampleImage(name, sampleId) {
    const key = `${name}|${sampleId}`;
    if (samples.has(key)) return samples.get(key);
    const image = await call('loraSampleImage', name, sampleId);
    if (image) {
        samples.set(key, image);
        if (samples.size > SAMPLE_CACHE) samples.delete(samples.keys().next().value);
    }
    return image;
}

/** The LoRAs suggested for a tag (their "Suggest for tags"), the starred first. */
export function lorasForTag(tag) {
    const key = tagKey(tag);
    if (!key || !catalog) return [];
    return catalog.loras.filter(entry => entry.linked.includes(key))
        .sort((a, b) => Number(b.favorite) - Number(a.favorite) || a.label.localeCompare(b.label));
}

export { loraLabel };
