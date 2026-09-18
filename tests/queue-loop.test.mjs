import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { startQueue } from '../scripts/renderer/generate.js';
import { callback_generate_cancel, callback_generate_skip, callback_generate_start, setQueueAutoStart } from '../scripts/renderer/callbacks.js';
import { setupQueue } from '../scripts/renderer/slots/myQueueSlot.js';
import { createRefineRunController, recordRefineRunCandidate } from '../scripts/renderer/tools/refineRunState.js';
import { createFakeDocument } from './helpers/fakeDom.mjs';

// Behaviour of the renderer queue loop (generate.js startQueue) with the backend stubbed at
// globalThis.api. FakeQueue keeps the slot order rules of slots/myQueueSlot.js (getFirstSlot
// / popJob / removeAll / removeFollowings) without its DOM; the second half of this file
// drives the real QueueManager, including its "−" button, on a fake DOM.
class FakeQueue {
    constructor() { this.slots = []; this.cancelFirst = false; }
    getFirstSlot() { this.cancelFirst = false; return this.slots[0] ?? null; }
    popJob(generateData) {
        this.cancelFirst = false;
        const index = this.slots.indexOf(generateData);
        if (index >= 0) this.slots.splice(index, 1);
        return this.slots[0] ?? null;
    }
    attach(_jobID, generateData) { this.slots.push(generateData); }
    removeAll() { this.slots.length = 0; }
    removeFollowings() { this.slots.length = Math.min(1, this.slots.length); }
    getSlotsCount() { return this.slots.length; }
}

const LANG = {
    generate_ai: 'ai', generate_start: '{0} {1}', ai_no_prompt_generate: '',
    gr_error_creating_image: 'Error {0} ({1})', run_button: 'Run', run_button_paused: 'Run (paused)',
};

function job(name, { regional = false } = {}) {
    const data = {
        name, seed: 1, negative: 'n',
        queueManager: { genType: 'normal', isRegional: regional, apiInterface: 'ComfyUI', loop: 0, loops: 1, aiInterface: 'None', aiRole: 0, aiOptions: {}, finalInfo: '', id: name },
    };
    if (regional) Object.assign(data, { positive_left: 'l', positive_right: 'r' });
    else data.positive = 'p';
    return data;
}

const flush = () => new Promise(resolve => setTimeout(resolve, 0));

// backend(name, call) answers runComfyUI / runComfyUI_Regional for the job `name`
function setup(backend) {
    const state = { runs: [], errors: [], runBarRefreshes: 0, clickable: [] };
    // The buttons keep the clickable state they were last given: a run that leaves Generate
    // clickable is a second click away from a double start, which is what state.enabled() reads.
    const button = name => ({
        clickable: true,
        setClickable(value) { this.clickable = value; state.clickable.push([name, value]); },
        setTitle() {},
    });
    state.enabled = () => Object.fromEntries(['single', 'batch', 'same', 'skip', 'cancel']
        .map(name => [name, globalThis.generate[`generate_${name}`].clickable]));
    globalThis.inBrowser = false;
    globalThis.inGenerating = false;
    globalThis.globalSettings = { language: 'en-US', generate_auto_start: true, css_style: 'dark', api_model_type: 'Checkpoint', scroll_to_last: false };
    globalThis.cachedFiles = { language: { 'en-US': LANG } };
    globalThis.generate = {
        cancelClicked: false, skipClicked: false, loadingMessage: '',
        showCancelButtons() {},
        keepGallery: { getValue: () => true },
        api_interface: { getValue: () => 'ComfyUI' },
        queueAutostart: { setValue() {} },
        generate_single: button('single'), generate_batch: button('batch'), generate_same: button('same'),
        generate_skip: button('skip'), generate_cancel: button('cancel'),
    };
    globalThis.mainGallery = {
        isLoading: false,
        showLoading() { this.isLoading = true; },
        hideLoading(message) { this.isLoading = false; if (message !== 'success') state.errors.push(message); },
        clearGallery() {},
        appendImageData() {},
    };
    globalThis.thumbGallery = { clear() {}, append() {} };
    globalThis.infoBox = { image: { clear() {}, appendValue() {} } };
    globalThis.overlay = { custom: { closeCustomOverlaysByGroup() {} }, buttons: { reload() {} } };
    globalThis.uiShell = { runBar: { refresh: () => { state.runBarRefreshes += 1; } } };
    globalThis.queueManager = new FakeQueue();
    const run = async data => { state.runs.push(data.name); return backend(data.name, state.runs.filter(name => name === data.name).length); };
    globalThis.api = {
        runComfyUI: run,
        runComfyUI_Regional: run,
        openWsComfyUI: async () => 'data:image/png;base64,AAAA',
        closeWsComfyUI() {},
        cancelComfyUI: async () => {},
    };
    return state;
}

