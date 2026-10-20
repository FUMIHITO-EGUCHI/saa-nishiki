// A LoRA's samples (loraSamples.js) on the in-memory DOM: the viewer that opens on all six
// and shows one large once it is picked, and the Retake dialog that keeps the prompt the
// samples are made with - this LoRA's own, or the default every LoRA shares.
import assert from 'node:assert/strict';
import test from 'node:test';

import { LORA_CATEGORIES, applyLoraChange, loraView, normalizeLoraDoc } from '../scripts/shared/loraCatalog.js';
import { withFakeDom } from './helpers/fakeDom.mjs';

const NAME = 'CharTurnIL.safetensors';
const WEIGHTS = [0, 0.2, 0.4, 0.6, 0.8, 1];

// the catalog behind globalThis.api, as main/lora_backend.js answers it
function catalogApi({ samples = WEIGHTS.slice(0, 4) } = {}) {
    let doc = normalizeLoraDoc({
        loras: { [NAME]: { samples: samples.map(weight => ({ id: `s${weight}`, file: `s${weight}.png`, weight, model: 'v170', positive: `masterpiece, 1girl, charturn${weight ? `\n<lora:${NAME}:${weight}:${weight}>` : ''}`, seed: 3 })) } },
    });
    const files = [{ name: NAME, base: 'sdxl', frequency: [['charturn', 10], ['back', 4]] }];
    const view = () => ({ loras: files.map(file => loraView(file, doc.loras[file.name] ?? {}, { defaults: doc.defaults })), defaults: doc.defaults, samplePrompt: doc.samplePrompt ?? null, categories: LORA_CATEGORIES });
    const applied = [];
    return {
        applied,
        doc: () => doc,
        api: {
            loraCatalog: async () => view(),
            loraApply: async change => {
                applied.push(change);
                doc = applyLoraChange(doc, change) ?? doc;
                return view();
            },
            loraSampleImage: async (name, id) => `data:image/png;base64,${id}`,
        },
    };
}

const flush = () => new Promise(resolve => setTimeout(resolve, 0));
const key = (document, name) => document.dispatchEvent({ type: 'keydown', key: name, preventDefault() {}, stopPropagation() {} });

let moduleCase = 0;

async function withSamples(body, options = {}) {
    moduleCase += 1;
    return withFakeDom(async document => {
        const store = catalogApi(options);
        globalThis.api = store.api;
        globalThis.inBrowser = false;
        globalThis.globalSettings = { language: 'en-US', api_model_type: 'Checkpoint' };
        globalThis.cachedFiles = { language: { 'en-US': {} } };
        globalThis.dropdownList = { model: { getValue: () => 'v170' } };
        globalThis.generate = { api_interface: { getValue: () => 'ComfyUI' } };
        // every sample of the LoRA already waits in the queue, so nothing is generated here
        globalThis.queueManager = { getValues: () => WEIGHTS.map(weight => ({ queueManager: { genType: 'partsSample', sampleKey: `lora:${NAME}:${weight}:v170` } })) };
        const client = await import('../scripts/renderer/loraClient.js');
        await client.loadLoraCatalog({ force: true });
        const samples = await import(`../scripts/renderer/loraSamples.js?case=${moduleCase}`);
        try {
            return await body({ document, store, samples });
        } finally {
            samples.closeSampleViewer();
            samples.closeRetakeDialog();
        }
    });
}

test('the viewer opens on all six, a picked one shows alone, and Escape goes back before it closes', async () => {
    await withSamples(async ({ document, samples }) => {
        samples.openSampleViewer(NAME);
        await flush();
        const cards = [...document.querySelectorAll('.lora-viewer-big')];
        assert.equal(cards.length, 6, 'off and five weights');
        assert.deepEqual([...document.querySelectorAll('.lora-viewer-card-weight')].map(node => node.textContent), ['off', '0.2', '0.4', '0.6', '0.8', '1']);
        assert.equal(cards[4].classList.contains('is-default'), true, 'the default weight is ringed');
        assert.equal(cards[4].disabled, true, 'a weight without a sample cannot be opened');
        assert.equal(cards[2].querySelector('img').src, 'data:image/png;base64,s0.4');
        assert.equal(document.querySelector('.lora-viewer-back'), null, 'no way back on the first view');
        assert.match(document.querySelector('.lora-viewer-strip .lora-viewer-prompt').textContent, /^masterpiece, 1girl, charturn$/, 'the prompt the six share, without the LoRA line');

        cards[2].click();
        assert.equal(document.querySelector('.lora-viewer-weight-value').textContent, '0.4');
        assert.ok(document.querySelector('.lora-viewer-back'), 'back to all six');
        assert.equal(document.querySelectorAll('.lora-viewer-thumb').length, 6, 'the strip to move on');
        assert.match(document.querySelector('.lora-viewer-info .lora-viewer-prompt').textContent, /<lora:CharTurnIL\.safetensors:0\.4:0\.4>/, 'the prompt that sample was made with');

        key(document, 'ArrowRight');
        assert.equal(document.querySelector('.lora-viewer-weight-value').textContent, '0.6');
        key(document, 'Escape');
        assert.equal(document.querySelectorAll('.lora-viewer-big').length, 6, 'Escape goes back to all six first');
        key(document, 'Escape');
        assert.equal(document.querySelector('.lora-viewer'), null, 'then closes');
    });
});

