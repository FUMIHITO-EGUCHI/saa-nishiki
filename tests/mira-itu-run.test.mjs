// MiraITU (generate_miraITU.js): the job the "Upscale" button queues, and what the
// ComfyUI run behind it sends to the gallery. MiraITU is an image-to-image path, so the
// prompt fields stay out of it - the Exclude row is the one it reads.
import assert from 'node:assert/strict';
import test from 'node:test';

import { generateMiraITU, startGenerateMiraITU } from '../scripts/renderer/generate_miraITU.js';

const LANG = {
    overlay_title: 'Now generating...', overlay_te: 'Elapsed time:', overlay_sec: 'seconds',
    vpred_on: 'V-Pred', vpred_on_zsnr: 'V-Pred + ZSNR', vpred_off: 'Off',
    gr_error_creating_image: 'Error {0} ({1})',
};

const taggerOptions = (overrides = {}) => ({
    sdxlModels: 'upscale.safetensors',
    imageWidth: 512, imageHeight: 768, upscaleRatio: 2, prebakeDryRun: false,
    ...overrides,
});

function setup({ exclude = '', muted = [], seed = 1234, autoStart = false, keepGallery = true } = {}) {
    const state = { attached: [], gallery: [], loading: [], cleared: 0, clickable: [] };
    globalThis.inBrowser = false;
    globalThis.inGenerating = false;
    globalThis.globalSettings = {
        language: 'en-US', css_style: 'dark', generate_auto_start: autoStart,
        scroll_to_last: false, prompt_field_muted: muted,
    };
    globalThis.cachedFiles = { language: { 'en-US': LANG } };
    const button = name => ({ setClickable: value => state.clickable.push([name, value]) });
    globalThis.generate = {
        cancelClicked: false,
        seed: { getValue: () => seed },
        api_interface: { getValue: () => 'ComfyUI' },
        api_address: { getValue: () => '127.0.0.1:58188' },
        api_preview_refresh_time: { getValue: () => '1.0' },
        webui_auth: { getValue: () => '' },
        webui_auth_enable: { getValue: () => 'OFF' },
        keepGallery: { getValue: () => keepGallery },
        showCancelButtons() {},
        generate_single: button('single'), generate_batch: button('batch'), generate_same: button('same'),
    };
    globalThis.dropdownList = { vpred: { getValue: () => 'Off' } };
    globalThis.prompt = { exclude: { getValue: () => exclude } };
    globalThis.mainGallery = {
        isLoading: false,
        showLoading: (...args) => { state.loading.push(['show', ...args]); globalThis.mainGallery.isLoading = true; },
        hideLoading: (...args) => { state.loading.push(['hide', ...args]); globalThis.mainGallery.isLoading = false; },
        clearGallery: () => { state.cleared += 1; },
        appendImageData: (...args) => state.gallery.push(args),
    };
    globalThis.queueManager = { attach: (banner, data) => state.attached.push([banner, data]) };
    globalThis.api = { compressGzip: async () => 'GZIPPED' };
    return state;
}

const imageFile = () => ({ arrayBuffer: async () => new Uint8Array([137, 80, 78, 71]).buffer });

// The queue row's thumbnail is made with an Image the fake DOM has no decoder for; the
// resize falls back to the original bytes and says so, which is noise here.
async function queueJob(options = {}) {
    const realWarn = console.warn;
    console.warn = () => {};
    try {
        await generateMiraITU({ imageData: imageFile(), taggerOptions: taggerOptions(options) });
    } finally {
        console.warn = realWarn;
    }
}

test('the queued job carries the image, the upscale model and the seed on screen', async () => {
    const state = setup({ seed: 4242 });
    await queueJob();

    assert.equal(state.attached.length, 1);
    const [banner, data] = state.attached[0];
    assert.deepEqual(data.queueManager, { genType: 'miraITU', apiInterface: 'ComfyUI' });
    assert.equal(data.model, 'upscale.safetensors');
    assert.equal(data.seed, 4242);
    assert.equal(data.addr, '127.0.0.1:58188');
    assert.equal(data.imageData, 'GZIPPED');
    assert.equal(data.uuid, 'none', 'only a browser client has one');
    assert.equal(typeof data.preview, 'string', 'the queue row shows a thumbnail of the source');
    assert.deepEqual(banner, ['MiraITU: 4242 |  512x768 -> 1024x1536', '4242 |  512x768 -> 1024x1536'],
        'the row says what it is upscaling to');

    assert.deepEqual(state.loading, [
        ['show', 'Now generating...', 'Elapsed time:', 'seconds'],
        ['hide', 'success', ''],
    ], 'without auto start the overlay only covers the queueing');
    assert.deepEqual(state.clickable, [['single', true], ['batch', true], ['same', true]]);
});

test('a dry run says so instead of naming a target size', async () => {
    const state = setup({ seed: 7 });
    await queueJob({ prebakeDryRun: true });
    assert.deepEqual(state.attached[0][0], ['MiraITU(Dry Run): 7', '7']);
});

test('seed -1 is drawn once for the job, not left for the backend', async () => {
    const state = setup({ seed: -1 });
    await queueJob();
    const { seed } = state.attached[0][1];
    assert.ok(Number.isInteger(seed) && seed >= 0, `drawn seed ${seed}`);
    assert.ok(state.attached[0][0][0].includes(`${seed}`), 'and the row shows the one that was drawn');
});

test('the Exclude row reaches MiraITU, its toggled-off chips stripped', async () => {
    const state = setup({ exclude: 'watermark, ~signature, blurry' });
    await queueJob();
    assert.equal(state.attached[0][1].exclude, 'watermark, blurry');
});

