// scripts/main/modelList.js against a model folder of its own: electron, main-common and
// js-yaml are swapped for stubs through module hooks, and the checkpoints, LoRAs, VAEs and
// the rest are empty files in a temp tree. Nothing reaches a backend; only the scan and the
// lists are run.
//
// What is pinned: which files each list picks up, what the keyword filter keeps, what a
// remote ComfyUI's own lists replace, and where the LoRA list says it came from — Fast mode
// reads that source before it rewrites a LoRA path for the pod.
//
// The two config files are written as JSON, which is YAML: js-yaml is an electron dependency
// and is not installed for a `node --test` run, so its `load` is stood in for by JSON.parse,
// which answers these documents with the same object. What is under test is what modelList
// does with the config, not how YAML is read.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import module from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'saa-model-list-'));
const comfyModels = path.join(root, 'comfy', 'models');
const comfyCheckpoints = path.join(comfyModels, 'checkpoints');
const webuiModels = path.join(root, 'webui', 'models');
const webuiCheckpoints = path.join(webuiModels, 'Stable-diffusion');

function touch(...parts) {
    const file = path.join(...parts);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '');
    return file;
}

// --- ComfyUI
touch(comfyCheckpoints, 'waiNSFW_v14.safetensors');
touch(comfyCheckpoints, 'SDXL', 'animagineXL40.safetensors');
touch(comfyCheckpoints, 'notes.txt');                                  // not a model
touch(comfyModels, 'loras', 'detail_tweaker.safetensors');
touch(comfyModels, 'loras', 'style', 'ghibli.safetensors');
touch(comfyModels, 'vae', 'vae-ft-mse.safetensors');
touch(comfyModels, 'diffusion_models', 'anima_v1.safetensors');
touch(comfyModels, 'diffusion_models', 'flux1-dev-Q8.gguf');
touch(comfyModels, 'unet', 'wan22_i2v.safetensors');
touch(comfyModels, 'text_encoders', 'clip_l.safetensors');
touch(comfyModels, 'text_encoders', 't5xxl_fp8.gguf');
touch(comfyModels, 'controlnet', 'union_sdxl.safetensors');
touch(comfyModels, 'clip_vision', 'clip_vision_g.safetensors');
touch(comfyModels, 'ipadapter', 'ip-adapter_sdxl.safetensors');
touch(comfyModels, 'upscale_models', '4x-UltraSharp.pth');
touch(comfyModels, 'upscale_models', '4x-AnimeSharp.safetensors');
touch(comfyModels, 'ultralytics', 'bbox', 'face_yolov8n.pt');
touch(comfyModels, 'sams', 'sam_vit_b.pth');
touch(comfyModels, 'onnx', 'wd-v1-4', 'model.onnx');
// --- WebUI
touch(webuiCheckpoints, 'animefull-final.safetensors');
touch(webuiCheckpoints, 'noobai-Q8.gguf');
touch(webuiModels, 'Lora', 'webui_style.safetensors');
touch(webuiModels, 'VAE', 'kl-f8-anime2.safetensors');
touch(webuiModels, 'ControlNet', 'control_canny.safetensors');
touch(webuiModels, 'adetailer', 'face_yolov8s.pt');
touch(webuiModels, 'ESRGAN', '4x_foolhardy_Remacri.pth');              // only reached through extra_model_paths.yaml
// --- the app's own folder
touch(root, 'models', 'tagger', 'wd-v1-4-moat-tagger-v2.onnx');

const stub = { handlers: {}, mutex: [] };
globalThis.__modelListStub = stub;

const STUBS = {
    electron: `
        const stub = globalThis.__modelListStub;
        export const app = { isPackaged: false, getAppPath: () => ${JSON.stringify(root)}, getPath: () => ${JSON.stringify(root)} };
        export const ipcMain = { handle: (channel, handler) => { stub.handlers[channel] = handler; } };`,
    main_common: `
        export async function setMutexBackendBusy(value) { globalThis.__modelListStub.mutex.push(value); }`,
    yaml: `
        export function load(text) { return JSON.parse(text); }`,
};
const stubUrl = name => `data:text/javascript,${encodeURIComponent(STUBS[name])}`;

