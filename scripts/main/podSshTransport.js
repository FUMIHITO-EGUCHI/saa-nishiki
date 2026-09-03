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
        this.config = { ...config, relaySource };
        const args = buildSshArgs(config);
        console.log(CAT, 'starting ssh relay to', config.target);
        const child = spawn('ssh', args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
        this.child = child;
        // echo off first (so the deploy is not echoed back), then the staged
        // bootstrap once the remote shell shows signs of life
        child.stdin.write('stty -echo 2>/dev/null\n');
        let bootstrapped = false;
        const bootstrap = () => {
            if (bootstrapped || this.child !== child) return;
            bootstrapped = true;
            child.stdin.write(buildBootstrapCommand({ comfyPort: config.comfyPort, relaySource }));
        };
        child.stdout.once('data', () => setTimeout(bootstrap, 750));
        setTimeout(bootstrap, 8000); // fallback if the shell never prints a banner

        this.ready = new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('relay start timed out (60 s)')), 60_000);
            this.onReady = () => { clearTimeout(timer); resolve(); };
            this.onFatal = message => { clearTimeout(timer); reject(new Error(message)); };
        });

        const parse = makeFrameParser(frame => this.handleFrame(frame));
        child.stdout.on('data', parse);
        child.stderr.on('data', data => {
            const text = data.toString('utf8').trim();
            if (text) console.warn(CAT, 'ssh:', text.slice(0, 500));
        });
        const die = why => {
            console.warn(CAT, 'session ended:', why);
            this.onFatal?.(why);
            this.job?.fail(`Error: pod SSH session ended: ${why}`);
            for (const resolve of this.pending.values()) resolve({ ok: false, message: why });
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
        const id = ++this.requestId;
        return new Promise(resolve => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                resolve({ ok: false, message: 'request timed out' });
            }, timeoutMs);
            this.pending.set(id, frame => { clearTimeout(timer); resolve(frame); });
            this.child.stdin.write(`${JSON.stringify({ id, ...payload })}\n`);
        });
    }

    stop() {
        const child = this.child;
        this.child = null;
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
        return { error: `Error: pod SSH connect failed: ${error.message}` };
    }
    if (session.job && !session.job.settled) return { error: 'Error: pod SSH transport is busy' };

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

export async function interruptPodWorkflow() {
    if (!session.child) return;
    await session.request({ cmd: 'interrupt' });
}

export function stopPodSshSession() {
    session.stop();
}
