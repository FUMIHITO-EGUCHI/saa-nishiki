// The end-to-end harness: the real app (Electron, the renderer, the main process) against
// the real local ComfyUI, driven the way a person drives it and judged by what comes out.
//
//   const app = await launchApp();          // its own settings folder, CDP on a free port
//   await app.typePositive('1girl, (long hair:1.2)');
//   const run = await app.generate();       // clicks Generate, waits for the images
//   run.images                              // what the gallery received: { seed, tags, bytes }
//   run.history                             // what ComfyUI ran: { id, workflow, outputs }
//   await app.close();
//
// What is real: SAA, ComfyUI, the models, the images. What is chosen for speed: 512 × 512,
// four steps, a fixed seed, Hires off. The machine facts (ComfyUI address, model folder,
// model names, LoRA names) are borrowed from the worktree's own settings/app.json and
// state.json, so the suite follows the developer's setup; SAA_E2E_COMFY overrides the
// address. Nothing here touches that settings folder: the app under test gets a temp one.
//
// A run needs ComfyUI up at that address with the checkpoint and the diffusion model
// loaded there; `npm run test:e2e` is meant for the developer's machine, not CI.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { DEFAULT_SETTINGS, makeEnvelope, splitFlat } from '../../scripts/shared/settingsSections.js';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// The keys whose values depend on the machine, taken from the worktree's own settings.
const MACHINE_APP_KEYS = [
    'api_addr', 'model_path_comfyui', 'thumb_select', 'thumb_select_list',
    'api_vae_unet_model', 'api_model_file_text_encoder', 'api_model_file_text_encoder_type', 'api_model_file_text_encoder_device',
    'api_fast_lora', 'api_fast_lora_strength', 'api_fast_steps', 'api_fast_cfg', 'api_fast_sampler', 'api_fast_scheduler',
    'api_fast_diff_lora', 'api_fast_diff_lora_strength', 'api_fast_diff_steps', 'api_fast_diff_cfg', 'api_fast_diff_sampler', 'api_fast_diff_scheduler',
];
const MACHINE_GENERATION_KEYS = ['api_model_file_select', 'api_model_file_diffusion_select', 'api_hf_upscaler_selected'];

function readEnvelopeData(file) {
    try {
        return JSON.parse(fs.readFileSync(file, 'utf8')).data ?? {};
    } catch {
        return {};
    }
}

// The settings a run starts from: the app's defaults, the machine facts, then what a
// story asks for. Small and deterministic where the generation is concerned.
export function machineFacts() {
    const app = readEnvelopeData(path.join(REPO_ROOT, 'settings', 'app.json'));
    const state = readEnvelopeData(path.join(REPO_ROOT, 'settings', 'state.json'));
    const facts = {};
    for (const key of MACHINE_APP_KEYS) if (Object.hasOwn(app, key)) facts[key] = app[key];
    for (const key of MACHINE_GENERATION_KEYS) if (Object.hasOwn(state.generation ?? {}, key)) facts[key] = state.generation[key];
    if (process.env.SAA_E2E_COMFY) facts.api_addr = process.env.SAA_E2E_COMFY;
    return facts;
}

// A seed no earlier run used: the seconds of the day this minute, in the slider's range.
export function freshSeed() {
    return 1000 + (Math.floor(Date.now() / 1000) % 1_000_000_000);
}

export const FAST_GENERATION = Object.freeze({
    width: 512, height: 512, step: 4, cfg: 5, api_hf_enable: false, api_image_landscape: false,
});

