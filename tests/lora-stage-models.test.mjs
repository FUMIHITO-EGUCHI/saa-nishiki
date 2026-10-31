// Every sampling pass of a ComfyUI run takes its model from "LoRA Loader from Text": the
// hires pass and ADetailer used to sample from the bare loader (no LoRA at all on the Anima
// hires pass, none on any ADetailer), and the switch between LoRA'd and bare weights made
// ComfyUI's dynamic VRAM read the whole model file again for each pass (2026-10-10).
import assert from 'node:assert/strict';
import { register } from 'node:module';
import test from 'node:test';

import { hiresModelOutput, loraStageModels, parseLoraTags, splitLoraText } from '../scripts/shared/loraStageModels.js';

test('tags are read the way ComfyUI_Mira parse_content reads them', () => {
    assert.deepEqual(parseLoraTags('1girl, <lora:a.safetensors:0.8:0.6>, smile'), [
        { name: 'a.safetensors', model: 0.8, clip: 0.6, hiresModel: 0.8, hiresClip: 0.6 },
    ], 'two values are reused for the hires pass');
    assert.deepEqual(parseLoraTags('<lora:a>')[0], { name: 'a', model: 1, clip: 1, hiresModel: 1, hiresClip: 1 });
    assert.deepEqual(parseLoraTags('<lora:a:0.7>')[0], { name: 'a', model: 0.7, clip: 1, hiresModel: 1, hiresClip: 1 },
        'one value sets the first-pass model only; the rest stay 1.0');
    assert.deepEqual(parseLoraTags('<lora:a:0.5:0.4:0.3>')[0], { name: 'a', model: 0.5, clip: 0.4, hiresModel: 0.3, hiresClip: 1 });
    assert.deepEqual(parseLoraTags('<lora:a:1:1:0:0:9>')[0], { name: 'a', model: 1, clip: 1, hiresModel: 0, hiresClip: 0 }, 'past four values are ignored');
    assert.deepEqual(parseLoraTags('<lora:> <lora::1> plain'), [], 'no name, no LoRA');
    assert.deepEqual(parseLoraTags('<lora:a:inf>')[0], { name: 'a', unknown: true }, 'a number only Python would read');
    assert.deepEqual(parseLoraTags('<lora:sub\\b.safetensors:1:1>\n<lora:c:0:0>').map(tag => tag.name), ['sub\\b.safetensors', 'c']);
});

test('the hires pass shares the first-pass model unless a tag gives it other strengths', () => {
    assert.equal(hiresModelOutput(''), 0, 'no LoRA: both outputs are the loader model');
    assert.equal(hiresModelOutput('<lora:anima-turbo-lora-v0.2.safetensors:0.8:0.8>'), 0, 'Fast mode / a LoRA slot set to ALL');
    assert.equal(hiresModelOutput('<lora:a:1:1> <lora:b>'), 0);
    assert.equal(hiresModelOutput('<lora:a:0.8:0.8:0:0>'), 2, 'a LoRA slot set to Base');
    assert.equal(hiresModelOutput('<lora:a:0:0:0.8:0.8>'), 2, 'a LoRA slot set to HiFix');
    assert.equal(hiresModelOutput('<lora:a:0.7>'), 2, 'hand-typed: the node applies 1.0 for hires');
    assert.equal(hiresModelOutput('<lora:a:1:1> <lora:b:1_0>'), 2, 'unsure: keep the hires model of the node');
    assert.deepEqual(loraStageModels(34, { text: '<lora:a:1:1>', hires: true }), { first: ['34', 0], hires: ['34', 0], last: ['34', 0] });
    assert.deepEqual(loraStageModels('39', { text: '<lora:a:0:0:1:1>', hires: true }), { first: ['39', 0], hires: ['39', 2], last: ['39', 2] });
    assert.deepEqual(loraStageModels('34', { text: '<lora:a:0:0:1:1>', hires: false }).last, ['34', 0], 'no hires: ADetailer follows the first pass');
});

