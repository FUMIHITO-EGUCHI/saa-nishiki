// The Settings > Backend "ComfyUI process" row (scripts/renderer/comfyProcessControl.js) on the
// fake DOM: which buttons a reply leaves usable, and the confirmations it asks for before a Stop
// ends something. The IPC is a stub that records the calls; myDialog is stubbed through a module
// hook (the real one draws into the page).
import assert from 'node:assert/strict';
import module from 'node:module';
import test from 'node:test';

import { withFakeDom } from './helpers/fakeDom.mjs';

const dialogs = { answers: [], asked: [] };
globalThis.__comfyPanelDialogs = dialogs;
const DIALOG_STUB = `
    const state = globalThis.__comfyPanelDialogs;
    export function showDialog(type, options) {
        state.asked.push({ type, ...options });
        return Promise.resolve(state.answers.shift() ?? false);
    }`;
module.registerHooks({
    resolve(specifier, context, nextResolve) {
        if (specifier.endsWith('components/myDialog.js') && String(context.parentURL ?? '').endsWith('/comfyProcessControl.js')) {
            return { url: `data:text/javascript,${encodeURIComponent(DIALOG_STUB)}`, shortCircuit: true };
        }
        return nextResolve(specifier, context);
    },
});
const { setupComfyProcessControl } = await import('../scripts/renderer/comfyProcessControl.js');

// the panel as index_electron.html has it: three buttons, a status line and a pill
function buildPanel(document) {
    const panel = document.createElement('div');
    panel.className = 'comfy-proc-panel';
    const parts = {};
    for (const name of ['start', 'stop', 'restart']) {
        const button = document.createElement('button');
        button.className = `comfy-proc-${name}`;
        panel.appendChild(button);
        parts[name] = button;
    }
    const status = document.createElement('div');
    status.className = 'comfy-proc-status';
    panel.appendChild(status);
    const pill = document.createElement('div');
    pill.className = 'comfy-proc-pill';
    pill.appendChild(document.createElement('span'));
    panel.appendChild(pill);
    document.body.appendChild(panel);
    return { panel, status, pill, ...parts };
}

// `replies` answers each call in turn (or a function of the call)
async function withPanel(replies, body) {
    dialogs.answers = [];
    dialogs.asked = [];
    const calls = [];
    const api = async args => {
        calls.push(args);
        const reply = typeof replies === 'function' ? replies(args, calls.length) : replies[Math.min(calls.length - 1, replies.length - 1)];
        return reply;
    };
    await withFakeDom(async document => {
        const parts = buildPanel(document);
        const control = setupComfyProcessControl();
        try {
            await new Promise(resolve => setTimeout(resolve, 0));   // the row refreshes itself once
            await body({ ...parts, control, calls, api });
        } finally {
            control.stop();   // the row would look again in two seconds while the phase is busy
        }
    }, { api: { comfyProcess: args => api(args) } });
}

test('a launch SAA started by itself leaves Stop usable: it is the only way to cancel it', async () => {
    await withPanel([{ ok: true, action: 'state', phase: 'starting', running: false, port: 8188 }], async ({ start, stop, restart, status, pill, control }) => {
        await control.refresh();
        assert.equal(stop.disabled, false, 'Stop cancels the start');
        assert.equal(start.disabled, true);
        assert.equal(restart.disabled, true);
        assert.equal(status.textContent, 'starting…');
        assert.equal(pill.classList.contains('is-busy'), true);
    });
});

test('an idle backend leaves Start or Stop usable by what is running', async () => {
    await withPanel([{ ok: true, action: 'state', phase: 'idle', running: true, port: 8188 }], async ({ start, stop, control }) => {
        await control.refresh();
        assert.equal(start.disabled, true, 'it is already up');
        assert.equal(stop.disabled, false);
    });
    await withPanel([{ ok: true, action: 'state', phase: 'idle', running: false, port: 8188 }], async ({ start, stop, control }) => {
        await control.refresh();
        assert.equal(start.disabled, false);
        assert.equal(stop.disabled, true);
    });
});

test('Stop asks about a program it cannot verify, and only then ends it', async () => {
    const replies = (args, index) => {
        if (args.action === 'state') return { ok: true, action: 'state', phase: 'idle', running: true, port: 8188 };
        if (index === 2) return { ok: false, action: 'stop', needsUnverified: true, running: false, holders: [{ pid: 4321, name: 'python.exe' }], message: 'held by pid 4321 (python.exe)' };
        return { ok: true, action: 'stop', running: false, message: 'ComfyUI stopped (pid 4321)' };
    };
    await withPanel(replies, async ({ control, calls }) => {
        dialogs.answers = [true];
        await control.act('stop');
        assert.equal(dialogs.asked.length, 1, 'the user is asked once');
        assert.match(dialogs.asked[0].message, /pid 4321 \(python\.exe\)/, 'the pid and the program are named');
        const stops = calls.filter(call => call.action === 'stop');
        assert.deepEqual(stops.map(call => call.unverified), [false, true], 'the second Stop carries the permission');
    });
});

test('a Stop the user does not allow ends nothing', async () => {
    const replies = args => (args.action === 'state'
        ? { ok: true, action: 'state', phase: 'idle', running: true, port: 8188 }
        : { ok: false, action: 'stop', needsUnverified: true, running: false, holders: [{ pid: 4321, name: 'python.exe' }], message: 'held by pid 4321 (python.exe)' });
    await withPanel(replies, async ({ control, calls }) => {
        dialogs.answers = [false];
        await control.act('stop');
        assert.equal(dialogs.asked.length, 1);
        assert.equal(calls.filter(call => call.action === 'stop').length, 1, 'no second Stop');
    });
});

test('the busy confirm still asks about running jobs first', async () => {
    const replies = (args, index) => {
        if (args.action === 'state') return { ok: true, action: 'state', phase: 'idle', running: true, port: 8188 };
        if (index === 2) return { ok: false, action: 'restart', needsConfirm: true, jobs: 2, running: true, message: 'ComfyUI has 2 job(s) running or queued' };
        return { ok: true, action: 'restart', running: true, message: 'ComfyUI is up' };
    };
    await withPanel(replies, async ({ control, calls }) => {
        dialogs.answers = [true];
        await control.act('restart');
        assert.match(dialogs.asked[0].message, /2 job\(s\)/);
        const restarts = calls.filter(call => call.action === 'restart');
        assert.deepEqual(restarts.map(call => call.force), [false, true]);
    });
});
