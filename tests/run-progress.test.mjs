import assert from 'node:assert/strict';
import test from 'node:test';

import { formatElapsed, parseLoadingMessage, setupRunProgress } from '../scripts/renderer/components/runProgress.js';
import { withFakeDom } from './helpers/fakeDom.mjs';

test('loading messages from generate.js are split into label, step/total and extra lines', () => {
  assert.deepEqual(parseLoadingMessage('148ad401\n[2/4] <6/22>'), { label: '[2/4]', step: 6, total: 22, extra: '148ad401' });
  assert.deepEqual(parseLoadingMessage('Wait for AI promot ...'), { label: 'Wait for AI promot ...', step: null, total: null, extra: '' });
  assert.deepEqual(parseLoadingMessage('Creating prompts 1/4……'), { label: 'Creating prompts 1/4……', step: null, total: null, extra: '' });
  assert.deepEqual(parseLoadingMessage(null), { label: '', step: null, total: null, extra: '' });
  assert.deepEqual(parseLoadingMessage('MiraITU: 123\n1024x1024 -> 2048x2048\n <3/10>'), { label: '1024x1024 -> 2048x2048', step: 3, total: 10, extra: 'MiraITU: 123' });
});

test('elapsed time formatting', () => {
  assert.equal(formatElapsed(0), '0 s');
  assert.equal(formatElapsed(59_900), '59 s');
  assert.equal(formatElapsed(102_000), '1 m 42 s');
  assert.equal(formatElapsed(-5), '0 s');
});

test('a backend wait reads from the language key, else the English template', async () => {
    const { formatBackendStatus } = await import('../scripts/renderer/components/runProgress.js');
    const status = { key: 'ui_fast_restart_status', text: 'Restarting ComfyUI with launch flags: {0}', args: ['--use-sage-attention --fast'] };
    assert.equal(formatBackendStatus(status), 'Restarting ComfyUI with launch flags: --use-sage-attention --fast');
    assert.equal(formatBackendStatus(status, { ui_fast_restart_status: '重启：{0}' }), '重启：--use-sage-attention --fast');
    assert.equal(formatBackendStatus({ key: 'x', text: '{0} of {1}', args: [2] }), '2 of ');
    assert.equal(formatBackendStatus(null), '');
    assert.equal(formatBackendStatus('text'), '');
});

test('the ComfyUI process line names the fast-mode flags a running backend has', async () => {
    const { describeComfyProcess } = await import('../scripts/renderer/comfyProcessControl.js');
    const t = (key, fallback) => fallback;
    assert.equal(describeComfyProcess({ ok: true, action: 'state', phase: 'idle', running: true, fastFlags: ['--use-sage-attention', '--fast'] }, t),
        'flags: --use-sage-attention --fast');
    assert.equal(describeComfyProcess({ ok: true, action: 'state', phase: 'idle', running: true, fastFlags: [] }, t), '');
    assert.equal(describeComfyProcess({ ok: true, action: 'state', phase: 'idle', running: false, fastFlags: ['--fast'] }, t), '');
});

// ---------------------------------------------------------------- the run bar on a fake DOM
// The row mirrors the legacy overlays (#cg-loading-overlay / #cg-error-overlay) that
// generate.js still drives; the MutationObserver that watches for them is stubbed and
// refresh() stands in for a mutation batch.
const RUN_GLOBALS = { MutationObserver: class { observe() {} disconnect() {} } };

function overlay(document, id, message) {
    const element = document.body.appendChild(document.createElement('div'));
    element.id = id;
    if (message !== undefined) {
        const pre = element.appendChild(document.createElement('pre'));
        pre.textContent = message;
    }
    return element;
}

function runBar(document, text = {}) {
    const root = document.body.appendChild(document.createElement('div'));
    const bar = setupRunProgress({ root, text });
    return {
        bar,
        root,
        row: root.querySelector('.run-progress-row'),
        title: root.querySelector('.run-progress-title'),
        timer: root.querySelector('.run-progress-timer'),
        fill: root.querySelector('.run-progress-bar i'),
        errorRow: root.querySelector('.run-error-row'),
        errorText: root.querySelector('.run-error-text'),
        errorHint: root.querySelector('.run-error-hint'),
        errorButton: root.querySelector('.run-error-details'),
    };
}

test('the run bar needs a root: without one there is nothing to set up', async () => {
    await withFakeDom(async document => {
        assert.equal(setupRunProgress(), null);
        assert.equal(setupRunProgress({}), null);
        assert.equal(setupRunProgress({ root: null, text: {} }), null);
        const { bar } = runBar(document);
        assert.notEqual(bar, null, 'a root does give a run bar');
        bar.destroy();
    }, RUN_GLOBALS);
});