test('the prompt splits into the tags and the plain_text the node would give', () => {
    assert.deepEqual(splitLoraText('1girl, smile, \n<lora:dmd2_sdxl_4step_lora_fp16.safetensors:1:1>'),
        { tags: '<lora:dmd2_sdxl_4step_lora_fp16.safetensors:1:1>', plain: '1girl, smile,' }, 'remove_brackets(...).strip()');
    assert.deepEqual(splitLoraText(' <lora:a:1> 1girl <lora:b:0:0:1:1>, smile \u3000'), { tags: '<lora:a:1><lora:b:0:0:1:1>', plain: '1girl , smile' });
    assert.deepEqual(splitLoraText('1girl, \ufeff'), { tags: '', plain: '1girl, \ufeff' }, 'Python\'s strip() keeps a BOM');
    assert.deepEqual(splitLoraText(undefined), { tags: '', plain: '' });
});

// --- the builders --------------------------------------------------------------------

const electron = `export const app = { isPackaged: false, getAppPath: () => process.cwd(), getPath: () => process.cwd(), getVersion: () => '0.0.0-test', on() {} };
export const ipcMain = { handle() {}, on() {} };
export const dialog = { showErrorBox() {} };
export const net = { request() {} };
export const shell = { openPath() {} };
export const nativeImage = {};
export class BrowserWindow { static getAllWindows() { return []; } }`;
register('data:text/javascript,' + encodeURIComponent(`export async function resolve(specifier, context, next) {
    if (specifier === 'electron') return { url: 'data:text/javascript,' + encodeURIComponent(${JSON.stringify(electron)}), shortCircuit: true };
    return next(specifier, context);
}`));
const { ComfyUI } = await import('../scripts/main/generate_backend_comfyui.js');
const builder = new ComfyUI('test');

const FAST_TAG = '<lora:anima-turbo-lora-v0.2.safetensors:0.8:0.8>';
const HIFIX_ONLY = '<lora:style.safetensors:0:0:0.7:0.7>';
const handDetailer = {
    model: 'bbox/hand_yolov8n.pt', confidence: 0.5, mask_filter_method: 'sam_vit_b_01ec64.pth', prompt: '', negative_prompt: '',
    steps: 8, cfg: 1.5, sampler: 'euler', scheduler: 'simple', denoise: 0.5, mask_blur: 4, dilate_erode: 4, mask_merge_invert: 'center-1',
};
const hiresOn = { enable: true, scale: 1.5, model: '4x-AnimeSharp.pth', denoise: 0.4, steps: 8, cfg: 1.5, seed: 7, colorTransfer: 'Mean' };
const hiresOff = { ...hiresOn, enable: false };

function common(overrides) {
    return {
        addr: '127.0.0.1:8189', auth: '', uuid: 'u', refresh: 0, negative: 'lowres', width: 512, height: 512, cfg: 1.5, step: 8, seed: 3,
        sampler: 'euler', scheduler: 'simple', img_prefix: 'x', adetailer: [handDetailer], hifix: hiresOn, ...overrides,
    };
}
const unet = { enable: true, model: 'waiANIMA_v10Base10.safetensors', dtype: 'default', clip_model: 'qwen_3_06b_base.safetensors', clip_type: 'stable_diffusion', clip_device: 'default', vae_model: 'qwen_image_vae.safetensors' };
const checkpoint = (overrides = {}) => common({
    model: 'waiIllustriousSDXL_v160.safetensors', vpred: 0, controlnet: [], vae: { vae_override: false, vae: 'None' },
    refiner: { enable: false, model: 'waiIllustriousSDXL_v160.safetensors', vpred: 0, ratio: 0.8, addnoise: false }, ...overrides,
});
const regional = { ratio: '1,1', split: 'left-right', str_left: 1, str_right: 1, option_left: 'default', option_right: 'default' };

const ofType = (workflow, type) => Object.values(workflow).filter(node => node.class_type === type);
const detailerModels = workflow => ofType(workflow, 'FaceDetailer').map(node => node.inputs.model);

test('ADetailer follows the selected hires image, including the color-transfer switch', () => {
    for (const [method, extra] of [
        ['createWorkflow', { positive: 'basket of apples' }],
        ['createWorkflowRegional', { regional, positive_left: 'basket', positive_right: 'cloth' }],
    ]) {
        const wf = builder[method](checkpoint({ ...extra, hifix: { ...hiresOn, colorTransfer: 'None' } }));
        assert.deepEqual(ofType(wf, 'FaceDetailer')[0].inputs.image, ['18', 0], method);
    }
    const wf = builder.createWorkflowUNet(common({ unet, positive: 'basket', hifix: hiresOn }));
    assert.deepEqual(ofType(wf, 'FaceDetailer')[0].inputs.image, ['62', 0]);
});

