// Pod start / stop / status from the app (issue #4) and the post-start bootstrap.
// Everything lifecycle-related goes through scripts/shared/runpodApi.js, which
// only knows status / start / stop: terminate is not reachable from the app.
import { podAction, resolvePodId } from '../shared/runpodApi.js';
import { podOllamaModels, podOllamaPull, podOllamaUnload, podRunBootstrap, stopPodSshSession } from './podSshTransport.js';

// The pod's LLM (Ollama) management: 'models' lists what is pulled / loaded,
// 'pull' downloads a model into /workspace/ollama/models, 'unload' frees the VRAM.
export async function controlPodOllama(settings, { action, model = '' } = {}) {
    switch (String(action ?? '')) {
        case 'models': return { action, ...await podOllamaModels({ settings, open: true }) };
        case 'pull': return { action, ...await podOllamaPull({ settings, model }) };
        case 'unload': return { action, ...await podOllamaUnload({ settings, open: true }) };
        default: return { ok: false, action, message: `unknown pod LLM action: ${action}` };
    }
}

const CAT = '[RunpodControl]';

export async function controlPod(settings, action) {
    const podId = resolvePodId(settings);
    if (!podId) return { ok: false, action, message: 'pod id unknown: set the SSH target (podid-user@ssh.runpod.io) or the Runpod pod id' };
    const result = await podAction({ apiKey: settings.api_pod_runpod_api_key, podId, action });
    console.log(CAT, action, podId, result.ok ? (result.pod?.desiredStatus ?? 'ok') : result.message);
    // a stopped pod takes the relay's shell with it; drop the session so the next run reconnects cleanly
    if (result.ok && action === 'stop') stopPodSshSession();
    return { ...result, podId };
}

export function registerRunpodControl(ipcMain, getSettings) {
    ipcMain.handle('runpod-pod-control', async (event, action) => {
        try {
            return await controlPod(getSettings(), String(action ?? ''));
        } catch (error) {
            return { ok: false, action, message: error?.message ?? String(error) };
        }
    });
    ipcMain.handle('pod-ollama', async (event, args) => {
        try {
            return await controlPodOllama(getSettings(), args ?? {});
        } catch (error) {
            return { ok: false, action: args?.action, message: error?.message ?? String(error) };
        }
    });
    ipcMain.handle('pod-run-bootstrap', async () => {
        try {
            return await podRunBootstrap({ settings: getSettings() });
        } catch (error) {
            return { ok: false, message: error?.message ?? String(error) };
        }
    });
}
