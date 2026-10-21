import { randomUUID } from 'node:crypto';
import { WebSocket } from 'ws';
import { backendAuthHeaders, httpApiUrl, wsApiUrl } from '../shared/backendAddress.js';
import { describeWorkflow } from '../shared/workflowRecord.js';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

// One connection and one immutable prompt per run. The socket is attached before
// submission; history remains authoritative when events are lost or cached.
export async function startWorkflowExecution({ addr, auth = '', workflow, requested = {}, transforms = [], outputNode = '29',
    stages = [], store, onProgress = () => {}, onPreview = () => {}, timeoutMs = 20 * 60_000,
    cancellation = { cancelled: false } }) {
    const clientId = randomUUID();
    const record = store.create('runs', { requested, transforms, submitted: false, status: 'preparing',
        apiPrompt: workflow, provenance: describeWorkflow(workflow, outputNode), events: [], stages: [],
        timing: { basis: 'client wall clock; per-stage durations not measured' } });
    const save = () => store.write('runs', record);
    let cancellationPromise;
    let remoteError = '';
    let promptId;
    const pending = [];
    const headers = backendAuthHeaders(auth);
    const request = async (pathname, body) => {
        const response = await fetch(httpApiUrl(addr, pathname), {
            headers: { ...headers, ...(body ? { 'Content-Type': 'application/json' } : {}) },
            method: body ? 'POST' : 'GET', body: body ? JSON.stringify(body) : undefined,
            signal: AbortSignal.timeout(30_000),
        });
        if (!response.ok) throw new Error(`ComfyUI HTTP ${response.status}: ${(await response.text()).slice(0, 1000)}`);
        return response;
    };
    const cancelRemote = () => {
        if (!promptId) return Promise.resolve();
        // The server atomically cancels this job only. A queue snapshot followed
        // by global /interrupt can accidentally interrupt the following job.
        cancellationPromise ??= request(`api/jobs/${encodeURIComponent(promptId)}/cancel`, {})
            .then(async response => {
                const reply=await response.json();
                record.cancellationAcknowledged = true;
                record.remoteCancellationDispatched = reply.cancelled === true;
            });
        return cancellationPromise;
    };
    const cancel = () => { cancellation.cancelled = true; return cancelRemote(); };
    const checkCancelled = async () => {
        if (!cancellation.cancelled) return;
        await cancel();
        throw new Error('Cancelled');
    };
    const event = message => {
        const { type, data = {} } = message;
        if (data.prompt_id && data.prompt_id !== promptId) return;
        if (type === 'progress') { onProgress(data.value, data.max); return; }
        if (!['execution_start', 'execution_cached', 'executing', 'executed', 'execution_success', 'execution_error', 'execution_interrupted'].includes(type)) return;
        if (record.events.length < 5000) record.events.push({ type, node: data.node ?? data.node_id ?? null,
            nodes: data.nodes, at: new Date().toISOString() });
        if (type === 'execution_cached') for (const id of data.nodes ?? []) {
            if (record.provenance.nodes[id]) record.provenance.nodes[id].state = 'cached';
        }
        if (type === 'executing' && data.node && record.provenance.nodes[data.node]) record.provenance.nodes[data.node].state = 'execution-observed';
        if (type === 'executed' && record.provenance.nodes[data.node]) record.provenance.nodes[data.node].state = 'observed-completed';
        if (type === 'execution_error') remoteError = String(data.exception_message ?? 'ComfyUI execution failed').slice(0, 2000);
        if (type === 'execution_interrupted') cancellation.cancelled = true;
    };
    const socket = new WebSocket(wsApiUrl(addr, `ws?clientId=${clientId}`), { headers });
    socket.on('message', (bytes, binary) => {
        if (binary) { if (bytes.length > 8) onPreview(bytes.subarray(8)); return; }
        try {
            const message = JSON.parse(bytes.toString());
            if (promptId) event(message);
            else if (pending.length < 1000) pending.push(message);
        } catch { /* malformed notification: history will still be checked */ }
    });
    socket.on('error', () => { /* connection failure handled below; later loss uses history */ });
    try {
        await new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('ComfyUI websocket connection timed out')), 10_000);
            socket.once('open', () => { clearTimeout(timer); resolve(); });
            socket.once('error', error => { clearTimeout(timer); reject(error); });
        });
        await checkCancelled();
        record.status = 'submitting';
        record.submissionAttemptedAt = new Date().toISOString();
        save();
        const response = await (await request('prompt', { prompt: workflow, client_id: clientId })).json();
        if (!response.prompt_id) throw new Error('ComfyUI did not return a prompt ID');
        promptId = record.promptId = response.prompt_id;
        record.submitted = true;
        record.status = 'running';
        record.startedAt = new Date().toISOString();
        pending.splice(0).forEach(event);
        save();
    } catch (error) {
        if (promptId) await cancelRemote().catch(() => {});
        record.status = cancellation.cancelled ? 'cancelled' : 'failed'; record.error = error.message; record.finishedAt = new Date().toISOString();
        try { save(); } finally { socket.terminate(); }
        throw error;
    }
    const result = (async () => {
        const deadline = Date.now() + timeoutMs;
        try {
            while (Date.now() < deadline) {
                await checkCancelled();
                if (remoteError) throw new Error(remoteError);
                let history;
                try {
                    history = (await (await request(`history/${encodeURIComponent(promptId)}`)).json())[promptId];
                } catch (error) {
                    // Model loading/detailing can temporarily stall the HTTP
                    // event loop. Losing one poll is not a failed generation.
                    if (!['TimeoutError','AbortError','TypeError'].includes(error.name)) throw error;
                    if (record.events.length < 5000) record.events.push({type:'history-retry',at:new Date().toISOString(),error:error.message});
                    await pause(750);
                    continue;
                }
                if (history) {
                    for (const [type, data] of history.status?.messages ?? []) event({ type, data });
                    if (remoteError) throw new Error(remoteError);
                    await checkCancelled();
                    if (history.status?.status_str === 'error') throw new Error('ComfyUI execution failed');
                    if (history.status?.completed || history.outputs?.[outputNode]?.images?.length) {
                        const info = history.outputs?.[outputNode]?.images?.[0];
                        if (!info) throw new Error('Selected output contains no image');
                        const getImage = async metadata => Buffer.from(await (await request(`view?${new URLSearchParams(metadata)}`)).arrayBuffer());
                        const image = await getImage(info);
                        await checkCancelled();
                        store.putImage('runs', record.id, 'final.png', image);
                        record.output = { node: outputNode, imageSlot: 'images', batchIndex: 0, ...info, asset: 'final.png' };
                        for (const stage of stages) {
                            const stageInfo = history.outputs?.[stage.node]?.images?.[0];
                            if (!stageInfo) { record.stages.push({ ...stage, state: 'unavailable' }); continue; }
                            try {
                                const asset = `stage-${stage.source}.png`;
                                store.putImage('runs', record.id, asset, await getImage(stageInfo));
                                record.stages.push({ ...stage, state: 'available', asset, backendOutput: stageInfo });
                            } catch (error) { record.stages.push({ ...stage, state: 'unavailable', error: error.message }); }
                        }
                        await checkCancelled();
                        record.status = 'succeeded';
                        return { image, record };
                    }
                }
                await pause(750);
            }
            await cancelRemote();
            throw new Error('ComfyUI run timed out; cancellation acknowledged');
        } catch (error) {
            const userCancelled=cancellation.cancelled;
            if(!record.cancellationAcknowledged)await cancelRemote().catch(cancelError=>{record.cancellationError=cancelError.message;});
            if (cancellationPromise) await cancellationPromise.catch(() => {});
            record.status = userCancelled && record.cancellationAcknowledged ? 'cancelled' : 'failed';
            record.error = error.message;
            throw error;
        } finally {
            record.finishedAt = new Date().toISOString();
            try { save(); } finally { socket.close(); }
        }
    })();
    result.catch(() => {}); // the UI may attach its result listener after submission
    return { promptId, runId: record.id, result, cancel };
}