export function e2eSettings(overrides = {}) {
    const facts = machineFacts();
    const checkpointGeneration = { api_model_sampler: 'euler_ancestral', api_model_scheduler: 'normal', ...FAST_GENERATION, regional_condition: false };
    const diffusionGeneration = { api_model_sampler: 'er_sde', api_model_scheduler: 'simple', ...FAST_GENERATION, regional_condition: false };
    return {
        ...DEFAULT_SETTINGS,
        ...facts,
        language: 'en-US',
        setup_wizard: false,        // no first-run wizard: its dialogs would wait for a person
        api_interface: 'ComfyUI',
        comfy_autostart: false,
        // The app under test must never restart the developer's ComfyUI: with no launch
        // command it cannot (a flag mismatch is logged and the run goes on), and the
        // Diffusion fast set asks for no launch flags.
        comfy_launch_command: '',
        api_fast_diff_comfy_args: '',
        api_fast_comfy_args: '',
        generate_auto_start: true,
        api_model_type: 'Checkpoint',
        api_fast_enable: false,
        model_filter: false,
        scroll_to_last: true,
        ...checkpointGeneration,
        batch: 1,
        // A seed of this launch's own: ComfyUI answers a prompt it already ran from its
        // cache, which SAA reports as an error (nothing was sampled), so two runs must
        // never be the same prompt with the same seed.
        random_seed: freshSeed(),
        model_type_generation: { Checkpoint: checkpointGeneration, Diffusion: diffusionGeneration },
        custom_prompt: '1girl, solo, white background',
        // no character slot: the default "Random" puts a different character in every prompt
        character_slots: [{ key: 'None', weight: 1 }, { key: 'None', weight: 1 }, { key: 'None', weight: 1 }],
        character1: 'None',
        api_prompt: '',
        api_prompt_right: '',
        api_neg_prompt: 'worst quality, low quality',
        prompt_custom_fields: [],
        ...overrides,
    };
}

export function writeSettings(settingsDir, flat) {
    const { app, state } = splitFlat(flat);
    fs.mkdirSync(settingsDir, { recursive: true });
    fs.writeFileSync(path.join(settingsDir, 'app.json'), JSON.stringify(makeEnvelope('app', app), null, 2));
    fs.writeFileSync(path.join(settingsDir, 'state.json'), JSON.stringify(makeEnvelope('state', state), null, 2));
}