const QUEUED = JSON.stringify({ prompt_id: 'p1' });

test('a job attached while the last image runs is taken by the same loop', async () => {
    let release;
    const state = setup(name => (name === 'A1' ? new Promise(resolve => { release = () => resolve(QUEUED); }) : QUEUED));
    globalThis.queueManager.attach('', job('A1'));
    const running = startQueue();
    await flush();
    globalThis.queueManager.attach('', job('B1'));   // a generate click during the final image
    await startQueue();                              // that click's own call returns: a loop is busy
    release();
    await running;
    assert.deepEqual(state.runs, ['A1', 'B1']);
    assert.equal(globalThis.queueManager.getSlotsCount(), 0);
    assert.equal(globalThis.inGenerating, false);
});

test('Skip with a job queued behind it ends the loop once: no restart, no stack overflow', async () => {
    let release;
    const state = setup(name => (name === 'A1' ? new Promise(resolve => { release = () => resolve(QUEUED); }) : QUEUED));
    globalThis.queueManager.attach('', job('A1'));
    const running = startQueue();
    await flush();
    // Skip, then a batch that was still building prompts attaches its first job
    globalThis.generate.skipClicked = true;
    globalThis.queueManager.removeFollowings();
    globalThis.queueManager.attach('', job('B1'));
    release();
    await running;   // used to recurse until "Maximum call stack size exceeded"
    assert.deepEqual(state.runs, ['A1']);
    assert.equal(globalThis.queueManager.getSlotsCount(), 1, 'the job behind the skip stays queued for the next click');
    assert.deepEqual(state.errors, []);
    assert.equal(globalThis.inGenerating, false);
});

for (const regional of [false, true]) {
    const label = regional ? 'Regional' : 'standard';
    test(`${label}: a queue-row delete while the backend prepares drops that job only and the loop goes on`, async () => {
        // "−" on the running row: the backend is cancelled, cancelClicked stays false
        const state = setup((name, call) => (name === 'A1' && call === 1 ? 'Error: Cancelled' : QUEUED));
        globalThis.queueManager.attach('', job('A1', { regional }));
        globalThis.queueManager.attach('', job('B1', { regional }));
        globalThis.queueManager.cancelFirst = true;
        await startQueue();
        assert.deepEqual(state.runs, ['A1', 'B1'], 'the deleted job is not run again');
        assert.equal(globalThis.queueManager.getSlotsCount(), 0);
        assert.equal(globalThis.queueManager.cancelFirst, false);
        assert.equal(globalThis.globalSettings.generate_auto_start, true);
        assert.deepEqual(state.errors, []);
    });

    test(`${label}: the Cancel button while the backend prepares stops the run and clears the queue`, async () => {
        const state = setup(name => {
            if (name !== 'A1') return QUEUED;
            globalThis.generate.cancelClicked = true;   // callback_generate_cancel landed mid-call
            return 'Error: Cancelled';
        });
        globalThis.queueManager.attach('', job('A1', { regional }));
        globalThis.queueManager.attach('', job('B1', { regional }));
        await startQueue();
        assert.deepEqual(state.runs, ['A1']);
        assert.equal(globalThis.queueManager.getSlotsCount(), 0);
        assert.deepEqual(state.errors, []);
    });
}

