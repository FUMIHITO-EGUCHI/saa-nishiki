// SSH transport to a Runpod pod's ComfyUI (see scripts/pod/comfy_ws_relay.py).
//
// Runpod's basic SSH proxy forbids port forwarding and forces a PTY, so instead of
// tunneling, a relay script is deployed to the pod's RAM (/dev/shm) and driven over
// stdin/stdout: `stty raw -echo` first (raw mode lifts the 4 KB canonical line
// limit that would truncate workflow JSON on stdin and stops the PTY echoing it
// back), then the relay is written via base64 and exec'd. Frames from the relay are
// prefixed with @@SAA@@; everything else on the wire (MOTD, escape noise) is
// ignored. Images arrive as base64 events and exist only in pod RAM.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseOllamaLoaded, parseOllamaTags, pullRequest, unloadRequest } from '../shared/ollamaModels.js';

const CAT = '[PodSSH]';
const SENTINEL = '@@SAA@@';
const RELAY_PATH = fileURLToPath(new URL('../pod/comfy_ws_relay.py', import.meta.url));

// Pure line/frame extractor: feed raw chunks, get parsed relay frames back.
// PTY output may interleave \r; frames are newline-delimited JSON after SENTINEL.
export function makeFrameParser(onFrame) {
    let buffer = '';
    return chunk => {
        buffer += chunk.toString('utf8').replaceAll('\r', '');
        let index;
        while ((index = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, index);
            buffer = buffer.slice(index + 1);
            const start = line.indexOf(SENTINEL);
            if (start < 0) continue;
            try {
                onFrame(JSON.parse(line.slice(start + SENTINEL.length)));
            } catch {
                // partial or mangled frame: drop it, the protocol has per-request acks
            }
        }
    };
}

// Runpod's basic proxy ignores an exec command and always drops into an
// interactive shell, so the ssh args carry no remote command; the bootstrap is
// typed into the shell over stdin instead (buildBootstrapCommand).
export function buildSshArgs({ target, keyPath }) {
    const key = String(keyPath ?? '').trim() || path.join(os.homedir(), '.ssh', 'id_ed25519');
    return [
        '-tt',
        '-o', 'BatchMode=yes',
        '-o', 'IdentitiesOnly=yes',
        '-o', 'StrictHostKeyChecking=accept-new',
        '-o', 'ConnectTimeout=20',
        '-o', 'ServerAliveInterval=30',
        '-i', key,
        String(target ?? '').trim(),
    ];
}

// The PTY starts in canonical mode, whose per-line input limit (MAX_CANON, 4 KB)
// would truncate both a single-line deploy and later multi-KB workflow JSON. So:
// echo off first, then the relay as a heredoc of short base64 lines, and `stty raw`
// only right before exec'ing the relay — raw mode persists across exec, lifting the
// line limit for the protocol while python owns the tty.
export function buildBootstrapCommand({ comfyPort = 8188, relaySource }) {
    const encoded = Buffer.from(relaySource, 'utf8').toString('base64');
    const wrapped = encoded.match(/.{1,76}/g).join('\n');
    return [
        "base64 -d > /dev/shm/saa_relay.py <<'SAA_EOF'",
        wrapped,
        'SAA_EOF',
        `stty raw 2>/dev/null; exec python3 -u /dev/shm/saa_relay.py --port ${Number(comfyPort) || 8188}`,
        '',
    ].join('\n');
}

class PodSshSession {
    constructor() {
        this.child = null;
        this.ready = null;
        this.isReady = false;       // relay printed its 'ready' frame and still answers
        this.requestId = 0;
        this.pending = new Map();   // request id -> resolve
        this.job = null;            // the single in-flight generation
        this.config = null;
    }

    configChanged(config, relaySource) {
        return !this.config
            || this.config.target !== config.target
            || this.config.keyPath !== config.keyPath
            || this.config.comfyPort !== config.comfyPort
            || this.config.relaySource !== relaySource; // redeploy an updated relay
    }

