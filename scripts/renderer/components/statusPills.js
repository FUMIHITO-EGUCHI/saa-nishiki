// Header status pills: "● ComfyUI 127.0.0.1:8189 · VRAM 1.6 / 12 GB" and "● Ollama · Small".
// Polls the main process (loopback or HTTPS-pod probe) every POLL_MS while the window is visible
// and no generation is running. formatBackendStatus is pure for tests.

const POLL_MS = 10_000;
const FAILURES_BEFORE_RED = 3;

function gb(mib) {
    return (mib / 1024).toFixed(1);
}

export function formatBackendStatus(status, { failures = 0, text = {} } = {}) {
    const comfy = status?.comfy ?? {};
    const ollama = status?.ollama ?? {};
    const pills = [];

    if (comfy.configured) {
        let state = 'ok';
        const parts = [`ComfyUI ${comfy.address ?? ''}`.trim()];
        if (comfy.ok) {
            if (comfy.vramUsedMiB !== null && comfy.vramUsedMiB !== undefined && comfy.vramTotalMiB) {
                parts.push(`VRAM ${gb(comfy.vramUsedMiB)} / ${gb(comfy.vramTotalMiB)} GB`);
            }
            if ((comfy.running ?? 0) > 0) state = 'busy';
        } else {
            state = failures >= FAILURES_BEFORE_RED ? 'bad' : 'warn';
            parts.push(text.noAnswer ?? 'no answer');
        }
        pills.push({ id: 'comfy', state, label: parts.join(' · '), title: comfy.version ? `ComfyUI ${comfy.version}${comfy.deviceName ? ` · ${comfy.deviceName}` : ''}` : (comfy.error ?? '') });
    } else if (status?.comfy) {
        pills.push({ id: 'comfy', state: 'off', label: text.comfyOff ?? 'ComfyUI not set', title: comfy.address ?? '' });
    }

    if (ollama.configured) {
        const parts = ['Ollama'];
        if (ollama.remote) parts.push(text.pod ?? 'Pod');
        if (ollama.mode) parts.push(String(ollama.mode));
        let state = 'ok';
        if (!ollama.ok) {
            state = failures >= FAILURES_BEFORE_RED ? 'bad' : 'warn';
            parts.push(text.noAnswer ?? 'no answer');
        }
        pills.push({ id: 'ollama', state, label: parts.join(' · '), title: ollama.error ?? '' });
    }

    return pills;
}

export function setupStatusPills({ container, getStatus, onClick, text = {}, isBusy = () => false, pollMs = POLL_MS } = {}) {
    if (!container || typeof getStatus !== 'function') return null;
    container.classList.add('status-pills');
    let failures = 0;
    let timer = null;
    let destroyed = false;

    function render(pills) {
        container.replaceChildren(...pills.map(pill => {
            const element = document.createElement('button');
            element.type = 'button';
            element.className = `status-pill is-${pill.state}`;
            element.dataset.backend = pill.id;
            element.title = pill.title || '';
            element.innerHTML = '<i></i>';
            element.append(document.createTextNode(pill.label));
            element.addEventListener('click', () => onClick?.(pill.id));
            return element;
        }));
    }

    async function poll() {
        if (destroyed) return;
        if (document.hidden || isBusy()) {
            schedule();
            return;
        }
        let status = null;
        try {
            status = await getStatus();
        } catch {
            status = null;
        }
        const anyDown = Boolean(status && ((status.comfy?.configured && !status.comfy.ok) || (status.ollama?.configured && !status.ollama.ok)));
        failures = anyDown ? failures + 1 : 0;
        render(formatBackendStatus(status, { failures, text }));
        schedule();
    }

    function schedule() {
        if (destroyed) return;
        clearTimeout(timer);
        timer = setTimeout(poll, pollMs);
    }

    poll();
    document.addEventListener('visibilitychange', () => { if (!document.hidden) poll(); });

    return {
        refresh: poll,
        updateLanguage(nextText = {}) { Object.assign(text, nextText); },
        destroy() { destroyed = true; clearTimeout(timer); },
    };
}