const hooksAvailable = typeof module.registerHooks === 'function';
if (hooksAvailable) {
    module.registerHooks({
        resolve(specifier, context, nextResolve) {
            const fromModelList = String(context.parentURL ?? '').endsWith('/scripts/main/modelList.js');
            if (specifier === 'saa-model-list-hook-probe') return { url: stubUrl('electron'), shortCircuit: true };
            if (fromModelList && specifier === 'electron') return { url: stubUrl('electron'), shortCircuit: true };
            if (fromModelList && specifier === '../../main-common.js') return { url: stubUrl('main_common'), shortCircuit: true };
            if (fromModelList && specifier === 'js-yaml') return { url: stubUrl('yaml'), shortCircuit: true };
            return nextResolve(specifier, context);
        },
    });
}

// Loaded only with the stubs in place: main-common would start a real electron app.
let modelList = null;
if (hooksAvailable) {
    const probe = await import('saa-model-list-hook-probe');
    if (typeof probe.app === 'object') modelList = await import('../scripts/main/modelList.js');
}
const opts = { skip: modelList ? false : 'needs node:module registerHooks', timeout: 30_000 };

test.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
});

const SETTINGS = {
    model_path_comfyui: comfyCheckpoints,
    model_path_webui: webuiCheckpoints,
    model_filter_keyword: '*',
    model_filter_keyword_diffusion: '*',
    model_filter: false,
    search_modelinsubfolder: true,
};

// A boot with these settings: the call main.js makes, so the lists under test are the ones
// the app starts with.
function boot(extra = {}) {
    stub.handlers = {};
    stub.mutex = [];
    modelList.setupModelList({ ...SETTINGS, ...extra });
}

const relative = (...parts) => path.join(...parts);

test('the checkpoint scan takes the model files of the folder and its subfolders, and nothing else', opts, () => {
    boot();
    assert.deepEqual(modelList.getModelList('ComfyUI').sort(), ['waiNSFW_v14.safetensors', relative('SDXL', 'animagineXL40.safetensors')].sort());
    assert.deepEqual(modelList.getModelList('WebUI').sort(), ['animefull-final.safetensors', 'noobai-Q8.gguf'].sort(), 'WebUI reads .gguf models too');
    assert.equal(modelList.getModelList('ComfyUI').includes('notes.txt'), false);
    assert.deepEqual(modelList.getModelList('nonsense'), ['None'], 'an interface that is neither is answered with None');

    boot({ search_modelinsubfolder: false });
    assert.deepEqual(modelList.getModelList('ComfyUI'), ['waiNSFW_v14.safetensors'], 'subfolders are left out when the setting is off');
});

test('the keyword filter keeps the matching checkpoints, and the whole list stays beside it', opts, () => {
    boot({ model_filter: true, model_filter_keyword: 'wai' });
    assert.deepEqual(modelList.getModelList('ComfyUI'), ['waiNSFW_v14.safetensors']);
    assert.deepEqual(modelList.getModelListAll('ComfyUI').sort(), ['waiNSFW_v14.safetensors', relative('SDXL', 'animagineXL40.safetensors')].sort(),
        'the unfiltered list is what the settings modal offers');
    assert.deepEqual(modelList.getModelList('WebUI'), ['Default'], 'no WebUI model carries the keyword');
    assert.deepEqual(modelList.getModelListAll('nonsense'), ['None']);

    // several keywords, and the match is on any part of the name, whatever its case
    boot({ model_filter: true, model_filter_keyword: ' WAI , animagine ' });
    assert.deepEqual(modelList.getModelList('ComfyUI').sort(), ['waiNSFW_v14.safetensors', relative('SDXL', 'animagineXL40.safetensors')].sort());

    // a keyword nothing matches leaves the dropdown with one entry rather than an empty one
    boot({ model_filter: true, model_filter_keyword: 'pony' });
    assert.deepEqual(modelList.getModelList('ComfyUI'), ['Default']);
    assert.deepEqual(modelList.getModelList('WebUI'), ['Default']);

    // '*' and a filter that is off keep every model
    for (const settings of [{ model_filter: true, model_filter_keyword: '*' }, { model_filter: false, model_filter_keyword: 'wai' }]) {
        boot(settings);
        assert.equal(modelList.getModelList('ComfyUI').length, 2, JSON.stringify(settings));
        assert.equal(modelList.getModelList('WebUI').length, 2, JSON.stringify(settings));
    }
});

