import assert from 'node:assert/strict';
import test from 'node:test';
import { createAutosave, createSettingsProxy } from '../scripts/renderer/tools/settingsAutosave.js';

function fakeTimers() {
    const queue = [];
    let next = 1;
    return {
        setTimer(fn, ms) { const handle = next++; queue.push({ handle, fn, ms }); return handle; },
        clearTimer(handle) { const index = queue.findIndex(entry => entry.handle === handle); if (index >= 0) queue.splice(index, 1); },
        async run() { while (queue.length) { const { fn } = queue.shift(); await fn(); } },
        size: () => queue.length,
    };
}

function harness(overrides = {}) {
    const timers = fakeTimers();
    const saved = [];
    const store = { cfg: 7, api_prompt: 'x', lora_slot: [], api_addr: '127.0.0.1:8189' };
    const autosave = createAutosave({
        collect: section => ({ section, snapshot: { ...store } }),
        save: async payload => { saved.push(payload); return true; },
        saveSync: payload => { saved.push({ sync: true, ...payload }); return true; },
        setTimer: timers.setTimer,
        clearTimer: timers.clearTimer,
        log: { error() {} },
        ...overrides,
    });
    return { timers, saved, store, autosave };
}

test('nothing is recorded until the autosave is enabled', () => {
    const { autosave, timers } = harness();
    assert.equal(autosave.markDirty('cfg'), false);
    assert.deepEqual(autosave.pending(), []);
    autosave.enable();
    assert.equal(autosave.markDirty('cfg'), true);
    assert.deepEqual(autosave.pending(), ['generation']);
    assert.equal(timers.size(), 1);
});

test('keys map to sections, unknown keys are ignored, and one debounced save carries all dirty sections', async () => {
    const { autosave, timers, saved } = harness();
    autosave.enable();
    autosave.markDirty('cfg');
    autosave.markDirty('api_prompt');
    autosave.markDirty('lora');
    assert.equal(autosave.markDirty('lastLoadedSettings'), false);
    assert.equal(timers.size(), 1, 'debounce timer is replaced, not stacked');
    await timers.run();
    assert.equal(saved.length, 1);
    assert.deepEqual(Object.keys(saved[0]).sort(), ['generation', 'lora', 'prompt']);
    assert.equal(saved[0].generation.section, 'generation');
    assert.deepEqual(autosave.pending(), []);
    assert.equal(autosave.saveCount(), 1);
});

test('a failed save keeps the sections dirty for the next flush', async () => {
    let fail = true;
    const errors = [];
    const { autosave, timers, saved } = harness({
        save: async payload => { if (fail) throw new Error('disk'); saved.push(payload); return true; },
        onError: (error, sections) => errors.push({ message: error.message, sections }),
    });
    autosave.enable();
    autosave.markDirty('api_addr');
    await timers.run();
    assert.equal(saved.length, 0);
    assert.deepEqual(autosave.pending(), ['app']);
    assert.deepEqual(errors, [{ message: 'disk', sections: ['app'] }]);
    fail = false;
    assert.equal(await autosave.flush(), true);
    assert.equal(saved.length, 1);
    assert.deepEqual(Object.keys(saved[0]), ['app']);
});

test('flushSync drains the queue synchronously for beforeunload', () => {
    const { autosave, timers, saved } = harness();
    autosave.enable();
    autosave.markDirty('ad_slot');
    assert.equal(autosave.flushSync(), true);
    assert.equal(timers.size(), 0, 'pending timer cancelled');
    assert.equal(saved.length, 1);
    assert.equal(saved[0].sync, true);
    assert.ok('adetailer' in saved[0]);
    assert.equal(autosave.flushSync(), true, 'nothing left is a success');
});

test('createSettingsProxy reports every string key written or deleted', () => {
    const seen = [];
    const raw = { cfg: 7 };
    const proxy = createSettingsProxy(raw, key => seen.push(key));
    proxy.cfg = 5;
    proxy.api_prompt = '1girl';
    Object.assign(proxy, { step: 20 });
    delete proxy.api_prompt;
    assert.deepEqual(seen, ['cfg', 'api_prompt', 'step', 'api_prompt']);
    assert.deepEqual(raw, { cfg: 5, step: 20 });
    assert.deepEqual({ ...proxy }, { cfg: 5, step: 20 }, 'spread works through the proxy');
});
