// The ADetailer slot (slots/myADetailerSlot.js) on the in-memory DOM: the columns a row
// offers on each backend, the ten values it reports in order, and what generate.js
// (createADetailer) makes of them. adetailer-comfyui.test.mjs covers that mapping from
// stubbed rows; this drives the real row into it.
import assert from 'node:assert/strict';
import test from 'node:test';

import { createADetailer } from '../scripts/renderer/generate.js';
import { withFakeDom } from './helpers/fakeDom.mjs';

// the textbox measures itself on a timer that outlives the fake document
globalThis.getComputedStyle = () => ({ lineHeight: '20px' });

const flush = () => new Promise(resolve => setTimeout(resolve, 0));
// what a ComfyUI installation answers with: detectors and SAM models in one list
const MODEL_LIST = ['face_yolov8m.pt', 'hand_yolov8s.pt', 'sam_vit_b_01ec64.pth', 'sam_vit_l_0b3195.pth'];

let moduleCase = 0;

async function withADetailerSlot(body, { apiInterface = 'ComfyUI' } = {}) {
    moduleCase += 1;
    return withFakeDom(async document => {
        globalThis.globalSettings = {
            language: 'en-US', css_style: 'dark', api_interface: apiInterface, api_adetailer_enable: true,
        };
        globalThis.cachedFiles = { aDetailerList: MODEL_LIST, language: { 'en-US': {} } };
        globalThis.generate = { api_interface: { getValue: () => apiInterface } };
        globalThis.overlay = { custom: { createCustomOverlay() {} } };

        const container = document.createElement('div');
        container.className = 'add-adetailer-main';
        document.body.appendChild(container);

        const module = await import(`../scripts/renderer/slots/myADetailerSlot.js?case=${moduleCase}`);
        const manager = module.setupADetailer('add-adetailer-main');
        globalThis.aDetailer = manager;
        return body({ document, container, manager, module });
    }, {
        localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
        getComputedStyle: () => ({ lineHeight: '20px' }),
    });
}

const click = (container, target) =>
    container.dispatchEvent({ type: 'click', target, bubbles: false, preventDefault() {}, stopPropagation() {} });

async function addRow(container, manager) {
    click(container, container.querySelector('.slot-action-add'));
    await flush();
    const className = manager.getSlots().at(-1);
    const slot = manager.slotIndex.get(className);
    const component = field => manager.componentInstances.get(`${className}-${slot.itemClasses[field]}`);
    return {
        className,
        set(field, value) {
            const control = component(field);
            if (control.updateDefaults) control.updateDefaults(value); else control.setValue(value);
            return this;
        },
    };
}

test('a ComfyUI row reports ten values, detector first and the SAM model in the enable column', async () => {
    await withADetailerSlot(async ({ container, manager, module }) => {
        assert.deepEqual(module.getADetailerModelList(), ['face_yolov8m.pt', 'hand_yolov8s.pt'],
            'the SAM models are not detectors');

        const row = await addRow(container, manager);
        assert.deepEqual(manager.getValues(), [[
            'face_yolov8m.pt', '0.3', '0', 'sam_vit_b_01ec64.pth', '', '4', 'center-1', '', '4', '0.5',
        ]], 'the first detector and the first SAM model, with the defaults the backend expects');

        row.set('ad_model', 'hand_yolov8s.pt').set('slot_enable', 'Off')
            .set('ad_confidence', '0.42').set('ad_prompt', 'detailed hand')
            .set('ad_negative_prompt', 'blurry').set('ad_denoise', '0.35');
        assert.deepEqual(manager.getValues(), [[
            'hand_yolov8s.pt', '0.42', '0', 'Off', 'detailed hand', '4', 'center-1', 'blurry', '4', '0.35',
        ]]);
    });
});