    async ensureStarted(config) {
        const relaySource = fs.readFileSync(RELAY_PATH, 'utf8');
        if (this.child && !this.configChanged(config, relaySource)) return this.ready;
        this.stop();
        this.isReady = false;
        this.config = { ...config, relaySource };
        const args = buildSshArgs(config);
        console.log(CAT, 'starting ssh relay to', config.target);
        const child = spawn('ssh', args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
        this.child = child;
        // echo off first (so the deploy is not echoed back), then the staged
        // bootstrap once the remote shell shows signs of life
        try { child.stdin.write('stty -echo 2>/dev/null\n'); } catch { /* spawn failure lands on 'error' */ }
        let bootstrapped = false;
        const bootstrap = () => {
            if (bootstrapped || this.child !== child) return;
            bootstrapped = true;
            try { child.stdin.write(buildBootstrapCommand({ comfyPort: config.comfyPort, relaySource })); } catch { /* dying; 'close' reports it */ }
        };
        child.stdout.once('data', () => setTimeout(bootstrap, 750));
        setTimeout(bootstrap, 8000); // fallback if the shell never prints a banner

        this.ready = new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                reject(new Error('relay start timed out (60 s)'));
                // a hung ssh would otherwise keep this.child set and pin the
                // rejected promise as the cached answer for every later run
                try { child.kill(); } catch { /* gone */ }
            }, 60_000);
            this.onReady = () => { clearTimeout(timer); resolve(); };
            this.onFatal = message => { clearTimeout(timer); reject(new Error(message)); };
        });

        const parse = makeFrameParser(frame => this.handleFrame(frame));
        child.stdout.on('data', parse);
        // ssh's own diagnostics (auth refused, "Connection closed", the Runpod proxy's
        // stopped-pod notice) only ever appear on stderr; keep the tail so a failure
        // reason reaches the user instead of a bare exit code.
        let lastStderr = '';
        child.stderr.on('data', data => {
            const text = data.toString('utf8').trim();
            if (!text) return;
            console.warn(CAT, 'ssh:', text.slice(0, 500));
            const lines = text.split('\n').map(line => line.trim()).filter(Boolean);
            if (lines.length) lastStderr = lines.at(-1).slice(0, 200);
        });
        const die = why => {
            const reason = lastStderr ? `${why}: ${lastStderr}` : why;
            console.warn(CAT, 'session ended:', reason);
            this.isReady = false;
            this.onFatal?.(reason);
            this.job?.fail(`Error: pod SSH session ended: ${reason}`);
            for (const resolve of this.pending.values()) resolve({ ok: false, message: reason });
            this.pending.clear();
            if (this.child === child) this.child = null;
        };
        child.on('error', error => die(error.message));
        child.on('close', code => die(`ssh exited (${code})`));
        return this.ready;
    }

    handleFrame(frame) {
        if (frame.event === 'ready') {
            console.log(CAT, 'relay ready (client', frame.clientId, ')');
            this.isReady = true;
            this.onReady?.();
            return;
        }
        if (frame.event === 'fatal') {
            this.onFatal?.(frame.message);
            return;
        }
        if (frame.id !== undefined && this.pending.has(frame.id)) {
            this.pending.get(frame.id)(frame);
            this.pending.delete(frame.id);
            return;
        }
        this.job?.handleEvent(frame);
    }

    request(payload, timeoutMs = 30_000) {
        const child = this.child;
        if (!child || child.killed || !child.stdin?.writable) {
            return Promise.resolve({ ok: false, message: 'pod SSH session is not connected' });
        }
        const id = ++this.requestId;
        return new Promise(resolve => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                resolve({ ok: false, message: 'request timed out' });
            }, timeoutMs);
            this.pending.set(id, frame => { clearTimeout(timer); resolve(frame); });
            try {
                child.stdin.write(`${JSON.stringify({ id, ...payload })}\n`);
            } catch (error) {
                clearTimeout(timer);
                this.pending.delete(id);
                resolve({ ok: false, message: `write failed: ${error.message}` });
            }
        });
    }

    stop() {
        const child = this.child;
        this.child = null;
        this.isReady = false;
        this.job?.fail('Error: pod SSH session stopped');
        this.job = null;
        if (!child) return;
        try { child.stdin.write(`${JSON.stringify({ id: ++this.requestId, cmd: 'exit' })}\n`); } catch { /* gone */ }
        setTimeout(() => { try { child.kill(); } catch { /* gone */ } }, 500);
    }
}

class PodJob {
    constructor({ onProgress, onPreview, timeoutMs }) {
        this.onProgress = onProgress;
        this.onPreview = onPreview;
        this.images = [];
        this.promptId = null;
        this.settled = false;
        this.timeoutMs = timeoutMs;
        this.promise = new Promise(resolve => { this.resolve = resolve; });
        this.touch();
    }

    touch() {
        clearTimeout(this.timer);
        this.timer = setTimeout(() => this.fail(`Error: pod generation timed out after ${this.timeoutMs}ms`), this.timeoutMs);
    }

