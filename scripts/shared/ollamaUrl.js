export function isOllamaChatUrl(apiUrl) {
    try {
        const url = new URL(apiUrl);
        return url.protocol === 'http:'
            && (url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '[::1]')
            && url.port === '11434'
            && url.pathname.replace(/\/$/, '') === '/api/chat';
    } catch {
        return false;
    }
}