test('a muted Exclude row sends nothing, chips or not', async () => {
    const state = setup({ exclude: 'watermark, blurry', muted: ['exclude'] });
    await queueJob();
    assert.equal(state.attached[0][1].exclude, '');
});

test('a run already on screen keeps its own overlay', async () => {
    const state = setup();
    globalThis.mainGallery.isLoading = true;
    await queueJob();
    assert.deepEqual(state.loading, [['hide', 'success', '']], 'no second overlay goes up');
});

// ------------------------------------------------------------------- the run itself

function job(overrides = {}) {
    return { seed: 4242, taggerOptions: taggerOptions(), ...overrides };
}

test('the image ComfyUI returns reaches the gallery with the run written on it', async () => {
    const state = setup();
    globalThis.api.runComfyUI_MiraITU = async () => JSON.stringify({ prompt_id: 'p1' });
    globalThis.api.openWsComfyUI = async () => 'data:image/png;base64,UPSCALED';
    globalThis.api.closeWsComfyUI = () => { state.closed = true; };

    const result = await startGenerateMiraITU('ComfyUI', job());

    assert.deepEqual(result, { ret: 'success', retCopy: '', breakNow: false });
    assert.equal(state.closed, true, 'the websocket is closed either way');
    const [image, seed, tag, keepGallery, scroll, info] = state.gallery[0];
    assert.equal(image, 'data:image/png;base64,UPSCALED');
    assert.equal(seed, '4242');
    assert.equal(tag, 'by MiraITU: 4242\n512x768 -> 1024x1536\n');
    assert.equal(keepGallery, true);
    assert.equal(scroll, false);
    assert.equal(info, null, 'no txt2img run info: the file\'s own parameters are shown instead');
    assert.equal(state.cleared, 0);
});

test('a dry run keeps the seed on the image but not a resolution it never reached', async () => {
    const state = setup({ keepGallery: false });
    globalThis.api.runComfyUI_MiraITU = async () => JSON.stringify({ prompt_id: 'p1' });
    globalThis.api.openWsComfyUI = async () => 'data:image/png;base64,DRY';
    globalThis.api.closeWsComfyUI = () => {};

    await startGenerateMiraITU('ComfyUI', job({ taggerOptions: taggerOptions({ prebakeDryRun: true }) }));

    assert.equal(state.gallery[0][2], 'by MiraITU: 4242\n');
    assert.equal(state.cleared, 1, 'keep gallery off empties it first');
});

test('a run that produced no image adds none, and is not an error either', async () => {
    const state = setup();
    globalThis.api.runComfyUI_MiraITU = async () => JSON.stringify({ prompt_id: 'p1' });
    globalThis.api.openWsComfyUI = async () => '';   // the backend had this prompt already
    globalThis.api.closeWsComfyUI = () => {};

    assert.deepEqual(await startGenerateMiraITU('ComfyUI', job()), { ret: 'success', retCopy: '', breakNow: false });
    assert.deepEqual(state.gallery, []);
});

test('a prompt the backend would not take is reported with what it said', async () => {
    const state = setup();
    globalThis.api.runComfyUI_MiraITU = async () => JSON.stringify({ error: 'node 14 is not in this workflow' });

    const result = await startGenerateMiraITU('ComfyUI', job());
    assert.deepEqual(result.ret, { error: 'node 14 is not in this workflow' }, 'no prompt_id: the answer is the report');
    assert.equal(result.breakNow, true);
    assert.deepEqual(state.gallery, []);
});

test('a backend error is reported and stops the queue', async () => {
    const state = setup();
    globalThis.api.runComfyUI_MiraITU = async () => 'Error: node 14 missing';

    const result = await startGenerateMiraITU('ComfyUI', job());
    assert.deepEqual(result, { ret: 'Error Error: node 14 missing (ComfyUI)', retCopy: 'Error: node 14 missing', breakNow: true });
    assert.deepEqual(state.gallery, []);
});

test('a cancel ends the run quietly, an image that failed does not', async () => {
    const state = setup();
    globalThis.api.runComfyUI_MiraITU = async () => JSON.stringify({ prompt_id: 'p1' });
    globalThis.api.closeWsComfyUI = () => {};

    globalThis.api.openWsComfyUI = async () => 'Error: Cancelled';
    assert.deepEqual(await startGenerateMiraITU('ComfyUI', job()),
        { ret: 'success', retCopy: '', breakNow: false }, 'a cancelled run is not an error');

    globalThis.api.openWsComfyUI = async () => 'Error: out of memory';
    const failed = await startGenerateMiraITU('ComfyUI', job());
    assert.equal(failed.breakNow, true);
    assert.equal(failed.retCopy, 'Error: out of memory');

    globalThis.generate.cancelClicked = true;
    globalThis.api.openWsComfyUI = async () => 'data:image/png;base64,LATE';
    const cancelled = await startGenerateMiraITU('ComfyUI', job());
    assert.deepEqual(cancelled, { ret: 'success', retCopy: '', breakNow: true }, 'Cancel stops the queue');
    assert.deepEqual(state.gallery, [], 'and the image it was too late for is dropped');
});

test('only ComfyUI can run MiraITU', async () => {
    setup();
    assert.deepEqual(await startGenerateMiraITU('WebUI', job()),
        { ret: 'Error: Not ComfyUI', retCopy: 'Error: Not ComfyUI', breakNow: true });
    assert.deepEqual(await startGenerateMiraITU('None', job()),
        { ret: 'success', retCopy: '', breakNow: false });
});
