// Resolves which endpoint the LLM features (tag generation / Refine) talk to,
// from the ai_interface target: 'Local' uses ai_local_addr as-is; 'Pod' uses the
// Runpod pod endpoint — either ai_pod_addr, or (with ai_pod_share_host) the
// image-generation pod address with its port swapped to Ollama's. Pure; shared
// by the renderer, the main-process backends and tests.
import { httpApiUrl } from './backendAddress.js';

export const OLLAMA_POD_PORT = 11434;

// Runpod's HTTP proxy encodes the pod port in the first host label:
// https://{podId}-{port}.proxy.runpod.net
const RUNPOD_PROXY_HOST = /^https:\/\/([a-z0-9]+)-(\d+)(\.proxy\.runpod\.net)$/i;

export function derivePodOllamaOrigin(apiAddr, port = OLLAMA_POD_PORT) {
    const text = String(apiAddr ?? '').trim().replace(/\/+$/, '');
    if (!text) return '';
    const proxy = text.match(RUNPOD_PROXY_HOST);
    if (proxy) return `https://${proxy[1]}-${port}${proxy[3]}`;
    try {
        const url = new URL(/^https?:\/\//i.test(text) ? text : `http://${text}`);
        url.port = String(port);
        // plain-HTTP addresses keep their historical bare host:port shape
        return url.protocol === 'https:' ? `${url.protocol}//${url.host}` : url.host;
    } catch {
        return '';
    }
}

// The origin the pod target points at ('' when unresolvable).
export function resolvePodOrigin(settings = {}) {
    return settings.ai_pod_share_host
        ? derivePodOllamaOrigin(settings.api_addr)
        : String(settings.ai_pod_addr ?? '').trim().replace(/\/+$/, '');
}

/**
 * The request target for the "local pipeline" LLM backends (Ollama / llama.cpp):
 * { apiUrl, apiAuth }. apiAuth is the raw auth string (Bearer token or
 * user:pass), turned into a header by backendAuthHeaders at request time.
 */
export function resolveLlmEndpoint(settings = {}) {
    if (String(settings.ai_interface ?? '') === 'Pod') {
        const origin = resolvePodOrigin(settings);
        return {
            apiUrl: origin ? httpApiUrl(origin, 'api/chat') : '',
            apiAuth: String(settings.ai_pod_auth ?? '').trim(),
        };
    }
    return { apiUrl: String(settings.ai_local_addr ?? '').trim(), apiAuth: '' };
}
