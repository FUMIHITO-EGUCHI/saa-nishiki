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
