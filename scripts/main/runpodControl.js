// Pod start / stop / status from the app (issue #4) and the post-start bootstrap.
// Everything lifecycle-related goes through scripts/shared/runpodApi.js, which
// only knows status / start / stop: terminate is not reachable from the app.
import { podAction, resolvePodId } from '../shared/runpodApi.js';
import { podRunBootstrap, stopPodSshSession } from './podSshTransport.js';

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
    ipcMain.handle('pod-run-bootstrap', async () => {
        try {
            return await podRunBootstrap({ settings: getSettings() });
        } catch (error) {
            return { ok: false, message: error?.message ?? String(error) };
        }
    });
}
