// Pod setup wizard: takes a brand-new Runpod pod from "ComfyUI and nothing else"
// to a pod SAA can generate on, without a single manual SSH session.
//
// Three steps: connection (and what the pod already has), the components to
// install, then the install itself with the pod's own log streamed back. All of
// it rides the existing SSH relay — see scripts/pod/comfy_ws_relay.py, which only
// ever writes and runs its own fixed paths.
import { createDialogShell } from './dialogShell.js';
import { reloadModelLists } from './myCollapsed.js';

const CAT = '[PodWizard]';
const LOG_POLL_MS = 2000;
// "[provision]   file.safetensors 1.2 GB / 6.5 GB (18%)"
const PROGRESS_LINE = /\(\d+%\)\s*$/;
const FAST_LORA_FILE = 'dmd2_sdxl_4step_lora_fp16.safetensors';
const CIVITAI_TOKEN_URL = 'https://civitai.com/user/account';

// name -> [label key, fallback label, approximate download, always on]
const COMPONENTS = [
    ['nodes', 'ui_pod_wizard_c_nodes', 'Custom nodes (Mira, Impact-Pack, controlnet_aux)', '~60 MB', true],
    ['pip', 'ui_pod_wizard_c_pip', "Custom nodes' Python requirements", '', true],
    ['checkpoint', 'ui_pod_wizard_c_checkpoint', 'Checkpoint waiIllustriousSDXL_v170', '6.5 GB', false],
    ['fastlora', 'ui_pod_wizard_c_fastlora', 'Fast mode LoRA (DMD2 4-step)', '390 MB', false],
    ['adetailer', 'ui_pod_wizard_c_adetailer', 'ADetailer detectors and SAM', '430 MB', false],
    ['upscaler', 'ui_pod_wizard_c_upscaler', 'Hires fix upscaler (RealESRGAN anime 6B)', '18 MB', false],
    ['controlnet', 'ui_pod_wizard_c_controlnet', 'ControlNet openpose (SDXL)', '770 MB', false],
];
const STEPS = [
    ['ui_pod_wizard_step_connection', 'Connection'],
    ['ui_pod_wizard_step_components', 'Components'],
    ['ui_pod_wizard_step_install', 'Install'],
];

function lang() {
    const settings = globalThis.globalSettings;
    return globalThis.cachedFiles?.language?.[settings?.language] ?? {};
}

function text(key, fallback) {
    const value = lang()[key];
    return typeof value === 'string' && value ? value : fallback;
}

function el(tag, className, content = '') {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (content) node.textContent = content;
    return node;
}

