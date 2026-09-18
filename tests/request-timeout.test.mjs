import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { armRequestTimeout } from '../scripts/main/requestTimeout.js';
import { STRUCTURED_REFINE_MIN_TIMEOUT, resolveChatTimeout } from '../scripts/main/ollamaSaaAdapter.js';

// The LLM request timeout: net.request never fires one of its own, so a stalled Ollama
// would hold the generation queue (and the Prose step in front of it) forever.

function fakeTimers() {
    const pending = new Map();
    let id = 0;
    return {
        setTimeout: (fn, ms) => { pending.set(++id, { fn, ms }); return id; },
        clearTimeout: handle => pending.delete(handle),
        run: () => { for (const [handle, { fn }] of [...pending]) { pending.delete(handle); fn(); } },
        get size() { return pending.size; },
        get delay() { return [...pending.values()][0]?.ms; },
    };
}

test('a request that goes quiet is answered and aborted when its time is up', () => {
    const timers = fakeTimers();
    const answers = [];
    let aborted = 0;
    armRequestTimeout({ timeout: 120000, onTimeout: ms => answers.push(ms), abort: () => { aborted++; }, timers });
    assert.equal(timers.delay, 120000);
    timers.run();
    assert.deepEqual(answers, [120000], 'the caller is told, in the shape requestLocal resolves with');
    assert.equal(aborted, 1, 'and the socket is dropped');
});

test('a request that answered on its own is never aborted afterwards', () => {
    const timers = fakeTimers();
    let aborted = 0;
    let answers = 0;
    const clear = armRequestTimeout({ timeout: 1000, onTimeout: () => { answers++; }, abort: () => { aborted++; }, timers });
    clear();
    assert.equal(timers.size, 0, 'the timer is gone');
    timers.run();
    assert.equal(answers, 0);
    assert.equal(aborted, 0);
});

test('clearing after a timeout changes nothing, and no limit means no timer', () => {
    const timers = fakeTimers();
    let aborted = 0;
    const clear = armRequestTimeout({ timeout: 10, onTimeout: () => {}, abort: () => { aborted++; }, timers });
    timers.run();
    clear();
    timers.run();
    assert.equal(aborted, 1, 'the abort happens once');
    for (const timeout of [0, undefined, null, 'soon', -5]) {
        const idle = fakeTimers();
        const stop = armRequestTimeout({ timeout, onTimeout: () => assert.fail('no limit was asked for'), abort: () => assert.fail('no limit'), timers: idle });
        assert.equal(idle.size, 0, String(timeout));
        stop();
        idle.run();
    }
});

test('both LLM requests arm their own timeout', () => {
    const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
    const backend = fs.readFileSync(path.join(root, 'scripts/main/remoteAI_backend.js'), 'utf8').replace(/\r\n/g, '\n');
    const bodyOf = name => {
        const start = backend.indexOf(`function ${name}(options) {`);
        assert.ok(start > 0, `${name} exists`);
        const next = backend.indexOf('\nfunction ', start + 1);
        return backend.slice(start, next < 0 ? backend.length : next);
    };
    for (const name of ['requestRemote', 'requestLocal']) {
        const body = bodyOf(name);
        assert.match(body, /const clearRequestTimeout = armRequestTimeout\(\{/, `${name} arms the timeout`);
        assert.match(body, /abort: \(\) => request\.abort\(\)/, `${name} drops the request when it runs out`);
        assert.ok(body.includes('clearRequestTimeout();'), `${name} clears it when the reply arrives`);
        assert.ok(!/setTimeout\(/.test(body), `${name} has no timer of its own left`);
    }
});

test('a structured Refine is given the time to write its answer; everything else keeps the card value', () => {
    const structured = { promptMode: 'Refine', editorFields: { common: 'a' }, generationContext: { positive: 'a' } };
    // the AI card's 10-300 s slider is sized for an Expand; a cut structured Refine loses the whole edit
    assert.equal(resolveChatTimeout({ timeout: 120000, ...structured }), STRUCTURED_REFINE_MIN_TIMEOUT);
    assert.equal(resolveChatTimeout({ timeout: 600000, ...structured }), 600000, 'a longer setting wins');
    assert.equal(resolveChatTimeout({ timeout: 120000, promptMode: 'Expand' }), 120000);
    assert.equal(resolveChatTimeout({ timeout: 120000, promptMode: 'Prose' }), 120000, 'Prose writes one paragraph');
    // a legacy Refine without the editor fields is the short generation-only request
    assert.equal(resolveChatTimeout({ timeout: 120000, promptMode: 'Refine' }), 120000);
    assert.equal(resolveChatTimeout({ timeout: 0, ...structured }), 0, 'no limit stays no limit');
    assert.equal(resolveChatTimeout({}), 0);
});
