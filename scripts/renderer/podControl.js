// The Runpod pod panel in the settings (issues #4 / #8 / #9).
//
// One state-driven panel instead of a row of one-shot buttons: the pill reports
// the pod, the chips report the services on it, and an action is only rendered
// while it applies. Nothing here can terminate a pod.
//
// The exception cases drive the shape:
//   - a STOPPED pod does not refuse an SSH connection, it hangs until the relay's
//     60 s start timeout. So the Runpod REST API is asked first, and the relay is
//     only dialled when the pod is known to be running (or the user asks).
//   - with no Runpod API key there is no cheap answer at all, so the panel says
//     "not checked" and waits for the user to press Check pod rather than
//     guessing "stopped" and hanging the settings page.
//   - every call is wrapped: a failure becomes a phase and a message, never a throw.
import { reloadModelLists } from './components/myCollapsed.js';
import { installedComponents, openPodSetupWizard } from './components/podSetupWizard.js';

const CAT = '[PodControl]';
const POLL_MS = 6000;          // while a pod is booting
const POLL_LIMIT = 40;         // give up after about four minutes

function lang() {
    const settings = globalThis.globalSettings;
    return globalThis.cachedFiles?.language?.[settings?.language] ?? {};
}

function text(key, fallback) {
    const value = lang()[key];
    return typeof value === 'string' && value ? value : fallback;
}

export function describePodResult(result, t = text) {
    if (!result) return t('ui_pod_result_none', 'no answer');
    if (!result.ok) return `${result.action ?? 'pod'}: ${result.message ?? 'failed'}`;
    const pod = result.pod ?? {};
    const parts = [];
    if (pod.desiredStatus) parts.push(pod.desiredStatus);
    if (pod.gpu) parts.push(pod.gpu);
    if (Number.isFinite(pod.costPerHr)) parts.push(`$${pod.costPerHr.toFixed(2)}/h`);
    if (Number.isFinite(pod.uptimeSeconds)) parts.push(`${Math.round(pod.uptimeSeconds / 60)} min`);
    const verb = result.action === 'start' ? t('ui_pod_result_started', 'start requested')
        : result.action === 'stop' ? t('ui_pod_result_stopped', 'stop requested')
            : t('ui_pod_result_status', 'status');
    return parts.length ? `${verb} · ${parts.join(' · ')}` : verb;
}

/**
 * What the panel should show, from what each source actually answered.
 *
 * `status` is the Runpod REST reply (absent when no API key is configured),
 * `probe` the relay reply (`idle` = the relay was not dialled, which is not a
 * failure). Pure, so the state machine can be tested without a pod.
 */
export function resolvePhase({ target, status, probe } = {}) {
    if (!target) return 'unconfigured';
    const desired = String(status?.ok ? status.pod?.desiredStatus ?? '' : '').toUpperCase();
    if (desired && desired !== 'RUNNING') return 'stopped';
    if (desired === 'RUNNING') return probe && !probe.ok && !probe.idle ? 'starting' : 'running';
    if (probe?.ok) return 'running';                       // the relay answered: it is up, key or no key
    if (probe && !probe.idle) return 'unreachable';        // we dialled and got nothing
    return 'unknown';                                      // nothing has been checked yet
}

// "RTX A6000 · $0.18/h · up 2 h 14 m" - only the parts the pod actually reported.
export function describePodFacts(pod, t = text) {
    const parts = [];
    if (pod?.gpu) parts.push(pod.gpu);
    if (Number.isFinite(pod?.costPerHr)) parts.push(`$${pod.costPerHr.toFixed(2)}/h`);
    if (Number.isFinite(pod?.uptimeSeconds)) {
        const minutes = Math.max(0, Math.round(pod.uptimeSeconds / 60));
        const shown = minutes >= 60 ? `${Math.floor(minutes / 60)} h ${minutes % 60} m` : `${minutes} m`;
        parts.push(`${t('ui_pod_uptime', 'up')} ${shown}`);
    }
    return parts.join(' · ');
}

// "1 checkpoint · 1 LoRA · 9 nodes" from a probe.
export function describeInventory(probe, t = text) {
    if (!probe) return '';
    const models = probe.models ?? {};
    const count = folder => (Array.isArray(models[folder]) ? models[folder].length : 0);
    const nodes = Array.isArray(probe.nodes) ? probe.nodes.length : 0;
    return [
        `${count('checkpoints')} ${t('ui_pod_inv_checkpoints', 'checkpoints')}`,
        `${count('loras')} ${t('ui_pod_inv_loras', 'LoRAs')}`,
        `${nodes} ${t('ui_pod_inv_nodes', 'nodes')}`,
    ].join(' · ');
}

