// The pod setup wizard: what it shows about a pod, what it pre-selects, and the
// wiring that lets it set up a brand-new pod without a manual SSH session.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { describeProbe, formatBytes, installedComponents, suggestComponents } from '../scripts/renderer/components/podSetupWizard.js';
import { DEFAULT_SETTINGS, SECTION_KEYS } from '../scripts/shared/settingsSections.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8').replace(/\r\n/g, '\n');

const FRESH_POD = {
    gpu: 'NVIDIA RTX A6000, 46068 MiB',
    workspaceFree: 205_000_000_000,
    files: { 'bootstrap.sh': false, 'provision.sh': false, 'extra_model_paths.yaml': false },
    nodes: ['ComfyUI-Manager'],
    models: { checkpoints: [], loras: [], 'ultralytics/bbox': [], sams: [], upscale_models: [], controlnet: [] },
    comfyUp: true,
    ollamaUp: false,
};

test('probe facts read as label / value pairs, unknown values included', () => {
    const facts = Object.fromEntries(describeProbe(FRESH_POD));
    assert.equal(facts.GPU, 'NVIDIA RTX A6000, 46068 MiB');
    assert.equal(facts['Free space on /workspace'], '191 GB');
    assert.equal(facts['ComfyUI answering'], 'yes');
    assert.equal(facts['Ollama answering'], 'no');
    assert.equal(facts['SAA scripts on the pod'], '0 / 3');
    assert.equal(facts.Checkpoints, '0');
    assert.deepEqual(describeProbe(null), []);
    assert.equal(Object.fromEntries(describeProbe({ ...FRESH_POD, gpu: '' })).GPU, 'unknown');
    assert.equal(formatBytes(0), '0 B');
    assert.equal(formatBytes(1536), '1.5 KB');
    assert.equal(formatBytes(-1), '?');
    assert.equal(formatBytes(undefined), '?');
});

const ALL_COMPONENTS = ['adetailer', 'checkpoint', 'controlnet', 'fastlora', 'nodes', 'pip', 'upscaler'].sort();
const STOCKED_POD = {
    ...FRESH_POD,
    nodes: ['ComfyUI-Manager', 'ComfyUI_Mira', 'ComfyUI_MiraSubPack', 'ComfyUI-Impact-Pack', 'ComfyUI-Impact-Subpack', 'comfyui_controlnet_aux'],
    models: {
        checkpoints: ['waiIllustriousSDXL_v170.safetensors'],
        loras: ['dmd2_sdxl_4step_lora_fp16.safetensors'],
        'ultralytics/bbox': ['face_yolov8m.pt'],
        sams: ['sam_vit_b_01ec64.pth'],
        upscale_models: ['RealESRGAN_x4plus_anime_6B.pth'],
        controlnet: ['control-lora-openposeXL2-rank256.safetensors'],
    },
};

test('a pod that has nothing gets everything ticked; what it already has is left out', () => {
    assert.deepEqual([...installedComponents(FRESH_POD)], [], 'a bare pod has nothing installed');
    assert.deepEqual([...suggestComponents(FRESH_POD)].sort(), ALL_COMPONENTS);

    assert.deepEqual([...installedComponents(STOCKED_POD)].sort(), ALL_COMPONENTS);
    assert.deepEqual([...suggestComponents(STOCKED_POD)], [], 'nothing left to install');

    // a LoRA folder without DMD2 still wants the fast-mode LoRA
    const otherLora = { ...STOCKED_POD, models: { ...STOCKED_POD.models, loras: ['some_style.safetensors'] } };
    assert.ok(!installedComponents(otherLora).has('fastlora'));
    assert.ok(suggestComponents(otherLora).has('fastlora'));
    // one custom node missing means the node set is not done, and pip follows it
    const halfNodes = { ...STOCKED_POD, nodes: STOCKED_POD.nodes.filter(name => name !== 'comfyui_controlnet_aux') };
    assert.ok(!installedComponents(halfNodes).has('nodes'));
    assert.ok(!installedComponents(halfNodes).has('pip'));
    // detectors without the SAM model are not a working ADetailer setup
    const noSam = { ...STOCKED_POD, models: { ...STOCKED_POD.models, sams: [] } };
    assert.ok(!installedComponents(noSam).has('adetailer'));
    // no probe means nothing is known to be there, so nothing is silently skipped
    assert.deepEqual([...installedComponents(undefined)], []);
    assert.deepEqual([...suggestComponents(undefined)].sort(), ALL_COMPONENTS);
});

