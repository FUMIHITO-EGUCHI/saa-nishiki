import assert from 'node:assert/strict';
import test from 'node:test';

import { applyFastMode, fastLoraTag, fastModeConfig, missingFastLora } from '../scripts/shared/fastMode.js';

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

const DIFF_SETTINGS = {
    api_fast_diff_lora: 'anima-turbo-lora-v0.2.safetensors',
    api_fast_diff_lora_strength: 0.8,
    api_fast_diff_steps: 8,
    api_fast_diff_cfg: 1.5,
    api_fast_diff_sampler: 'euler',
    api_fast_diff_scheduler: 'simple',
};

test('a Diffusion (UNET) run takes the Anima Turbo set, never the SDXL LoRA', () => {
    const unet = { ...sampleGenerateData(), unet: { enable: true, model: 'waiANIMA_v10Base10.safetensors' } };
    const result = applyFastMode(unet, { ...FAST_SETTINGS, ...DIFF_SETTINGS, api_model_type: 'Diffusion' });

    assert.equal(result.step, 8);
    assert.equal(result.cfg, 1.5);
    assert.equal(result.sampler, 'euler');
    assert.equal(result.scheduler, 'simple');
    assert.match(result.positive, /<lora:anima-turbo-lora-v0\.2\.safetensors:0\.8:0\.8>$/);
    assert.doesNotMatch(result.positive, /dmd2/);
    assert.deepEqual(result.hifix, { enable: true, steps: 8, cfg: 1.5, denoise: 0.4, seed: 1 });
    assert.equal(result.adetailer[0].sampler, 'euler');
    assert.equal(unet.step, 30, 'input must not be mutated');
});

test('the route follows the run, not the stored model type', () => {
    // a checkpoint workflow (no unet) keeps the SDXL set even while the UI sits on Diffusion
    const checkpoint = applyFastMode(sampleGenerateData(), { ...FAST_SETTINGS, ...DIFF_SETTINGS, api_model_type: 'Diffusion' });
    assert.equal(checkpoint.sampler, 'lcm');
    assert.match(checkpoint.positive, /dmd2_sdxl_4step_lora/);
});

test('Diffusion set falls back to the measured Turbo values', () => {
    assert.deepEqual(fastModeConfig({ api_fast_enable: true }, { diffusion: true }),
        { enabled: true, lora: '', strength: 0.8, steps: 8, cfg: 1.5, sampler: 'euler', scheduler: 'simple' });
});

test('a fast LoRA ComfyUI does not list is reported, an unknown list never blocks', () => {
    const unet = { ...sampleGenerateData(), unet: { enable: true } };
    const settings = { ...FAST_SETTINGS, ...DIFF_SETTINGS };
    assert.equal(missingFastLora(unet, settings, ['None', 'dmd2_sdxl_4step_lora.safetensors']), 'anima-turbo-lora-v0.2.safetensors');
    assert.equal(missingFastLora(unet, settings, ['None', 'anima-turbo-lora-v0.2.safetensors']), '');
    assert.equal(missingFastLora(unet, { ...settings, api_fast_diff_lora: 'anima/turbo.safetensors' }, ['anima\\turbo.safetensors']), '', 'separators do not matter');
    assert.equal(missingFastLora(unet, settings, ['None']), '', 'placeholder-only list is unknown');
    assert.equal(missingFastLora(unet, settings, []), '');
    assert.equal(missingFastLora(unet, { ...settings, api_fast_enable: false }, ['x.safetensors']), '');
    assert.equal(missingFastLora(unet, { ...settings, api_fast_diff_lora: 'None' }, ['x.safetensors']), '');
    assert.equal(missingFastLora(sampleGenerateData(), settings, ['dmd2_sdxl_4step_lora.safetensors']), '', 'checkpoint run checks the SDXL LoRA');
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
