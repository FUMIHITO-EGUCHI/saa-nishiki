// Pod controls in the backend settings (issue #4 / #8): Runpod status / start /
// stop through the REST API, the post-start bootstrap, and "fetch pod models".
// Results land in the note line under the buttons; nothing here can terminate.
import { setupButtons } from './components/myButtons.js';
import { reloadModelLists } from './components/myCollapsed.js';

const CAT = '[PodControl]';
const BUTTON = { width: 'auto', height: '30px', defaultColor: '#3a3f4a', hoverColor: '#4a5160' };
const BUTTON_STOP = { ...BUTTON, defaultColor: '#7a3b3b', hoverColor: '#94494a' };

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

export function setupPodControls() {
    const note = document.querySelector('.system-settings-api-pod-result');
    const show = message => { if (note) note.textContent = message; console.log(CAT, message); };
    let busy = false;
    const run = async (label, task) => {
        if (busy) return;
        busy = true;
        show(`${label}…`);
        try {
            show(await task());
        } catch (error) {
            show(`${label}: ${error?.message ?? error}`);
        } finally {
            busy = false;
            globalThis.uiShell?.pills?.refresh?.();
        }
    };
    const control = action => run(action, async () => describePodResult(await globalThis.api.runpodPodControl(action)));

    const buttons = {
        status: setupButtons('system-settings-api-pod-status', text('ui_pod_status', 'Pod status'), BUTTON, () => control('status')),
        start: setupButtons('system-settings-api-pod-start', text('ui_pod_start', 'Start pod'), BUTTON, () => control('start')),
        stop: setupButtons('system-settings-api-pod-stop', text('ui_pod_stop', 'Stop pod'), BUTTON_STOP, () => control('stop')),
        bootstrap: setupButtons('system-settings-api-pod-bootstrap', text('ui_pod_bootstrap', 'Run bootstrap'), BUTTON, () => run('bootstrap', async () => {
            const result = await globalThis.api.podRunBootstrap();
            return result?.ok ? `${text('ui_pod_result_bootstrap', 'bootstrap started, log:')} ${result.log}` : `bootstrap: ${result?.message ?? 'failed'}`;
        })),
        fetchModels: setupButtons('system-settings-api-pod-fetch-models', text('ui_pod_fetch_models', 'Fetch pod models'), BUTTON, () => run('models', async () => {
            const result = await globalThis.api.updateModelListRemote({ open: true });
            if (!result?.ok) return `models: ${result?.message ?? 'failed'}`;
            // re-read every list (remote included, now that the relay is open) and redraw the dropdowns
            await reloadModelLists();
            const counts = Object.entries(result.counts ?? {}).map(([key, count]) => `${key} ${count}`).join(', ');
            return `${text('ui_pod_result_models', 'pod models applied:')} ${counts}`;
        })),
    };

    return {
        buttons,
        reloadModelLists,
        updateLanguage() {
            const labels = {
                status: text('ui_pod_status', 'Pod status'),
                start: text('ui_pod_start', 'Start pod'),
                stop: text('ui_pod_stop', 'Stop pod'),
                bootstrap: text('ui_pod_bootstrap', 'Run bootstrap'),
                fetchModels: text('ui_pod_fetch_models', 'Fetch pod models'),
            };
            for (const [key, button] of Object.entries(buttons)) {
                button?.setTitle?.(labels[key]);
            }
        },
    };
}
