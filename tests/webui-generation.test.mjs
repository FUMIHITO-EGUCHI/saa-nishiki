// Behaviour of scripts/main/generate_backend_webui.js in plain node: electron (`net`,
// `ipcMain`), the renderer bridge of the ComfyUI backend and the generation mutex are
// swapped for stubs through module hooks, and a local HTTP server on an ephemeral
// loopback port stands in for WebUI / Forge. Nothing else is reached: every payload
// below is the one the module really sent, read back off that server.
import assert from 'node:assert/strict';
import http from 'node:http';
import module from 'node:module';
import test from 'node:test';

import { regionalRatio } from '../scripts/shared/regionalGeneration.js';

const stub = {
    busy: false,        // the generation mutex of main-common
    mutex: [],          // every setMutexBackendBusy value, in order
    renderer: [],       // { uuid, functionName, args } per sendToRenderer
    handlers: {},       // the ipcMain channels the module registers
};
globalThis.__webuiStub = stub;

const STUBS = {
    // electron's net.request over node's http: the same options and the same
    // 'response' / 'error' / 'timeout' events, so the request handling runs unchanged.
    // `agent: false` keeps each request on a socket of its own, as electron's net does -
    // node's keep-alive pool otherwise makes one request inherit another's idle timer.
    electron: `
        import http from 'node:http';
        export const ipcMain = {
            handle(name, handler) { globalThis.__webuiStub.handlers[name] = handler; },
        };
        export const net = {
            request(options) {
                const url = new URL(options.url);
                return http.request({
                    protocol: url.protocol,
                    hostname: url.hostname,
                    port: url.port,
                    path: url.pathname + url.search,
                    method: options.method || 'GET',
                    headers: options.headers || {},
                    timeout: options.timeout,
                    agent: false,
                });
            },
        };`,
    comfyui: `
        export function sendToRenderer(uuid, functionName, ...args) {
            globalThis.__webuiStub.renderer.push({ uuid, functionName, args });
        }`,
    main_common: `
        export async function getMutexBackendBusy() { return globalThis.__webuiStub.busy; }
        export async function setMutexBackendBusy(value) {
            globalThis.__webuiStub.busy = value;
            globalThis.__webuiStub.mutex.push(value);
            return { success: true, value };
        }`,
    probe: 'export const hooked = true;',
};
const stubUrl = name => `data:text/javascript,${encodeURIComponent(STUBS[name])}`;

const hooksAvailable = typeof module.registerHooks === 'function';
if (hooksAvailable) {
    module.registerHooks({
        resolve(specifier, context, nextResolve) {
            const fromWebUI = String(context.parentURL ?? '').endsWith('/scripts/main/generate_backend_webui.js');
            if (specifier === 'saa-webui-hook-probe') return { url: stubUrl('probe'), shortCircuit: true };
            if (fromWebUI && specifier === 'electron') return { url: stubUrl('electron'), shortCircuit: true };
            if (fromWebUI && specifier === './generate_backend_comfyui.js') return { url: stubUrl('comfyui'), shortCircuit: true };
            if (fromWebUI && specifier === '../../main-common.js') return { url: stubUrl('main_common'), shortCircuit: true };
            return nextResolve(specifier, context);
        },
    });
}

// Only with the stubs in place is the module loaded at all: without them it reaches electron.
let webui = null;
if (hooksAvailable) {
    const { hooked } = await import('saa-webui-hook-probe');
    if (hooked === true) webui = await import('../scripts/main/generate_backend_webui.js');
}
const skip = webui ? false : 'needs node:module registerHooks';
// a wait that never comes back fails its own test instead of leaving `node --test` running for good
const opts = { skip, timeout: 30_000 };

if (webui) webui.setupGenerateBackendWebUI();

// Every fake backend still listening, closed after the test whatever happened in it:
// an open server keeps the test process alive and turns a failure into a hang.
const openServers = new Set();

async function closeServer(server) {
    openServers.delete(server);
    server.closeAllConnections();
    await new Promise(resolve => server.close(() => resolve()));
}

