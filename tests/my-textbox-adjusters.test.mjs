import assert from 'node:assert/strict';
import test from 'node:test';
import v8 from 'node:v8';
import vm from 'node:vm';

// myTextbox.js height adjusters with just enough DOM for setupTextbox: the batched window
// resize, textboxes taken out of the page, whether a removed textbox can be collected, the
// cached line height, the single-line box and the drag handle.

v8.setFlagsFromString('--expose-gc');
const gc = vm.runInNewContext('gc');

const windowListeners = new Map();
const documentListeners = new Map();
const containers = new Map();
const computed = { reads: 0 };
let frames = [];

function fakeElement(extra = {}) {
    const listeners = new Map();
    return {
        style: {}, dataset: {}, value: '', placeholder: '', title: '', isConnected: true,
        addEventListener: (type, fn) => {
            if (!listeners.has(type)) listeners.set(type, []);
            listeners.get(type).push(fn);
        },
        removeEventListener: (type, fn) => {
            listeners.set(type, (listeners.get(type) ?? []).filter(entry => entry !== fn));
        },
        dispatchEvent: event => {
            for (const fn of [...(listeners.get(event.type) ?? [])]) fn(event);
            return true;
        },
        ...extra,
    };
}

// A textarea that records what was written to style.height and counts the scrollHeight
// reads: the three-phase adjustment is about which of those happen, and when.
function fakeTextarea() {
    const heightWrites = [];
    let scrollHeight = 100;
    const textarea = fakeElement({
        heightWrites,
        scrollHeightReads: 0,
        style: new Proxy({}, {
            set(target, key, value) {
                if (key === 'height') heightWrites.push(value);
                target[key] = value;
                return true;
            },
        }),
    });
    Object.defineProperty(textarea, 'scrollHeight', {
        configurable: true,
        enumerable: true,
        get() { textarea.scrollHeightReads += 1; return scrollHeight; },
        set(value) { scrollHeight = value; },
    });
    return textarea;
}

function fakeContainer(id) {
    const textarea = fakeTextarea();
    const handle = fakeElement();
    const container = {
        textarea,
        handle,
        set innerHTML(_html) { /* setupTextbox's markup: the parts are handed out below */ },
        querySelector: selector => {
            if (selector.endsWith('-textarea')) return textarea;
            if (selector.endsWith('-resize-handle')) return handle;
            return null;
        },
    };
    containers.set(`.${id}`, container);
    return container;
}

globalThis.document = {
    querySelector: selector => containers.get(selector) ?? null,
    styleSheets: [],
    addEventListener: (type, fn) => {
        if (!documentListeners.has(type)) documentListeners.set(type, []);
        documentListeners.get(type).push(fn);
    },
    removeEventListener: (type, fn) => {
        documentListeners.set(type, (documentListeners.get(type) ?? []).filter(entry => entry !== fn));
    },
};
globalThis.addEventListener = (type, fn) => windowListeners.set(type, fn);
globalThis.dispatchEvent = event => windowListeners.get(event.type)?.(event);
globalThis.requestAnimationFrame = callback => { frames.push(callback); return frames.length; };
globalThis.getComputedStyle = element => {
    computed.reads += 1;
    return { lineHeight: element.computedLineHeight ?? (element.isConnected ? '20px' : '') };
};
globalThis.innerHeight = 1000;

const { setupTextbox } = await import('../scripts/renderer/components/myTextbox.js');

const runFrames = () => { const pending = frames; frames = []; for (const callback of pending) callback(); };
const settle = () => new Promise(resolve => setTimeout(resolve, 5));
const documentTypes = () => [...documentListeners].filter(([, fns]) => fns.length > 0).map(([type]) => type).sort();
const fireDocument = (type, event = {}) => { for (const fn of [...(documentListeners.get(type) ?? [])]) fn({ type, ...event }); };

