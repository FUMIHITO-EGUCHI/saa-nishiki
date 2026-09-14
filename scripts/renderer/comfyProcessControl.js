// Settings > Backend > "ComfyUI process": Start / Stop / Restart of the local
// backend (scripts/main/comfyProcess.js over the comfy-process IPC). Electron
// only: the browser build has no process to talk to and hides the row.

const CAT = '[ComfyProcessControl]';

function lang() {
    const settings = globalThis.globalSettings;
    return globalThis.cachedFiles?.language?.[settings?.language] ?? {};
}

function text(key, fallback) {
    const value = lang()[key];
    return typeof value === 'string' && value ? value : fallback;
}

// One line for the status span from an action result / state reply.
export function describeComfyProcess(reply, t = text) {
    if (!reply) return t('ui_comfy_proc_unknown', 'not checked');
    if (reply.phase && reply.phase !== 'idle') {
        const verb = reply.phase === 'starting' ? t('ui_comfy_proc_starting', 'starting…')
            : reply.phase === 'stopping' ? t('ui_comfy_proc_stopping', 'stopping…') : reply.phase;
        return verb;
    }
    if (reply.ok === false) return reply.message || t('ui_comfy_proc_failed', 'failed');
    if (reply.message) return reply.message;
    return reply.running ? t('ui_comfy_proc_running', 'running') : t('ui_comfy_proc_down', 'not running');
}

export function setupComfyProcessControl() {
    const panel = document.querySelector('.comfy-proc-panel');
    if (!panel) return null;
    const api = globalThis.api?.comfyProcess;
    if (typeof api !== 'function') {
        panel.hidden = true;
        return null;
    }
    const buttons = {
        start: panel.querySelector('.comfy-proc-start'),
        stop: panel.querySelector('.comfy-proc-stop'),
        restart: panel.querySelector('.comfy-proc-restart'),
    };
    const status = panel.querySelector('.comfy-proc-status');
    const pill = panel.querySelector('.comfy-proc-pill');
    let busy = false;

    function paint(reply) {
        if (status) status.textContent = describeComfyProcess(reply);
        const running = reply?.running === true;
        if (pill) {
            // status-pill states (index_*.css): default dot = ok, is-busy, is-off
            pill.classList.toggle('is-busy', busy);
            pill.classList.toggle('is-off', !running && !busy);
            const label = pill.querySelector('span');
            if (label) label.textContent = busy ? '…' : (running ? text('ui_comfy_proc_running', 'running') : text('ui_comfy_proc_down', 'not running'));
        }
        for (const [name, button] of Object.entries(buttons)) {
            if (!button) continue;
            button.disabled = busy;
            // start only when down, stop / restart only when up (unknown: everything stays available)
            if (reply && typeof reply.running === 'boolean' && !busy) {
                if (name === 'start') button.disabled = running;
                if (name === 'stop') button.disabled = !running;
            }
        }
    }

    async function act(action) {
        if (busy) return;
        busy = true;
        paint({ phase: action === 'stop' ? 'stopping' : 'starting', running: null });
        try {
            const reply = await api({ action });
            if (!reply?.ok) console.warn(CAT, action, reply?.message, reply?.log ?? '');
            busy = false;
            paint(reply);
        } catch (error) {
            busy = false;
            paint({ ok: false, message: error?.message ?? String(error) });
        }
        globalThis.uiShell?.pills?.refresh?.();
    }

    async function refresh() {
        if (busy) return;
        try {
            paint(await api({ action: 'state' }));
        } catch (error) {
            paint({ ok: false, message: error?.message ?? String(error) });
        }
    }

    buttons.start?.addEventListener('click', () => act('start'));
    buttons.stop?.addEventListener('click', () => act('stop'));
    buttons.restart?.addEventListener('click', () => act('restart'));
    pill?.addEventListener('click', refresh);
    // the row lives on a settings page: refresh when that page is shown, not on a timer
    document.addEventListener('saa-settings-page', event => { if (event.detail?.page === 'backend') refresh(); });
    refresh();
    return { refresh, act };
}
