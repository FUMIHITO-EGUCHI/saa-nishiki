import assert from 'node:assert/strict';
import test from 'node:test';

import { applyFastMode, fastLoraTag, fastModeConfig } from '../scripts/shared/fastMode.js';

const FAST_SETTINGS = {
    api_fast_enable: true,
    api_fast_lora: 'dmd2_sdxl_4step_lora.safetensors',
    api_fast_lora_strength: 0.8,
    api_fast_steps: 6,
    api_fast_cfg: 1,
    api_fast_sampler: 'lcm',
    api_fast_scheduler: 'sgm_uniform',
};

function sampleGenerateData() {
    return {
        positive: 'masterpiece, 1girl\n<lora:style.safetensors:0.6:0.6>',
        negative: 'lowres',
        cfg: 7,
        step: 30,
        sampler: 'euler_ancestral',
        scheduler: 'normal',
        hifix: { enable: true, steps: 20, denoise: 0.4, seed: 1 },
        adetailer: [
            { model: 'bbox/face_yolov8m.pt', mask_filter_method: 'sam_vit_b_01ec64.pth', denoise: 0.35 },
            { model: 'None', mask_filter_method: 'Off' },
        ],
    };
}

test('fast mode off returns the generateData untouched', () => {
    const data = sampleGenerateData();
    assert.equal(applyFastMode(data, { api_fast_enable: false }), data);
    assert.equal(applyFastMode(data, {}), data);
});

test('fast mode overrides sampling on the base pass and appends the LoRA tag', () => {
    const data = sampleGenerateData();
    const result = applyFastMode(data, FAST_SETTINGS);

    assert.notEqual(result, data);
    assert.equal(data.step, 30, 'input must not be mutated');
    assert.equal(result.step, 6);
    assert.equal(result.cfg, 1);
    assert.equal(result.sampler, 'lcm');
    assert.equal(result.scheduler, 'sgm_uniform');
    assert.equal(result.positive, 'masterpiece, 1girl\n<lora:style.safetensors:0.6:0.6>\n<lora:dmd2_sdxl_4step_lora.safetensors:0.8:0.8>');
    assert.equal(result.negative, 'lowres');
});

test('fast mode reaches the hires and ADetailer passes', () => {
    const result = applyFastMode(sampleGenerateData(), FAST_SETTINGS);

    assert.deepEqual(result.hifix, { enable: true, steps: 6, cfg: 1, denoise: 0.4, seed: 1 });
    assert.equal(result.adetailer[0].steps, 6);
    assert.equal(result.adetailer[0].cfg, 1);
    assert.equal(result.adetailer[0].sampler, 'lcm');
    assert.equal(result.adetailer[0].scheduler, 'sgm_uniform');
    assert.equal(result.adetailer[0].denoise, 0.35, 'user denoise survives');
    assert.equal(result.adetailer[1].mask_filter_method, 'Off');
});

test('regional prompts get the LoRA on the left text (the LoRA loader reads that node)', () => {
    const result = applyFastMode({ positive_left: 'left', positive_right: 'right', cfg: 7 }, FAST_SETTINGS);
    assert.equal(result.positive_left, 'left\n<lora:dmd2_sdxl_4step_lora.safetensors:0.8:0.8>');
    assert.equal(result.positive_right, 'right');
});

test('LoRA tag is added once and skipped when no LoRA is selected', () => {
    const tagged = applyFastMode(applyFastMode(sampleGenerateData(), FAST_SETTINGS), FAST_SETTINGS);
    assert.equal(tagged.positive.split('dmd2_sdxl_4step_lora').length, 2);

    const noLora = applyFastMode(sampleGenerateData(), { ...FAST_SETTINGS, api_fast_lora: 'None' });
    assert.equal(noLora.positive, sampleGenerateData().positive);
    assert.equal(noLora.step, 6, 'step override still applies without a LoRA');
    assert.equal(fastLoraTag(fastModeConfig({ api_fast_lora: '' })), '');
});

test('config falls back to sane values for garbage settings', () => {
    const config = fastModeConfig({ api_fast_enable: true, api_fast_steps: 'x', api_fast_cfg: -3, api_fast_sampler: '', api_fast_lora_strength: 'nope' });
    assert.deepEqual(config, { enabled: true, lora: '', strength: 1, steps: 8, cfg: 1, sampler: 'lcm', scheduler: 'sgm_uniform' });
});