// A WebUI / Forge stand-in. `state` decides what each endpoint answers; `calls` keeps
// what arrived, so a test reads the payload the module built instead of its source.
async function fakeWebUI(overrides = {}) {
    const calls = [];
    const state = {
        forge: true,
        models: ['control_v11p_sd15_openpose [cab727d4]', 'control_v11f1p_sd15_depth [cfd03158]'],
        modelListStatus: 200,
        modules: ['none', 'openpose_full', 'depth_midas'],
        adModels: ['face_yolov8n.pt', 'hand_yolov8n.pt'],
        adStatus: 200,
        upscalers: [{ name: 'None' }, { name: 'Latent' }, { name: '4x-UltraSharp' }],
        progress: { progress: 0.5, current_image: 'UFJFVklFVw==' },
        txt2img: { images: ['R0lGODlhAQABAAAAACw='], info: JSON.stringify({ seed: 1234, infotexts: ['1girl'] }) },
        txt2imgStatus: 200,
        txt2imgBody: null,      // a raw body, for a reply that is not JSON
        txt2imgDelay: 0,
        detect: { info: 'Success', images: ['Q09OVFJPTA=='] },
        drop: new Set(),        // paths whose connection is cut instead of answered
        ...overrides,
    };

    const reply = (res, status, value) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(typeof value === 'string' ? value : JSON.stringify(value));
    };

    const route = (req, res, url) => {
        const at = url.pathname;
        if (state.drop.has(at)) {
            req.socket.destroy();
            return;
        }
        if (at === '/sdapi/v1/options' && req.method === 'GET') {
            // Forge is told apart by forge_additional_modules being one of its options
            reply(res, 200, state.forge
                ? { sd_model_checkpoint: 'a.safetensors', forge_additional_modules: [] }
                : { sd_model_checkpoint: 'a.safetensors', sd_vae: 'Automatic' });
        } else if (at === '/sdapi/v1/options' && req.method === 'POST') {
            reply(res, 200, {});
        } else if (at === '/controlnet/model_list') {
            reply(res, state.modelListStatus, state.modelListStatus === 200 ? { model_list: state.models } : 'Not Found');
        } else if (at === '/controlnet/module_list') {
            reply(res, 200, { module_list: state.modules });
        } else if (at === '/adetailer/v1/ad_model') {
            reply(res, state.adStatus, state.adStatus === 200 ? { ad_model: state.adModels } : 'Not Found');
        } else if (at === '/sdapi/v1/upscalers') {
            reply(res, 200, state.upscalers);
        } else if (at === '/sdapi/v1/progress') {
            reply(res, 200, state.progress);
        } else if (at === '/sdapi/v1/interrupt') {
            reply(res, 200, {});
        } else if (at === '/controlnet/detect') {
            reply(res, 200, state.detect);
        } else if (at === '/sdapi/v1/txt2img') {
            const answer = () => reply(res, state.txt2imgStatus, state.txt2imgBody ?? state.txt2img);
            if (state.txt2imgDelay > 0) setTimeout(answer, state.txt2imgDelay).unref?.();
            else answer();
        } else {
            reply(res, 404, { detail: 'Not Found' });
        }
    };

    const server = http.createServer((req, res) => {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => {
            const url = new URL(req.url, 'http://backend');
            calls.push({ method: req.method, path: url.pathname, search: url.search, headers: req.headers, body });
            route(req, res, url);
        });
    });
    openServers.add(server);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));

    return {
        state,
        calls,
        addr: `127.0.0.1:${server.address().port}`,
        close: () => closeServer(server),
        of(path, method = 'POST') {
            return calls.filter(call => call.path === path && call.method === method).at(-1);
        },
        payload(path = '/sdapi/v1/txt2img') {
            const call = this.of(path);
            assert.ok(call, `no POST ${path} was sent`);
            return JSON.parse(call.body);
        },
    };
}

async function until(check, timeoutMs = 10_000) {
    const deadline = Date.now() + timeoutMs;
    while (!check()) {
        if (Date.now() > deadline) throw new Error('timed out waiting');
        await new Promise(resolve => { setTimeout(resolve, 10).unref?.(); });
    }
}

function reset() {
    Object.assign(stub, { busy: false, mutex: [], renderer: [] });
    webui.resetModelLists();
}

const previews = () => stub.renderer.filter(call => call.functionName === 'updatePreview');
const progresses = () => stub.renderer.filter(call => call.functionName === 'updateProgress');

