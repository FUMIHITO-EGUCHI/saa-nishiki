// The prompt's LoRAs reach every sampling pass, end to end: Diffusion (Anima) with a hires
// pass and a face ADetailer, judged by the model links ComfyUI was asked to run. Until
// 2026-10-10 the Anima hires pass sampled from the bare UNET loader and every ADetailer
// from the bare loader: no LoRA there (Fast mode's Turbo LoRA included), and each switch
// between LoRA'd and bare weights made ComfyUI's dynamic VRAM read the model file again.
// Fast mode here asks for no launch flags (harness settings), so ComfyUI is not restarted.
// Run with `npm run test:e2e`.
import assert from 'node:assert/strict';
import test from 'node:test';

import { launchApp, workflow } from './harness.mjs';

const TURBO = 'anima-turbo-lora-v0.2.safetensors';
const DIFFUSION = {
    api_model_sampler: 'er_sde', api_model_scheduler: 'simple', step: 6, cfg: 3, width: 512, height: 512,
    api_hf_enable: true, api_hf_scale: 1.25, api_hf_denoise: 0.4, api_hf_steps: 4, api_hf_colortransfer: 'Mean',
    api_image_landscape: false, regional_condition: false,
};
// model, confidence, top-k, SAM, prompt, dilate, merge / invert, negative, blur, denoise
const FACE_SLOT = ['face_yolov8m.pt', '0.3', '0', 'sam_vit_b_01ec64.pth', '', '4', 'center-1', '', '4', '0.4'];

let app = null;

test.before(async () => {
    app = await launchApp({
        settings: {
            api_model_type: 'Diffusion',
            ...DIFFUSION,
            model_type_generation: { Diffusion: DIFFUSION },
            api_adetailer_enable: true,
            ad_slot: [FACE_SLOT],
            api_fast_diff_lora: TURBO,
            custom_prompt: 'masterpiece, best quality',
        },
    });
});
test.after(async () => { await app?.close(); });

// The model link of every sampling pass of the run: first pass, hires, ADetailer.
function passModels(wf) {
    const only = type => {
        const nodes = workflow.nodes(wf, type);
        assert.equal(nodes.length, 1, `one ${type} in the run`);
        return nodes[0];
    };
    const first = only('KSamplerAdvanced');
    const hires = only('KSampler');
    const detailer = only('FaceDetailer');
    const link = node => {
        const model = node.inputs.model;
        assert.equal(wf[model[0]]?.class_type, 'LoRAfromText', `${node.class_type} samples from the LoRA node, not ${wf[model[0]]?.class_type}`);
        return model;
    };
    return { first: link(first), hires: link(hires), detailer: link(detailer) };
}

test('Fast mode: hires and ADetailer sample from the first pass\'s Turbo LoRA model', async () => {
    await app.page.evaluate(`document.querySelector('#fast-mode-toggle').click()`);
    assert.equal(await app.setting('api_fast_enable'), true);
    await app.typePositive('1girl, solo, white background, smile, looking at viewer');
    const run = await app.generate({ expectImages: 1 });
    assert.equal(run.error, '', `no error overlay; log ${app.logFile}`);
    const { workflow: wf, outputs } = run.history[0];
    assert.ok(workflow.loras(wf, outputs).includes(TURBO), 'the Turbo LoRA rides in the prompt');
    const models = passModels(wf);
    assert.deepEqual(models.first[1], 0);
    assert.deepEqual(models.hires, models.first, 'one model for the whole run: no reload between passes');
    assert.deepEqual(models.detailer, models.first);
    await app.page.evaluate(`document.querySelector('#fast-mode-toggle').click()`);
    assert.equal(await app.setting('api_fast_enable'), false);
});

test('a LoRA written for the hires pass only reaches hires and ADetailer, not the first pass', async () => {
    // the LoRA slots' HiFix mode writes <lora:name:0:0:m:c>
    await app.typePositive(`1girl, solo, white background, smile, <lora:${TURBO}:0:0:0.8:0.8>`);
    const run = await app.generate({ expectImages: 1 });
    assert.equal(run.error, '', `no error overlay; log ${app.logFile}`);
    const { workflow: wf } = run.history[0];
    const models = passModels(wf);
    assert.deepEqual(models.first[1], 0);
    assert.deepEqual(models.hires, [models.first[0], 2], 'the hires model output of the LoRA node');
    assert.deepEqual(models.detailer, models.hires, 'ADetailer works on the hires image');
});