test('the diffusion list reads both folders and both file kinds, under its own keyword', opts, () => {
    boot();
    assert.deepEqual(modelList.getDiffusionModelList('ComfyUI').sort(),
        ['anima_v1.safetensors', 'flux1-dev-Q8.gguf', 'wan22_i2v.safetensors'].sort(), 'diffusion_models and unet, .safetensors and .gguf');
    assert.deepEqual(modelList.getDiffusionModelList('WebUI').sort(), ['animefull-final.safetensors', 'noobai-Q8.gguf'].sort(),
        'WebUI has no separate diffusion folder');
    assert.deepEqual(modelList.getDiffusionModelList('nonsense'), ['None']);

    // the checkpoint keyword must not reach it: an SDXL filter would hide every Anima model
    boot({ model_filter: true, model_filter_keyword: 'wai', model_filter_keyword_diffusion: 'anima' });
    assert.deepEqual(modelList.getDiffusionModelList('ComfyUI'), ['anima_v1.safetensors']);
    boot({ model_filter: true, model_filter_keyword: 'wai', model_filter_keyword_diffusion: 'nothing-like-this' });
    assert.deepEqual(modelList.getDiffusionModelList('ComfyUI'), ['None']);
});

test('the other ComfyUI lists: LoRA, VAE, text encoders, ControlNet, upscalers, ADetailer, ONNX', opts, () => {
    boot();
    assert.deepEqual(modelList.getLoRAList('ComfyUI').sort(), ['detail_tweaker.safetensors', relative('style', 'ghibli.safetensors')].sort());
    assert.deepEqual(modelList.getLoRAList('WebUI'), ['webui_style.safetensors']);
    assert.deepEqual(modelList.getVAEList('ComfyUI'), ['vae-ft-mse.safetensors']);
    assert.deepEqual(modelList.getVAEList('WebUI'), ['kl-f8-anime2.safetensors']);
    assert.deepEqual(modelList.getTextEncoderList('ComfyUI').sort(), ['clip_l.safetensors', 't5xxl_fp8.gguf'].sort());

    // clip vision and IPAdapter models ride along under their own prefixes, behind 'none'
    const controlnet = modelList.getControlNetList('ComfyUI');
    assert.equal(controlnet[0], 'none', 'the empty choice comes first');
    assert.deepEqual(controlnet.slice(1).sort(), ['union_sdxl.safetensors', 'CV->clip_vision_g.safetensors', 'IPA->ip-adapter_sdxl.safetensors'].sort());
    assert.deepEqual(modelList.getControlNetList('WebUI'), ['none', 'control_canny.safetensors']);

    // the upscalers keep their file names and the latent ones are added
    const upscalers = modelList.getUpscalerList('ComfyUI');
    assert.deepEqual(upscalers.slice(0, 2).sort(), ['4x-UltraSharp.pth', '4x-AnimeSharp.safetensors'].sort());
    assert.deepEqual(upscalers.slice(2), ['Latent (nearest-exact)', 'Latent (bilinear)', 'Latent (area)', 'Latent (bicubic)', 'Latent (bislerp)']);
    // WebUI has no upscale_models folder here, so the names A1111 ships with are used
    assert.equal(modelList.getUpscalerList('WebUI').includes('R-ESRGAN 4x+ Anime6B'), true);
    assert.equal(modelList.getUpscalerList('WebUI').includes('Latent (area)'), false, 'the latent ones are a ComfyUI thing');
    // and when there is one, WebUI is asked for the name without its extension
    const webuiUpscalers = path.join(webuiModels, 'upscale_models');
    touch(webuiUpscalers, '4x_foolhardy_Remacri.pth');
    touch(webuiUpscalers, '4x-AnimeSharp.safetensors');
    try {
        boot();
        assert.deepEqual(modelList.getUpscalerList('WebUI').sort(), ['4x-AnimeSharp', '4x_foolhardy_Remacri']);
    } finally {
        fs.rmSync(webuiUpscalers, { recursive: true, force: true });
    }

    assert.deepEqual(modelList.getADetailerList('ComfyUI').sort(), ['face_yolov8n.pt', 'sam_vit_b.pth'].sort(), 'the bbox and the SAM models');
    assert.deepEqual(modelList.getADetailerList('WebUI'), ['face_yolov8s.pt']);
    assert.deepEqual(modelList.getONNXList('ComfyUI'), ['wd-v1-4/model.onnx'], 'ONNX names are written with forward slashes for the backend');
    assert.deepEqual(modelList.getONNXList('WebUI'), ['None']);
    assert.deepEqual(modelList.getImageTaggerModels(), ['wd-v1-4-moat-tagger-v2.onnx']);
});