test('a backend error keeps the failed job, pauses auto-start, redraws the run bar and does not restart', async () => {
    const state = setup(() => 'Error: boom');
    globalThis.queueManager.attach('', job('A1'));
    globalThis.queueManager.attach('', job('B1'));
    await startQueue();
    assert.deepEqual(state.runs, ['A1']);
    assert.equal(globalThis.queueManager.getSlotsCount(), 2);
    assert.equal(globalThis.globalSettings.generate_auto_start, false);
    assert.equal(globalThis.generate.autoStartDisabledByError, true);
    assert.ok(state.runBarRefreshes > 0, 'the "auto-start on" pill follows the pause');
    assert.equal(state.errors.length, 1);
});

test('setQueueAutoStart redraws the run bar', () => {
    const state = setup(() => QUEUED);
    setQueueAutoStart(false);
    setQueueAutoStart(true);
    assert.equal(state.runBarRefreshes, 2);
});

test('Cancel with nothing running closes the overlay without an error and leaves the generate buttons alone', async () => {
    const state = setup(() => QUEUED);
    globalThis.mainGallery.isLoading = true;   // a click still building prompts shows the overlay
    globalThis.generate.loadingMessage = 'Creating prompts';
    globalThis.queueManager.attach('', job('A1'));
    await callback_generate_cancel();
    assert.equal(globalThis.generate.cancelClicked, true);
    assert.equal(globalThis.queueManager.getSlotsCount(), 0);
    assert.equal(globalThis.mainGallery.isLoading, false);
    assert.equal(globalThis.generate.loadingMessage, '');
    assert.deepEqual(state.errors, [], 'no "cancel" error overlay');
    assert.deepEqual(state.clickable.filter(([name]) => ['single', 'batch', 'same'].includes(name)), [],
        'a new click cannot reset cancelClicked while the cancelled click is still building prompts');
});

// ------------------------------------------------------------- the buttons of a running click
test('a generate click switches Generate / Batch / Same off for as long as the run lasts', async () => {
    const state = setup(() => QUEUED);
    // generateImage reads the backend address before anything else; an unconfigured backend
    // throws there, which is the path the "never leave the buttons disabled" finally exists for.
    globalThis.generate.api_address = { getValue() { throw new Error('backend not set'); } };
    const running = callback_generate_start('normal');
    // the click is in flight: a second Create Image / Batch / Same would be a double start
    assert.deepEqual(state.enabled(), { single: false, batch: false, same: false, skip: true, cancel: true },
        'the three generate buttons are off and Skip / Cancel are on while the run lasts');
    await running;
    assert.deepEqual(state.enabled(), { single: true, batch: true, same: true, skip: true, cancel: true },
        'a failed run gives the generate buttons back');
    assert.equal(state.errors.length, 1, 'the failure is reported once');
    assert.equal(globalThis.inGenerating, false);
});

test('Skip switches the Skip button off so a second click cannot skip the next job as well', () => {
    const state = setup(() => QUEUED);
    globalThis.queueManager.attach('', job('A1'));
    globalThis.queueManager.attach('', job('B1'));
    callback_generate_skip();
    assert.equal(state.enabled().skip, false, 'Skip is spent until the next job arms it again');
    assert.equal(globalThis.generate.skipClicked, true);
    assert.equal(globalThis.queueManager.getSlotsCount(), 1, 'only the jobs behind the running one are dropped');
    assert.equal(globalThis.globalSettings.generate_auto_start, true, 'the auto-start setting is put back afterwards');
});

test('Cancel switches both Skip and Cancel off and asks the backend to stop once', async () => {
    const state = setup(() => QUEUED);
    globalThis.inGenerating = true;   // an image is at the backend, so the cancel goes out
    globalThis.generate.nowAPI = 'ComfyUI';
    let cancels = 0;
    globalThis.api.cancelComfyUI = async () => { cancels += 1; };
    globalThis.queueManager.attach('', job('A1'));
    await callback_generate_cancel();
    assert.equal(state.enabled().skip, false, 'Skip cannot be pressed on a run that is already stopping');
    assert.equal(state.enabled().cancel, false, 'nor can Cancel a second time');
    assert.equal(globalThis.generate.cancelClicked, true);
    assert.equal(cancels, 1);
    assert.equal(globalThis.queueManager.getSlotsCount(), 0);
});