    handleEvent(frame) {
        if (this.settled) return;
        this.touch();
        if (frame.event === 'queued') this.promptId = frame.promptId;
        else if (frame.event === 'progress') this.onProgress?.(frame.value, frame.max);
        else if (frame.event === 'preview') this.onPreview?.(Buffer.from(frame.data, 'base64'));
        else if (frame.event === 'image') this.images.push(Buffer.from(frame.data, 'base64'));
        else if (frame.event === 'error') this.fail(`Error: ${frame.message}`);
        else if (frame.event === 'done') {
            if (this.images.length === 0) this.fail('Error: pod run finished without an image');
            else this.finish({ images: this.images, promptId: this.promptId });
        }
    }

    finish(value) {
        if (this.settled) return;
        this.settled = true;
        clearTimeout(this.timer);
        this.resolve(value);
    }

    fail(message) {
        this.finish({ error: message });
    }
}

const session = new PodSshSession();

export function podSshConfig(settings = {}) {
    return {
        enabled: settings.api_pod_ssh_enable === true,
        target: String(settings.api_pod_ssh_target ?? '').trim(),
        keyPath: String(settings.api_pod_ssh_key ?? '').trim(),
        comfyPort: Number(settings.api_pod_ssh_comfy_port) || 8188,
    };
}

export function isPodSshEnabled(settings) {
    const config = podSshConfig(settings);
    return config.enabled && config.target !== '';
}

/**
 * Run one workflow on the pod. Resolves to { images: Buffer[], promptId } or
 * { error: 'Error: ...' } — never rejects, matching the backend's error-string style.
 */
export async function runPodWorkflow({ settings, workflow, saveNodes, onProgress, onPreview, timeoutMs = 600_000 }) {
    const config = podSshConfig(settings);
    if (!config.enabled || !config.target) return { error: 'Error: pod SSH transport is not configured' };
    try {
        await session.ensureStarted(config);
    } catch (error) {
        session.stop(); // drop the half-open session so the next run reconnects instead of replaying this rejection
        const hint = /exited|timed out|refused|closed|reset/i.test(error.message) ? ' — is the pod running?' : '';
        return { error: `Error: pod SSH connect failed: ${error.message}${hint}` };
    }
    if (session.job && !session.job.settled) return { error: 'Error: pod SSH transport is busy' };
    // On a 12 GB pod the LLM and the SDXL checkpoint do not fit together: hand
    // the VRAM to ComfyUI before the workflow starts (a no-op when nothing is loaded).
    await unloadLoadedPodModels();

    const job = new PodJob({ onProgress, onPreview, timeoutMs });
    session.job = job;
    const ack = await session.request({ cmd: 'submit', workflow, saveNodes });
    console.log(CAT, 'submit ack:', JSON.stringify(ack).slice(0, 200));
    if (!ack.ok) {
        job.fail(`Error: pod submit failed: ${ack.message ?? 'no ack'}`);
    }
    const result = await job.promise;
    console.log(CAT, 'job finished:', result.error ?? `${result.images?.length} image(s), prompt ${result.promptId}`);
    if (session.job === job) session.job = null;
    return result;
}

// One Ollama call on the pod through the relay: { ok, status, json } or
// { ok: false, message }. Opens the SSH session when needed (like a generation);
// the relay talks to 127.0.0.1:11434 only.
export async function podOllamaRequest({ settings, method = 'POST', path = '/api/chat', body = null, timeoutMs = 300_000 }) {
    const config = podSshConfig(settings);
    if (!config.enabled || !config.target) return { ok: false, message: 'pod SSH transport is not configured' };
    try {
        await session.ensureStarted(config);
    } catch (error) {
        session.stop();
        return { ok: false, message: `pod SSH connect failed: ${error.message}` };
    }
    const reply = await session.request({ cmd: 'ollama', method, path, body, timeout: Math.ceil(timeoutMs / 1000) }, timeoutMs + 5000);
    if (!reply.ok) return { ok: false, status: reply.status, message: reply.message ?? 'pod ollama request failed' };
    return { ok: true, status: reply.status, json: reply.json };
}

export async function interruptPodWorkflow() {
    if (!session.child) return;
    await session.request({ cmd: 'interrupt' });
}

export function stopPodSshSession() {
    session.stop();
}

// Status for the header pill: never opens a connection, only reports the existing one.
export function podSessionState() {
    if (!session.child) return 'off';
    return session.isReady ? 'connected' : 'connecting';
}

// ComfyUI /system_stats fetched through the already-open relay (or null). An older
// deployed relay answers unknown cmds with ok:false, which also lands on null.
export async function podSessionStats() {
    return (await podComfyHealth()).stats;
}

