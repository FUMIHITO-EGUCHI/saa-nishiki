// Runpod REST API, pod lifecycle only (issue #4): status / start / stop.
//
// Termination is deliberately impossible from here: the pod's /workspace volume
// (models, Ollama, bootstrap) dies with the pod, so no DELETE request and no
// "terminate" action exist in this module. `podAction` refuses anything outside
// ALLOWED_ACTIONS before a URL is even built.
//
// Pure (no Electron, no fs): used by the main process (scripts/main/runpodControl.js)
// and the CLI (scripts/podControl.mjs).

export const RUNPOD_API_BASE = 'https://rest.runpod.io/v1';
export const ALLOWED_ACTIONS = Object.freeze(['status', 'start', 'stop']);

// "2i3m9z8k6tqb7d-644118a9@ssh.runpod.io" -> "2i3m9z8k6tqb7d" (the SSH user is
// <podId>-<hash>); an explicit pod id setting wins over the derivation.
export function podIdFromSshTarget(target) {
    const user = String(target ?? '').trim().split('@')[0];
    const match = /^([a-z0-9]+)-[a-z0-9]+$/i.exec(user);
    return match ? match[1] : '';
}

export function resolvePodId(settings = {}) {
    const explicit = String(settings.api_pod_runpod_pod_id ?? '').trim();
    if (explicit) return explicit;
    return podIdFromSshTarget(settings.api_pod_ssh_target);
}

export function podActionRequest(action, podId) {
    if (!ALLOWED_ACTIONS.includes(action)) throw new Error(`refused pod action: ${action}`);
    const id = String(podId ?? '').trim();
    if (!/^[a-z0-9]+$/i.test(id)) throw new Error('invalid pod id');
    if (action === 'status') return { method: 'GET', url: `${RUNPOD_API_BASE}/pods/${id}` };
    return { method: 'POST', url: `${RUNPOD_API_BASE}/pods/${id}/${action}` };
}

// Trimmed view of a pod record for the UI / CLI.
export function summarizePod(data) {
    if (!data || typeof data !== 'object') return null;
    return {
        id: data.id ?? null,
        name: data.name ?? null,
        desiredStatus: data.desiredStatus ?? null,
        costPerHr: Number.isFinite(Number(data.costPerHr)) ? Number(data.costPerHr) : null,
        gpu: data.gpu?.displayName ?? data.machine?.gpuDisplayName ?? data.machine?.gpuTypeId ?? null,
        uptimeSeconds: Number.isFinite(Number(data.runtime?.uptimeInSeconds)) ? Number(data.runtime.uptimeInSeconds) : null,
    };
}

/**
 * One pod lifecycle call. Resolves to { ok, status, action, pod, message } and
 * never rejects for HTTP errors (only for a refused action / missing inputs).
 */
export async function podAction({ apiKey, podId, action, fetchImpl = globalThis.fetch, timeoutMs = 20_000 }) {
    const key = String(apiKey ?? '').trim();
    if (!key) return { ok: false, action, message: 'Runpod API key is not set' };
    let request;
    try {
        request = podActionRequest(action, podId);
    } catch (error) {
        return { ok: false, action, message: error.message };
    }
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
    try {
        const response = await fetchImpl(request.url, {
            method: request.method,
            headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
            signal: controller?.signal,
        });
        const text = await response.text();
        let data = null;
        try { data = text ? JSON.parse(text) : null; } catch { data = null; }
        if (!response.ok) {
            const detail = data?.error ?? data?.message ?? text.slice(0, 200);
            return { ok: false, status: response.status, action, message: `Runpod ${action} HTTP ${response.status}${detail ? `: ${detail}` : ''}` };
        }
        return { ok: true, status: response.status, action, pod: summarizePod(data) };
    } catch (error) {
        const message = error?.name === 'AbortError' ? `Runpod ${action} timed out` : (error?.message ?? String(error));
        return { ok: false, action, message };
    } finally {
        if (timer) clearTimeout(timer);
    }
}