// ---------------------------------------------------------------- the real queue rows
// What the row's "−" button does to the rows is half of the behaviour: these drive the
// real QueueManager (slots/myQueueSlot.js) on a fake DOM, with a backend whose call stays
// pending (ComfyUI waiting to restart for the fast-mode flags, or sampling) until the test
// lets it answer - cancelled when something asked it to stop, an image otherwise.
const fakeDocument = createFakeDocument();
globalThis.document = fakeDocument;
globalThis.requestAnimationFrame = () => 0;   // the row textboxes are not under test
const queueContainer = fakeDocument.body.appendChild(fakeDocument.createElement('div'));
queueContainer.className = 'queue-container';
const realQueue = setupQueue('queue-container');

function setupRealQueue() {
    const state = setup(() => QUEUED);
    realQueue.removeAll();
    realQueue.cancelFirst = false;
    globalThis.queueManager = realQueue;
    let cancelMark = false;
    let pendingRun = null;
    const start = async data => {
        state.runs.push(data.name);
        cancelMark = false;   // every backend run clears its own cancel mark (generate_backend_comfyui.js)
        return new Promise(resolve => { pendingRun = resolve; });
    };
    globalThis.api = {
        runComfyUI: start,
        runComfyUI_Regional: start,
        openWsComfyUI: async () => 'data:image/png;base64,AAAA',
        closeWsComfyUI() {},
        cancelComfyUI: async () => { cancelMark = true; },
        cancelWebUI: async () => { cancelMark = true; },
        localAI: async () => JSON.stringify({ choices: [{ message: { content: 'a girl' } }] }),
    };
    state.attach = (name, options) => {
        const data = job(name, options);
        realQueue.attach([name, name], data);
        return data;
    };
    // the row's "−" button, through the real delegated click handler
    state.minus = async name => {
        const slotClass = realQueue.getSlots().find(cls => realQueue.getSlotValue(cls)?.name === name);
        assert.ok(slotClass, `no queue row for ${name}`);
        const [onClick] = queueContainer.listeners.get('click') ?? [];
        await onClick({ target: { closest: () => ({ dataset: { action: 'delete', slot: slotClass } }) } });
    };
    // let the pending backend call answer, over and over, until the loop is done
    state.finish = async running => {
        let done = false;
        running.then(() => { done = true; });
        for (let round = 0; round < 50 && !done; round++) {
            await flush();
            const resolve = pendingRun;
            pendingRun = null;
            resolve?.(cancelMark ? 'Error: Cancelled' : QUEUED);
        }
        await running;
    };
    state.queued = () => realQueue.getSlots().map(cls => realQueue.getSlotValue(cls).name);
    return state;
}

test('the real rows: "−" twice on the running job drops it alone, the jobs behind it still run', async () => {
    const state = setupRealQueue();
    const first = state.attach('A');
    state.attach('B');
    state.attach('C');
    const running = startQueue();
    await flush();
    await state.minus('A');   // asks the backend to stop and marks the job
    assert.equal(first.queueManager.dropped, true, 'the waiting steps (AI request, Prose) see the drop');
    await state.minus('A');   // impatient second click: the row goes at once
    await state.finish(running);
    assert.deepEqual(state.runs, ['A', 'B', 'C'], 'B is not swallowed by the pop of a row that is already gone');
    assert.deepEqual(state.queued(), []);
    assert.deepEqual(state.errors, []);
});

test('the real rows: "−" on another row after "−" on the running one removes that row, not the next job', async () => {
    const state = setupRealQueue();
    state.attach('A');
    state.attach('B');
    state.attach('C');
    const running = startQueue();
    await flush();
    await state.minus('A');
    await state.minus('C');   // used to delete the first row instead of this one
    assert.deepEqual(state.queued(), ['A', 'B']);
    await state.finish(running);
    assert.deepEqual(state.runs, ['A', 'B'], 'B runs, the deleted C does not');
    assert.deepEqual(state.queued(), []);
});