// Relay alive vs ComfyUI answering (issue #9): { ok, stats, message } through the
// already-open relay; ok:false with a message when ComfyUI on the pod is down.
// Never opens a connection.
export async function podComfyHealth() {
    if (podSessionState() !== 'connected') return { ok: false, stats: null, message: 'pod relay not connected' };
    const reply = await session.request({ cmd: 'stats' }, 5000);
    if (!reply.ok) return { ok: false, stats: null, message: reply.message ?? 'ComfyUI on the pod did not answer' };
    return { ok: true, stats: reply.stats ?? null, message: '' };
}

async function openSession(settings) {
    const config = podSshConfig(settings);
    if (!config.enabled || !config.target) return 'pod SSH transport is not configured';
    try {
        await session.ensureStarted(config);
        return '';
    } catch (error) {
        session.stop();
        return `pod SSH connect failed: ${error.message}`;
    }
}

// Best effort, through the already-open relay only: unload every model Ollama
// holds in VRAM. Silent when Ollama is down or nothing is loaded.
async function unloadLoadedPodModels() {
    if (podSessionState() !== 'connected') return [];
    try {
        const ps = await session.request({ cmd: 'ollama', method: 'GET', path: '/api/ps', body: null, timeout: 5 }, 8000);
        if (!ps.ok) return [];
        const loaded = parseOllamaLoaded(ps.json);
        for (const model of loaded) {
            const unload = unloadRequest(model);
            await session.request({ cmd: 'ollama', ...unload, timeout: 20 }, 25_000);
        }
        if (loaded.length) console.log(CAT, 'unloaded pod LLM:', loaded.join(', '));
        return loaded;
    } catch (error) {
        console.log(CAT, 'pod LLM unload skipped:', error?.message ?? error);
        return [];
    }
}

// The Ollama models on the pod (/api/tags): { ok, models, loaded } or { ok: false, message }.
// open:false only asks an already-open relay; open:true dials the pod.
export async function podOllamaModels({ settings, open = false }) {
    if (open) {
        const failure = await openSession(settings);
        if (failure) return { ok: false, message: failure };
    } else if (podSessionState() !== 'connected') {
        return { ok: false, message: 'pod relay not connected' };
    }
    const tags = await podOllamaRequest({ settings, method: 'GET', path: '/api/tags', timeoutMs: 10_000 });
    if (!tags.ok) return { ok: false, message: tags.message };
    const ps = await podOllamaRequest({ settings, method: 'GET', path: '/api/ps', timeoutMs: 10_000 });
    return { ok: true, models: parseOllamaTags(tags.json), loaded: ps.ok ? parseOllamaLoaded(ps.json) : [] };
}

// Pull a model into /workspace/ollama/models on the pod. The relay call stays
// open for the whole download (stream:false), so the timeout is generous.
export async function podOllamaPull({ settings, model, timeoutMs = 45 * 60_000 }) {
    let request;
    try {
        request = pullRequest(model);
    } catch (error) {
        return { ok: false, message: error.message };
    }
    const reply = await podOllamaRequest({ settings, ...request, timeoutMs });
    if (!reply.ok) return { ok: false, message: reply.message };
    const status = String(reply.json?.status ?? '');
    return status && status !== 'success'
        ? { ok: false, message: `pull ${request.body.model}: ${status}` }
        : { ok: true, model: request.body.model };
}

// Unload the pod's LLM so the GPU is free for image generation: { ok, unloaded }.
export async function podOllamaUnload({ settings, open = false }) {
    if (open) {
        const failure = await openSession(settings);
        if (failure) return { ok: false, message: failure };
    } else if (podSessionState() !== 'connected') {
        return { ok: false, message: 'pod relay not connected' };
    }
    return { ok: true, unloaded: await unloadLoadedPodModels() };
}

// /object_info for the loader nodes (issue #8): { ok, info: { node: payload|null }, errors }.
// open:false only asks an already-open relay (a settings refresh must not dial the pod);
// open:true connects like a generation does (the explicit "fetch pod models" button).
export async function podObjectInfo({ settings, nodes, open = false, timeoutMs = 20_000 }) {
    if (open) {
        const failure = await openSession(settings);
        if (failure) return { ok: false, message: failure };
    } else if (podSessionState() !== 'connected') {
        return { ok: false, message: 'pod relay not connected' };
    }
    const reply = await session.request({ cmd: 'object_info', nodes }, timeoutMs);
    if (!reply.ok) return { ok: false, message: reply.message ?? 'object_info failed' };
    return { ok: true, info: reply.info ?? {}, errors: reply.errors ?? {} };
}

