// The run's own info (BBCode) is parked under its seed while the image is in flight
// (generate.js) and picked up again when the image arrives (generate_backend.js ->
// customGallery.js). This covers both ends: what the arriving image takes, and the cap
// that keeps the parking map from growing without end.
import assert from 'node:assert/strict';
import test from 'node:test';

import { startQueue } from '../scripts/renderer/generate.js';
import { from_main_updateGallery } from '../scripts/renderer/generate_backend.js';
import { setupGallery } from '../scripts/renderer/customGallery.js';
import { withFakeDom } from './helpers/fakeDom.mjs';

const png = name => `data:image/png;base64,${name}`;

class FakeIntersectionObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
}

function fakeStorage() {
    const store = new Map();
    return {
        getItem: key => (store.has(key) ? store.get(key) : null),
        setItem: (key, value) => store.set(key, String(value)),
        removeItem: key => store.delete(key),
    };
}

async function withGallery(body) {
    const info = [];
    return withFakeDom(async document => {
        const container = document.createElement('div');
        container.className = 'custom-gallery';
        document.body.appendChild(container);
        globalThis.mainGallery = {};
        globalThis.infoBox = { image: { setValue: value => info.push(value) } };
        globalThis.globalSettings = { language: 'en-US', scroll_to_last: false };
        globalThis.cachedFiles = { language: { 'en-US': {} } };
        globalThis.inBrowser = false;
        globalThis.api = { readBase64Image: async () => ({ metadata: {} }) };
        setupGallery('custom-gallery');
        return body({ container, gallery: globalThis.mainGallery, info });
    }, {
        localStorage: fakeStorage(),
        IntersectionObserver: FakeIntersectionObserver,
        Image: class { set src(value) { this._src = value; } },
    });
}

// Both ends of this path do the lookup - generate_backend.js reads the map and hands the
// text on, and the gallery reads it again when it is handed '' - so breaking one of them
// alone changes nothing; this covers the path, not which of the two carries it.
test('an image coming back over IPC takes the info parked under its seed', async () => {
    await withGallery(async ({ container, info }) => {
        globalThis.generate = {
            infoBySeed: new Map([['808', 'Steps: 28, CFG: 5']]),
            keepGallery: { getValue: () => true },
        };
        from_main_updateGallery(png('a'), '808', '1girl');
        assert.equal(info.at(-1), 'Steps: 28, CFG: 5');

        // Keep gallery off: the run before it goes, and a seed nobody parked info for
        // leaves the panel to the file's own parameters instead
        globalThis.generate.keepGallery = { getValue: () => false };
        from_main_updateGallery(png('b'), '999', '1boy');
        assert.deepEqual(
            container.querySelectorAll('.cg-preview-image').map(image => image.dataset.src),
            [png('b')]);
        assert.equal(info.at(-1), 'Seed: [999]\n');
    });
});

// ----------------------------------------------------------- the cap on the parking map

const LANG = {
    generate_start: '{0} {1}', gr_error_creating_image: 'Error {0} ({1})',
    run_button: 'Run', run_button_paused: 'Run (paused)',
};

class FakeQueue {
    constructor() { this.slots = []; }
    getFirstSlot() { return this.slots[0] ?? null; }
    popJob(generateData) {
        const index = this.slots.indexOf(generateData);
        if (index >= 0) this.slots.splice(index, 1);
        return this.slots[0] ?? null;
    }
    attach(_jobID, generateData) { this.slots.push(generateData); }
    removeAll() { this.slots.length = 0; }
    getSlotsCount() { return this.slots.length; }
}

function queueSetup() {
    const button = () => ({ setClickable() {}, setTitle() {} });
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
        generate_single: button(), generate_batch: button(), generate_same: button(),
        generate_skip: button(), generate_cancel: button(),
    };
    globalThis.mainGallery = { isLoading: false, showLoading() {}, hideLoading() {}, clearGallery() {}, appendImageData() {} };
    globalThis.thumbGallery = { clear() {}, append() {} };
    globalThis.infoBox = { image: { clear() {}, appendValue() {} } };
    globalThis.overlay = { custom: { closeCustomOverlaysByGroup() {} }, buttons: { reload() {} } };
    globalThis.uiShell = { runBar: { refresh() {} } };
    globalThis.queueManager = new FakeQueue();
    globalThis.api = {
        runComfyUI: async () => JSON.stringify({ prompt_id: 'p1' }),
        openWsComfyUI: async () => png('AAAA'),
        closeWsComfyUI() {},
        cancelComfyUI: async () => {},
    };
}

function job(seed) {
    return {
        seed, positive: 'p', negative: 'n',
        queueManager: { genType: 'normal', isRegional: false, apiInterface: 'ComfyUI', loop: 0, loops: 1, aiInterface: 'None', aiRole: 0, aiOptions: {}, finalInfo: `info ${seed}`, id: `${seed}` },
    };
}

test('the parked run info is capped at 512 seeds, oldest first', async () => {
    queueSetup();
    // 512 runs already parked, seed 1 the oldest of them
    globalThis.generate.infoBySeed = new Map(Array.from({ length: 512 }, (_, index) => [`${index + 1}`, `info ${index + 1}`]));

    globalThis.queueManager.attach('', job(1000));
    await startQueue();

    const parked = globalThis.generate.infoBySeed;
    assert.equal(parked.size, 512, 'one in, one out');
    assert.equal(parked.get('1000'), 'info 1000', 'the run that just went out is parked');
    assert.equal(parked.has('1'), false, 'the seed parked longest ago is the one dropped');
    assert.equal(parked.has('2'), true);

    // and it stays at the cap as the batch goes on
    globalThis.queueManager.attach('', job(1001));
    await startQueue();
    assert.equal(parked.size, 512);
    assert.equal(parked.has('2'), false);
    assert.equal(parked.get('1001'), 'info 1001');
});