// "all 7 components installed" / "4 of 7 installed" / "not checked yet".
export function describeSetup(probe, t = text) {
    if (!probe) return t('ui_pod_setup_unknown', 'not checked yet');
    const installed = installedComponents(probe).size;
    const total = 7;
    return installed >= total
        ? t('ui_pod_setup_complete', 'all components installed')
        : `${installed} / ${total} ${t('ui_pod_setup_partial', 'components installed')}`;
}

// "podid-user@ssh.runpod.io · id_ed25519 · port 8188" - the key by file name only.
export function describeConnection(settings = {}, t = text) {
    const target = String(settings.api_pod_ssh_target ?? '').trim();
    if (!target) return t('ui_pod_conn_none', 'no SSH target set');
    const key = String(settings.api_pod_ssh_key ?? '').trim().split(/[\\/]/).pop();
    const parts = [target];
    if (key) parts.push(key);
    parts.push(`${t('ui_pod_conn_port', 'port')} ${Number(settings.api_pod_ssh_comfy_port) || 8188}`);
    return parts.join(' · ');
}

export function setupPodControls() {
    const panel = document.querySelector('.pod-panel:not(.pod-llm-panel)');
    const note = document.querySelector('.system-settings-api-pod-result');
    const show = message => { if (note) note.textContent = message ?? ''; if (message) console.log(CAT, message); };

    const pick = selector => panel?.querySelector(selector) ?? null;
    const dom = panel && {
        pill: pick('.pod-state-pill'),
        pillText: pick('.pod-state-text'),
        facts: pick('.pod-facts'),
        check: pick('.pod-btn-check'),
        start: pick('.pod-btn-start'),
        stop: pick('.pod-btn-stop'),
        servicesSep: pick('.pod-sep-services'),
        services: pick('.pod-row-services'),
        comfy: pick('.pod-chip-comfy'),
        ollama: pick('.pod-chip-ollama'),
        inventory: pick('.pod-inventory'),
        repair: pick('.pod-btn-repair'),
        models: pick('.pod-btn-models'),
        setupSummary: pick('.pod-setup-summary'),
        setup: pick('.pod-btn-setup'),
        connection: pick('.pod-connection-summary'),
        edit: pick('.pod-btn-edit'),
        fields: pick('.pod-connection-fields'),
    };

    // one in-flight pod call at a time; everything below goes through it
    let busy = false;
    // before anything has been read: configured but unchecked, never a guess at "stopped"
    let state = {
        phase: String(globalThis.globalSettings?.api_pod_ssh_target ?? '').trim() ? 'unknown' : 'unconfigured',
        status: null, probe: null, message: '',
    };
    let pollTimer = null;
    let pollsLeft = 0;

    const settings = () => globalThis.globalSettings ?? {};
    const hasApi = () => typeof globalThis.api?.runpodPodControl === 'function';
    const apiKey = () => String(settings().api_pod_runpod_api_key ?? '').trim();
    const target = () => String(settings().api_pod_ssh_target ?? '').trim();

    function stopPolling() {
        clearTimeout(pollTimer);
        pollTimer = null;
        pollsLeft = 0;
    }

    const run = async (label, task) => {
        if (busy) return null;
        busy = true;
        show(`${label}…`);
        render();
        try {
            return await task();
        } catch (error) {
            show(`${label}: ${error?.message ?? error}`);
            return null;
        } finally {
            busy = false;
            render();
            globalThis.uiShell?.pills?.refresh?.();
        }
    };

    // ---- reading the pod ------------------------------------------------
    // `dial` opens the SSH relay. Never do that on a passive refresh unless the
    // Runpod API says the pod is running: dialling a stopped pod hangs for 60 s.
    async function read({ dial = false } = {}) {
        if (!hasApi()) {
            state = { phase: 'unconfigured', status: null, probe: null, message: text('ui_pod_desktop_only', 'pod control needs the desktop app') };
            return state;
        }
        if (!target()) {
            state = { phase: 'unconfigured', status: null, probe: null, message: '' };
            return state;
        }
        let status = null;
        if (apiKey()) {
            status = await globalThis.api.runpodPodControl('status').catch(error => ({ ok: false, message: error?.message ?? String(error) }));
        }
        const desired = String(status?.ok ? status.pod?.desiredStatus ?? '' : '').toUpperCase();
        // Dial only when asked, or when the Runpod API says it is up. With open:false
        // the probe is a cheap question to an already-open relay, so it always runs.
        const shouldDial = dial || desired === 'RUNNING';
        const probe = typeof globalThis.api.podSetup === 'function'
            ? await globalThis.api.podSetup({ action: 'probe', open: shouldDial })
                .catch(error => ({ ok: false, message: error?.message ?? String(error) }))
            : null;
        const phase = resolvePhase({ target: target(), status, probe });
        const message = status && !status.ok ? `Runpod API: ${status.message}`
            : (probe && !probe.ok && !probe.idle ? probe.message ?? '' : '');
        state = { phase, status, probe: probe?.ok ? probe.probe : null, provisioning: probe?.provisioning === true, message };
        return state;
    }

    async function refresh({ dial = false, label = text('ui_pod_check', 'Check pod') } = {}) {
        return run(label, async () => {
            await read({ dial });
            show(state.message || '');
            return state;
        });
    }

    // A pod that is booting, or services that were just restarted: keep looking
    // until everything answers, then stop by itself. Bounded, and it gives up as
    // soon as the panel leaves the page.
    function settling() {
        if (state.phase === 'starting') return true;
        return state.phase === 'running' && Boolean(state.probe)
            && (state.probe.comfyUp !== true || state.probe.ollamaUp !== true);
    }

    function pollUntilSettled() {
        stopPolling();
        pollsLeft = POLL_LIMIT;
        const tick = async () => {
            pollTimer = null;
            if (pollsLeft-- <= 0 || !panel?.isConnected) return;
            if (!busy) {
                await read({ dial: true });
                render();
            }
            if (settling()) pollTimer = setTimeout(tick, POLL_MS);
        };
        pollTimer = setTimeout(tick, POLL_MS);
    }

    // ---- rendering ------------------------------------------------------
    function setChip(chip, up, label) {
        if (!chip) return;
        chip.classList.toggle('is-bad', up === false);
        chip.classList.toggle('is-off', up === null);
        const dot = chip.querySelector('i');
        if (dot) dot.style.background = up === true ? 'var(--saa-ok)' : up === false ? 'var(--saa-danger)' : 'var(--saa-muted)';
        const span = chip.querySelector('span');
        if (span) span.textContent = label;
    }

    function render() {
        if (!dom) return;
        const { phase, status, probe } = state;
        const key = apiKey();
        const pillLabels = {
            unconfigured: text('ui_pod_state_unconfigured', 'Not configured'),
            unknown: text('ui_pod_state_unknown', 'Not checked'),
            stopped: text('ui_pod_state_stopped', 'Stopped'),
            starting: text('ui_pod_state_starting', 'Starting'),
            running: text('ui_pod_state_running', 'Running'),
            unreachable: text('ui_pod_state_unreachable', 'No answer'),
        };
        dom.pillText.textContent = busy ? text('ui_pod_state_checking', 'Checking…') : pillLabels[phase];
        dom.pill.classList.toggle('is-busy', busy || phase === 'starting');
        dom.pill.classList.toggle('is-bad', !busy && phase === 'unreachable');
        dom.pill.classList.toggle('is-off', !busy && (phase === 'stopped' || phase === 'unknown' || phase === 'unconfigured'));

        // the REST reply carries $/h and uptime; without a key the probe still knows the GPU
        const facts = describePodFacts(status?.ok ? status.pod : null) || (probe?.gpu ?? '');
        dom.facts.textContent = phase === 'unconfigured'
            ? text('ui_pod_facts_unconfigured', 'add an SSH target to run generation on a pod')
            : facts || (!key ? text('ui_pod_facts_no_key', 'add a Runpod API key to start and stop it from here') : '');

        const canPower = key && hasApi();
        dom.check.hidden = busy || !(phase === 'unknown' || phase === 'unreachable');
        dom.start.hidden = busy || !canPower || !(phase === 'stopped');
        dom.stop.hidden = busy || !canPower || !(phase === 'running' || phase === 'starting');

        const showServices = phase === 'running';
        dom.services.hidden = !showServices;
        dom.servicesSep.hidden = !showServices;
        if (showServices) {
            setChip(dom.comfy, probe ? probe.comfyUp === true : null, text('ui_pod_chip_comfy', 'ComfyUI'));
            setChip(dom.ollama, probe ? probe.ollamaUp === true : null, text('ui_pod_chip_ollama', 'Ollama'));
            dom.inventory.textContent = probe ? describeInventory(probe) : text('ui_pod_services_unknown', 'services not checked');
            const broken = Boolean(probe) && (probe.comfyUp !== true || probe.ollamaUp !== true);
            dom.repair.hidden = busy || !broken || state.provisioning === true;
            dom.models.hidden = busy || !probe;
        }

        dom.setupSummary.textContent = state.provisioning
            ? text('ui_pod_wizard_already_running', 'provisioning is already running on this pod')
            : describeSetup(probe);
        dom.setup.hidden = busy;

        dom.connection.textContent = describeConnection(settings());
        dom.edit.hidden = busy;
        // an unconfigured pod opens its fields: there is nothing else to do there
        if (phase === 'unconfigured' && dom.fields.hidden && !dom.edit.dataset.touched) {
            dom.fields.hidden = false;
            dom.edit.setAttribute('aria-expanded', 'true');
        }
    }

    // ---- actions --------------------------------------------------------
    if (dom) {
        const control = action => run(action, async () => {
            const result = await globalThis.api.runpodPodControl(action);
            show(describePodResult(result));
            if (!result?.ok) return result;
            await read({ dial: action !== 'stop' && action !== 'start' });
            if (action === 'start') {
                state = { ...state, phase: 'starting' };
                pollUntilSettled();
            }
            if (action === 'stop') {
                stopPolling();
                state = { ...state, phase: 'stopped', probe: null };
            }
            return result;
        });

        dom.check.addEventListener('click', () => refresh({ dial: true }));
        dom.pill.addEventListener('click', () => refresh({ dial: state.phase !== 'stopped' }));
        dom.pill.addEventListener('keydown', event => {
            if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); refresh({ dial: state.phase !== 'stopped' }); }
        });
        dom.start.addEventListener('click', () => control('start'));
        dom.stop.addEventListener('click', () => control('stop'));
        dom.repair.addEventListener('click', () => run(text('ui_pod_repair', 'Restart services'), async () => {
            const result = await globalThis.api.podRunBootstrap();
            show(result?.ok ? `${text('ui_pod_result_bootstrap', 'restarting services, log:')} ${result.log}` : `bootstrap: ${result?.message ?? 'failed'}`);
            if (result?.ok) pollUntilSettled();
        }));
        dom.models.addEventListener('click', () => run(text('ui_pod_fetch_models', 'Refresh lists'), async () => {
            const result = await globalThis.api.updateModelListRemote({ open: true });
            if (!result?.ok) { show(`models: ${result?.message ?? 'failed'}`); return; }
            await reloadModelLists();
            const counts = Object.entries(result.counts ?? {}).map(([kind, value]) => `${kind} ${value}`).join(', ');
            show(`${text('ui_pod_result_models', 'pod models applied:')} ${counts}`);
            await read({ dial: false });
        }));
        dom.setup.addEventListener('click', () => openPodSetupWizard(dom.setup));
        dom.edit.addEventListener('click', () => {
            const open = dom.fields.hidden;
            dom.fields.hidden = !open;
            dom.edit.dataset.touched = '1';
            dom.edit.setAttribute('aria-expanded', open ? 'true' : 'false');
        });

        // the wizard changes what is on the pod, so re-read when it closes
        document.addEventListener('saa-pod-wizard-closed', () => { refresh({ dial: true, label: text('ui_pod_check', 'Check pod') }); });

        // First look happens when the panel is actually on screen: the settings
        // modal is built at startup and mostly never opened.
        if (typeof IntersectionObserver === 'function') {
            let looked = false;
            const observer = new IntersectionObserver(entries => {
                if (!entries.some(entry => entry.isIntersecting) || looked) return;
                looked = true;
                observer.disconnect();
                refresh({ dial: false });
            });
            observer.observe(panel);
        }
        render();
    }

    const llm = setupPodLlmRow({ text, run: (label, task) => run(label, task) });

    return {
        reloadModelLists,
        refresh,
        stopPolling,
        state: () => ({ ...state }),
        updateLanguage() {
            for (const node of document.querySelectorAll('.pod-panel [data-ui-text]')) {
                const value = lang()[node.dataset.uiText];
                if (typeof value === 'string' && value) node.textContent = value;
            }
            render();
            llm?.render?.();
        },
    };
}