// Run /workspace/saa/bootstrap.sh on the pod (after a START): { ok, log | message }.
export async function podRunBootstrap({ settings }) {
    const failure = await openSession(settings);
    if (failure) return { ok: false, message: failure };
    const reply = await session.request({ cmd: 'bootstrap' }, 15_000);
    if (!reply.ok) return { ok: false, message: reply.message ?? 'bootstrap failed' };
    return { ok: true, log: reply.log ?? '' };
}

// ---------------------------------------------------------------- pod setup wizard
//
// A stock runpod-slim pod has ComfyUI and its venv but no custom nodes and no
// model files, so bootstrap.sh alone cannot bring it up. These four calls are
// what the wizard drives, all through the same single SSH session: read the
// pod's state, push SAA's copies of the durable scripts, run the provisioning,
// and stream its log. The relay only ever writes and runs its own fixed paths.

// The files the relay accepts in a deploy, and where they come from in the repo.
const DEPLOY_SOURCES = Object.freeze({
    'bootstrap.sh': 'bootstrap.sh',
    'provision.sh': 'provision.sh',
    'extra_model_paths.yaml': 'extra_model_paths.yaml',
});

// What the pod has right now: GPU, free space, deployed scripts, nodes, models,
// whether ComfyUI and Ollama answer. { ok, probe, provisioning } or { ok:false, message }.
//
// open:false only asks a relay that is already connected. A stopped pod does not
// refuse the SSH connection, it hangs until the 60 s start timeout, so the panel
// must not dial one on a passive refresh - it asks the Runpod API first.
export async function podProbe({ settings, open = true }) {
    if (open) {
        const failure = await openSession(settings);
        if (failure) return { ok: false, message: failure };
    } else if (podSessionState() !== 'connected') {
        return { ok: false, message: 'pod relay not connected', idle: true };
    }
    const reply = await session.request({ cmd: 'probe' }, 30_000);
    if (!reply.ok) return { ok: false, message: reply.message ?? 'probe failed' };
    return { ok: true, probe: reply.probe ?? {}, provisioning: reply.provisioning === true };
}

// Push bootstrap.sh / provision.sh / extra_model_paths.yaml onto the pod's volume.
export async function podDeployScripts({ settings }) {
    const failure = await openSession(settings);
    if (failure) return { ok: false, message: failure };
    const files = [];
    for (const [name, source] of Object.entries(DEPLOY_SOURCES)) {
        const path = fileURLToPath(new URL(`../pod/${source}`, import.meta.url));
        try {
            files.push({ name, data: fs.readFileSync(path).toString('base64') });
        } catch (error) {
            return { ok: false, message: `cannot read ${source}: ${error.message}` };
        }
    }
    const reply = await session.request({ cmd: 'deploy', files }, 60_000);
    if (!reply.ok) {
        const detail = Object.entries(reply.errors ?? {}).map(([name, message]) => `${name}: ${message}`).join('; ');
        return { ok: false, message: detail || reply.message || 'deploy failed' };
    }
    return { ok: true, written: reply.written ?? [] };
}

// Start provision.sh for the selected components. The Civitai token is handed to
// the relay for the child's environment only — it is never put on a command line.
export async function podProvision({ settings, components, civitaiToken = '', civitaiUrl = '' }) {
    const failure = await openSession(settings);
    if (failure) return { ok: false, message: failure };
    const wanted = (Array.isArray(components) ? components : []).map(String);
    if (wanted.length === 0) return { ok: false, message: 'nothing selected to install' };
    const reply = await session.request({ cmd: 'provision', components: wanted, civitaiToken, civitaiUrl }, 30_000);
    if (!reply.ok) return { ok: false, message: reply.message ?? 'provision failed' };
    return { ok: true, log: reply.log ?? '' };
}

// Tail bootstrap.log / provision.log from a byte offset: { ok, text, offset, size, running }.
export async function podReadLog({ settings, name = 'provision', offset = 0 }) {
    const failure = await openSession(settings);
    if (failure) return { ok: false, message: failure };
    const reply = await session.request({ cmd: 'log', name, offset }, 30_000);
    if (!reply.ok) return { ok: false, message: reply.message ?? 'log read failed' };
    return {
        ok: true,
        text: reply.text ?? '',
        offset: Number(reply.offset) || 0,
        size: Number(reply.size) || 0,
        running: reply.running === true,
        missing: reply.missing === true,
    };
}