test('a folder that is not there leaves the list with its empty entry, never undefined', opts, () => {
    boot({ model_path_comfyui: path.join(root, 'nowhere', 'checkpoints'), model_path_webui: path.join(root, 'nowhere', 'models') });
    assert.deepEqual(modelList.getModelList('ComfyUI'), ['Default']);
    assert.deepEqual(modelList.getLoRAList('ComfyUI'), []);
    assert.deepEqual(modelList.getVAEList('ComfyUI'), ['None']);
    assert.deepEqual(modelList.getDiffusionModelList('ComfyUI'), ['None']);
    assert.deepEqual(modelList.getTextEncoderList('ComfyUI'), ['None']);
    assert.deepEqual(modelList.getControlNetList('ComfyUI'), ['none']);
    assert.deepEqual(modelList.getADetailerList('ComfyUI'), ['None']);
    assert.deepEqual(modelList.getONNXList('ComfyUI'), ['None']);
    assert.equal(modelList.getUpscalerList('ComfyUI')[0], 'None');
});

test('a local scan says the LoRA list is local; a remote one says which backend it came from', opts, () => {
    boot();
    assert.equal(modelList.getLoRAListSource(), 'local');

    // Fast mode reads this before it rewrites a LoRA path: a pod list is not a local folder
    const applied = modelList.applyRemoteModelLists({ loras: ['pod/anime_detailer.safetensors'] }, {}, 'pod');
    assert.deepEqual(applied, ['loras']);
    assert.deepEqual(modelList.getLoRAList('ComfyUI'), ['pod/anime_detailer.safetensors']);
    assert.equal(modelList.getLoRAListSource(), 'pod');

    // a reload from the settings puts it back on the folder on this machine
    modelList.updateModelAndLoRAList([comfyCheckpoints, webuiCheckpoints, '*', false, true, '*']);
    assert.equal(modelList.getLoRAListSource(), 'local');
    assert.deepEqual(modelList.getLoRAList('ComfyUI').sort(), ['detail_tweaker.safetensors', relative('style', 'ghibli.safetensors')].sort());
    assert.deepEqual(stub.mutex, [false], 'the reload also lets go of the generation mutex');

    // an empty remote list is not a list: the empty entry stands in for it
    modelList.applyRemoteModelLists({ loras: [] }, {}, 'https');
    assert.deepEqual(modelList.getLoRAList('ComfyUI'), ['None']);
    assert.equal(modelList.getLoRAListSource(), 'https', 'it is still the remote backend that has no LoRAs');
});

test('the remote lists replace the ComfyUI ones kind by kind, and leave the rest of the scan alone', opts, () => {
    boot();
    const webuiBefore = modelList.getModelList('WebUI');
    const applied = modelList.applyRemoteModelLists({
        checkpoints: ['pod_waiNSFW.safetensors', 'pod_animagine.safetensors'],
        vae: ['pod_vae.safetensors'],
        upscalers: ['pod_4x.pth'],
        controlnet: ['pod_union.safetensors'],
        diffusion: ['pod_anima.safetensors', 'pod_flux.gguf'],
        textEncoders: ['pod_clip.safetensors'],
    }, { model_filter_keyword: 'wai', model_filter_keyword_diffusion: 'anima', model_filter: true }, 'pod');

    assert.deepEqual(applied.sort(), ['checkpoints', 'controlnet', 'diffusion', 'textEncoders', 'upscalers', 'vae']);
    assert.deepEqual(modelList.getModelList('ComfyUI'), ['pod_waiNSFW.safetensors'], 'the checkpoint keyword still applies');
    assert.deepEqual(modelList.getModelListAll('ComfyUI'), ['pod_waiNSFW.safetensors', 'pod_animagine.safetensors'], 'unfiltered, as the settings modal wants it');
    assert.deepEqual(modelList.getDiffusionModelList('ComfyUI'), ['pod_anima.safetensors'], 'and the diffusion keyword, not the checkpoint one');
    assert.deepEqual(modelList.getVAEList('ComfyUI'), ['pod_vae.safetensors']);
    assert.deepEqual(modelList.getTextEncoderList('ComfyUI'), ['pod_clip.safetensors']);
    assert.deepEqual(modelList.getControlNetList('ComfyUI'), ['none', 'pod_union.safetensors']);
    assert.deepEqual(modelList.getUpscalerList('ComfyUI').slice(0, 2), ['pod_4x.pth', 'Latent (nearest-exact)']);
    assert.deepEqual(modelList.getLoRAList('ComfyUI').sort(), ['detail_tweaker.safetensors', relative('style', 'ghibli.safetensors')].sort(),
        'a kind the backend did not send keeps the local scan');
    assert.equal(modelList.getLoRAListSource(), 'local', 'and keeps saying it is local');
    assert.deepEqual(modelList.getModelList('WebUI'), webuiBefore, 'the WebUI lists are not a remote ComfyUI to replace');

    // nothing sent at all changes nothing
    assert.deepEqual(modelList.applyRemoteModelLists({}, {}), []);
    assert.deepEqual(modelList.applyRemoteModelLists(null, {}), []);
    assert.deepEqual(modelList.getModelList('ComfyUI'), ['pod_waiNSFW.safetensors']);
    // a filter that keeps no checkpoint still leaves the dropdown an entry
    modelList.applyRemoteModelLists({ checkpoints: ['pod_animagine.safetensors'] }, { model_filter_keyword: 'wai', model_filter: true });
    assert.deepEqual(modelList.getModelList('ComfyUI'), ['Default']);
    // and an empty list of each kind falls back to the entry the dropdown needs
    modelList.applyRemoteModelLists({ vae: [], upscalers: [], diffusion: [], textEncoders: [], controlnet: [] }, {});
    assert.deepEqual(modelList.getVAEList('ComfyUI'), ['None']);
    assert.deepEqual(modelList.getTextEncoderList('ComfyUI'), ['None']);
    assert.deepEqual(modelList.getDiffusionModelList('ComfyUI'), ['None']);
    assert.deepEqual(modelList.getControlNetList('ComfyUI'), ['none']);
    assert.equal(modelList.getUpscalerList('ComfyUI')[0], 'None');
});