function freePort() {
    return new Promise((resolve, reject) => {
        const server = net.createServer();
        server.unref();
        server.on('error', reject);
        server.listen(0, '127.0.0.1', () => {
            const { port } = server.address();
            server.close(() => resolve(port));
        });
    });
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function fetchJson(url, init) {
    const response = await fetch(url, init);
    if (!response.ok) throw new Error(`${url}: ${response.status}`);
    return response.json();
}

// ---------------------------------------------------------------- ComfyUI

export function comfyClient(address) {
    const base = `http://${address}`;
    const client = {
        base,
        async stats() { return fetchJson(`${base}/system_stats`); },
        async historyIds() { return Object.keys(await fetchJson(`${base}/history?max_items=500`)); },
        // { id, workflow, outputs, status } for every run of the history not in `known`
        async historySince(known) {
            const history = await fetchJson(`${base}/history?max_items=500`);
            return Object.entries(history)
                .filter(([id]) => !known.has(id))
                .map(([id, entry]) => ({ id, workflow: entry.prompt?.[2] ?? {}, outputs: entry.outputs ?? {}, status: entry.status ?? {} }));
        },
    };
    return client;
}

// Readers of a ComfyUI workflow ({ nodeId: { class_type, inputs } }), by what the node
// is rather than by its number, which SAA may renumber.
export const workflow = {
    nodes(wf, classType) {
        return Object.entries(wf).filter(([, node]) => node?.class_type === classType).map(([id, node]) => ({ id, ...node }));
    },
    isSampler(node) {
        return ['KSampler', 'KSamplerAdvanced', 'SamplerCustomAdvanced', 'SamplerCustom'].includes(node?.class_type);
    },
    // The nodes upstream of the run's outputs, nearest first: SAA's workflow template
    // carries every stage (Hires pass, refiner) and ComfyUI executes only what the saver
    // needs, so a node's inputs count only when the saver's chain reaches it.
    executedChain(wf, outputs = null) {
        const starts = outputs ? Object.keys(outputs) : Object.keys(wf).filter(id => /Save|Saver|PreviewImage/.test(wf[id]?.class_type ?? ''));
        const seen = new Set();
        const chain = [];
        const queue = [...starts];
        while (queue.length) {
            const id = queue.shift();
            if (seen.has(id) || !wf[id]) continue;
            seen.add(id);
            chain.push({ id, ...wf[id] });
            for (const value of Object.values(wf[id].inputs ?? {})) if (Array.isArray(value)) queue.push(String(value[0]));
        }
        return chain;
    },
    // the sampler the saved image came out of (the last stage that ran)
    sampler(wf, outputs = null) {
        return workflow.executedChain(wf, outputs).find(node => workflow.isSampler(node)) ?? null;
    },
    // every sampler that ran, from the last stage back to the first
    samplers(wf, outputs = null) {
        return workflow.executedChain(wf, outputs).filter(node => workflow.isSampler(node));
    },
    seedOf(sampler) {
        return sampler?.inputs?.seed ?? sampler?.inputs?.noise_seed ?? null;
    },
    // A node input that may be a link [nodeId, outputIndex]: followed to the node it
    // comes from, and `pick(node, outputIndex)` says which of that node's inputs carries
    // the value on (SAA's text boxes and canvas node pass their inputs through).
    resolve(wf, value, pick, hops = 8) {
        let current = value;
        for (let hop = 0; Array.isArray(current) && hop < hops; hop++) {
            const node = wf[String(current[0])];
            if (!node) return null;
            current = pick(node, Number(current[1]));
        }
        return Array.isArray(current) ? null : current;
    },
    text(wf, value) {
        return workflow.resolve(wf, value, node => node.inputs?.text ?? null);
    },
    // the text of the CLIPTextEncode a sampler input points at ("positive" / "negative")
    conditioningText(wf, which, outputs = null) {
        const sampler = workflow.sampler(wf, outputs);
        const link = sampler?.inputs?.[which];
        if (!Array.isArray(link)) return null;
        let node = wf[link[0]];
        // through the conditioning helpers SAA may put in between
        for (let hops = 0; node && node.class_type !== 'CLIPTextEncode' && hops < 6; hops++) {
            const next = Object.values(node.inputs ?? {}).find(value => Array.isArray(value) && wf[value[0]]?.class_type?.includes('CLIPTextEncode'))
                ?? Object.values(node.inputs ?? {}).find(value => Array.isArray(value) && String(wf[value[0]]?.class_type ?? '').toLowerCase().includes('conditioning'));
            node = next ? wf[next[0]] : null;
        }
        return node ? workflow.text(wf, node.inputs?.text) : null;
    },
    positive(wf, outputs = null) { return workflow.conditioningText(wf, 'positive', outputs); },
    negative(wf, outputs = null) { return workflow.conditioningText(wf, 'negative', outputs); },
    checkpoint(wf, outputs = null) {
        return workflow.executedChain(wf, outputs).find(node => node.class_type === 'CheckpointLoaderSimple')?.inputs?.ckpt_name ?? null;
    },
    unet(wf, outputs = null) {
        return workflow.executedChain(wf, outputs).find(node => node.class_type === 'UNETLoader')?.inputs?.unet_name ?? null;
    },
    // the LoRA names the run loaded, by whichever loader SAA used (the text loader lists
    // them as "<lora:name:weight>" text)
    loras(wf, outputs = null) {
        const names = [];
        for (const node of workflow.executedChain(wf, outputs)) {
            if (node.class_type === 'LoraLoader' || node.class_type === 'LoraLoaderModelOnly') names.push(node.inputs?.lora_name);
            if (node.class_type === 'LoRAfromText') {
                for (const match of String(workflow.text(wf, node.inputs?.text) ?? '').matchAll(/<lora:([^:>]+)(?::[^>]*)?>/g)) names.push(match[1]);
            }
        }
        return names.filter(Boolean);
    },
    latentSize(wf, outputs = null) {
        const latent = workflow.executedChain(wf, outputs).find(node => ['EmptyLatentImage', 'EmptySD3LatentImage'].includes(node.class_type));
        if (!latent) return null;
        // SAA's canvas node hands the size on: its outputs are Width, Height, Batch in that order
        const canvas = (node, index) => [node.inputs?.Width, node.inputs?.Height, node.inputs?.Batch][index] ?? null;
        return {
            width: workflow.resolve(wf, latent.inputs.width, canvas),
            height: workflow.resolve(wf, latent.inputs.height, canvas),
            batch: workflow.resolve(wf, latent.inputs.batch_size, canvas),
        };
    },
    classTypes(wf) { return [...new Set(Object.values(wf).map(node => node?.class_type))]; },
};

// ---------------------------------------------------------------- the app

class Page {
    constructor(ws) {
        this.ws = ws;
        this.nextId = 0;
        this.pending = new Map();
        ws.onmessage = event => {
            const message = JSON.parse(event.data);
            if (message.id && this.pending.has(message.id)) {
                this.pending.get(message.id)(message);
                this.pending.delete(message.id);
            }
        };
    }

    send(method, params = {}) {
        return new Promise(resolve => {
            const id = ++this.nextId;
            this.pending.set(id, resolve);
            this.ws.send(JSON.stringify({ id, method, params }));
        });
    }

    // Evaluates `expression` in the page; a promise is awaited; an exception throws here.
    async evaluate(expression) {
        const reply = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
        const details = reply.result?.exceptionDetails;
        if (details) throw new Error(`page: ${details.exception?.description ?? details.text ?? JSON.stringify(details)}`);
        return reply.result?.result?.value;
    }

    async waitFor(expression, { timeoutMs = 15_000, intervalMs = 100, label = expression } = {}) {
        const deadline = Date.now() + timeoutMs;
        for (;;) {
            const value = await this.evaluate(expression);
            if (value) return value;
            if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs} ms waiting for ${label}`);
            await sleep(intervalMs);
        }
    }

    async rect(selector) {
        const json = await this.evaluate(`(() => {
            const element = document.querySelector(${JSON.stringify(selector)});
            if (!element) return null;
            const r = element.getBoundingClientRect();
            return JSON.stringify({ x: r.left + r.width / 2, y: r.top + r.height / 2, width: r.width, height: r.height });
        })()`);
        return json ? JSON.parse(json) : null;
    }

    // A real mouse click at the middle of the element (the page sees mousedown / mouseup / click).
    async click(selector) {
        const rect = await this.rect(selector);
        if (!rect || rect.width === 0) throw new Error(`nothing to click at ${selector}`);
        await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: rect.x, y: rect.y });
        await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: rect.x, y: rect.y, button: 'left', clickCount: 1 });
        await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: rect.x, y: rect.y, button: 'left', clickCount: 1 });
    }

    // Keyboard text into whatever has the focus, the way typing puts it there.
    async type(text) {
        await this.send('Input.insertText', { text });
    }

    async key(key, code = key, keyCode = 0) {
        await this.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: keyCode });
        await this.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: keyCode });
    }

    close() {
        this.ws.close();
    }
}

async function electronBinary() {
    const electron = await import('electron');
    return electron.default;
}

async function connectPage(port, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        try {
            const targets = await fetchJson(`http://127.0.0.1:${port}/json`);
            const page = targets.find(target => target.type === 'page' && !/devtools/.test(target.url));
            if (page) {
                const ws = new WebSocket(page.webSocketDebuggerUrl);
                await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
                return new Page(ws);
            }
        } catch {
            // not listening yet
        }
        if (Date.now() > deadline) throw new Error(`the app did not open its CDP port ${port} within ${timeoutMs} ms`);
        await sleep(250);
    }
}

