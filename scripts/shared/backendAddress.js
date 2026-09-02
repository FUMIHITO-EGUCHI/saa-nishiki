// Address and auth helpers shared by the renderer and the main-process backends.
// An "addr" is either a bare `host:port` (plain HTTP, the historical format) or a
// full `https://host[:port]` origin for TLS endpoints such as Runpod pod proxies.
// Plain `http://...` inputs are normalized back to bare `host:port` so existing
// settings keep their historical shape.

export function normalizeApiAddress(input) {
    const text = String(input ?? '').trim().replace(/\/+$/, '');
    if (!text) return '';
    if (!/^[a-zA-Z][a-zA-Z\d+.-]*:\/\//.test(text)) return text;
    try {
        const url = new URL(text);
        if (url.protocol === 'https:') return `https://${url.host}`;
        if (url.protocol === 'http:') return url.host;
    } catch {
        return '';
    }
    return '';
}

export function isSecureApiAddress(addr) {
    return /^https:\/\//i.test(String(addr ?? '').trim());
}

export function httpApiUrl(addr, path = '') {
    const base = String(addr ?? '').trim().replace(/\/+$/, '');
    const suffix = String(path ?? '').replace(/^\/+/, '');
    const origin = /^https?:\/\//i.test(base) ? base : `http://${base}`;
    return suffix ? `${origin}/${suffix}` : `${origin}/`;
}

export function wsApiUrl(addr, path = '') {
    const httpUrl = httpApiUrl(addr, path);
    return httpUrl.replace(/^https:/i, 'wss:').replace(/^http:/i, 'ws:');
}

// `user:pass` -> HTTP Basic (WebUI --api-auth), anything else -> Bearer token
// (reverse proxies in front of a ComfyUI pod). Empty -> no header.
export function backendAuthHeaders(auth) {
    const value = String(auth ?? '').trim();
    if (!value) return {};
    if (value.includes(':')) {
        const encoded = typeof Buffer === 'undefined'
            ? btoa(String.fromCharCode(...new TextEncoder().encode(value)))
            : Buffer.from(value).toString('base64');
        return { Authorization: `Basic ${encoded}` };
    }
    return { Authorization: `Bearer ${value}` };
}
