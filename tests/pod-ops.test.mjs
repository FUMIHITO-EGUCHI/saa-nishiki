// Issues #4 (Runpod start / stop), #8 (remote model lists) and #9 (relay up, ComfyUI down).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { ALLOWED_ACTIONS, RUNPOD_API_BASE, podAction, podActionRequest, podIdFromSshTarget, resolvePodId, summarizePod } from '../scripts/shared/runpodApi.js';
import { REMOTE_MODEL_NODE_NAMES, applyModelFilter, comboOptions, countLists, extractModelLists } from '../scripts/shared/remoteModelInfo.js';
import { formatBackendStatus } from '../scripts/renderer/components/statusPills.js';
import { DEFAULT_SETTINGS, SECTION_KEYS } from '../scripts/shared/settingsSections.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8').replace(/\r\n/g, '\n');

// ---- #4

test('runpod: the pod id comes from the SSH target unless set explicitly', () => {
    assert.equal(podIdFromSshTarget('2i3m9z8k6tqb7d-644118a9@ssh.runpod.io'), '2i3m9z8k6tqb7d');
    assert.equal(podIdFromSshTarget('root@example.com'), '');
    assert.equal(podIdFromSshTarget(''), '');
    assert.equal(resolvePodId({ api_pod_ssh_target: 'abc123-9f@ssh.runpod.io' }), 'abc123');
    assert.equal(resolvePodId({ api_pod_ssh_target: 'abc123-9f@ssh.runpod.io', api_pod_runpod_pod_id: ' zzz9 ' }), 'zzz9');
});

test('runpod: only status / start / stop can be built; terminate is refused before any URL exists', () => {
    assert.deepEqual([...ALLOWED_ACTIONS], ['status', 'start', 'stop']);
    assert.deepEqual(podActionRequest('status', 'abc'), { method: 'GET', url: `${RUNPOD_API_BASE}/pods/abc` });
    assert.deepEqual(podActionRequest('start', 'abc'), { method: 'POST', url: `${RUNPOD_API_BASE}/pods/abc/start` });
    assert.deepEqual(podActionRequest('stop', 'abc'), { method: 'POST', url: `${RUNPOD_API_BASE}/pods/abc/stop` });
    for (const action of ['terminate', 'delete', 'DELETE', 'reset', '']) {
        assert.throws(() => podActionRequest(action, 'abc'), /refused pod action/);
    }
    assert.throws(() => podActionRequest('start', '../pods'), /invalid pod id/);
    const source = read('scripts/shared/runpodApi.js');
    assert.doesNotMatch(source, /method:\s*'DELETE'/, 'no DELETE request anywhere in the module');
    assert.doesNotMatch(source, /\/terminate/, 'no terminate endpoint');
});

test('runpod: podAction sends the bearer key and never rejects on HTTP errors', async () => {
    const calls = [];
    const fetchImpl = async (url, init) => {
        calls.push({ url, init });
        if (url.endsWith('/stop')) return { ok: false, status: 401, text: async () => '{"error":"Unauthorized"}' };
        return { ok: true, status: 200, text: async () => JSON.stringify({ id: 'abc', name: 'saa', desiredStatus: 'RUNNING', costPerHr: 0.18, gpu: { displayName: 'RTX 3080 Ti' }, runtime: { uptimeInSeconds: 600 } }) };
    };
    const status = await podAction({ apiKey: 'k', podId: 'abc', action: 'status', fetchImpl });
    assert.equal(status.ok, true);
    assert.deepEqual(status.pod, { id: 'abc', name: 'saa', desiredStatus: 'RUNNING', costPerHr: 0.18, gpu: 'RTX 3080 Ti', uptimeSeconds: 600 });
    assert.equal(calls[0].init.method, 'GET');
    assert.equal(calls[0].init.headers.Authorization, 'Bearer k');
    const stop = await podAction({ apiKey: 'k', podId: 'abc', action: 'stop', fetchImpl });
    assert.equal(stop.ok, false);
    assert.match(stop.message, /HTTP 401: Unauthorized/);
    const noKey = await podAction({ apiKey: '', podId: 'abc', action: 'start', fetchImpl });
    assert.equal(noKey.ok, false);
    assert.equal(calls.length, 2, 'no request without a key');
    const refused = await podAction({ apiKey: 'k', podId: 'abc', action: 'terminate', fetchImpl });
    assert.equal(refused.ok, false);
    assert.equal(calls.length, 2, 'a refused action never reaches fetch');
    assert.equal(summarizePod(null), null);
});

