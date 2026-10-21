import assert from 'node:assert/strict';
import { register } from 'node:module';
import test, { beforeEach } from 'node:test';

// Load the real backend builders without Electron or a running ComfyUI server.
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

beforeEach(t => {
    // Make an accidental random seed observable without probabilistic failures.
    let random = 900000;
    t.mock.method(globalThis.crypto, 'getRandomValues', values => {
        values.fill(++random);
        return values;
    });
});

const detailer = {
    model: 'bbox/hand_yolov8n.pt', confidence: 0.5, mask_filter_method: 'sam_vit_b_01ec64.pth',
    prompt: '', negative_prompt: '', promptMode: 'inherit', seed: -1,
    steps: 8, cfg: 1.5, sampler: 'euler', scheduler: 'simple', denoise: 0.5,
    mask_blur: 4, dilate_erode: 4, mask_merge_invert: 'center-1',
};
const hires = { enable: false, scale: 1.5, model: '4x-AnimeSharp.pth', denoise: 0.4, steps: 8, cfg: 1.5, seed: 71, colorTransfer: 'Mean' };
const refiner = { enable: false, model: 'refiner.safetensors', vpred: 0, ratio: 0.8, addnoise: false };
const controlnet = [{ imageAfter: 'H4sI', preModel: 'None', postModel: 'controlnet.safetensors', postStr: 0.7, postStart: 0, postEnd: 1 }];
const paths = [
    { method: 'createWorkflow', checkpoint: true, hiresSampler: '20' },
    { method: 'createWorkflowRegional', checkpoint: true, hiresSampler: '20' },
    { method: 'createWorkflowUNet', checkpoint: false, hiresSampler: '61' },
    { method: 'createWorkflowRegionalUnet', checkpoint: false, hiresSampler: '20' },
];

function data(overrides = {}) {
    return {
        addr: '127.0.0.1:8189', auth: '', uuid: 'u', refresh: 0, model: 'base.safetensors', vpred: 0,
        positive: 'a red bird', negative: 'lowres, blurry', positive_left: 'a red bird', positive_right: 'a blue bird',
        width: 512, height: 512, cfg: 1.5, step: 8, seed: 31415, sampler: 'euler', scheduler: 'simple', img_prefix: 'test',
        adetailer: [{ ...detailer }], hifix: { ...hires }, refiner: { ...refiner }, controlnet: [], vae: { vae_override: false, vae: 'None' },
        unet: { enable: true, model: 'anima.safetensors', dtype: 'default', clip_model: 'qwen.safetensors', clip_type: 'stable_diffusion', clip_device: 'default', vae_model: 'vae.safetensors' },
        regional: { ratio: '1,1', split: 'left-right', str_left: 1, str_right: 1, option_left: 'default', option_right: 'default' },
        ...overrides,
    };
}
const detailers = workflow => Object.values(workflow).filter(node => node.class_type === 'FaceDetailer');
function assertInherited(workflow, samplerId) {
    const sampler = workflow[samplerId];
    assert.match(sampler.class_type, /KSampler/);
    assert.equal(detailers(workflow).length, 1);
    for (const polarity of ['positive', 'negative']) {
        assert.deepEqual(detailers(workflow)[0].inputs[polarity], sampler.inputs[polarity],
            `${polarity} must reuse the final image sampler's conditioning, including its output index`);
    }
}
function assertPrompt(workflow, link, expected) {
    const encoder = workflow[link[0]];
    assert.equal(encoder.class_type, 'CLIPTextEncode');
    assert.equal(encoder.inputs.text, expected);
}