// generateData as the renderer builds it (scripts/renderer/generate.js), minus the parts
// the WebUI backend never reads.
function generateData(addr, extra = {}) {
    return {
        addr,
        auth: '',
        uuid: 'uuid-1',
        refresh: 0,
        model: 'waiNSFW_v14.safetensors',
        vpred: false,
        positive: '1girl, solo, smile',
        negative: 'worst quality',
        width: 832,
        height: 1216,
        cfg: 5,
        step: 28,
        seed: 1234567,
        sampler: 'Euler a',
        scheduler: 'Karras',
        hifix: { enable: false },
        refiner: { enable: false },
        vae: { vae_override: false, vae: 'None' },
        adetailer: [],
        controlnet: [],
        img_prefix: '[date]',
        ...extra,
    };
}

function regionalData(addr, extra = {}) {
    return generateData(addr, {
        positive: undefined,
        positive_left: '1girl, blonde hair',
        positive_right: '1boy, black hair',
        regional: { ratio: regionalRatio(30, 20, 'WebUI'), str_left: 1.2, str_right: 0.8, split: 'left-right' },
        ...extra,
    });
}

test.afterEach(async () => {
    webui?.stopPollingWebUI();
    for (const server of [...openServers]) await closeServer(server);
});

test('a Forge run sends the txt2img payload the settings describe, and brings the image back', opts, async () => {
    reset();
    const backend = await fakeWebUI();
    try {
        const result = await webui.runWebUI(generateData(backend.addr, { auth: 'saa:secret' }));
        assert.equal(result, 'data:image/png;base64,R0lGODlhAQABAAAAACw=');

        const payload = backend.payload();
        assert.equal(payload.prompt, '1girl, solo, smile');
        assert.equal(payload.negative_prompt, 'worst quality');
        assert.equal(payload.steps, 28);
        assert.equal(payload.width, 832);
        assert.equal(payload.height, 1216);
        assert.equal(payload.cfg_scale, 5);
        assert.equal(payload.seed, 1234567);
        // the sampler and scheduler names go out unchanged, under the keys A1111 reads
        assert.equal(payload.sampler_index, 'Euler a');
        assert.equal(payload.scheduler, 'Karras');
        assert.equal(payload.batch_size, 1);
        assert.equal(payload.save_images, true);
        assert.equal(payload.enable_hr, undefined, 'Hires off sends no hr keys');
        assert.equal(payload.refiner_checkpoint, undefined);
        // Forge takes its model with the request, so the A1111 options POST is not used
        assert.equal(payload.override_settings_restore_afterwards, true);
        assert.deepEqual(payload.override_settings, {
            sd_model_checkpoint: 'waiNSFW_v14.safetensors',
            directories_filename_pattern: '[date]',
        });
        assert.equal(backend.of('/sdapi/v1/options'), undefined);

        // `user:pass` is WebUI's --api-auth, so it goes out as HTTP Basic, on every call
        const basic = `Basic ${Buffer.from('saa:secret').toString('base64')}`;
        assert.equal(backend.of('/sdapi/v1/txt2img').headers.authorization, basic);
        assert.equal(backend.of('/sdapi/v1/options', 'GET').headers.authorization, basic);

        // the run bar is finished off, and the mutex is taken and given back
        assert.deepEqual(stub.renderer.at(-1), { uuid: 'uuid-1', functionName: 'updateProgress', args: ['100', '100%'] });
        assert.deepEqual(stub.mutex, [true, false]);
        assert.equal(stub.busy, false);
    } finally {
        await backend.close();
    }
});