test('runpod: settings keys, IPC, CLI and the relay bootstrap command are wired', () => {
    assert.equal(DEFAULT_SETTINGS.api_pod_runpod_api_key, '');
    assert.equal(DEFAULT_SETTINGS.api_pod_runpod_pod_id, '');
    assert.ok(SECTION_KEYS.app.includes('api_pod_runpod_api_key') && SECTION_KEYS.app.includes('api_pod_runpod_pod_id'));
    const control = read('scripts/main/runpodControl.js');
    assert.match(control, /ipcMain\.handle\('runpod-pod-control'/);
    assert.match(control, /ipcMain\.handle\('pod-run-bootstrap'/);
    assert.match(control, /if \(result\.ok && action === 'stop'\) stopPodSshSession\(\);/, 'a stop drops the relay session');
    assert.match(read('scripts/preload.js'), /runpodPodControl: async \(action\) => ipcRenderer\.invoke\('runpod-pod-control', action\)/);
    assert.match(read('main.js'), /registerRunpodControl\(ipcMain, getGlobalSettings\)/);
    const cli = read('scripts/podControl.mjs');
    assert.match(cli, /ALLOWED_ACTIONS\.includes\(args\.action\)/);
    assert.match(cli, /process\.env\.RUNPOD_API_KEY \|\| settings\.api_pod_runpod_api_key/);
    const relay = read('scripts/pod/comfy_ws_relay.py');
    assert.match(relay, /elif cmd == 'bootstrap':/);
    assert.match(relay, /BOOTSTRAP_SCRIPT = '\/workspace\/saa\/bootstrap\.sh'/);
    assert.match(relay, /subprocess\.Popen\(\['bash', script\]/, 'only the fixed script path is executed');
    const html = read('scripts/html_shared_body.js');
    for (const cls of ['system-settings-api-pod-runpod-key', 'system-settings-api-pod-runpod-pod-id', 'system-settings-api-pod-status', 'system-settings-api-pod-start', 'system-settings-api-pod-stop', 'system-settings-api-pod-bootstrap', 'system-settings-api-pod-fetch-models', 'system-settings-api-pod-result']) {
        assert.ok(html.includes(cls), cls);
    }
    const lang = JSON.parse(read('data/language.json'));
    for (const key of ['api_pod_runpod_api_key', 'api_pod_runpod_pod_id', 'ui_pod_status', 'ui_pod_start', 'ui_pod_stop', 'ui_pod_bootstrap', 'ui_pod_fetch_models', 'ui_status_comfy_down']) {
        assert.equal(typeof lang['en-US'][key], 'string', `en ${key}`);
        assert.equal(typeof lang['zh-CN'][key], 'string', `zh ${key}`);
    }
});

// ---- #8

const OBJECT_INFO = {
    CheckpointLoaderSimple: { CheckpointLoaderSimple: { input: { required: { ckpt_name: [['waiIllustriousSDXL_v170.safetensors', 'other_v1.safetensors'], { tooltip: 'x' }] } } } },
    LoraLoader: { LoraLoader: { input: { required: { model: ['MODEL', {}], lora_name: [['dmd2_sdxl_4step_lora_fp16.safetensors'], {}] } } } },
    VAELoader: { VAELoader: { input: { required: { vae_name: [[], {}] } } } },
    // ComfyUI 0.26 answers some loaders in the v3 combo encoding
    UpscaleModelLoader: { UpscaleModelLoader: { input: { required: { model_name: ['COMBO', { multiselect: false, options: ['RealESRGAN_x4plus_anime_6B.pth'] }] } } } },
    ControlNetLoader: null,
};

test('remote models: /object_info combos become per-kind lists, missing nodes stay null', () => {
    assert.deepEqual([...REMOTE_MODEL_NODE_NAMES], ['CheckpointLoaderSimple', 'LoraLoader', 'VAELoader', 'UpscaleModelLoader', 'ControlNetLoader', 'UNETLoader', 'CLIPLoader']);
    assert.deepEqual(comboOptions(OBJECT_INFO.LoraLoader, 'LoraLoader', 'lora_name'), ['dmd2_sdxl_4step_lora_fp16.safetensors']);
    assert.equal(comboOptions(OBJECT_INFO.LoraLoader, 'LoraLoader', 'model'), null, 'a non-combo input is not a list');
    const lists = extractModelLists(OBJECT_INFO);
    assert.deepEqual(lists.checkpoints, ['waiIllustriousSDXL_v170.safetensors', 'other_v1.safetensors']);
    assert.deepEqual(lists.loras, ['dmd2_sdxl_4step_lora_fp16.safetensors']);
    assert.deepEqual(lists.vae, []);
    assert.deepEqual(lists.upscalers, ['RealESRGAN_x4plus_anime_6B.pth']);
    assert.equal(lists.controlnet, null);
    assert.equal(lists.diffusion, null);
    assert.deepEqual(countLists(lists), { checkpoints: 2, loras: 1, vae: 0, upscalers: 1 });
    assert.deepEqual(applyModelFilter(lists.checkpoints, 'waiIllustrious', true), ['waiIllustriousSDXL_v170.safetensors']);
    assert.deepEqual(applyModelFilter(lists.checkpoints, 'waiIllustrious', false), lists.checkpoints);
    assert.deepEqual(applyModelFilter(lists.checkpoints, '*', true), lists.checkpoints);
});

test('remote models: relay object_info is limited to the loader nodes and the lists replace the local scan', () => {
    const relay = read('scripts/pod/comfy_ws_relay.py');
    assert.match(relay, /elif cmd == 'object_info':/);
    assert.match(relay, /if str\(node\) in OBJECT_INFO_NODES/, 'only whitelisted node classes are queried');
    for (const node of REMOTE_MODEL_NODE_NAMES) assert.ok(relay.includes(`'${node}'`), `relay knows ${node}`);
    const transport = read('scripts/main/podSshTransport.js');
    assert.match(transport, /export async function podObjectInfo\(\{ settings, nodes, open = false/);
    assert.match(transport, /else if \(podSessionState\(\) !== 'connected'\) \{\n\s+return \{ ok: false, message: 'pod relay not connected' \};/, 'open:false never dials the pod');
    const modelList = read('scripts/main/modelList.js');
    assert.match(modelList, /function applyRemoteModelLists\(lists, \{ model_filter_keyword = '\*', model_filter = false \} = \{\}\)/);
    assert.match(modelList, /MODELLIST_COMFYUI = applyModelFilter\(lists\.checkpoints, model_filter_keyword, model_filter\);/);
    assert.match(modelList, /CONTROLNET_COMFYUI = \['none', \.\.\.lists\.controlnet\]/);
    const remote = read('scripts/main/remoteModelList.js');
    assert.match(remote, /if \(!address \|\| loopbackOrigin\(address\)\) return null;/, 'loopback ComfyUI keeps the folder scan');
    assert.match(remote, /ipcMain\.handle\('update-model-list-remote'/);
    assert.match(read('scripts/renderer/components/myCollapsed.js'), /await globalThis\.api\.updateModelListRemote\?\.\(\{ open: false \}\);/);
    assert.match(read('scripts/renderer.js'), /await globalThis\.api\.updateModelListRemote\?\.\(\{ open: false \}\);/);
    assert.match(read('scripts/renderer/uiShell.js'), /onPodConnected: \(\) => \{ if \(!globalThis\.inGenerating\) globalThis\.podControls\?\.reloadModelLists\?\.\(\); \}/);
    assert.doesNotMatch(read('scripts/renderer/podControl.js'), /global-refresh-toggle/, 'that button reloads the whole page');
    assert.match(read('scripts/renderer/components/myCollapsed.js'), /export async function reloadModelLists\(\)/);
});

// ---- #9

test('pills: relay connected but ComfyUI down is its own warn -> bad state with the error as title', () => {
    const base = { comfy: { configured: true, pod: true, podState: 'connected', address: 'abc-1@ssh.runpod.io' } };
    const up = formatBackendStatus({ comfy: { ...base.comfy, ok: true, vramUsedMiB: 512, vramTotalMiB: 12288 } });
    assert.deepEqual([up[0].state, up[0].label], ['ok', 'ComfyUI · Pod · VRAM 0.5 / 12.0 GB']);
    const down = formatBackendStatus({ comfy: { ...base.comfy, ok: false, error: 'ComfyUI is not running on the pod (port 8188 refused)' } }, { failures: 1 });
    assert.deepEqual([down[0].state, down[0].label, down[0].title], ['warn', 'ComfyUI · Pod · ComfyUI down', 'ComfyUI is not running on the pod (port 8188 refused)']);
    const red = formatBackendStatus({ comfy: { ...base.comfy, ok: false, error: 'x' } }, { failures: 3, text: { comfyDown: 'ComfyUI未运行' } });
    assert.deepEqual([red[0].state, red[0].label], ['bad', 'ComfyUI · Pod · ComfyUI未运行']);
    // standby / connecting are untouched
    const standby = formatBackendStatus({ comfy: { ...base.comfy, podState: 'off', ok: true } });
    assert.deepEqual([standby[0].state, standby[0].label], ['off', 'ComfyUI · Pod · standby']);
    const probe = read('scripts/main/backendStatus.js');
    assert.match(probe, /const health = await podComfyHealth\(\);\n\s+result\.comfy\.ok = health\.ok;/);
    const relay = read('scripts/pod/comfy_ws_relay.py');
    assert.match(relay, /emit\(\{'id': rid, 'ok': False, 'message': comfy_down_message\(error\)\}\)/);
});

test('pills: the pod Ollama shows standby (not a failure) while the relay is idle', () => {
    const idle = formatBackendStatus({ ollama: { configured: true, remote: true, ok: false, standby: true, mode: 'Small', error: 'pod relay not connected' } }, { failures: 5 });
    assert.deepEqual([idle[0].state, idle[0].label], ['off', 'Ollama · Pod · Small · standby']);
    const down = formatBackendStatus({ ollama: { configured: true, remote: true, ok: false, mode: 'Small', error: 'Ollama is not running on the pod' } }, { failures: 1 });
    assert.deepEqual([down[0].state, down[0].label], ['warn', 'Ollama · Pod · Small · no answer']);
    assert.match(read('scripts/renderer/components/statusPills.js'), /!status\.ollama\.ok && !status\.ollama\.standby/, 'standby does not count towards the red threshold');
});