test("extra_model_paths.yaml adds the WebUI install's models to the ComfyUI lists", opts, () => {
    const yamlFile = path.join(root, 'comfy', 'extra_model_paths.yaml');
    fs.writeFileSync(yamlFile, JSON.stringify({
        a111: {
            base_path: path.join(root, 'webui'),
            checkpoints: 'models/Stable-diffusion',
            loras: 'models/Lora\n',                              // the block form, one path per line
            controlnet: ['models/ControlNet', '  ', ' models/Nowhere '],  // and the list form
            upscale_models: 'models/ESRGAN',
            vae: 'models/VAE',
        },
    }));
    try {
        boot();
        assert.equal(modelList.getExtraModels().exist, true);
        assert.deepEqual(modelList.collectRelativePaths('checkpoints'), ['models/Stable-diffusion']);
        assert.deepEqual(modelList.collectRelativePaths('loras'), ['models/Lora'], 'the blank line of a block is not a path');
        assert.deepEqual(modelList.collectRelativePaths('controlnet'), ['models/ControlNet', 'models/Nowhere'],
            'each entry of a list is its own path, trimmed, and a blank one is dropped');
        assert.deepEqual(modelList.collectRelativePaths('nothing_here'), []);

        assert.equal(modelList.getModelList('ComfyUI').includes('animefull-final.safetensors'), true, 'the A1111 checkpoint is offered under ComfyUI too');
        assert.equal(modelList.getLoRAList('ComfyUI').includes('webui_style.safetensors'), true);
        assert.equal(modelList.getControlNetList('ComfyUI').includes('control_canny.safetensors'), true);
        assert.equal(modelList.getUpscalerList('ComfyUI').includes('4x_foolhardy_Remacri.pth'), true, 'upscalers are read as .pth');
        assert.deepEqual(modelList.getExtraModels().vae, ['kl-f8-anime2.safetensors']);

        // and the keyword filter still decides what the dropdown shows
        boot({ model_filter: true, model_filter_keyword: 'animefull' });
        assert.deepEqual(modelList.getModelList('ComfyUI'), ['animefull-final.safetensors']);

        // a file that names no A1111 install is no reason to fail the boot
        fs.writeFileSync(yamlFile, JSON.stringify({ comfyui: { base_path: path.join(root, 'comfy') } }));
        boot();
        assert.equal(modelList.getExtraModels().exist, false);
        assert.equal(modelList.getModelList('ComfyUI').includes('animefull-final.safetensors'), false);
    } finally {
        fs.rmSync(yamlFile, { force: true });
        boot();
        assert.equal(modelList.getExtraModels().exist, false, 'the extra models are dropped once the file is gone');
    }
});

