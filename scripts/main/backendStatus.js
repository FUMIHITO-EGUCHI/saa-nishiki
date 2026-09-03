// Health probe for the header status pills.
// Reads ComfyUI /system_stats and the Ollama /api/tags endpoint with GETs only.
// Only the user-configured backend address is ever contacted: loopback hosts over
// plain HTTP, remote hosts (e.g. Runpod pod proxies) only over HTTPS.
import { net } from 'electron';
import { backendAuthHeaders } from '../shared/backendAddress.js';
import { resolvePodOrigin } from '../shared/llmEndpoint.js';

const CAT = '[BackendStatus]';
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

export function loopbackOrigin(raw) {
    const text = String(raw ?? '').trim();
    if (!text) return null;
    let url;
    try {
        url = new URL(/^https?:\/\//i.test(text) ? text : `http://${text}`);
    } catch {
        return null;
    }
    if (!LOOPBACK_HOSTS.has(url.hostname)) return null;
    return `${url.protocol}//${url.host}`;
}

// Loopback (any scheme) or HTTPS-only for remote hosts; anything else is refused.
export function probeOrigin(raw) {
    const loopback = loopbackOrigin(raw);
    if (loopback) return loopback;
    const text = String(raw ?? '').trim();
    if (!/^https:\/\//i.test(text)) return null;
    try {
        const url = new URL(text);
        return `${url.protocol}//${url.host}`;
    } catch {
        return null;
    }
}

function getJson(url, { timeout = 1500, request = net.request, headers = {} } = {}) {
    return new Promise(resolve => {
        let settled = false;
        let req;
        const finish = value => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve(value);
        };
        const timer = setTimeout(() => {
            try { req?.abort(); } catch { /* ignore */ }
            finish({ ok: false, error: 'timeout' });
        }, timeout);
        try {
            req = request({ method: 'GET', url, headers, timeout });
        } catch (error) {
            finish({ ok: false, error: error?.message ?? String(error) });
            return;
        }
        req.on('response', response => {
            const chunks = [];
            response.on('data', chunk => chunks.push(chunk));
            response.on('end', () => {
                const status = response.statusCode;
                if (status < 200 || status >= 300) {
                    finish({ ok: false, error: `HTTP ${status}` });
                    return;
                }
                try {
                    finish({ ok: true, data: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
                } catch {
                    finish({ ok: true, data: null });
                }
            });
            response.on('error', error => finish({ ok: false, error: error?.message ?? String(error) }));
        });
        req.on('error', error => finish({ ok: false, error: error?.message ?? String(error) }));
        req.on('timeout', () => {
            try { req.abort(); } catch { /* ignore */ }
            finish({ ok: false, error: 'timeout' });
        });
        req.end();
    });
}

// Normalises /system_stats into the small shape the renderer needs.
export function summarizeSystemStats(data) {
    const device = Array.isArray(data?.devices) ? data.devices[0] : null;
    const vramTotal = Number(device?.vram_total);
    const vramFree = Number(device?.vram_free);
    return {
        version: data?.system?.comfyui_version ?? null,
        deviceName: device?.name ?? null,
        vramTotalMiB: Number.isFinite(vramTotal) ? Math.round(vramTotal / 1024 / 1024) : null,
        vramUsedMiB: Number.isFinite(vramTotal) && Number.isFinite(vramFree) ? Math.round((vramTotal - vramFree) / 1024 / 1024) : null,
    };
}

export async function probeBackends(settings, options = {}) {
    const result = { comfy: { configured: false, ok: false }, ollama: { configured: false, ok: false }, checkedAt: Date.now() };

    if (settings?.api_interface === 'ComfyUI') {
        const origin = probeOrigin(settings.api_addr);
        result.comfy.configured = Boolean(origin);
        result.comfy.address = origin ? origin.replace(/^https?:\/\//, '') : String(settings.api_addr ?? '');
        if (origin) {
            const auth = settings.webui_auth_enable === 'ON' ? String(settings.webui_auth ?? '').trim() : '';
            const comfyOptions = { ...options, headers: backendAuthHeaders(auth) };
            const stats = await getJson(`${origin}/system_stats`, comfyOptions);
            if (stats.ok) {
                Object.assign(result.comfy, { ok: true }, summarizeSystemStats(stats.data));
                const queue = await getJson(`${origin}/queue`, comfyOptions);
                if (queue.ok && queue.data) {
                    result.comfy.running = Array.isArray(queue.data.queue_running) ? queue.data.queue_running.length : 0;
                    result.comfy.pending = Array.isArray(queue.data.queue_pending) ? queue.data.queue_pending.length : 0;
                }
            } else {
                result.comfy.error = stats.error;
            }
        }
    }

    if (settings?.ai_interface === 'Local' || settings?.ai_interface === 'Pod') {
        const isPod = settings.ai_interface === 'Pod';
        const origin = isPod
            ? probeOrigin(resolvePodOrigin(settings))
            : loopbackOrigin(settings.ai_local_addr);
        result.ollama.configured = Boolean(origin);
        result.ollama.remote = isPod;
        if (origin) {
            const auth = isPod ? String(settings.ai_pod_auth ?? '').trim() : '';
            const tags = await getJson(`${origin}/api/tags`, { ...options, headers: backendAuthHeaders(auth) });
            result.ollama.ok = tags.ok;
            if (!tags.ok) result.ollama.error = tags.error;
            result.ollama.mode = settings.ai_local_model_mode ?? null;
        }
    }

    return result;
}

export function registerBackendStatus(ipcMain, getSettings) {
    ipcMain.handle('get-backend-status', async () => {
        try {
            return await probeBackends(getSettings());
        } catch (error) {
            console.warn(CAT, 'probe failed:', error?.message ?? error);
            return { comfy: { configured: false, ok: false }, ollama: { configured: false, ok: false }, checkedAt: Date.now() };
        }
    });
}