// Installs the recorder the stories read: every image the gallery receives.
const RECORDER = `(() => {
    const gallery = globalThis.mainGallery;
    if (!gallery || gallery.__e2eRecorder) return Boolean(gallery?.__e2eRecorder);
    globalThis.__e2e = { images: [] };
    const original = gallery.appendImageData;
    gallery.appendImageData = function (base64, seed, tags, ...rest) {
        globalThis.__e2e.images.push({ seed: String(seed), tags: String(tags ?? ''), bytes: typeof base64 === 'string' ? base64.length : 0 });
        return original.call(this, base64, seed, tags, ...rest);
    };
    gallery.__e2eRecorder = true;
    return true;
})()`;

const READY = `Boolean(globalThis.generate?.generate_single && globalThis.mainGallery?.appendImageData && globalThis.globalSettings && document.querySelector('.model-type .mydropdown-input'))`;

export async function launchApp({ settings = {}, startTimeoutMs = 90_000 } = {}) {
    const flat = e2eSettings(settings);
    const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'saa-e2e-'));
    const settingsDir = path.join(runDir, 'settings');
    writeSettings(settingsDir, flat);
    const port = await freePort();
    const log = fs.createWriteStream(path.join(runDir, 'app.log'));
    const child = spawn(await electronBinary(), ['.', `--saa-cdp-port=${port}`, `--saa-settings-dir=${settingsDir}`], {
        cwd: REPO_ROOT, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    });
    child.stdout.pipe(log);
    child.stderr.pipe(log);
    const exited = new Promise(resolve => child.on('exit', resolve));

    const page = await connectPage(port, startTimeoutMs);
    await page.waitFor(READY, { timeoutMs: startTimeoutMs, label: 'the app to finish its setup' });
    await page.evaluate(RECORDER);
    const comfy = comfyClient(flat.api_addr);

    const app = {
        page,
        comfy,
        settings: flat,
        settingsDir,
        runDir,
        logFile: path.join(runDir, 'app.log'),

        // a setting as the running app has it
        setting(key) { return page.evaluate(`globalThis.globalSettings[${JSON.stringify(key)}]`); },

        // The run bar's sliders, set as a person sets them (the control, which writes the
        // setting through its own callback); answers with the value the control shows.
        async setSlider(name, value) {
            return page.evaluate(`(() => {
                const control = globalThis.generate[${JSON.stringify(name)}];
                control.setValue(${Number(value)});
                if (control.getValue() !== ${Number(value)}) throw new Error('the ${name} slider did not take ' + ${Number(value)});
                return control.getValue();
            })()`);
        },
        setSeed(seed) { return app.setSlider('seed', seed); },
        setBatch(count) { return app.setSlider('batch', count); },

        // Clicks one of the Generate buttons ('single' = one image, 'batch' = the batch
        // count with a random character per image, 'same' = the batch count with the same
        // character) and waits for the images: what the gallery received and what ComfyUI
        // ran, in the order they came. A batch with a fixed seed asks whether to run
        // anyway; the answer is yes, as a person would click.
        async generate({ button = 'single', expectImages = 1, timeoutMs = 180_000 } = {}) {
            const known = new Set(await comfy.historyIds());
            const before = await page.evaluate('globalThis.__e2e.images.length');
            await page.evaluate(`globalThis.generate.generate_${button}.click()`);
            if (button !== 'single') {
                const yes = '.dialog-container .dialog-button-container-yes button, .dialog-container .dialog-button-container-yes';
                const asked = await page.waitFor(`Boolean(document.querySelector(${JSON.stringify(yes)})) || globalThis.inGenerating === true || globalThis.__e2e.images.length > ${before}`, { timeoutMs: 5000, label: 'the batch to start or ask' }).catch(() => false);
                if (asked && await page.evaluate(`Boolean(document.querySelector(${JSON.stringify(yes)}))`)) await page.click(yes);
            }
            try {
                await page.waitFor(
                    `globalThis.__e2e.images.length >= ${before + expectImages} && globalThis.inGenerating !== true && !globalThis.mainGallery.isLoading`,
                    { timeoutMs, intervalMs: 250, label: `${expectImages} image(s) from the run` },
                );
            } catch (error) {
                // what the app was doing when the wait gave up, for the failure message
                const state = await page.evaluate(`JSON.stringify({
                    images: globalThis.__e2e.images.length - ${before}, inGenerating: globalThis.inGenerating,
                    loading: globalThis.mainGallery.isLoading, queued: globalThis.queueManager?.getSlotsCount?.(),
                    error: (document.getElementById('cg-error-overlay')?.textContent ?? '').trim().slice(0, 300),
                    status: (document.getElementById('cg-loading-overlay')?.textContent ?? '').trim().slice(0, 120),
                })`).catch(() => 'unavailable');
                throw new Error(`${error.message}; the app: ${state}; log: ${app.logFile}`);
            }
            // the gallery may still be drawing the last image; the error overlay, if any, is up by now
            await sleep(300);
            const images = (await page.evaluate('JSON.stringify(globalThis.__e2e.images)'));
            const history = await comfy.historySince(known);
            return { images: JSON.parse(images).slice(before), history, error: await app.errorText() };
        },

        // the text of the gallery's error overlay, '' when there is none
        errorText() {
            return page.evaluate(`document.getElementById('cg-error-overlay')?.textContent ?? ''`);
        },

        // The Positive field in its text form, typed as a person types it (the field
        // parses the text into chips as it goes). Replaces what the field held.
        async typePositive(text) {
            const textarea = '.myTextbox-prompt-positive-textarea';
            await page.evaluate(`(() => {
                const textarea = document.querySelector(${JSON.stringify(textarea)});
                const wrapper = textarea.closest('.myTextbox-wrapper');
                const [textButton] = wrapper.querySelectorAll('.tag-view-button');
                if (textarea.getClientRects().length === 0) textButton.click();
            })()`);
            await page.waitFor(`document.querySelector(${JSON.stringify(textarea)}).getClientRects().length > 0`, { label: 'the Positive textarea' });
            await page.click(textarea);
            await page.evaluate(`(() => { const t = document.querySelector(${JSON.stringify(textarea)}); t.focus(); t.select(); })()`);
            await page.type(text);
            await page.key('Escape'); // closes a suggestion list, if one opened
            await page.evaluate(`document.querySelector(${JSON.stringify(textarea)}).blur()`);
            await sleep(200);
        },

        // Opens the Settings modal on one of its pages ('general', 'model', 'backend', …)
        // through the header's gear, as a person does; closeSettings puts it away.
        async openSettingsPage(pageId) {
            await page.click('#settings-modal-toggle');
            await page.waitFor(`!document.getElementById('settings-modal').hidden`, { label: 'the Settings modal' });
            await page.click(`.settings-modal-nav-item[data-settings-page="${pageId}"]`);
            await page.waitFor(`document.querySelector('.settings-modal-page[data-settings-page-content="${pageId}"]')?.getClientRects().length > 0`, { label: `the ${pageId} page` });
        },
        async closeSettings() {
            // some changes (a model type switch) close the modal on their own
            if (await page.evaluate(`document.getElementById('settings-modal').hidden`)) return;
            await page.click('#settings-modal-close');
            await page.waitFor(`document.getElementById('settings-modal').hidden`, { label: 'the Settings modal to close' });
        },

        // Picks `optionText` in one of the dropdowns (the container's class name); the
        // dropdown has to be on screen (openSettingsPage for the ones in Settings).
        async pickDropdown(container, optionText) {
            await page.click(`.${container} .mydropdown-input`);
            const item = await page.waitFor(`(() => {
                const items = [...document.querySelectorAll('.mydropdown-item')].filter(item => item.getClientRects().length > 0);
                const hit = items.find(item => item.textContent.trim() === ${JSON.stringify(optionText)});
                if (!hit) return '';
                hit.id ||= 'e2e-pick-' + Math.random().toString(36).slice(2);
                return hit.id;
            })()`, { label: `the "${optionText}" option` });
            // the list takes its place under the input a frame after it opens
            await sleep(150);
            await page.click(`#${item}`);
            await sleep(300);
            const shown = await page.evaluate(`document.querySelector('.${container} .mydropdown-input')?.value ?? ''`);
            if (shown.trim() !== optionText) throw new Error(`the ${container} dropdown shows "${shown}" after picking "${optionText}"`);
        },

        async close() {
            // the browser may go away before it answers, so the answer is not waited for
            try { await Promise.race([page.send('Browser.close'), sleep(3000)]); } catch { /* already gone */ }
            page.close();
            const timer = setTimeout(() => { try { child.kill(); } catch { /* gone */ } }, 10_000);
            await exited;
            clearTimeout(timer);
            log.end();
            if (!process.env.SAA_E2E_KEEP) fs.rmSync(runDir, { recursive: true, force: true });
        },
    };
    return app;
}