test('custom_path.yaml scans the folders it names instead of the ones beside the checkpoints', opts, () => {
    const elsewhere = path.join(root, 'elsewhere');
    touch(elsewhere, 'loras', 'external_lora.safetensors');
    touch(elsewhere, 'loras', 'shared_name.safetensors');
    touch(elsewhere, 'loras_extra', 'second_lora.safetensors');
    touch(elsewhere, 'loras_extra', 'shared_name.safetensors');      // the same name in both folders
    touch(elsewhere, 'cn', 'custom_control.safetensors');
    touch(elsewhere, 'cv', 'custom_clip_vision.safetensors');
    touch(elsewhere, 'ipa', 'custom_ipadapter.safetensors');
    const absoluteLoras = path.join(root, 'absolute_loras');
    touch(absoluteLoras, 'absolute_lora.safetensors');
    const configFile = path.join(root, 'data', 'custom_path.yaml');
    fs.mkdirSync(path.dirname(configFile), { recursive: true });
    const config = {
        use_custom_path: true,
        comfyui: {
            enable: true,
            base_path: elsewhere,
            lora: `loras\nloras_extra\nloras_that_are_gone\n${absoluteLoras}`,   // several folders: one not there, one named in full
            controlnet: 'cn',
            clip_vision: 'cv',
            ipadapter: 'ipa',
        },
    };
    fs.writeFileSync(configFile, JSON.stringify(config));
    try {
        boot();
        assert.deepEqual(modelList.getLoRAList('ComfyUI').sort(),
            ['absolute_lora.safetensors', 'external_lora.safetensors', 'second_lora.safetensors', 'shared_name.safetensors'],
            'every folder the file names is scanned (under the base path or named in full), one that is not there is skipped, and a name found twice is offered once');
        assert.equal(modelList.getLoRAListSource(), 'local', 'a folder on this machine is still local');
        assert.deepEqual(modelList.getVAEList('ComfyUI'), ['vae-ft-mse.safetensors'], 'a kind the file does not name keeps the default folder');
        assert.deepEqual(modelList.getControlNetList('ComfyUI'),
            ['none', 'custom_control.safetensors', 'CV->custom_clip_vision.safetensors', 'IPA->custom_ipadapter.safetensors'],
            'the clip vision and IPAdapter models keep their prefixes here too');

        // a section that is switched off, and a file that does not ask for custom paths at all
        for (const off of [{ ...config, comfyui: { ...config.comfyui, enable: false } }, { ...config, use_custom_path: false }]) {
            fs.writeFileSync(configFile, JSON.stringify(off));
            boot();
            assert.deepEqual(modelList.getLoRAList('ComfyUI').sort(), ['detail_tweaker.safetensors', relative('style', 'ghibli.safetensors')].sort(), JSON.stringify(off));
        }
    } finally {
        fs.rmSync(configFile, { force: true });
        fs.rmSync(elsewhere, { recursive: true, force: true });
        fs.rmSync(absoluteLoras, { recursive: true, force: true });
    }
});

test('every list is offered over IPC, and answers what the getter answers', opts, async () => {
    boot();
    assert.deepEqual(Object.keys(stub.handlers).sort(), [
        'get-adetailer-list', 'get-controlnet-list', 'get-diffusion-model-list', 'get-image-tagger-models',
        'get-lora-list-all', 'get-model-list', 'get-model-list-all', 'get-onnx-list', 'get-text-encoder-list',
        'get-upscaler-list', 'get-vae-list', 'update-model-list',
    ]);
    assert.deepEqual(await stub.handlers['get-model-list']({}, 'ComfyUI'), modelList.getModelList('ComfyUI'));
    assert.deepEqual(await stub.handlers['get-lora-list-all']({}, 'ComfyUI'), modelList.getLoRAList('ComfyUI'));
    assert.deepEqual(await stub.handlers['get-onnx-list']({}, 'ComfyUI'), modelList.getONNXList('ComfyUI'));
    assert.deepEqual(await stub.handlers['get-image-tagger-models']({}), modelList.getImageTaggerModels());

    // the reload channel takes the settings as an array, in the order the renderer sends them
    stub.mutex = [];
    await stub.handlers['update-model-list']({}, [comfyCheckpoints, webuiCheckpoints, 'wai', true, false, 'anima']);
    assert.deepEqual(modelList.getModelList('ComfyUI'), ['waiNSFW_v14.safetensors'], 'args[2] is the checkpoint keyword, args[3] turns it on');
    assert.deepEqual(modelList.getDiffusionModelList('ComfyUI'), ['anima_v1.safetensors'], 'args[5] is the diffusion keyword');
    assert.deepEqual(modelList.getLoRAList('ComfyUI'), ['detail_tweaker.safetensors'], 'args[4] off leaves the subfolders out');
    assert.deepEqual(stub.mutex, [false]);
});