test('a WebUI row offers the models WebUI carries itself and its own mask filters', async () => {
    await withADetailerSlot(async ({ container, manager, module }) => {
        const models = module.getADetailerModelList();
        assert.equal(models[0], 'face_yolov8n.pt', 'the ones every WebUI has come first');
        assert.ok(models.includes('mediapipe_face_mesh'));
        assert.ok(models.includes('sam_vit_b_01ec64.pth'), 'and the installation\'s list follows whole');

        const row = await addRow(container, manager);
        assert.equal(manager.getValues()[0][3], 'Area', 'WebUI picks a mask filter, not a SAM model');
        row.set('slot_enable', 'Confidence');
        assert.equal(manager.getValues()[0][3], 'Confidence');
    }, { apiInterface: 'WebUI' });
});

test('the row reaches ComfyUI as a bbox detector, a SAM model and checked numbers', async () => {
    await withADetailerSlot(async ({ container, manager }) => {
        const row = await addRow(container, manager);
        row.set('ad_confidence', '5').set('ad_mask_k', '900').set('ad_dilate_erode', '12')
            .set('ad_mask_blur', '8').set('ad_denoise', '0.35').set('ad_prompt', 'high quality face');

        const [sent] = createADetailer('ComfyUI');
        assert.equal(sent.model, 'bbox/face_yolov8m.pt');
        assert.equal(sent.mask_filter_method, 'sam_vit_b_01ec64.pth');
        assert.equal(sent.confidence, 0.3, 'a confidence outside 0-1 falls back to the default');
        assert.equal(sent.mask_k, 0, 'a sam dilation outside the node\'s range falls back to the default too');
        assert.equal(sent.dilate_erode, 12);
        assert.equal(sent.mask_blur, 8);
        assert.equal(sent.denoise, '0.35');
        assert.equal(sent.prompt, 'high quality face');
    });
});

test('an off row and a "none" detector are not sent at all', async () => {
    await withADetailerSlot(async ({ container, manager }) => {
        const first = await addRow(container, manager);
        const second = await addRow(container, manager);
        second.set('ad_model', 'hand_yolov8s.pt');
        assert.equal(createADetailer('ComfyUI').length, 2);

        first.set('slot_enable', 'Off');
        assert.deepEqual(createADetailer('ComfyUI').map(sent => sent.model), ['bbox/hand_yolov8s.pt']);

        globalThis.globalSettings.api_adetailer_enable = false;
        assert.deepEqual(createADetailer('ComfyUI'), [], 'the card\'s own switch sends none of it');
    });
});

test('deleting a row takes it out of what the backend gets', async () => {
    await withADetailerSlot(async ({ container, manager }) => {
        const first = await addRow(container, manager);
        const second = await addRow(container, manager);
        second.set('ad_model', 'hand_yolov8s.pt');

        const del = container.querySelector(`.${manager.slotIndex.get(first.className).itemClasses.delete}`);
        click(container, del);
        assert.deepEqual(manager.getSlots(), [second.className]);
        assert.deepEqual(createADetailer('ComfyUI').map(sent => sent.model), ['bbox/hand_yolov8s.pt']);
    });
});

test('flush rebuilds the rows the settings hold, in the order they were saved', async () => {
    await withADetailerSlot(async ({ manager }) => {
        globalThis.globalSettings.ad_slot = [
            ['face_yolov8m.pt', '0.42', '0', 'sam_vit_l_0b3195.pth', 'face', '12', 'center-1', 'blurry', '8', '0.35'],
            ['hand_yolov8s.pt', '0.5', '2', 'Off', '', '4', 'mask-area', '', '4', '0.4'],
        ];
        manager.flush();
        await flush();

        assert.deepEqual(manager.getValues(), globalThis.globalSettings.ad_slot);
        assert.deepEqual(createADetailer('ComfyUI').map(sent => [sent.model, sent.mask_filter_method]),
            [['bbox/face_yolov8m.pt', 'sam_vit_l_0b3195.pth']], 'the off row stays out');
    });
});