export function formatBytes(bytes) {
    if (!Number.isFinite(bytes) || bytes < 0) return '?';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let value = bytes;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1; }
    return `${value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

// One line per fact, so a user can see at a glance what a pod is still missing.
export function describeProbe(probe, t = text) {
    if (!probe) return [];
    const models = probe.models ?? {};
    const count = folder => (Array.isArray(models[folder]) ? models[folder].length : 0);
    const yes = t('ui_pod_wizard_yes', 'yes');
    const no = t('ui_pod_wizard_no', 'no');
    const nodes = Array.isArray(probe.nodes) ? probe.nodes : [];
    const deployed = Object.values(probe.files ?? {}).filter(Boolean).length;
    return [
        [t('ui_pod_wizard_fact_gpu', 'GPU'), probe.gpu || t('ui_pod_wizard_unknown', 'unknown')],
        [t('ui_pod_wizard_fact_space', 'Free space on /workspace'), formatBytes(probe.workspaceFree)],
        [t('ui_pod_wizard_fact_comfy', 'ComfyUI answering'), probe.comfyUp ? yes : no],
        [t('ui_pod_wizard_fact_ollama', 'Ollama answering'), probe.ollamaUp ? yes : no],
        [t('ui_pod_wizard_fact_scripts', 'SAA scripts on the pod'), `${deployed} / 3`],
        [t('ui_pod_wizard_fact_nodes', 'Custom nodes'), nodes.length ? `${nodes.length}` : no],
        [t('ui_pod_wizard_fact_checkpoints', 'Checkpoints'), `${count('checkpoints')}`],
        [t('ui_pod_wizard_fact_loras', 'LoRAs'), `${count('loras')}`],
    ];
}

// The custom nodes provision.sh installs; all of them have to be there before
// the "nodes" component counts as done.
const REQUIRED_NODES = ['ComfyUI_Mira', 'ComfyUI_MiraSubPack', 'ComfyUI-Impact-Pack', 'ComfyUI-Impact-Subpack', 'comfyui_controlnet_aux'];

// What the pod already has. Those rows are shown as installed and cannot be
// ticked: re-downloading them would be a no-op (provision.sh checksums first).
export function installedComponents(probe) {
    const models = probe?.models ?? {};
    const nodes = probe?.nodes ?? [];
    const has = (folder, needle) => (models[folder] ?? []).some(name => (needle ? name.includes(needle) : true));
    const installed = new Set();
    if (REQUIRED_NODES.every(name => nodes.includes(name))) {
        installed.add('nodes');
        installed.add('pip'); // installed with the nodes; nothing on the pod reports it separately
    }
    if (has('checkpoints')) installed.add('checkpoint');
    if (has('loras', 'dmd2')) installed.add('fastlora');
    if (has('ultralytics/bbox') && has('sams')) installed.add('adetailer');
    if (has('upscale_models')) installed.add('upscaler');
    if (has('controlnet')) installed.add('controlnet');
    return installed;
}

// Which components are worth pre-selecting: everything the pod does not have.
export function suggestComponents(probe) {
    const installed = installedComponents(probe);
    return new Set(COMPONENTS.map(([name]) => name).filter(name => !installed.has(name)));
}

let singleton = null;

export function createPodSetupWizard() {
    const shell = createDialogShell({ className: 'pod-wizard' });
    const { body, footer } = shell;

    // ---- step indicator
    const stepList = el('ol', 'pod-wizard-steps');
    const stepChips = STEPS.map(([key, fallback], index) => {
        const chip = el('li', 'pod-wizard-step', `${index + 1}. ${text(key, fallback)}`);
        stepList.appendChild(chip);
        return chip;
    });
    body.appendChild(stepList);

    // ---- step 1: connection
    const connection = el('div', 'pod-wizard-panel');
    const connectionIntro = el('p', 'pod-wizard-intro');
    connection.appendChild(connectionIntro);
    const fields = el('div', 'pod-wizard-fields');
    const makeField = (labelKey, labelFallback, type = 'text') => {
        const wrap = el('label', 'pod-wizard-field');
        const caption = el('span', 'pod-wizard-field-label', text(labelKey, labelFallback));
        const input = el('input', 'pod-wizard-input');
        input.type = type;
        wrap.append(caption, input);
        fields.appendChild(wrap);
        return input;
    };
    const targetInput = makeField('api_pod_ssh_target', 'SSH target (podid-user@ssh.runpod.io)');
    const keyInput = makeField('api_pod_ssh_key', 'Private key file');
    const portInput = makeField('api_pod_ssh_comfy_port', 'ComfyUI port');
    connection.appendChild(fields);
    const testRow = el('div', 'pod-wizard-row');
    const testButton = el('button', 'pod-wizard-button', text('ui_pod_wizard_test', 'Test connection'));
    testButton.type = 'button';
    testRow.appendChild(testButton);
    connection.appendChild(testRow);
    const factTable = el('dl', 'pod-wizard-facts');
    connection.appendChild(factTable);
    body.appendChild(connection);

    // ---- step 2: components
    const components = el('div', 'pod-wizard-panel');
    components.hidden = true;
    const componentsIntro = el('p', 'pod-wizard-intro');
    components.appendChild(componentsIntro);
    const list = el('div', 'pod-wizard-component-list');
    const rows = new Map();
    for (const [name, labelKey, labelFallback, size, required] of COMPONENTS) {
        const row = el('label', 'pod-wizard-component');
        const box = el('input');
        box.type = 'checkbox';
        box.checked = true;
        box.disabled = required;
        const caption = el('span', 'pod-wizard-component-label', text(labelKey, labelFallback));
        const sizeTag = el('span', 'pod-wizard-component-size', size);
        row.append(box, caption, sizeTag);
        list.appendChild(row);
        rows.set(name, { row, box, sizeTag, size, required });
    }
    components.appendChild(list);
    const tokenWrap = el('label', 'pod-wizard-field pod-wizard-token');
    const tokenLabel = el('span', 'pod-wizard-field-label', text('api_pod_civitai_token', 'Civitai API token'));
    const tokenInput = el('input', 'pod-wizard-input');
    tokenInput.type = 'password';
    tokenInput.autocomplete = 'off';
    tokenWrap.append(tokenLabel, tokenInput);
    components.appendChild(tokenWrap);
    const tokenNote = el('p', 'pod-wizard-note', text(
        'ui_pod_wizard_token_note',
        `Civitai refuses an unauthenticated checkpoint download (403). Create a token at ${CIVITAI_TOKEN_URL} (Account settings -> API Keys). It is stored in the app settings and handed to the pod as an environment variable only.`,
    ));
    components.appendChild(tokenNote);
    body.appendChild(components);

    // ---- step 3: install
    const install = el('div', 'pod-wizard-panel pod-wizard-install');
    install.hidden = true;
    const installStatus = el('p', 'pod-wizard-intro');
    install.appendChild(installStatus);
    const logPane = el('pre', 'pod-wizard-log');
    install.appendChild(logPane);
    const afterRow = el('div', 'pod-wizard-row pod-wizard-after');
    const bootstrapButton = el('button', 'pod-wizard-button', text('ui_pod_bootstrap', 'Run bootstrap'));
    bootstrapButton.type = 'button';
    const modelsButton = el('button', 'pod-wizard-button', text('ui_pod_fetch_models', 'Fetch pod models'));
    modelsButton.type = 'button';
    afterRow.append(bootstrapButton, modelsButton);
    afterRow.hidden = true;
    install.appendChild(afterRow);
    body.appendChild(install);

    // ---- footer
    const note = el('p', 'pod-wizard-footer-note');
    const backButton = el('button', 'pod-wizard-button', text('ui_pod_wizard_back', 'Back'));
    backButton.type = 'button';
    const nextButton = el('button', 'pod-wizard-button pod-wizard-button-primary', text('ui_pod_wizard_next', 'Next'));
    nextButton.type = 'button';
    const buttonRow = el('div', 'pod-wizard-row');
    buttonRow.append(backButton, nextButton);
    footer.append(note, buttonRow);

    const panels = [connection, components, install];
    let step = 0;
    let probe = null;
    let busy = false;
    let running = false;
    let logOffset = 0;
    let pollTimer = null;

    function setNote(message) {
        note.textContent = message ?? '';
        if (message) console.log(CAT, message);
    }

    function render() {
        panels.forEach((panel, index) => { panel.hidden = index !== step; });
        stepChips.forEach((chip, index) => chip.classList.toggle('is-current', index === step));
        backButton.disabled = step === 0 || busy;
        nextButton.disabled = busy || (step === 2 && running);
        nextButton.textContent = step === 0 ? text('ui_pod_wizard_next', 'Next')
            : step === 1 ? text('ui_pod_wizard_install', 'Install')
                : text('ui_pod_wizard_close', 'Close');
        connectionIntro.textContent = text(
            'ui_pod_wizard_connection_intro',
            'A new pod has ComfyUI and nothing else. Check the connection first: the wizard reads what the pod already has before it changes anything.',
        );
        componentsIntro.textContent = text(
            'ui_pod_wizard_components_intro',
            'Everything is downloaded on the pod itself and verified against a known checksum. Items the pod already has are unticked.',
        );
    }

    async function call(args) {
        if (!globalThis.api?.podSetup) return { ok: false, message: 'pod setup is only available in the desktop app' };
        return globalThis.api.podSetup(args);
    }

    async function withBusy(label, task) {
        if (busy) return null;
        busy = true;
        setNote(`${label}…`);
        render();
        try {
            return await task();
        } catch (error) {
            setNote(`${label}: ${error?.message ?? error}`);
            return null;
        } finally {
            busy = false;
            render();
        }
    }

    // The main process opens the relay from its own copy of the settings, so every
    // edit made here has to be flushed before a call that dials the pod.
    async function readConnectionFields() {
        const settings = globalThis.globalSettings;
        if (!settings) return;
        settings.api_pod_ssh_target = targetInput.value.trim();
        settings.api_pod_ssh_key = keyInput.value.trim();
        const port = Number.parseInt(portInput.value, 10);
        settings.api_pod_ssh_comfy_port = Number.isInteger(port) && port > 0 && port < 65536 ? port : 8188;
        // the wizard is the usual way in for a first-time pod, so turn the transport on
        settings.api_pod_ssh_enable = true;
        globalThis.uiShell?.gpuToggle?.render?.();
        await globalThis.settingsPersistence?.flush?.();
    }

    function renderFacts() {
        factTable.replaceChildren();
        for (const [label, value] of describeProbe(probe)) {
            factTable.append(el('dt', 'pod-wizard-fact-label', label), el('dd', 'pod-wizard-fact-value', String(value)));
        }
    }

    async function runProbe() {
        await readConnectionFields();
        return withBusy(text('ui_pod_wizard_test', 'Test connection'), async () => {
            const result = await call({ action: 'probe' });
            if (!result?.ok) {
                probe = null;
                renderFacts();
                setNote(result?.message ?? 'probe failed');
                return false;
            }
            probe = result.probe;
            renderFacts();
            applyProbeToComponents();
            setNote(result.provisioning
                ? text('ui_pod_wizard_already_running', 'provisioning is already running on this pod')
                : text('ui_pod_wizard_probe_ok', 'pod reached'));
            return true;
        });
    }

    // Anything the pod already has is shown as installed and cannot be ticked;
    // provision.sh would checksum it and skip it anyway.
    function applyProbeToComponents() {
        const installed = installedComponents(probe);
        const suggested = suggestComponents(probe);
        for (const [name, entry] of rows) {
            const isInstalled = probe ? installed.has(name) : false;
            entry.row.classList.toggle('is-installed', isInstalled);
            entry.box.disabled = isInstalled || entry.required;
            entry.box.checked = !isInstalled && (entry.required || suggested.has(name));
            entry.sizeTag.textContent = isInstalled ? text('ui_pod_wizard_installed', 'installed') : entry.size;
        }
    }

    function selectedComponents() {
        return [...rows.entries()].filter(([, entry]) => entry.box.checked).map(([name]) => name);
    }

    function appendLog(chunk) {
        if (!chunk) return;
        const atBottom = logPane.scrollTop + logPane.clientHeight >= logPane.scrollHeight - 24;
        logPane.textContent += chunk;
        if (atBottom) logPane.scrollTop = logPane.scrollHeight;
        showProgress(chunk);
    }

    // provision.sh reports a download every few seconds as
    // "[provision]   <file> 1.2 GB / 6.5 GB (18%)"; the newest one becomes the
    // headline so a multi-GB file does not look like a stalled window.
    function showProgress(chunk) {
        const lines = chunk.split('\n').filter(line => PROGRESS_LINE.test(line));
        if (lines.length === 0) return;
        installStatus.textContent = lines.at(-1).replace(/^\[provision\]\s*/, '').trim();
    }

    function stopPolling() {
        clearTimeout(pollTimer);
        pollTimer = null;
    }

    async function pollLog() {
        const result = await call({ action: 'log', name: 'provision', offset: logOffset });
        if (!result?.ok) {
            setNote(result?.message ?? 'log read failed');
            running = false;
            render();
            return;
        }
        appendLog(result.text);
        logOffset = result.offset;
        if (result.running || result.text) {
            pollTimer = setTimeout(pollLog, LOG_POLL_MS);
            return;
        }
        running = false;
        afterRow.hidden = false;
        installStatus.textContent = text('ui_pod_wizard_install_done', 'Provisioning finished. Run the bootstrap so ComfyUI picks up the new nodes and models.');
        setNote('');
        // A fresh install of the fast LoRA is only useful once the setting names it.
        const settings = globalThis.globalSettings;
        if (settings && selectedComponents().includes('fastlora') && (!settings.api_fast_lora || settings.api_fast_lora === 'None')) {
            settings.api_fast_lora = FAST_LORA_FILE;
        }
        // read the pod again so a second pass shows what actually landed
        const refreshed = await call({ action: 'probe' });
        probe = refreshed?.ok ? refreshed.probe : null;
        renderFacts();
        applyProbeToComponents();
        render();
    }

    async function startInstall() {
        const wanted = selectedComponents();
        if (wanted.length === 0) {
            // nothing left to fetch: still offer the two things that follow an install
            step = 2;
            logPane.textContent = '';
            installStatus.textContent = text('ui_pod_wizard_all_present', 'The pod already has everything selectable. Run the bootstrap if ComfyUI has not picked the models up yet.');
            afterRow.hidden = false;
            setNote('');
            render();
            return true;
        }
        const settings = globalThis.globalSettings;
        const token = tokenInput.value.trim();
        if (settings && token) settings.api_pod_civitai_token = token;
        if (wanted.includes('checkpoint') && !(token || settings?.api_pod_civitai_token)) {
            setNote(text('ui_pod_wizard_need_token', 'the checkpoint needs a Civitai token'));
            return false;
        }
        await globalThis.settingsPersistence?.flush?.(); // the main process reads the token from its own copy
        step = 2;
        logPane.textContent = '';
        logOffset = 0;
        afterRow.hidden = true;
        installStatus.textContent = text('ui_pod_wizard_install_running', 'Installing on the pod. This runs on the pod itself, so closing this window does not stop it.');
        render();

        const started = await withBusy(text('ui_pod_wizard_install', 'Install'), async () => {
            // provision.sh appends to its log, so start reading at the current end:
            // the pane shows this run, not every run the pod has ever had
            const head = await call({ action: 'log', name: 'provision', offset: Number.MAX_SAFE_INTEGER });
            logOffset = head?.ok ? head.offset : 0;
            const deployed = await call({ action: 'deploy' });
            if (!deployed?.ok) {
                setNote(deployed?.message ?? 'deploy failed');
                return false;
            }
            appendLog(`${text('ui_pod_wizard_deployed', 'scripts deployed:')} ${(deployed.written ?? []).join(', ')}\n`);
            const result = await call({
                action: 'provision',
                components: wanted,
                civitaiToken: token || settings?.api_pod_civitai_token || '',
            });
            if (!result?.ok) {
                setNote(result?.message ?? 'provision failed');
                return false;
            }
            appendLog(`${text('ui_pod_wizard_started', 'provisioning started, log:')} ${result.log}\n`);
            return true;
        });
        if (!started) return false;
        running = true;
        render();
        pollTimer = setTimeout(pollLog, LOG_POLL_MS);
        return true;
    }

    testButton.addEventListener('click', () => { runProbe(); });
    bootstrapButton.addEventListener('click', () => withBusy(text('ui_pod_bootstrap', 'Run bootstrap'), async () => {
        const result = await globalThis.api?.podRunBootstrap?.();
        setNote(result?.ok ? `${text('ui_pod_result_bootstrap', 'bootstrap started, log:')} ${result.log}` : (result?.message ?? 'bootstrap failed'));
    }));
    modelsButton.addEventListener('click', () => withBusy(text('ui_pod_fetch_models', 'Fetch pod models'), async () => {
        const result = await globalThis.api?.updateModelListRemote?.({ open: true });
        if (!result?.ok) {
            setNote(result?.message ?? 'models failed');
            return;
        }
        await reloadModelLists();
        const counts = Object.entries(result.counts ?? {}).map(([key, value]) => `${key} ${value}`).join(', ');
        setNote(`${text('ui_pod_result_models', 'pod models applied:')} ${counts}`);
    }));

    backButton.addEventListener('click', () => {
        if (step === 0 || busy) return;
        step -= 1;
        render();
    });
    nextButton.addEventListener('click', async () => {
        if (busy) return;
        if (step === 0) {
            if (!probe && !(await runProbe())) return;
            step = 1;
            render();
            return;
        }
        if (step === 1) {
            await startInstall();
            return;
        }
        shell.close({ apply: true });
    });

    shell.setCloseHandler(() => {
        stopPolling();
        globalThis.settingsPersistence?.flush?.();
        // the pod may have changed under the settings panel; let it re-read
        document.dispatchEvent(new CustomEvent('saa-pod-wizard-closed'));
    });

    return {
        open(trigger = null) {
            const settings = globalThis.globalSettings ?? {};
            targetInput.value = settings.api_pod_ssh_target ?? '';
            keyInput.value = settings.api_pod_ssh_key ?? '';
            portInput.value = `${settings.api_pod_ssh_comfy_port ?? 8188}`;
            tokenInput.value = settings.api_pod_civitai_token ?? '';
            step = 0;
            probe = null;
            running = false;
            logPane.textContent = '';
            logOffset = 0;
            afterRow.hidden = true;
            renderFacts();
            applyProbeToComponents();
            setNote('');
            render();
            shell.open({ trigger, title: text('ui_pod_wizard_title', 'Pod setup'), initialFocus: () => targetInput });
        },
        close: () => shell.close({ apply: false }),
        destroy: () => { stopPolling(); shell.destroy(); },
    };
}

export function openPodSetupWizard(trigger = null) {
    singleton ??= createPodSetupWizard();
    singleton.open(trigger);
    return singleton;
}
