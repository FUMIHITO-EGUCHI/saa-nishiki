// Remote ComfyUI model lists (issue #8): ask the backend that will actually run
// the workflow which checkpoints / LoRAs / VAEs ... it can see, via /object_info,
// and hand them to modelList.js in place of the local folder scan.
//
// Two remote shapes: the Runpod pod behind the SSH relay (object_info relay cmd),
// or an HTTPS ComfyUI address (GET only, same origin rule as the status probe).
// Loopback ComfyUI keeps the local scan: the folders are on this machine.
import { net } from 'electron';
import { backendAuthHeaders } from '../shared/backendAddress.js';
import { REMOTE_MODEL_NODE_NAMES, countLists, extractModelLists } from '../shared/remoteModelInfo.js';
import { loopbackOrigin, probeOrigin } from './backendStatus.js';
import { applyRemoteModelLists } from './modelList.js';
import { isPodSshEnabled, podObjectInfo } from './podSshTransport.js';

const CAT = '[RemoteModelList]';

function getJson(url, { timeout = 8000, headers = {} } = {}) {
    return new Promise(resolve => {
        let settled = false;
        const finish = value => { if (!settled) { settled = true; clearTimeout(timer); resolve(value); } };
        let req;
        const timer = setTimeout(() => { try { req?.abort(); } catch { /* ignore */ } finish({ ok: false, error: 'timeout' }); }, timeout);
        try {
            req = net.request({ method: 'GET', url, headers });
        } catch (error) {
            finish({ ok: false, error: error?.message ?? String(error) });
            return;
        }
        req.on('response', response => {
            const chunks = [];
            response.on('data', chunk => chunks.push(chunk));
            response.on('end', () => {
                if (response.statusCode !== 200) { finish({ ok: false, error: `HTTP ${response.statusCode}` }); return; }
                try { finish({ ok: true, data: JSON.parse(Buffer.concat(chunks).toString('utf8')) }); } catch (error) { finish({ ok: false, error: error.message }); }
            });
            response.on('error', error => finish({ ok: false, error: error.message }));
        });
        req.on('error', error => finish({ ok: false, error: error.message }));
        req.end();
    });
}

// Where the remote lists come from, or null when the local scan is right.
export function remoteModelSource(settings) {
    if (settings?.api_interface !== 'ComfyUI') return null;
    if (isPodSshEnabled(settings)) return 'pod';
    const address = String(settings.api_addr ?? '').trim();
    if (!address || loopbackOrigin(address)) return null;
    return probeOrigin(address) ? 'https' : null;
}

async function fetchObjectInfo(settings, { open }) {
    const source = remoteModelSource(settings);
    if (!source) return { ok: false, source: null, message: 'local ComfyUI: folder scan is used' };
    if (source === 'pod') {
        const reply = await podObjectInfo({ settings, nodes: REMOTE_MODEL_NODE_NAMES, open });
        return { ...reply, source };
    }
    const origin = probeOrigin(settings.api_addr);
    const auth = settings.webui_auth_enable === 'ON' ? String(settings.webui_auth ?? '').trim() : '';
    const headers = backendAuthHeaders(auth);
    const info = {};
    const errors = {};
    for (const node of REMOTE_MODEL_NODE_NAMES) {
        const reply = await getJson(`${origin}/object_info/${node}`, { headers });
        if (reply.ok) info[node] = reply.data;
        else { info[node] = null; errors[node] = reply.error; }
    }
    if (Object.keys(errors).length === REMOTE_MODEL_NODE_NAMES.length) {
        return { ok: false, source, message: `ComfyUI at ${origin} did not answer: ${errors[REMOTE_MODEL_NODE_NAMES[0]]}` };
    }
    return { ok: true, source, info, errors };
}

/**
 * Fetch and apply. Resolves to { ok, source, applied, counts, message }; never rejects.
 * open:false never dials the pod (a settings refresh while the relay is idle just
 * keeps the local lists); open:true is the explicit "fetch pod models" action.
 */
export async function refreshRemoteModelLists(settings, { open = false } = {}) {
    try {
        const reply = await fetchObjectInfo(settings, { open });
        if (!reply.ok) return { ok: false, source: reply.source, applied: [], counts: {}, message: reply.message };
        const lists = extractModelLists(reply.info);
        const applied = applyRemoteModelLists(lists, settings);
        const counts = countLists(lists);
        console.log(CAT, `${reply.source} lists applied:`, JSON.stringify(counts));
        return { ok: true, source: reply.source, applied, counts, message: '' };
    } catch (error) {
        console.warn(CAT, 'refresh failed:', error?.message ?? error);
        return { ok: false, source: null, applied: [], counts: {}, message: error?.message ?? String(error) };
    }
}

export function registerRemoteModelList(ipcMain, getSettings) {
    ipcMain.handle('update-model-list-remote', async (event, args) => {
        return refreshRemoteModelLists(getSettings(), { open: args?.open === true });
    });
}