test('a token goes out as Bearer, and Hires and the Refiner add their own keys', opts, async () => {
    reset();
    const backend = await fakeWebUI();
    try {
        const data = generateData(backend.addr, {
            auth: 'pod-token-123',
            img_prefix: '[datetime]/[model_name]',
            hifix: { enable: true, denoise: 0.35, scale: 1.5, model: '4x-UltraSharp', steps: 12 },
            refiner: { enable: true, model: 'refiner.safetensors', ratio: 0.8 },
        });
        assert.equal(await webui.runWebUI(data), 'data:image/png;base64,R0lGODlhAQABAAAAACw=');

        const payload = backend.payload();
        assert.equal(payload.enable_hr, true);
        assert.equal(payload.denoising_strength, 0.35);
        assert.equal(payload.hr_scale, 1.5);
        assert.equal(payload.hr_upscaler, '4x-UltraSharp');
        assert.equal(payload.hr_second_pass_steps, 12);
        // the first pass keeps the requested size; Hires scales up from it
        assert.equal(payload.firstphase_width, 832);
        assert.equal(payload.firstphase_height, 1216);
        // the second pass repeats the sampler, the scheduler and both prompts
        assert.equal(payload.hr_sampler_name, 'Euler a');
        assert.equal(payload.hr_scheduler, 'Karras');
        assert.equal(payload.hr_prompt, '1girl, solo, smile');
        assert.equal(payload.hr_negative_prompt, 'worst quality');
        // Forge Error #10: the Hires pass is told to load no extra modules of its own
        assert.deepEqual(payload.hr_additional_modules, []);
        // the refiner is a different checkpoint, taken over at its ratio
        assert.equal(payload.refiner_checkpoint, 'refiner.safetensors');
        assert.equal(payload.refiner_switch_at, 0.8);
        // the save pattern of the run is carried into the override settings
        assert.equal(payload.override_settings.directories_filename_pattern, '[datetime]/[model_name]');

        assert.equal(backend.of('/sdapi/v1/txt2img').headers.authorization, 'Bearer pod-token-123');
    } finally {
        await backend.close();
    }
});

test('a refiner that is the checkpoint itself is left out of the payload', opts, async () => {
    reset();
    const backend = await fakeWebUI();
    try {
        const data = generateData(backend.addr, { refiner: { enable: true, model: 'waiNSFW_v14.safetensors', ratio: 0.8 } });
        await webui.runWebUI(data);
        assert.equal(backend.payload().refiner_checkpoint, undefined);
    } finally {
        await backend.close();
    }
});

test('ADetailer slots go out as the args list the extension reads', opts, async () => {
    reset();
    const backend = await fakeWebUI();
    try {
        // one slot as scripts/renderer/generate.js createADetailer() builds it for WebUI
        const slot = {
            model: 'face_yolov8n.pt',
            prompt: 'detailed face',
            negative_prompt: 'blurry',
            confidence: 0.3,
            mask_k: 0,
            mask_filter_method: 'Area',
            dilate_erode: 4,
            mask_merge_invert: 'Merge',
            mask_blur: 4,
            denoise: 0.4,
        };
        await webui.runWebUI(generateData(backend.addr, { adetailer: [slot] }));

        const args = backend.payload().alwayson_scripts.ADetailer.args;
        assert.equal(args[0], true, 'ad_enable');
        assert.equal(args[1], false, 'skip_img2img');
        assert.deepEqual(args[2], {
            ad_model: 'face_yolov8n.pt',
            ad_prompt: 'detailed face',
            ad_negative_prompt: 'blurry',
            ad_confidence: 0.3,
            ad_mask_k: 0,
            ad_mask_filter_method: 'Area',
            ad_dilate_erode: 4,
            ad_mask_merge_invert: 'Merge',
            ad_mask_blur: 4,
            ad_denoising_strength: 0.4,
        });
        assert.equal(args.length, 3);
    } finally {
        await backend.close();
    }
});

test('ControlNet slots name the model the backend knows, and a slot with no image is left out', opts, async () => {
    reset();
    const backend = await fakeWebUI();
    try {
        const slots = [
            // "On": the image is preprocessed by the module named in preModel
            { preModel: 'openpose_full', preRes: '512', postModel: 'control_v11p_sd15_openpose.safetensors', postStr: '0.9', postStart: 0, postEnd: '0.7', image: 'BASE64POSE', imageAfter: null },
            // "Post": an already preprocessed image, so no module runs again
            { preModel: 'depth_midas', preRes: '768', postModel: 'control_v11f1p_sd15_depth', postStr: '0.5', postStart: '0.1', postEnd: 1, image: null, imageAfter: 'BASE64DEPTH' },
            // an off slot, and one with neither image
            { preModel: 'none', preRes: '512', postModel: 'none', postStr: 1, postStart: 0, postEnd: 1, image: 'X', imageAfter: null },
            { preModel: 'openpose_full', preRes: '512', postModel: 'control_v11p_sd15_openpose.safetensors', postStr: 1, postStart: 0, postEnd: 1, image: null, imageAfter: null },
        ];
        await webui.runWebUI(generateData(backend.addr, { controlnet: slots }));

        const args = backend.payload().alwayson_scripts.controlnet.args;
        assert.equal(args.length, 2);
        assert.deepEqual(args[0], {
            enabled: true,
            module: 'openpose_full',
            image: 'BASE64POSE',
            processor_res: 512,
            // the hash the backend appends to its own list is kept: it is how it names the model
            model: 'control_v11p_sd15_openpose [cab727d4]',
            weight: 0.9,
            guidance_start: 0,
            guidance_end: 0.7,
            control_mode: 'Balanced',
            resize_mode: 'Just Resize',
            threshold_a: 0.5,
            threshold_b: 0.5,
            hr_option: 'Both',
            pixel_perfect: true,
        });
        assert.equal(args[1].module, 'none', 'an image that is already preprocessed skips the module');
        assert.equal(args[1].image, 'BASE64DEPTH');
        assert.equal(args[1].model, 'control_v11f1p_sd15_depth [cfd03158]');
        assert.equal(args[1].processor_res, 768);
        assert.equal(args[1].weight, 0.5);
        assert.equal(args[1].guidance_start, 0.1);
        assert.equal(args[1].guidance_end, 1);
    } finally {
        await backend.close();
    }
});

