// Asks the loopback ComfyUI backend to unload its models when SAA exits, so the
// checkpoint does not stay resident in VRAM after the window is closed.
// Only ever talks to 127.0.0.1 / localhost; any other address is ignored.
import { net } from 'electron';

const CAT = '[ComfyRelease]';
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

export function loopbackComfyAddress(settings) {
    if (!settings || settings.api_interface !== 'ComfyUI') return null;
    const raw = String(settings.api_addr ?? '').trim();
    if (!raw) return null;
    let url;
    try {
        url = new URL(/^https?:\/\//i.test(raw) ? raw : `http://${raw}`);
    } catch {
        return null;
    }
    if (!LOOPBACK_HOSTS.has(url.hostname)) return null;
    return `${url.protocol}//${url.host}`;
}

export function releaseComfyModels(settings, { timeout = 1500, request = net.request } = {}) {
    const base = loopbackComfyAddress(settings);
    if (!base) return Promise.resolve(false);

    return new Promise(resolve => {
        let settled = false;
        const finish = value => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve(value);
        };
        const timer = setTimeout(() => {
            console.warn(CAT, `ComfyUI /free did not answer within ${timeout}ms`);
            try { req.abort(); } catch { /* already gone */ }
            finish(false);
        }, timeout);

        let req;
        try {
            req = request({
                method: 'POST',
                url: `${base}/free`,
                headers: { 'Content-Type': 'application/json' },
                timeout,
            });
        } catch (error) {
            console.warn(CAT, 'ComfyUI /free request could not be created:', error?.message ?? error);
            finish(false);
            return;
        }
        req.on('response', response => {
            response.on('data', () => {});
            response.on('end', () => {
                const ok = response.statusCode >= 200 && response.statusCode < 300;
                if (ok) console.log(CAT, 'ComfyUI models unloaded (/free).');
                else console.warn(CAT, `ComfyUI /free returned HTTP ${response.statusCode}`);
                finish(ok);
            });
        });
        req.on('error', error => {
            console.warn(CAT, 'ComfyUI /free failed:', error?.message ?? error);
            finish(false);
        });
        req.on('timeout', () => {
            try { req.abort(); } catch { /* ignore */ }
            finish(false);
        });
        req.write(JSON.stringify({ unload_models: true, free_memory: true }));
        req.end();
    });
}
