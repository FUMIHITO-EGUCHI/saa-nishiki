// The timeout of an LLM request, armed by hand.
//
// Electron's net.request takes a `timeout` option and has a 'timeout' event, but neither
// fires for a backend that accepted the connection and then went quiet - which is what a
// stalled Ollama looks like. Without this the generation queue waits forever.
//
// Pure (no electron import): the timer, the answer and the abort are testable on their own.

/**
 * Arms `timeout` ms: when it runs out, `onTimeout(ms)` answers the caller and `abort()`
 * drops the request. Returns the clear function for the paths that finished on their own;
 * a request that answered is never aborted afterwards, and a timed-out one never has its
 * answer overwritten. A timeout of 0 (or no number) means "wait", and clearing is a no-op.
 */
export function armRequestTimeout({ timeout, onTimeout = () => {}, abort = () => {}, timers = globalThis } = {}) {
    const ms = Number(timeout);
    if (!Number.isFinite(ms) || ms <= 0) return () => {};
    let settled = false;
    const handle = timers.setTimeout(() => {
        if (settled) return;
        settled = true;
        onTimeout(ms);
        abort();
    }, ms);
    return () => {
        if (settled) return;
        settled = true;
        timers.clearTimeout(handle);
    };
}