test('a ControlNet model list that never arrived does not take the run down with it', opts, async () => {
    reset();
    // the backend has no ControlNet extension: its model list 404s, so no name can be resolved
    const backend = await fakeWebUI({ modelListStatus: 404 });
    try {
        const slot = { preModel: 'openpose_full', preRes: '512', postModel: 'control_v11p_sd15_openpose.safetensors', postStr: 1, postStart: 0, postEnd: 1, image: 'BASE64POSE', imageAfter: null };
        const result = await webui.runWebUI(generateData(backend.addr, { controlnet: [slot] }));
        assert.equal(result, 'data:image/png;base64,R0lGODlhAQABAAAAACw=');
        assert.equal(backend.payload().alwayson_scripts.controlnet.args[0].model, 'none');
        assert.equal(stub.busy, false);
        // a model the backend does not know falls back the same way
        assert.equal(webui.getControlNetProcessorList().includes('openpose_full'), true);
    } finally {
        await backend.close();
    }
});

test('a Regional run is one line per side, and the Forge Couple mapping is the ComfyUI layout', opts, async () => {
    reset();
    const backend = await fakeWebUI();
    try {
        const data = regionalData(backend.addr, {
            positive_left: '1girl, blonde hair\nsmile',
            positive_right: '1boy, black hair,',
        });
        assert.equal(await webui.runWebUI_Regional(data), 'data:image/png;base64,R0lGODlhAQABAAAAACw=');

        const payload = backend.payload();
        // Forge Couple splits the regions on "\n": one line each, and a newline inside a
        // side becomes a comma instead of gluing its tags together
        assert.equal(payload.prompt, '1girl, blonde hair, smile\n1boy, black hair,');

        const args = payload.alwayson_scripts['forge couple'].args;
        assert.deepEqual(args.slice(0, 7), [true, true, 'Advanced', '\n', 'Vertical', null, null]);
        assert.deepEqual(args.slice(8, 11), ['{ }', false, true]);

        // Image Ratio 30 with Overlap Ratio 20: ComfyUI cuts the image into strips
        // 0.6 / 0.2 / 1.4, the first region being strips 1+2 and the second strips 2+3.
        // Forge Couple is sent the same two regions as fractions of the image.
        const [end, start] = regionalRatio(30, 20, 'WebUI').split(',').map(Number);
        assert.ok(Math.abs(end - 0.8 / 2.2) < 1e-9, `first region ends at ${end}`);
        assert.ok(Math.abs(start - 0.6 / 2.2) < 1e-9, `second region starts at ${start}`);
        assert.ok(start < end, 'the regions overlap instead of leaving a gap');
        assert.deepEqual(args[7], [[0, end, 0, 1, 1.2], [start, 1, 0, 1, 0.8]]);
        // the middle of the image belongs to the second region, as it does on ComfyUI
        assert.ok(0.5 > end && 0.5 > start);
    } finally {
        await backend.close();
    }
});

