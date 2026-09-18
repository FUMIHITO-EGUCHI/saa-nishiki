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

// One line for the status span from an action result / state reply. The pill
// beside it already says running / not running, so a plain state reply adds
// nothing; only progress, an action's outcome or an error is worth a line.
export function describeComfyProcess(reply, t = text) {
    if (!reply) return t('ui_comfy_proc_unknown', 'not checked');
    if (reply.phase && reply.phase !== 'idle') {
        const verb = reply.phase === 'starting' || reply.phase === 'restarting' ? t('ui_comfy_proc_starting', 'starting…')
            : reply.phase === 'stopping' ? t('ui_comfy_proc_stopping', 'stopping…') : reply.phase;
        return verb;
    }
    if (reply.ok === false) return reply.message || t('ui_comfy_proc_failed', 'failed');
    if (reply.action && reply.action !== 'state' && reply.message) return reply.message;
    // fast-mode launch flags the running backend has (comfyLaunchArgs.js)
    if (reply.running === true && Array.isArray(reply.fastFlags) && reply.fastFlags.length > 0) {
        return `${t('ui_comfy_proc_flags', 'flags:')} ${reply.fastFlags.join(' ')}`;
    }
    return '';
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
    let busyAction = '';
    let repoll = null;

    function paint(reply) {
        if (status) status.textContent = describeComfyProcess(reply);
        const running = reply?.running === true;
        // a start SAA runs by itself (autostart, a fast-mode restart) belongs to no click of
        // this panel: the phase in the reply says it is under way, and Stop cancels it
        const phaseBusy = typeof reply?.phase === 'string' && reply.phase !== 'idle';
        const working = busy || phaseBusy;
        if (pill) {
            // status-pill states (index_*.css): default dot = ok, is-busy, is-off
            pill.classList.toggle('is-busy', working);
            pill.classList.toggle('is-off', !running && !working);
            const label = pill.querySelector('span');
            if (label) label.textContent = working ? '…' : (running ? text('ui_comfy_proc_running', 'running') : text('ui_comfy_proc_down', 'not running'));
        }
        for (const [name, button] of Object.entries(buttons)) {
            if (!button) continue;
            // while a start or restart runs, Stop stays available: it cancels that start
            button.disabled = working && !(name === 'stop' && busyAction !== 'stop');
            // start only when down, stop / restart only when up (unknown: everything stays available)
            if (reply && typeof reply.running === 'boolean' && !working) {
                if (name === 'start') button.disabled = running;
                if (name === 'stop') button.disabled = !running;
            }
        }
        // the row has no timer of its own; while the main process works, look again shortly
        if (repoll) clearTimeout(repoll);
        repoll = phaseBusy && !busy ? setTimeout(() => { repoll = null; refresh(); }, 2000) : null;
    }

    // Stop / Restart would end jobs ComfyUI is running: ask before going on with { force: true }
    async function confirmForce(action, reply) {
        const { showDialog } = await import('./components/myDialog.js');
        const message = text('ui_comfy_proc_confirm_busy', 'ComfyUI has {0} job(s) running or queued. Stop it anyway? That work is lost.')
            .replace('{0}', String(reply.jobs ?? '?'));
        const yesText = action === 'restart' ? text('ui_comfy_restart', 'Restart') : text('ui_comfy_stop', 'Stop');
        return showDialog('confirm', { message, yesText, noText: text('ui_comfy_proc_keep', 'Keep running') });
    }

    // The port is held by something SAA cannot tell is ComfyUI (a hung one, or one started
    // outside SAA): name the pid and the program, and end it only if the user says so.
    async function confirmUnverified(action, reply) {
        const { showDialog } = await import('./components/myDialog.js');
        const holders = (reply.holders ?? []).map(holder => `pid ${holder.pid} (${holder.name})`).join(', ');
        const message = text('ui_comfy_proc_confirm_unverified', 'The ComfyUI port is held by {0}, which does not answer as ComfyUI. End that process anyway?')
            .replace('{0}', holders || '?');
        const yesText = action === 'restart' ? text('ui_comfy_restart', 'Restart') : text('ui_comfy_stop', 'Stop');
        return showDialog('confirm', { message, yesText, noText: text('ui_comfy_proc_leave', 'Leave it alone') });
    }

    async function act(action, { force = false, unverified = false } = {}) {
        if (busy) {
            // Stop during a start or restart: the main process cancels the start and ends its launcher
            if (action !== 'stop' || busyAction === 'stop') return;
            if (status) status.textContent = text('ui_comfy_proc_stopping', 'stopping…');
            try {
                const reply = await api({ action: 'stop', force: true });
                if (!reply?.ok) console.warn(CAT, 'stop', reply?.message);
                if (!busy) paint(reply);   // the start's own reply (cancelled) came first
            } catch (error) {
                console.warn(CAT, 'stop', error?.message ?? error);
            }
            globalThis.uiShell?.pills?.refresh?.();
            return;
        }
        busy = true;
        busyAction = action;
        paint({ phase: action === 'stop' ? 'stopping' : 'starting', running: null });
        try {
            const reply = await api({ action, force, unverified });
            if (!reply?.ok) console.warn(CAT, action, reply?.message, reply?.log ?? '');
            busy = false;
            busyAction = '';
            paint(reply);
            if (reply?.needsConfirm && !force) {
                if (await confirmForce(action, reply)) await act(action, { force: true, unverified });
                return;
            }
            if (reply?.needsUnverified && !unverified) {
                if (await confirmUnverified(action, reply)) await act(action, { force: true, unverified: true });
                return;
            }
        } catch (error) {
            busy = false;
            busyAction = '';
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
    // `stop`: drop the pending re-poll (the tests, and anything that takes the row away)
    return { refresh, act, stop: () => { if (repoll) clearTimeout(repoll); repoll = null; } };
}