function press(element, key) {
    let prevented = false;
    element.dispatchEvent({ type: 'keydown', key, preventDefault() { prevented = true; } });
    return prevented;
}

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

test('a burst of resizes is coalesced into one frame, and the next burst gets a frame of its own', async () => {
    fakeContainer('box-batch');
    setupTextbox('box-batch', 'batch', { minLines: 2, maxLines: 20 });
    await settle();

    frames = [];
    globalThis.dispatchEvent({ type: 'resize' });
    globalThis.dispatchEvent({ type: 'resize' });
    globalThis.dispatchEvent({ type: 'resize' });
    assert.equal(frames.length, 1, 'three resizes, one measuring frame');

    runFrames();
    globalThis.dispatchEvent({ type: 'resize' });
    assert.equal(frames.length, 1, 'the frame that ran freed the slot');
    runFrames();
});

test('the resize batch releases every height before it reads any of them', async () => {
    const first = fakeContainer('box-phase-1');
    const second = fakeContainer('box-phase-2');
    setupTextbox('box-phase-1', 'one', { minLines: 2, maxLines: 20 });
    setupTextbox('box-phase-2', 'two', { minLines: 2, maxLines: 20 });
    await settle();

    // the reads are ordered against the writes by recording both on one list
    const order = [];
    for (const box of [first, second]) {
        Object.defineProperty(box.textarea, 'scrollHeight', {
            configurable: true,
            get() { order.push(`read ${box.textarea.placeholder}`); return 160; },
        });
        box.textarea.style = new Proxy({}, {
            set(target, key, value) {
                if (key === 'height') order.push(`write ${box.textarea.placeholder} ${value}`);
                target[key] = value;
                return true;
            },
        });
        box.textarea.placeholder = box === first ? 'one' : 'two';
    }
    globalThis.dispatchEvent({ type: 'resize' });
    runFrames();
    assert.deepEqual(order, [
        'write one auto', 'write two auto',
        'read one', 'read two',
        'write one 160px', 'write two 160px',
    ], 'two textboxes cost one layout, not two');
});

test('the line height is measured once per textbox and dropped again on a resize', async () => {
    const box = fakeContainer('box-cache');
    setupTextbox('box-cache', 'cache', { minLines: 2, maxLines: 20 });
    await settle();

    computed.reads = 0;
    box.textarea.dispatchEvent({ type: 'input' });
    box.textarea.dispatchEvent({ type: 'input' });
    box.textarea.dispatchEvent({ type: 'input' });
    assert.equal(computed.reads, 0, 'typing never asks for the computed style again');

    globalThis.dispatchEvent({ type: 'resize' });
    runFrames();
    computed.reads = 0;
    box.textarea.dispatchEvent({ type: 'input' });
    assert.equal(computed.reads, 0, 'the resize batch measured it again and cached that');
});

test('an unresolved line height (a box with no layout of its own) is measured again every time', async () => {
    const box = fakeContainer('box-nolayout');
    setupTextbox('box-nolayout', 'nolayout', { minLines: 2, maxLines: 20 });
    await settle();

    box.textarea.computedLineHeight = '';   // what a box without a layout box reports
    globalThis.dispatchEvent({ type: 'resize' });
    runFrames();
    computed.reads = 0;
    box.textarea.dispatchEvent({ type: 'input' });
    assert.equal(computed.reads, 1, 'nothing worth caching came back, so it is asked again');
    box.textarea.dispatchEvent({ type: 'input' });
    assert.equal(computed.reads, 2);
    assert.equal(box.textarea.style.height, '100px', 'and the fallback line height is still 20px');

    // once it is in the page again the answer is cached as usual
    box.textarea.computedLineHeight = undefined;
    globalThis.dispatchEvent({ type: 'resize' });
    runFrames();
    computed.reads = 0;
    box.textarea.dispatchEvent({ type: 'input' });
    assert.equal(computed.reads, 0);
});