test('a top-bottom Regional run maps the sides to rows, and Hires is still its own pass', opts, async () => {
    reset();
    const backend = await fakeWebUI();
    try {
        const data = regionalData(backend.addr, {
            regional: { ratio: '0.6,0.4', str_left: 1, str_right: 1, split: 'top-bottom' },
            hifix: { enable: true, denoise: 0.35, scale: 1.5, model: 'Latent', steps: 10 },
        });
        await webui.runWebUI_Regional(data);

        const payload = backend.payload();
        assert.deepEqual(payload.alwayson_scripts['forge couple'].args[7], [[0, 1, 0, 0.6, 1], [0, 1, 0.4, 1, 1]]);
        assert.equal(payload.enable_hr, true);
        assert.equal(payload.hr_prompt, payload.prompt, 'the Hires pass keeps both regions');
        assert.deepEqual(payload.hr_additional_modules, []);
    } finally {
        await backend.close();
    }
});

test('a Regional run without Hires or a refiner still goes out', opts, async () => {
    reset();
    const backend = await fakeWebUI();
    try {
        // what the saa-agent sends: no hifix and no refiner section at all
        const data = regionalData(backend.addr, { hifix: undefined, refiner: undefined });
        const result = await webui.runWebUI_Regional(data);
        assert.equal(result, 'data:image/png;base64,R0lGODlhAQABAAAAACw=');
        assert.equal(backend.payload().enable_hr, undefined);
        assert.equal(stub.busy, false);
    } finally {
        await backend.close();
    }
});

test('a Diffusion model names the checkpoint and its own modules on Forge', opts, async () => {
    reset();
    const backend = await fakeWebUI();
    try {
        // the Diffusion Model type sends no `model`, only `unet` (scripts/renderer/generate.js)
        const data = generateData(backend.addr, {
            model: undefined,
            unet: {
                enable: true,
                model: 'waiANIMA_v10.safetensors',
                clip_model: 'clip_l.safetensors',
                vae_model: 'sdxl_vae.safetensors',
            },
        });
        await webui.runWebUI(data);

        assert.deepEqual(backend.payload().override_settings, {
            sd_model_checkpoint: 'waiANIMA_v10.safetensors',
            forge_additional_modules: ['clip_l.safetensors', 'sdxl_vae.safetensors'],
            directories_filename_pattern: '[date]',
        });
    } finally {
        await backend.close();
    }
});

test('an A1111 backend is told its options first, and its request carries no override_settings', opts, async () => {
    reset();
    const backend = await fakeWebUI({ forge: false });
    try {
        const data = generateData(backend.addr, { vae: { vae_override: true, vae: 'sdxl_vae.safetensors' } });
        assert.equal(await webui.runWebUI(data), 'data:image/png;base64,R0lGODlhAQABAAAAACw=');

        await until(() => backend.of('/sdapi/v1/options'));
        assert.deepEqual(JSON.parse(backend.of('/sdapi/v1/options').body), {
            sd_model_checkpoint: 'waiNSFW_v14.safetensors',
            sd_vae: 'sdxl_vae.safetensors',
            directories_filename_pattern: '[date]',
        });

        const payload = backend.payload();
        assert.equal(payload.override_settings, undefined, 'A1111 has no override settings to restore');
        assert.equal(payload.override_settings_restore_afterwards, undefined);
        assert.equal(payload.prompt, '1girl, solo, smile');
    } finally {
        await backend.close();
    }
});

test('an HTTP error, a reply that is not JSON and a cut connection each end the run and free the backend', opts, async () => {
    reset();
    const backend = await fakeWebUI({ txt2imgStatus: 500, txt2imgBody: '{"error":"OutOfMemoryError"}' });
    try {
        assert.equal(await webui.runWebUI(generateData(backend.addr)), 'Error: HTTP error 500');
        assert.equal(stub.busy, false, 'the next generation is not told the backend is busy');

        backend.state.txt2imgStatus = 200;
        backend.state.txt2imgBody = '<html>Gradio is starting</html>';
        const notJson = await webui.runWebUI(generateData(backend.addr));
        assert.match(notJson, /^Error: Image not found or invalid:/);
        assert.equal(stub.busy, false);

        backend.state.drop = new Set(['/sdapi/v1/txt2img']);
        const dropped = await webui.runWebUI(generateData(backend.addr));
        assert.match(dropped, /^Error: Request failed:/);
        assert.equal(stub.busy, false);

        // a reply with no image at all is an error, not an image source of "undefined"
        backend.state.drop = new Set();
        backend.state.txt2imgBody = null;
        backend.state.txt2img = { images: [], info: '{}' };
        const empty = await webui.runWebUI(generateData(backend.addr));
        assert.match(empty, /^Error:/);
        assert.equal(empty.includes('undefined'), false, empty);
        assert.equal(stub.busy, false);
    } finally {
        await backend.close();
    }
});