test('"Make default" in the single view stores that weight as the LoRA\'s default', async () => {
    await withSamples(async ({ document, store, samples }) => {
        samples.openSampleViewer(NAME);
        [...document.querySelectorAll('.lora-viewer-big')][3].click();
        const make = document.querySelector('.lora-viewer-actions .viewer-primary-button');
        assert.equal(make.disabled, false);
        make.click();
        await flush();
        assert.deepEqual(store.applied.at(-1), { action: 'set', name: NAME, patch: { range: { min: 0.2, max: 1, def: 0.6, src: 'default' } } });
        assert.equal(document.querySelector('.lora-viewer-pill')?.textContent, 'Default', 'the view follows the catalog');
        assert.equal(document.querySelector('.lora-viewer-actions .viewer-primary-button').disabled, true);
    });
});

test('Retake writes this LoRA\'s own prompt: its words marked, the quality words fixed in front', async () => {
    await withSamples(async ({ document, store, samples }) => {
        samples.openRetakeDialog(NAME);
        const chips = () => [...document.querySelectorAll('.lora-retake-chip')];
        assert.equal(chips()[0].classList.contains('is-fixed'), true);
        assert.match(chips()[0].textContent, /^Quality · Illustrious/);
        const word = chips().find(chip => chip.textContent.startsWith('charturn'));
        assert.ok(word?.classList.contains('is-lora'), 'the trigger word is marked');
        assert.equal(document.querySelector('.lora-retake-chips .lora-retake-chip-remove') !== null, true);

        // "looking at viewer" out, "from behind" in
        chips().find(chip => chip.textContent.startsWith('looking at viewer')).querySelector('.lora-retake-chip-remove').click();
        const add = document.querySelector('.lora-retake-add');
        add.value = 'from behind';
        add.dispatchEvent({ type: 'keydown', key: 'Enter', preventDefault() {}, stopPropagation() {} });
        document.querySelector('.lora-retake-foot .selection-modal-apply').click();
        await flush();
        await flush();
        assert.deepEqual(store.applied, [{ action: 'set', name: NAME, patch: { samplePrompt: {
            body: '1girl, solo, full body, standing, charturn, simple background, white background, from behind',
            negative: 'worst quality, low quality, bad anatomy, bad hands, artist name, signature, watermark, text, logo',
            seed: 3,
        } } }], 'only this LoRA changed');
        assert.equal(document.querySelector('.lora-retake'), null, 'the dialog closed');
    });
});

test('Retake on Default for all writes the template, and an untouched LoRA follows it', async () => {
    await withSamples(async ({ document, store, samples }) => {
        samples.openRetakeDialog(NAME);
        const scope = label => [...document.querySelectorAll('.lora-retake-scope button')].find(node => node.textContent === label);
        scope('Default for all').click();
        assert.ok([...document.querySelectorAll('.lora-retake-chip')].some(chip => chip.textContent.startsWith('LoRA words')), 'where each LoRA\'s words go');
        const add = document.querySelector('.lora-retake-add');
        add.value = 'chibi';
        add.dispatchEvent({ type: 'keydown', key: 'Enter', preventDefault() {}, stopPropagation() {} });
        scope('This LoRA').click();
        assert.ok([...document.querySelectorAll('.lora-retake-chip')].some(chip => chip.textContent.startsWith('chibi')), 'this LoRA\'s prompt follows the default it never left');
        document.querySelector('.lora-retake-foot .selection-modal-apply').click();
        await flush();
        await flush();
        assert.equal(store.applied.length, 1, 'the template only: the LoRA keeps following it');
        assert.equal(store.applied[0].action, 'sample-template');
        assert.equal(store.applied[0].patch.body, '1girl, solo, full body, standing, looking at viewer, {lora}, simple background, white background, chibi');
        assert.equal(store.doc().loras[NAME].samplePrompt, undefined);
    });
});

test('Reset puts this LoRA back on the default, and Cancel keeps nothing', async () => {
    await withSamples(async ({ document, store, samples }) => {
        await store.api.loraApply({ action: 'set', name: NAME, patch: { samplePrompt: { body: 'chibi, charturn', negative: 'lowres', seed: 5 } } });
        const client = await import('../scripts/renderer/loraClient.js');
        await client.loadLoraCatalog({ force: true });
        store.applied.length = 0;

        samples.openRetakeDialog(NAME);
        assert.equal(document.querySelector('.lora-retake-seed input').value, '5', 'the LoRA\'s own seed');
        const reset = [...document.querySelectorAll('.lora-retake-tools .lora-button')].find(node => node.textContent === 'Reset');
        reset.click();
        assert.equal(document.querySelector('.lora-retake-seed input').value, '3');
        document.querySelector('.lora-retake-foot .selection-modal-apply').click();
        await flush();
        await flush();
        assert.deepEqual(store.applied, [{ action: 'set', name: NAME, patch: { samplePrompt: null } }], 'it follows the default again');

        store.applied.length = 0;
        samples.openRetakeDialog(NAME);
        document.querySelector('.lora-retake-add').value = 'x';
        document.querySelector('.lora-retake-foot .selection-modal-cancel').click();
        await flush();
        assert.deepEqual(store.applied, []);
        assert.equal(document.querySelector('.lora-retake'), null);
    });
});