test('a single-line box is one line high, is never measured against its content, and swallows Enter', async () => {
    const one = fakeContainer('box-single');
    const many = fakeContainer('box-multi');
    one.textarea.scrollHeight = 500;   // it holds a long line
    setupTextbox('box-single', 'single', { minLines: 1, maxLines: 1 });
    setupTextbox('box-multi', 'multi', { minLines: 2, maxLines: 20 });
    await settle();
    one.textarea.scrollHeightReads = 0;

    assert.deepEqual(one.textarea.heightWrites, ['20px'], 'straight to one line: no height:auto pass');
    assert.equal(one.textarea.style.overflowY, 'hidden', 'a single-line box never scrolls itself');
    assert.equal(one.textarea.scrollHeightReads, 0, 'there is nothing to measure against');

    assert.equal(press(one.textarea, 'Enter'), true, 'Enter would leave a line break in a one-line box');
    assert.equal(press(one.textarea, 'a'), false, 'every other key is typing');
    assert.equal(press(many.textarea, 'Enter'), false, 'a multi-line box takes line breaks');

    // it stays one line however much is typed into it
    one.textarea.heightWrites.length = 0;
    one.textarea.scrollHeight = 900;
    one.textarea.dispatchEvent({ type: 'input' });
    assert.deepEqual(one.textarea.heightWrites, ['20px']);
    assert.equal(one.textarea.scrollHeightReads, 0);
});

test('the drag handle resizes by whole lines, and only while the box is in manual mode', async () => {
    const box = fakeContainer('box-drag');
    const control = setupTextbox('box-drag', 'drag', { minLines: 2, maxLines: 10, autoResize: false });
    await settle();
    assert.equal(box.handle.style.display, 'block', 'the handle is there to be dragged');
    assert.equal(control.getHeight(), 2);

    let prevented = false;
    box.handle.dispatchEvent({ type: 'mousedown', clientY: 100, preventDefault() { prevented = true; } });
    assert.equal(prevented, true, 'the drag is not a text selection');
    assert.deepEqual(documentTypes(), ['mousemove', 'mouseup'], 'the drag follows the pointer off the handle');

    fireDocument('mousemove', { clientY: 160 });   // three lines down at a line height of 20
    assert.equal(control.getHeight(), 5);
    assert.equal(box.textarea.style.height, '100px');

    fireDocument('mousemove', { clientY: 400 });   // past the maximum
    assert.equal(control.getHeight(), 10, 'the box stops at maxLines');
    fireDocument('mousemove', { clientY: 0 });     // past the minimum
    assert.equal(control.getHeight(), 2, 'and at minLines');

    fireDocument('mouseup');
    assert.deepEqual(documentTypes(), [], 'the pointer is free again');
    box.textarea.heightWrites.length = 0;
    fireDocument('mousemove', { clientY: 400 });
    assert.deepEqual(box.textarea.heightWrites, [], 'a move after the drag is nobody\'s business');
});

test('switching a box to auto mode hides the handle and ends a drag that is still in flight', async () => {
    const box = fakeContainer('box-auto');
    const control = setupTextbox('box-auto', 'auto', { minLines: 2, maxLines: 10, autoResize: false });
    await settle();

    box.handle.dispatchEvent({ type: 'mousedown', clientY: 100, preventDefault() {} });
    control.setAutoResize(true);
    assert.equal(box.handle.style.display, 'none', 'the handle is gone in auto mode');

    box.textarea.heightWrites.length = 0;
    fireDocument('mousemove', { clientY: 400 });
    assert.deepEqual(box.textarea.heightWrites, [], 'the box follows its content now, not the pointer');
    fireDocument('mouseup');

    // and a fresh press on the handle starts nothing at all
    let prevented = false;
    box.handle.dispatchEvent({ type: 'mousedown', clientY: 100, preventDefault() { prevented = true; } });
    assert.equal(prevented, false, 'the press is left to the page');
    assert.deepEqual(documentTypes(), [], 'no drag was started');
});