test('the run bar title: a backend wait speaks over the queue label, which speaks over "Generating…"', async t => {
    t.mock.timers.enable({ apis: ['setInterval', 'Date'] });
    await withFakeDom(async document => {
        const { bar, row, title, fill } = runBar(document, { generating: 'Generating…' });
        globalThis.generate = { loadingMessage: '', backendStatus: '' };
        overlay(document, 'cg-loading-overlay');
        bar.refresh();
        assert.equal(row.hidden, false, 'the progress row is shown while the run lasts');
        assert.equal(title.textContent, 'Generating…', 'nothing to say yet: the placeholder');

        globalThis.generate.loadingMessage = '148ad401\n[2/4] <6/22>';
        t.mock.timers.tick(250);
        assert.equal(title.textContent, '[2/4]', 'the parsed queue label');
        assert.equal(title.title, '148ad401', 'the rest of the message is the tooltip');
        assert.equal(fill.style.width, '27%');

        globalThis.generate.backendStatus = 'Restarting ComfyUI with launch flags: --fast';
        t.mock.timers.tick(250);
        assert.equal(title.textContent, 'Restarting ComfyUI with launch flags: --fast',
            'a backend wait speaks over the queue label for as long as it lasts');

        globalThis.generate.backendStatus = '';
        t.mock.timers.tick(250);
        assert.equal(title.textContent, '[2/4]', 'and the queue label comes back when it is over');
        bar.destroy();
    }, RUN_GLOBALS);
});

test('the run bar ticks every 250 ms, not sooner and not later', async t => {
    t.mock.timers.enable({ apis: ['setInterval', 'Date'] });
    await withFakeDom(async document => {
        const { bar, title } = runBar(document);
        globalThis.generate = { loadingMessage: 'first', backendStatus: '' };
        overlay(document, 'cg-loading-overlay');
        bar.refresh();
        assert.equal(title.textContent, 'first', 'the first tick is the start itself, not a wait');

        globalThis.generate.loadingMessage = 'second';
        t.mock.timers.tick(249);
        assert.equal(title.textContent, 'first', 'nothing has ticked yet');
        t.mock.timers.tick(1);
        assert.equal(title.textContent, 'second');
        bar.destroy();
    }, RUN_GLOBALS);
});

test('the run bar starts one ticker per run and takes the row away when the run stops', async t => {
    t.mock.timers.enable({ apis: ['setInterval', 'Date'] });
    await withFakeDom(async document => {
        const { bar, root, row, title } = runBar(document);
        globalThis.generate = { loadingMessage: 'first', backendStatus: '' };
        const loading = overlay(document, 'cg-loading-overlay');
        bar.refresh();
        bar.refresh();   // a second mutation batch for the same run
        assert.equal(bar.isRunning(), true);
        assert.equal(root.classList.contains('is-running'), true);

        globalThis.generate.backendStatus = 'Restarting ComfyUI';   // a restart that never reported back
        loading.remove();
        bar.refresh();
        assert.equal(bar.isRunning(), false);
        assert.equal(row.hidden, true, 'the progress row is hidden again');
        assert.equal(root.classList.contains('is-running'), false);
        assert.equal(globalThis.generate.backendStatus, '', 'a restart that never sent its "done" is cleared');

        globalThis.generate.loadingMessage = 'after the stop';
        t.mock.timers.tick(5000);
        assert.equal(title.textContent, 'first', 'the second refresh left no ticker of its own behind');
        bar.destroy();
    }, RUN_GLOBALS);
});

test('the run bar error row follows the error overlay and goes away with it', async () => {
    await withFakeDom(async document => {
        const { bar, root, errorRow, errorText, errorHint, errorButton } =
            runBar(document, { errorHint: 'Queue paused', details: 'Details' });
        globalThis.generate = { loadingMessage: '', backendStatus: '' };
        assert.equal(errorRow.hidden, true, 'nothing failed yet');

        const error = overlay(document, 'cg-error-overlay', '\n  HTTPError: 500 boom\n  at run (generate.js:1)');
        bar.refresh();
        assert.equal(errorRow.hidden, false);
        assert.equal(errorText.textContent, 'HTTPError: 500 boom', 'the first non-empty line of the overlay');
        assert.equal(errorHint.textContent, 'Queue paused');
        assert.equal(errorButton.textContent, 'Details');
        assert.equal(root.classList.contains('is-error'), true);

        errorButton.click();
        assert.equal(error.classList.contains('is-revealed'), true, 'Details reveals the overlay');

        error.remove();
        bar.refresh();
        assert.equal(errorRow.hidden, true, 'the error row goes with the overlay');
        assert.equal(root.classList.contains('is-error'), false);
        bar.destroy();
    }, RUN_GLOBALS);
});
