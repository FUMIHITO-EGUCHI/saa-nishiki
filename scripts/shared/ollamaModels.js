// Pure helpers for managing the Ollama models on the pod (list / pull / unload)
// and the keep-alive the pod's LLM uses between calls. Shared by the main
// process, the renderer and the batch scripts.

// Ollama model names: repo/name:tag or hf.co/org/repo:quant
const MODEL_NAME = /^[A-Za-z0-9][A-Za-z0-9._\/-]*(?::[A-Za-z0-9._-]+)?$/;

export function isValidOllamaModelName(model) {
    const text = String(model ?? '').trim();
    return text !== '' && text.length <= 200 && MODEL_NAME.test(text) && !text.includes('..');
}

// /api/tags -> sorted model names
export function parseOllamaTags(payload) {
    const models = Array.isArray(payload?.models) ? payload.models : [];
    return models
        .map(model => String(model?.name ?? model?.model ?? '').trim())
        .filter(Boolean)
        .sort((left, right) => left.localeCompare(right));
}

// /api/ps -> names of the models currently loaded in VRAM
export function parseOllamaLoaded(payload) {
    return parseOllamaTags(payload);
}

// keep_alive as Ollama accepts it: a duration string ('10m', '1h'), a number of
// seconds, or 0 / '0' to unload right after the answer.
export function normalizeKeepAlive(value, fallback = '10m') {
    if (value === 0 || value === '0') return 0;
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) return Math.round(value);
    const text = String(value ?? '').trim();
    if (/^\d+$/.test(text)) return Number.parseInt(text, 10);
    if (/^\d+(\.\d+)?(ms|s|m|h)$/.test(text)) return text;
    if (text === '-1') return -1;
    return fallback;
}

// POST /api/generate with an empty prompt and keep_alive 0 unloads a model.
export function unloadRequest(model) {
    return { method: 'POST', path: '/api/generate', body: { model, prompt: '', keep_alive: 0, stream: false } };
}

// POST /api/pull with stream:false answers once the download finished.
export function pullRequest(model) {
    if (!isValidOllamaModelName(model)) throw new Error(`invalid Ollama model name: ${model}`);
    return { method: 'POST', path: '/api/pull', body: { model: String(model).trim(), stream: false } };
}

// Models that fit next to an SDXL checkpoint on a 12 GB pod, by purpose.
export const RECOMMENDED_POD_MODELS = Object.freeze([
    { model: 'hf.co/HauhauCS/Gemma4-12B-QAT-Uncensored-HauhauCS-Balanced:Q4_K_M', sizeGb: 8, purpose: 'translation review, Refine / Expand (strong Japanese)' },
    { model: 'huihui_ai/qwen3-abliterated:8b', sizeGb: 5, purpose: 'fast fallback for refused batches' },
]);