test('the real rows: Cancel, then a new generate click, keeps the new job and runs it', async () => {
    const state = setupRealQueue();
    state.attach('A');
    state.attach('B');
    const running = startQueue();
    await flush();
    await callback_generate_cancel();       // clears the queue, asks the backend to stop
    globalThis.generate.cancelClicked = false;   // callback_generate_start of the next click
    globalThis.generate.skipClicked = false;
    state.attach('N');
    await startQueue();                     // that click's own call returns: this loop is busy
    await state.finish(running);
    assert.deepEqual(state.runs, ['A', 'N'], 'the job queued after the cancel is not popped away');
    assert.deepEqual(state.queued(), []);
    assert.deepEqual(state.errors, []);
    assert.equal(globalThis.globalSettings.generate_auto_start, true);
});

for (const regional of [false, true]) {
    const label = regional ? 'Regional' : 'standard';
    test(`${label}: a job dropped while a step before the backend waits never reaches the backend`, async () => {
        const state = setupRealQueue();
        const first = state.attach('A', { regional });
        state.attach('B', { regional });
        // what "−" leaves behind when the AI request or the Prose paragraph is still running
        first.queueManager.dropped = true;
        const running = startQueue();
        await state.finish(running);
        assert.deepEqual(state.runs, ['B'], 'the dropped job is not generated');
        assert.deepEqual(state.queued(), []);
        assert.deepEqual(state.errors, []);
    });

    test(`${label}: Cancel while the AI request is still running stops before the backend`, async () => {
        const state = setupRealQueue();
        const data = state.attach('A', { regional });
        Object.assign(data.queueManager, {
            aiInterface: 'Local', aiRole: 2,
            aiOptions: { promptMode: 'Expand', apiUrl: 'http://127.0.0.1:11434/v1/chat/completions' },
        });
        let release;
        globalThis.api.localAI = () => new Promise(resolve => { release = resolve; });
        const running = startQueue();
        await flush();
        await callback_generate_cancel();   // lands while the LLM is still writing
        release(JSON.stringify({ choices: [{ message: { content: 'a girl' } }] }));
        await state.finish(running);
        assert.deepEqual(state.runs, [], 'no image is generated for a cancelled job');
        assert.deepEqual(state.queued(), []);
        assert.deepEqual(state.errors, []);
    });
}

test('a job dropped with "−" ends its Refine run as a cancel, so nothing is auto-applied', async () => {
    const state = setupRealQueue();
    const controller = createRefineRunController({ role: 2, runSame: false, total: 1, snapshot: { fields: {} } });
    recordRefineRunCandidate(controller, {
        format: 'v3', validForEditorApply: true, changes: 'tighter',
        editorFields: { common: 'c', positive: 'p', negative: 'n' },
    });
    const data = state.attach('A');
    data.queueManager.refineRun = controller;
    data.queueManager.structuredRefine = true;
    const running = startQueue();
    await flush();
    await state.minus('A');
    await state.finish(running);
    assert.deepEqual(state.runs, ['A']);
    assert.equal(controller.decision.reason, 'cancel');
    assert.equal(controller.decision.autoApply, false, 'no image was made: its Refine answer is not applied by itself');
});

test('Skip keeps an image that was still being built out of the queue', () => {
    // generateImage / generateRegionalImage need the whole prompt UI, so this is pinned at
    // the source: the attach guard covers Skip as well as Cancel in both build loops.
    const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
    for (const path of ['scripts/renderer/generate.js', 'scripts/renderer/generate_regional.js']) {
        const source = read(path);
        assert.match(source, /if\(globalThis\.generate\.cancelClicked \|\| globalThis\.generate\.skipClicked\)\r?\n\s*break;/,
            `${path}: the queued image is dropped on Skip too`);
    }
});