test('same-checkpoint refiner stays bypassed when latent hires is selected', () => {
    for (const [method, extra, latent] of [
        ['createWorkflow', { positive: 'basket' }, '46'],
        ['createWorkflowRegional', { regional, positive_left: 'basket', positive_right: 'cloth' }, '58'],
    ]) {
        const wf = builder[method](checkpoint({ ...extra,
            refiner: { enable: true, model: 'waiIllustriousSDXL_v160.safetensors', ratio: 0.8, vpred: 0 },
            hifix: { ...hiresOn, model: 'Latent (nearest-exact)' },
        }));
        assert.deepEqual(wf[latent].inputs.samples, ['36', 0], method);
    }
});

test('Anima: hires and ADetailer sample from the same LoRA\'d model as the first pass', () => {
    const wf = builder.createWorkflowUNet(common({ unet, positive: `1girl, waving, ${FAST_TAG}` }));
    assert.deepEqual(wf['36'].inputs.model, ['34', 0]);
    assert.deepEqual(wf['61'].inputs.model, ['34', 0], 'the template wired the hires pass to the bare UNET loader 51');
    assert.deepEqual(detailerModels(wf), [['34', 0]]);
});

test('Anima: a HiFix-only LoRA gives the hires pass and ADetailer the hires model', () => {
    const wf = builder.createWorkflowUNet(common({ unet, positive: `1girl, ${HIFIX_ONLY}` }));
    assert.deepEqual(wf['36'].inputs.model, ['34', 0]);
    assert.deepEqual(wf['61'].inputs.model, ['34', 2]);
    assert.deepEqual(detailerModels(wf), [['34', 2]], 'ADetailer works on the hires image');
    const noHires = builder.createWorkflowUNet(common({ unet, positive: `1girl, ${HIFIX_ONLY}`, hifix: hiresOff }));
    assert.equal(noHires['61'], undefined);
    assert.deepEqual(detailerModels(noHires), [['34', 0]], 'without hires ADetailer follows the first pass');
});

test('Anima regional: hires and ADetailer take the LoRA node 39 too', () => {
    const wf = builder.createWorkflowRegionalUnet(common({ unet, regional, positive_left: `1girl, ${FAST_TAG}`, positive_right: '1boy' }));
    assert.deepEqual(wf['36'].inputs.model, ['39', 0]);
    assert.deepEqual(wf['20'].inputs.model, ['39', 0]);
    assert.deepEqual(detailerModels(wf), [['39', 0]], 'was the bare UNET loader 59');
});

test('Checkpoint: ADetailer samples from the LoRA\'d model, hires shares it when the strengths match', () => {
    const wf = builder.createWorkflow(checkpoint({ positive: '1girl, <lora:dmd2_sdxl_4step_lora_fp16.safetensors:1:1>' }));
    assert.deepEqual(wf['36'].inputs.model, ['34', 0]);
    assert.deepEqual(wf['20'].inputs.model, ['34', 0], 'was 39:2, a second clone of the same weights');
    assert.deepEqual(detailerModels(wf), [['34', 0]], 'was the bare checkpoint 45 (no LoRA, no v-prediction sampling)');

    const refined = builder.createWorkflow(checkpoint({
        positive: '1girl', hifix: hiresOff,
        refiner: { enable: true, model: 'other.safetensors', vpred: 0, ratio: 0.8, addnoise: false },
    }));
    assert.deepEqual(detailerModels(refined), [['39', 0]], 'a refiner checkpoint ends the run: ADetailer follows it');

    const regionalWf = builder.createWorkflowRegional(checkpoint({ regional, positive_left: `1girl, ${HIFIX_ONLY}`, positive_right: '1boy' }));
    assert.deepEqual(regionalWf['20'].inputs.model, ['34', 2]);
    assert.deepEqual(detailerModels(regionalWf), [['34', 2]]);
});