test('a run while the backend is busy is refused, and a payload that cannot be sent frees it again', opts, async () => {
    reset();
    const backend = await fakeWebUI();
    try {
        stub.busy = true;
        assert.match(await webui.runWebUI(generateData(backend.addr)), /^Error: WebUI is busy/);
        assert.equal(backend.of('/sdapi/v1/txt2img'), undefined, 'nothing is sent while another run holds the backend');
        assert.deepEqual(stub.mutex, [], 'a refused run does not touch the lock it did not take');

        // an agent payload whose adetailer is not a list: building the payload throws
        stub.busy = false;
        const broken = await webui.runWebUI(generateData(backend.addr, { adetailer: { model: 'face_yolov8n.pt' } }));
        assert.match(broken, /^Error:/);
        assert.equal(stub.busy, false, 'a run that failed while building its payload still frees the backend');

        // and the next run goes through, instead of being told the backend is busy for good
        assert.equal(await webui.runWebUI(generateData(backend.addr)), 'data:image/png;base64,R0lGODlhAQABAAAAACw=');
    } finally {
        await backend.close();
    }
});

test('progress polling sends the preview and the percentage; a poll without an image keeps the last preview', opts, async () => {
    reset();
    const backend = await fakeWebUI({ txt2imgDelay: 2600 });
    try {
        const running = webui.runWebUI(generateData(backend.addr, { refresh: 1 }));
        await until(() => previews().length > 0);
        assert.deepEqual(previews()[0], { uuid: 'uuid-1', functionName: 'updatePreview', args: ['data:image/png;base64,UFJFVklFVw=='] });
        assert.deepEqual(progresses()[0].args, ['50', '100%']);

        // live previews off in the backend: the percentage still moves, the preview stays
        backend.state.progress = { progress: 0.62, current_image: null };
        await until(() => progresses().some(call => call.args[0] === '62'));
        assert.equal(previews().length, 1, 'no "base64,null" preview is sent');

        assert.equal(await running, 'data:image/png;base64,R0lGODlhAQABAAAAACw=');
        assert.deepEqual(progresses().at(-1).args, ['100', '100%']);
        assert.ok(backend.calls.filter(call => call.path === '/sdapi/v1/progress').length >= 2);
    } finally {
        webui.stopPollingWebUI();
        await backend.close();
    }
});

test('Cancel interrupts the backend, and the run comes back cancelled', opts, async () => {
    reset();
    const backend = await fakeWebUI({ txt2imgDelay: 300 });
    try {
        const running = webui.runWebUI(generateData(backend.addr, { refresh: 1 }));
        await until(() => backend.calls.some(call => call.path === '/sdapi/v1/txt2img'));
        webui.cancelWebUI();
        assert.equal(await running, 'Error: Cancelled');
        await until(() => backend.of('/sdapi/v1/interrupt'));
        assert.equal(stub.busy, false);

        // polling stopped with the run: no further progress call arrives
        const polls = backend.calls.filter(call => call.path === '/sdapi/v1/progress').length;
        await new Promise(resolve => { setTimeout(resolve, 1200).unref?.(); });
        assert.equal(backend.calls.filter(call => call.path === '/sdapi/v1/progress').length, polls);
    } finally {
        await backend.close();
    }
});

