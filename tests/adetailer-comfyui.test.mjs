import assert from 'node:assert/strict';
import test from 'node:test';

import { createADetailer } from '../scripts/renderer/generate.js';

test('ComfyUI ADetailer keeps mask blur independent from mask dilation', () => {
    globalThis.globalSettings = { api_adetailer_enable: true };
    globalThis.aDetailer = {
        getValues: () => [[
            'face_yolov8m.pt',
            '0.42',
            '0',
            'sam_vit_b_01ec64.pth',
            'high quality face',
            '12',
            'center-1',
            'blurry, deformed',
            '8',
            '0.35'
        ]]
    };

    const [result] = createADetailer('ComfyUI');

    assert.equal(result.model, 'bbox/face_yolov8m.pt');
    assert.equal(result.confidence, '0.42');
    assert.equal(result.dilate_erode, 12);
    assert.equal(result.mask_blur, 8);
    assert.equal(result.denoise, '0.35');
    assert.equal(result.positive_prompt, undefined);
    assert.equal(result.prompt, 'high quality face');
    assert.equal(result.negative_prompt, 'blurry, deformed');
});

// The slot fields are text boxes, so every number reaching a backend goes through
// checkNumberInRange / convertToMultipleOfNFloor first (numbers.js).
function webuiSlot(overrides = {}) {
    const values = {
        model: 'face_yolov8m.pt', confidence: '0.42', mask_k: '3', enable: 'Mask',
        prompt: 'high quality face', dilate_erode: '12', merge_invert: 'center-1',
        negative: 'blurry, deformed', mask_blur: '8', denoise: '0.35',
        ...overrides,
    };
    globalThis.globalSettings = { api_adetailer_enable: true };
    globalThis.aDetailer = {
        getValues: () => [[
            values.model, values.confidence, values.mask_k, values.enable, values.prompt,
            values.dilate_erode, values.merge_invert, values.negative, values.mask_blur, values.denoise,
        ]],
    };
    return createADetailer('WebUI')[0];
}

test('WebUI ADetailer sends mask_k as the top-k count, 0 to disable, never a flag', () => {
    assert.equal(webuiSlot().mask_k, 3, 'a text field, a number on the wire');
    assert.equal(webuiSlot({ mask_k: '0' }).mask_k, 0, '0 turns the top-k filter off');
    assert.equal(webuiSlot({ mask_k: '10' }).mask_k, 10);
    assert.equal(webuiSlot({ mask_k: '3.7' }).mask_k, 3, 'a count is a whole number');
    // 0 .. 10 is the whole range the backend takes; anything else falls back to "off"
    assert.equal(webuiSlot({ mask_k: '20' }).mask_k, 0);
    assert.equal(webuiSlot({ mask_k: '-1' }).mask_k, 0);
});

test('WebUI ADetailer clamps dilate / erode onto the ±128 grid of 4', () => {
    assert.equal(webuiSlot().dilate_erode, 12);
    assert.equal(webuiSlot({ dilate_erode: '13' }).dilate_erode, 12, 'down to the next multiple of 4');
    assert.equal(webuiSlot({ dilate_erode: '-13' }).dilate_erode, -16);
    assert.equal(webuiSlot({ dilate_erode: '900' }).dilate_erode, 128);
    assert.equal(webuiSlot({ dilate_erode: '-900' }).dilate_erode, -128);
    assert.equal(webuiSlot({ mask_blur: '70' }).mask_blur, 4, 'mask_blur tops out at 64 here, then falls back');
});