for (const path of paths) {
    const build = overrides => builder[path.method](data(overrides));
    for (const blank of ['', ' \t\n　']) {
        test(`${path.method}: inherit treats ${blank ? 'whitespace' : 'empty text'} as the original conditioning`, () => {
            const wf = build({ adetailer: [{ ...detailer, prompt: blank, negative_prompt: blank }] });
            assertInherited(wf, '36');
        });
    }

    test(`${path.method}: inherit follows the HiRes sampler`, () => {
        const wf = build({ hifix: { ...hires, enable: true } });
        assertInherited(wf, path.hiresSampler);
    });

    test(`${path.method}: explicit prompts survive inherit and empty modes`, () => {
        for (const promptMode of ['inherit', 'empty']) {
            const wf = build({ adetailer: [{ ...detailer, promptMode, prompt: 'detailed hands', negative_prompt: 'extra fingers' }] });
            const [node] = detailers(wf);
            assertPrompt(wf, node.inputs.positive, 'detailed hands');
            assertPrompt(wf, node.inputs.negative, 'extra fingers');
        }
    });

    test(`${path.method}: an explicit prompt only overrides its own polarity`, () => {
        for (const polarity of ['positive', 'negative']) {
            const field = polarity === 'positive' ? 'prompt' : 'negative_prompt';
            const other = polarity === 'positive' ? 'negative' : 'positive';
            const wf = build({ adetailer: [{ ...detailer, [field]: 'custom detail' }] });
            const [node] = detailers(wf);
            assertPrompt(wf, node.inputs[polarity], 'custom detail');
            assert.deepEqual(node.inputs[other], wf['36'].inputs[other]);
        }
    });

    test(`${path.method}: empty mode retains deliberately empty conditioning`, () => {
        const wf = build({ adetailer: [{ ...detailer, promptMode: 'empty' }] });
        const [node] = detailers(wf);
        assertPrompt(wf, node.inputs.positive, '');
        assertPrompt(wf, node.inputs.negative, '');
    });

    test(`${path.method}: each detailer uses its fixed seed, including zero, or the generation seed`, () => {
        const unspecified = { ...detailer };
        delete unspecified.seed;
        const wf = build({ adetailer: [unspecified, { ...detailer, seed: -1 }, { ...detailer, seed: 0 }, { ...detailer, seed: 42 }] });
        assert.deepEqual(detailers(wf).map(node => node.inputs.seed), [31415, 31415, 0, 42]);
    });

    test(`${path.method}: an inherited generation seed of zero stays zero`, () => {
        const wf = build({ seed: 0 });
        assert.equal(detailers(wf)[0].inputs.seed, 0);
    });

    test(`${path.method}: identical fixed inputs produce identical complete graphs`, () => {
        for (const seed of [-1, 0, 42]) {
            const input = data({ hifix: { ...hires, enable: true }, adetailer: [{ ...detailer, seed }] });
            const one = builder[path.method](structuredClone(input));
            const two = builder[path.method](structuredClone(input));
            assert.deepEqual(two, one, `ADetailer seed ${seed} must not introduce fresh randomness`);
        }
    });

    if (path.checkpoint) {
        test(`${path.method}: inherit follows an active Refiner without HiRes`, () => {
            const wf = build({ refiner: { ...refiner, enable: true } });
            assertInherited(wf, '37');
        });
        for (const stage of ['base', 'refiner', 'hires', 'refiner-hires']) {
            test(`${path.method}: ${stage} inherits the final ControlNet-conditioned outputs`, () => {
                const refined = stage.includes('refiner');
                const upscaled = stage.includes('hires');
                const wf = build({ controlnet, refiner: { ...refiner, enable: refined }, hifix: { ...hires, enable: upscaled } });
                const finalSampler = upscaled ? path.hiresSampler : refined ? '37' : '36';
                const inputs = wf[finalSampler].inputs;
                assert.equal(wf[inputs.positive[0]].class_type, 'ControlNetApplyAdvanced', 'fixture applies ControlNet to the selected sampler');
                assert.equal(inputs.negative[1], 1, 'negative conditioning is ControlNet output 1');
                assertInherited(wf, finalSampler);
            });
        }
    }
}