test('the LoRA nodes read the tags only: a new prompt with the same LoRAs gives them the same inputs', () => {
    // LoRAfromText runs again on any change of its inputs and makes new clones, which
    // ComfyUI's dynamic VRAM reloads from disk (2026-10-12: ~70 s per image, SDXL on a hard disk)
    const builds = [
        ['createWorkflow', text => checkpoint({ positive: text }), ['34', '39'], ['2', '41']],
        ['createWorkflowRegional', text => checkpoint({ regional, positive_left: text, positive_right: '1boy' }), ['34', '39'], ['2', '41']],
        ['createWorkflowUNet', text => common({ unet, positive: text }), ['34'], ['2']],
        ['createWorkflowRegionalUnet', text => common({ unet, regional, positive_left: text, positive_right: '1boy' }), ['39'], ['41']],
    ];
    for (const [build, data, loraNodes, encoders] of builds) {
        const one = builder[build](data(`1girl, smile, ${FAST_TAG}`));
        const two = builder[build](data(`1boy, ${FAST_TAG}, from below`));
        for (const id of loraNodes) {
            assert.equal(one[id].class_type, 'LoRAfromText', `${build}: ${id}`);
            assert.equal(one[id].inputs.text, FAST_TAG, `${build}: ${id} reads the tags`);
            assert.deepEqual(one[id].inputs, two[id].inputs, `${build}: ${id} is the same node for both prompts`);
        }
        for (const id of encoders) {
            assert.equal(one[id].class_type, 'CLIPTextEncode');
            assert.equal(one[id].inputs.text, '1girl, smile,', `${build}: encoder ${id} takes the prompt without the tags`);
            assert.equal(two[id].inputs.text, '1boy, , from below');
        }
        const saver = ofType(one, 'ImageSaverMira')[0];
        const saved = Array.isArray(saver.inputs.positive) ? one[saver.inputs.positive[0]].inputs.text : saver.inputs.positive;
        assert.ok(saved.includes(FAST_TAG), `${build}: the saved metadata keeps the tags`);
    }
});

test('Checkpoint with IP-Adapter: the hires pass keeps its LoRAs, on top of the adapter', () => {
    const ipa = { preModel: 'ip-adapter->clip_vision_vit_h.safetensors', postModel: 'IPA->ip-adapter-plus_sdxl_vit-h.safetensors', postStr: 0.6, postStart: 0, postEnd: 1, image: 'H4sI' };
    const wf = builder.createWorkflow(checkpoint({ positive: '1girl, <lora:a:1:1>', controlnet: [ipa] }));
    const [adapter] = Object.entries(wf).filter(([, node]) => node.class_type === 'AV_IPAdapter');
    assert.deepEqual(wf['34'].inputs.model, [adapter[0], 0], 'the first pass samples through the adapter');
    assert.deepEqual(wf['20'].inputs.model, ['34', 0], 'was wired to the adapter directly, skipping every LoRA');
});

test('Checkpoint with IP-Adapter and a refiner: each pass keeps its own checkpoint under the adapter', () => {
    const ipa = { preModel: 'ip-adapter->clip_vision_vit_h.safetensors', postModel: 'IPA->ip-adapter-plus_sdxl_vit-h.safetensors', postStr: 0.6, postStart: 0, postEnd: 1, image: 'H4sI' };
    const refiner = { enable: true, model: 'refiner.safetensors', vpred: 0, ratio: 0.8, addnoise: false };
    for (const [build, extra] of [
        ['createWorkflow', { positive: '1girl, <lora:a:1:1>' }],
        ['createWorkflowRegional', { regional, positive_left: '1girl, <lora:a:1:1>', positive_right: '1boy' }],
    ]) {
        const wf = builder[build](checkpoint({ ...extra, controlnet: [ipa], refiner }));
        const adapters = Object.entries(wf).filter(([, node]) => node.class_type === 'AV_IPAdapter');
        assert.equal(adapters.length, 2, `${build}: one adapter per checkpoint`);
        const [[baseId, base], [refinerId, refined]] = adapters;
        assert.equal(wf['35'].inputs.model[0], '45', 'node 35 samples the base checkpoint');
        assert.deepEqual(base.inputs.model, ['35', 0], `${build}: the first pass's adapter sits on the base checkpoint, not the refiner's 44`);
        assert.deepEqual(wf['34'].inputs.model, [baseId, 0]);
        assert.deepEqual(refined.inputs.model, ['44', 0]);
        assert.deepEqual(wf['39'].inputs.model, [refinerId, 0]);
        assert.deepEqual(wf['20'].inputs.model, ['39', 0], `${build}: hires follows the refiner`);
    }
});