test('installed rows are disabled, and a download reports its progress', () => {
    const wizard = read('scripts/renderer/components/podSetupWizard.js');
    assert.match(wizard, /entry\.box\.disabled = isInstalled \|\| entry\.required;/, 'what the pod has cannot be ticked');
    assert.match(wizard, /entry\.sizeTag\.textContent = isInstalled \? text\('ui_pod_wizard_installed'/);
    assert.match(wizard, /const PROGRESS_LINE = \/\\\(\\d\+%\\\)\\s\*\$\//);
    assert.match(wizard, /installStatus\.textContent = lines\.at\(-1\)/, 'the newest progress line is the headline');
    // an empty selection is not an error: the pod is already complete
    assert.match(wizard, /if \(wanted\.length === 0\) \{\n\s+\/\/ nothing left to fetch/);

    const provision = read('scripts/pod/provision.sh');
    assert.match(provision, /log "  \$name \$\(human "\$got"\) \/ \$\(human "\$total"\) \(\$\(\(got \* 100 \/ total\)\)%\)"/);
    assert.match(provision, /while kill -0 "\$pid" 2>\/dev\/null; do/, 'progress is polled while curl runs');
    assert.match(provision, /CKPT_BYTES=6938040682/);
    // every download call carries its expected size, so the percentage is real
    for (const [file, bytes] of [
        ['face_yolov8m.pt', '52026019'],
        ['hand_yolov8n.pt', '6237883'],
        ['sam_vit_b_01ec64.pth', '375042383'],
        ['RealESRGAN_x4plus_anime_6B.pth', '17938799'],
        ['dmd2_sdxl_4step_lora_fp16.safetensors', '393854592'],
        ['control-lora-openposeXL2-rank256.safetensors', '774423024'],
    ]) {
        assert.ok(new RegExp(`${file.replace(/\./g, '\\.')} ${bytes}\\n`).test(provision), file);
    }
});

test('the relay only writes and runs its own fixed paths', () => {
    const relay = read('scripts/pod/comfy_ws_relay.py');
    for (const cmd of ['probe', 'deploy', 'provision', 'log']) {
        assert.match(relay, new RegExp(`elif cmd == '${cmd}':`), cmd);
    }
    // exactly three deployable files, each resolving to a fixed absolute path
    const targets = relay.match(/DEPLOY_TARGETS = \{([^}]*)\}/)[1];
    const entries = [...targets.matchAll(/'([^']+)':\s*([^,\n]+)/g)].map(match => [match[1], match[2].trim()]);
    assert.deepEqual(entries, [
        ['bootstrap.sh', 'BOOTSTRAP_SCRIPT'],
        ['provision.sh', 'PROVISION_SCRIPT'],
        ['extra_model_paths.yaml', "'/workspace/runpod-slim/extra_model_paths.yaml'"],
    ]);
    assert.match(relay, /BOOTSTRAP_SCRIPT = '\/workspace\/saa\/bootstrap\.sh'/);
    assert.match(relay, /PROVISION_SCRIPT = '\/workspace\/saa\/provision\.sh'/);
    assert.match(relay, /target = DEPLOY_TARGETS\.get\(name\)\n\s+if not target:/, 'an unlisted name is refused');
    assert.match(relay, /components = \[c for c in \(request\.get\('components'\) or \[\]\) if c in PROVISION_COMPONENTS\]/);
    assert.match(relay, /env\['CIVITAI_TOKEN'\] = token/, 'the token goes into the environment');
    assert.doesNotMatch(relay, /shell=True/);
    assert.doesNotMatch(relay, /\brm -rf\b|shutil\.rmtree/, 'the relay never deletes anything on the volume');
    // websocket-client is only needed by submit, so an unprovisioned pod can still be set up
    assert.match(relay, /def websocket_module\(\):/);
    assert.match(relay, /ws = websocket_module\(\)\.WebSocket\(\)/);
});

test('provision.sh handles every component the relay accepts, and gates the checkpoint', () => {
    const relay = read('scripts/pod/comfy_ws_relay.py');
    const declared = [...relay.match(/PROVISION_COMPONENTS = \(([^)]*)\)/)[1].matchAll(/'([a-z]+)'/g)].map(match => match[1]);
    const provision = read('scripts/pod/provision.sh');
    const all = provision.match(/ALL_COMPONENTS="([^"]*)"/)[1].split(/\s+/);
    assert.deepEqual([...declared].sort(), [...all].sort(), 'relay and script agree on the component names');
    for (const name of declared) {
        if (name === 'checkpoint') continue; // guarded by its own `if want checkpoint` branch below
        assert.ok(provision.includes(`if want ${name}; then`) || provision.includes(`want ${name}`), name);
    }
    assert.match(provision, /if want checkpoint; then\n\s+if \[ -n "\$\{CIVITAI_TOKEN:-\}" \]/, 'no token, no checkpoint download');
    // Civitai answers 404 when the query narrows to a variant that does not exist
    // (this build is published as size=pruned), so the plain version URL is used
    assert.match(provision, /CKPT_URL="\$\{CIVITAI_URL:-https:\/\/civitai\.com\/api\/download\/models\/2883731\}"/);
    assert.doesNotMatch(provision, /size=full/);
    // the token is fed to curl on stdin, never as an argument
    assert.match(provision, /\| curl -fL -sS -m 7200 -K - &/);
    assert.doesNotMatch(provision, /curl [^\n|]*\$token/);
    assert.match(provision, /sha256sum "\$dest\.part"/, 'every download is checksummed before it is kept');
    assert.match(provision, /codeload\.github\.com/, 'tarballs, not git clone (a Runpod IP can hit an auth prompt)');
    assert.doesNotMatch(provision, /--components "\$CIVITAI_TOKEN"/);
});