test('the model lists are read once and cleared by a reset; a backend without ADetailer stops being asked', opts, async () => {
    reset();
    const backend = await fakeWebUI({ adStatus: 404 });
    try {
        await webui.runWebUI(generateData(backend.addr));
        assert.deepEqual(webui.getControlNetProcessorList(), ['none', 'openpose_full', 'depth_midas']);
        // "None" is the backend's own no-upscaler entry; the Hires list does not offer it
        assert.deepEqual(webui.getUpscalersModelList(), ['Latent', '4x-UltraSharp']);
        assert.equal(webui.getADetailerModelList(), 'not_exist');

        const asked = backend.calls.filter(call => call.path === '/controlnet/module_list').length;
        await webui.runWebUI(generateData(backend.addr));
        assert.equal(backend.calls.filter(call => call.path === '/controlnet/module_list').length, asked, 'a list already read is not asked for again');
        assert.equal(backend.calls.filter(call => call.path === '/adetailer/v1/ad_model').length, 1, 'a missing extension is asked for once');

        webui.resetModelLists();
        assert.equal(webui.getControlNetProcessorList(), 'none');
        assert.equal(webui.getUpscalersModelList(), 'none');
        assert.equal(webui.getADetailerModelList(), 'none');
        backend.state.adStatus = 200;
        await webui.runWebUI(generateData(backend.addr));
        assert.deepEqual(webui.getADetailerModelList(), ['face_yolov8n.pt', 'hand_yolov8n.pt']);

        // a proxy that answers a list request with something else leaves the list empty
        // instead of taking the generation down with it
        webui.resetModelLists();
        backend.state.upscalers = { detail: 'Not Found' };
        assert.equal(await webui.runWebUI(generateData(backend.addr)), 'data:image/png;base64,R0lGODlhAQABAAAAACw=');
        assert.equal(webui.getUpscalersModelList(), 'none');
        assert.equal(stub.busy, false);
    } finally {
        await backend.close();
    }
});

test('ControlNet detect returns the preprocessed image, and a backend with none is an error', opts, async () => {
    reset();
    const backend = await fakeWebUI();
    try {
        const data = { addr: backend.addr, auth: '', controlNet: 'openpose_full', imageData: 'BASE64SOURCE', outputResolution: 512 };
        assert.equal(await webui.runWebUI_ControlNet(data), 'Q09OVFJPTA==');
        assert.deepEqual(JSON.parse(backend.of('/controlnet/detect').body), {
            controlnet_module: 'openpose_full',
            controlnet_input_images: ['BASE64SOURCE'],
            controlnet_processor_res: 512,
            controlnet_threshold_a: 64,
            controlnet_threshold_b: 64,
            controlnet_masks: [],
            low_vram: false,
        });
        assert.equal(stub.busy, false);

        backend.state.detect = { info: 'Failed' };
        assert.equal(await webui.runWebUI_ControlNet(data), 'Error: No image from backend');
        assert.equal(stub.busy, false, 'the lock is given back however the detect ended');
    } finally {
        await backend.close();
    }
});

test('the agent run hands the image to the renderer instead of returning it', opts, async () => {
    reset();
    const backend = await fakeWebUI();
    try {
        // the saa-agent sends no vae section; the run fills one in rather than failing
        const data = generateData(backend.addr, { uuid: 'agent-7', vae: undefined });
        assert.equal(await webui.python_runWebUI(data, false, false), 'Success');
        assert.deepEqual(data.vae, { vae_override: false, vae: 'None' });
        assert.deepEqual(stub.renderer.at(-1), { uuid: 'agent-7', functionName: 'updateProgress', args: ['data:image/png;base64,R0lGODlhAQABAAAAACw='] });

        // an error is returned to the agent instead of being sent as an image
        backend.state.txt2imgStatus = 500;
        const failed = await webui.python_runWebUI(generateData(backend.addr, { uuid: 'agent-7' }), false, false);
        assert.equal(failed, 'Error: HTTP error 500');
        assert.equal(stub.renderer.at(-1).args[0], 'log', 'the failed run sends no image of its own');
    } finally {
        await backend.close();
    }
});

test('the IPC channels of the backend are the ones the renderer calls', opts, async () => {
    reset();
    const backend = await fakeWebUI();
    try {
        for (const channel of ['generate-backend-webui-run', 'generate-backend-webui-run-regional', 'generate-backend-webui-run-controlnet',
            'generate-backend-webui-start-polling', 'generate-backend-webui-stop-polling', 'generate-backend-webui-cancel',
            'generate-backend-webui-get-module-list', 'generate-backend-webui-get-ad-model', 'generate-backend-webui-get-upscaler-model',
            'generate-backend-webui-reset-model-list']) {
            assert.ok(stub.handlers[channel], `${channel} is registered`);
        }
        const result = await stub.handlers['generate-backend-webui-run']({}, generateData(backend.addr));
        assert.equal(result, 'data:image/png;base64,R0lGODlhAQABAAAAACw=');
        assert.deepEqual(await stub.handlers['generate-backend-webui-get-upscaler-model']({}), ['Latent', '4x-UltraSharp']);
    } finally {
        await backend.close();
    }
});
