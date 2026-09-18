import assert from 'node:assert/strict';
import test from 'node:test';
import v8 from 'node:v8';
import vm from 'node:vm';

// myTextbox.js height adjusters with just enough DOM for setupTextbox: the batched window
// resize, textboxes taken out of the page, and whether a removed textbox can be collected.

v8.setFlagsFromString('--expose-gc');
const gc = vm.runInNewContext('gc');

const windowListeners = new Map();
const containers = new Map();
let frames = [];

function fakeElement(extra = {}) {
    const listeners = new Map();
    return {
        style: {}, dataset: {}, value: '', placeholder: '', title: '', isConnected: true,
        addEventListener: (type, fn) => listeners.set(type, fn),
        dispatchEvent: event => listeners.get(event.type)?.(event),
        ...extra,
    };
}

function fakeContainer(id) {
    const textarea = fakeElement({ scrollHeight: 100 });
    const container = {
        textarea,
        set innerHTML(_html) { /* setupTextbox's markup: the parts are handed out below */ },
        querySelector: selector => {
            if (selector.endsWith('-textarea')) return textarea;
            if (selector.endsWith('-resize-handle')) return fakeElement();
            return null;
        },
    };
    containers.set(`.${id}`, container);
    return container;
}

globalThis.document = { querySelector: selector => containers.get(selector) ?? null, styleSheets: [] };
globalThis.addEventListener = (type, fn) => windowListeners.set(type, fn);
globalThis.dispatchEvent = event => windowListeners.get(event.type)?.(event);
globalThis.requestAnimationFrame = callback => { frames.push(callback); return frames.length; };
globalThis.getComputedStyle = element => ({ lineHeight: element.isConnected ? '20px' : '' });
globalThis.innerHeight = 1000;

const { setupTextbox } = await import('../scripts/renderer/components/myTextbox.js');

const runFrames = () => { const pending = frames; frames = []; for (const callback of pending) callback(); };
const settle = () => new Promise(resolve => setTimeout(resolve, 5));

test('a window resize re-measures connected textboxes and leaves detached ones at their height', async () => {
    const shown = fakeContainer('box-shown');
    const detached = fakeContainer('box-detached');
    setupTextbox('box-shown', 'shown', { minLines: 2, maxLines: 20 });
    setupTextbox('box-detached', 'detached', { minLines: 2, maxLines: 20 });
    await settle();   // the initial setTimeout adjustment
    assert.equal(shown.textarea.style.height, '100px');
    assert.equal(detached.textarea.style.height, '100px');

    shown.textarea.scrollHeight = 200;
    detached.textarea.isConnected = false;   // e.g. a Scene row the layout has taken out
    detached.textarea.scrollHeight = 0;
    globalThis.dispatchEvent({ type: 'resize' });
    runFrames();
    assert.equal(shown.textarea.style.height, '200px');
    assert.equal(detached.textarea.style.height, '100px', 'not collapsed to the minimum while out of the page');
});

test('a textbox dropped with its row (queue slot, deleted custom field) can be garbage collected', async () => {
    let container = fakeContainer('box-removed');
    let control = setupTextbox('box-removed', 'removed', { minLines: 2, maxLines: 1 });
    await settle();
    const collected = new WeakRef(container.textarea);
    containers.delete('.box-removed');
    container = null;
    control = null;
    for (let round = 0; round < 10 && collected.deref(); round++) {
        await settle();
        gc();
    }
    assert.equal(collected.deref(), undefined, 'the resize registry no longer keeps the textbox alive');
    globalThis.dispatchEvent({ type: 'resize' });
    assert.doesNotThrow(runFrames);
});
