const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

// An Ollama-native chat endpoint is recognized by its /api/chat path, not by a
// fixed host: plaintext HTTP stays confined to loopback, while any HTTPS host
// (e.g. a Runpod pod proxy) is accepted so remote Ollama speaks its native
// dialect instead of the OpenAI-compatible fallback.
export function isOllamaChatUrl(apiUrl) {
    try {
        const url = new URL(apiUrl);
        if (url.protocol === 'pod-ssh:') return url.pathname.replace(/\/$/, '') === '/api/chat';
        if (url.pathname.replace(/\/$/, '') !== '/api/chat') return false;
        if (url.protocol === 'https:') return true;
        return url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname);
    } catch {
        return false;
    }
}