// ---------------------------------------------------------------- LLM row
// "Pod LLM models" / "Pull model" / "Unload LLM" folded into the model row: the
// list is what the field offers, and the two actions are states of that row.
function setupPodLlmRow({ text: t, run }) {
    const row = document.querySelector('.pod-row-llm');
    const note = document.querySelector('.system-settings-ai-pod-llm-result');
    if (!row) return null;
    const chip = row.querySelector('.pod-chip-llm');
    const pull = row.querySelector('.pod-btn-llm-pull');
    const unload = row.querySelector('.pod-btn-llm-unload');
    const check = row.querySelector('.pod-btn-llm-check');
    const show = message => { if (note) note.textContent = message ?? ''; if (message) console.log(CAT, message); };
    let models = null;   // null = never asked
    let loaded = [];

    const modelName = () => String(globalThis.ai?.pod_model?.getValue?.() ?? globalThis.globalSettings?.ai_pod_model ?? '').trim();

    function render() {
        const name = modelName();
        const known = Array.isArray(models);
        const pulled = known && models.includes(name);
        const resident = loaded.includes(name);
        chip.hidden = !known || !name;
        if (!chip.hidden) {
            const dot = chip.querySelector('i');
            const label = chip.querySelector('span');
            dot.style.background = pulled ? (resident ? 'var(--saa-ok)' : 'var(--saa-muted)') : 'var(--saa-warn)';
            label.textContent = pulled
                ? (resident ? t('ui_pod_llm_loaded', 'loaded') : t('ui_pod_llm_ready', 'on the pod'))
                : t('ui_pod_llm_missing', 'not on the pod');
            chip.classList.toggle('is-warn', !pulled);
        }
        pull.hidden = !known || !name || pulled;
        unload.hidden = !resident;
        check.hidden = known;   // once the chip reports the state, clicking it re-checks
        chip.style.cursor = chip.hidden ? '' : 'pointer';
    }

    function ask() {
        return run(t('ui_pod_llm_models', 'Check models'), async () => {
            const result = await globalThis.api?.podOllama?.({ action: 'models' });
            if (!result?.ok) { models = null; loaded = []; show(`models: ${result?.message ?? 'failed'}`); render(); return; }
            models = Array.isArray(result.models) ? result.models : [];
            loaded = Array.isArray(result.loaded) ? result.loaded : [];
            show(describePodLlmModels(result, modelName(), t));
            render();
        });
    }

    check.addEventListener('click', ask);
    chip.addEventListener('click', ask);
    pull.addEventListener('click', () => run(t('ui_pod_llm_pull', 'Download'), async () => {
        const model = modelName();
        if (!model) { show(t('ui_pod_result_llm_no_model', 'set the pod Ollama model first')); return; }
        const result = await globalThis.api?.podOllama?.({ action: 'pull', model });
        if (!result?.ok) { show(`pull: ${result?.message ?? 'failed'}`); return; }
        show(`${t('ui_pod_result_llm_pulled', 'pulled:')} ${result.model}`);
        models = Array.isArray(models) ? [...new Set([...models, result.model])] : [result.model];
        render();
    }));
    unload.addEventListener('click', () => run(t('ui_pod_llm_unload', 'Unload'), async () => {
        const result = await globalThis.api?.podOllama?.({ action: 'unload' });
        if (!result?.ok) { show(`unload: ${result?.message ?? 'failed'}`); return; }
        show(result.unloaded?.length
            ? `${t('ui_pod_result_llm_unloaded', 'unloaded:')} ${result.unloaded.join(', ')}`
            : t('ui_pod_result_llm_nothing_loaded', 'nothing loaded'));
        loaded = [];
        render();
    }));

    render();
    return { render };
}

// "pulled: a, b · loaded: a · current model missing" for the note line.
export function describePodLlmModels(result, currentModel = '', t = text) {
    if (!result?.ok) return `models: ${result?.message ?? 'failed'}`;
    const models = Array.isArray(result.models) ? result.models : [];
    const loaded = Array.isArray(result.loaded) ? result.loaded : [];
    const parts = [`${t('ui_pod_result_llm_models', 'pulled:')} ${models.length ? models.join(', ') : '-'}`];
    if (loaded.length) parts.push(`${t('ui_pod_result_llm_loaded', 'loaded:')} ${loaded.join(', ')}`);
    const wanted = String(currentModel ?? '').trim();
    if (wanted && !models.includes(wanted)) parts.push(`${t('ui_pod_result_llm_missing', 'not on the pod:')} ${wanted}`);
    return parts.join(' · ');
}