test('bootstrap.sh survives a pod that has no extra_model_paths.yaml yet', () => {
    const bootstrap = read('scripts/pod/bootstrap.sh');
    assert.match(bootstrap, /if \[ -f "\$EXTRA_MODEL_PATHS" \]; then\n\s+EXTRA_ARGS=\(--extra-model-paths-config "\$EXTRA_MODEL_PATHS"\)/);
    assert.match(bootstrap, /tr '\\0' ' ' < "\/proc\/\$\(pgrep -f "main\.py --listen" \| head -1\)\/cmdline"/,
        'cmdline is NUL separated, so a plain grep would restart ComfyUI on every run');
    assert.match(bootstrap, /for req in "\$COMFY_DIR"\/custom_nodes\/\*\/requirements\.txt/, 'every node, not just Impact-Pack');
});

test('secrets are never shown in the clear', () => {
    // setupTextbox's sixth argument is passwordMode: the field renders ****** until focused
    const renderer = read('scripts/renderer.js');
    for (const [field, setting] of [
        ['system-settings-api-pod-runpod-key', 'api_pod_runpod_api_key'],
        ['system-settings-api-pod-civitai-token', 'api_pod_civitai_token'],
    ]) {
        const call = renderer.slice(renderer.indexOf(`setupTextbox('${field}'`));
        const head = call.slice(0, call.indexOf('),\n') + 1);
        assert.ok(head.includes(`globalThis.globalSettings.${setting} = value.trim(); }, true)`), field);
    }
    const wizard = read('scripts/renderer/components/podSetupWizard.js');
    assert.match(wizard, /tokenInput\.type = 'password';/);
    assert.match(wizard, /tokenInput\.autocomplete = 'off';/);
    // the token reaches the pod through the environment, and nothing logs it
    assert.doesNotMatch(wizard, /console\.log\([^)]*token/i);
    assert.doesNotMatch(read('scripts/main/runpodControl.js'), /console\.log\([^)]*civitai/i);
    const provision = read('scripts/pod/provision.sh');
    assert.doesNotMatch(provision, /log "[^"]*\$\{?CIVITAI_TOKEN/, 'the token value is never logged');
    assert.doesNotMatch(provision, /log "[^"]*\$url/, 'the download URL carries the token as a query parameter');
});

test('wizard wiring: transport, IPC, preload, settings, markup and language', () => {
    const transport = read('scripts/main/podSshTransport.js');
    for (const fn of ['podProbe', 'podDeployScripts', 'podProvision', 'podReadLog']) {
        assert.match(transport, new RegExp(`export async function ${fn}\\(`), fn);
    }
    assert.match(transport, /'bootstrap\.sh': 'bootstrap\.sh'/);
    const control = read('scripts/main/runpodControl.js');
    assert.match(control, /ipcMain\.handle\('pod-setup'/);
    assert.match(control, /case 'provision':/);
    assert.match(read('scripts/preload.js'), /podSetup: async \(args\) => ipcRenderer\.invoke\('pod-setup', args\)/);
    assert.equal(DEFAULT_SETTINGS.api_pod_civitai_token, '');
    assert.ok(SECTION_KEYS.app.includes('api_pod_civitai_token'));
    const html = read('scripts/html_shared_body.js');
    for (const cls of ['pod-btn-setup', 'system-settings-api-pod-civitai-token']) {
        assert.ok(html.includes(cls), cls);
    }
    assert.match(read('scripts/renderer/podControl.js'), /openPodSetupWizard\(dom\.setup\)/);
    const lang = JSON.parse(read('data/language.json'));
    for (const key of ['api_pod_civitai_token', 'ui_pod_wizard_open', 'ui_pod_wizard_title', 'ui_pod_wizard_step_connection',
        'ui_pod_wizard_c_fastlora', 'ui_pod_wizard_token_note', 'ui_pod_wizard_install_done']) {
        assert.equal(typeof lang['en-US'][key], 'string', `en ${key}`);
        assert.equal(typeof lang['zh-CN'][key], 'string', `zh ${key}`);
    }
});
