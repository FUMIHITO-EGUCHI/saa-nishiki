// Start / stop / restart of the local ComfyUI backend from inside SAA.
//
// SAA does not own the ComfyUI install: the user points `comfy_launch_command` at
// whatever brings their backend up (a start script, or python main.py with its
// arguments). Start runs that command and waits for /system_stats on the
// configured loopback port; stop asks ComfyUI to unload its models, then kills
// whichever processes hold that port (so it works even when the launch command
// was a script that returned after spawning python); restart is the two in turn.
// Only the loopback address in `api_addr` is ever touched, never a remote host.
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { app } from 'electron';
import { launchSpec, loopbackPort, parseLsofPids, parseNetstatPids, shouldAutostart } from '../shared/comfyProcessLogic.js';

const CAT = '[ComfyProcess]';
const START_TIMEOUT_MS = 120_000;
const STOP_TIMEOUT_MS = 12_000;

const state = { phase: 'idle', message: '', since: 0, lastLog: '' };

function setPhase(phase, message = '') {
    state.phase = phase;
    state.message = message;
    state.since = Date.now();
}

export function comfyProcessState() {
    return { ...state };
}

function request(port, { method = 'GET', pathname = '/', body = null, timeout = 2000 } = {}) {
    return new Promise(resolve => {
        const req = http.request({ host: '127.0.0.1', port, method, path: pathname, timeout,
            headers: body ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } : {} }, res => {
            const chunks = [];
            res.on('data', chunk => chunks.push(chunk));
            res.on('end', () => resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') }));
        });
        req.on('timeout', () => { req.destroy(new Error('timeout')); });
        req.on('error', error => resolve({ ok: false, error: error?.message ?? String(error) }));
        if (body) req.write(body);
        req.end();
    });
}

export async function comfyHealth(port, timeout = 2000) {
    if (!port) return { ok: false, error: 'no loopback port' };
    const reply = await request(port, { pathname: '/system_stats', timeout });
    return reply.ok ? { ok: true } : { ok: false, error: reply.error ?? `HTTP ${reply.status}` };
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function waitFor(check, timeoutMs, stepMs = 1000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (await check()) return true;
        await sleep(stepMs);
    }
    return check();
}

function logFile() {
    const dir = path.join(app.getPath('userData'), 'logs');
    fs.mkdirSync(dir, { recursive: true });
    return path.join(dir, 'comfy-launch.log');
}

function logTail(file, lines = 30) {
    try {
        const text = fs.readFileSync(file, 'utf8');
        return text.split(/\r?\n/).filter(Boolean).slice(-lines).join('\n');
    } catch {
        return '';
    }
}

function run(file, args, options = {}) {
    return new Promise(resolve => {
        execFile(file, args, { windowsHide: true, ...options }, (error, stdout, stderr) => {
            resolve({ ok: !error, stdout: String(stdout ?? ''), stderr: String(stderr ?? ''), error: error?.message });
        });
    });
}

// Pids of whatever listens on the port (Windows: netstat; POSIX: lsof).
export async function listenerPids(port) {
    if (process.platform === 'win32') {
        const result = await run('netstat', ['-ano', '-p', 'TCP']);
        return parseNetstatPids(result.stdout, port);
    }
    const result = await run('lsof', ['-t', `-iTCP:${port}`, '-sTCP:LISTEN']);
    return parseLsofPids(result.stdout);
}

async function killTree(pid) {
    if (process.platform === 'win32') {
        const result = await run('taskkill', ['/PID', String(pid), '/T', '/F']);
        return result.ok || /not found|見つかりません/i.test(result.stderr + result.stdout);
    }
    await run('pkill', ['-TERM', '-P', String(pid)]);
    try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ }
    return true;
}

export async function startComfy(settings) {
    const port = loopbackPort(settings?.api_addr);
    if (!port) return { ok: false, action: 'start', message: 'ComfyUI address is not a loopback address (127.0.0.1 / localhost)' };
    const command = String(settings?.comfy_launch_command ?? '').trim();
    if (!command) return { ok: false, action: 'start', message: 'no launch command configured (Settings > Backend > ComfyUI process)' };
    if (state.phase !== 'idle') return { ok: false, action: 'start', message: `busy: ${state.phase}` };

    if ((await comfyHealth(port)).ok) return { ok: true, action: 'start', message: `already running on 127.0.0.1:${port}`, running: true };

    const file = logFile();
    // the log is passed on: a .ps1 on Windows writes its output there itself (see launchSpec)
    const spec = launchSpec(command, process.platform, { log: file });
    setPhase('starting', `running ${command}`);
    console.log(CAT, 'start:', spec.file, spec.args.join(' '));

    let exited = null;
    try {
        const out = fs.openSync(file, 'a');
        fs.writeSync(out, `\n===== ${new Date().toISOString()} start: ${command}\n`);
        // a self-logging spec appends to the file itself, so it must not inherit our handle
        if (spec.selfLogged) fs.closeSync(out);
        const child = spawn(spec.file, spec.args, {
            cwd: spec.cwd && fs.existsSync(spec.cwd) ? spec.cwd : undefined,
            shell: spec.shell,
            windowsHide: true,
            windowsVerbatimArguments: spec.windowsVerbatimArguments === true,
            detached: true,             // ComfyUI outlives SAA: closing the window must not kill a run
                                        // (on Windows a non-detached child dies with the app; a detached
                                        // one has no console, which launchSpec works around for .ps1)
            stdio: spec.selfLogged ? 'ignore' : ['ignore', out, out],
        });
        child.on('exit', (code, signal) => { exited = { code, signal }; });
        child.on('error', error => { exited = { code: -1, signal: null, error: error.message }; });
        child.unref();
        if (!spec.selfLogged) fs.closeSync(out);
    } catch (error) {
        setPhase('idle');
        return { ok: false, action: 'start', message: `launch failed: ${error?.message ?? error}` };
    }

    // a launcher script exiting 0 is normal (it spawned python and returned); a
    // non-zero exit before the port answers ends the wait early as a failure
    await waitFor(async () => (exited && exited.code !== 0) || (await comfyHealth(port)).ok, START_TIMEOUT_MS);
    const up = (await comfyHealth(port)).ok;
    state.lastLog = logTail(file);
    setPhase('idle');
    if (up) return { ok: true, action: 'start', message: `ComfyUI is up on 127.0.0.1:${port}`, running: true };
    const why = exited && exited.code !== 0 ? `launch command exited with ${exited.error ?? exited.code}` : 'ComfyUI did not answer within 120 s';
    return { ok: false, action: 'start', message: why, log: state.lastLog, running: false };
}

export async function stopComfy(settings, { quiet = false } = {}) {
    const port = loopbackPort(settings?.api_addr);
    if (!port) return { ok: false, action: 'stop', message: 'ComfyUI address is not a loopback address (127.0.0.1 / localhost)' };
    if (state.phase !== 'idle') return { ok: false, action: 'stop', message: `busy: ${state.phase}` };
    setPhase('stopping', `stopping ComfyUI on 127.0.0.1:${port}`);
    try {
        const wasUp = (await comfyHealth(port)).ok;
        if (wasUp) {
            // let it drop the models first so VRAM is released even if the kill races
            await request(port, { method: 'POST', pathname: '/free', body: '{"unload_models":true,"free_memory":true}', timeout: 3000 });
        }
        const pids = await listenerPids(port);
        if (pids.length === 0) {
            if (!wasUp) return { ok: true, action: 'stop', message: quiet ? '' : 'ComfyUI is not running', running: false };
            return { ok: false, action: 'stop', message: `something answers on 127.0.0.1:${port} but no local listener was found`, running: true };
        }
        for (const pid of pids) {
            console.log(CAT, 'kill tree', pid);
            await killTree(pid);
        }
        const down = await waitFor(async () => !(await comfyHealth(port, 1000)).ok, STOP_TIMEOUT_MS, 500);
        if (!down) return { ok: false, action: 'stop', message: `ComfyUI still answers on 127.0.0.1:${port}`, running: true };
        return { ok: true, action: 'stop', message: `ComfyUI stopped (pid ${pids.join(', ')})`, running: false };
    } finally {
        setPhase('idle');
    }
}

export async function restartComfy(settings) {
    const stopped = await stopComfy(settings, { quiet: true });
    if (!stopped.ok) return { ...stopped, action: 'restart' };
    const started = await startComfy(settings);
    return { ...started, action: 'restart' };
}

// SAA just came up: bring the backend with it when the user asked for that.
export async function autostartComfy(settings) {
    const port = loopbackPort(settings?.api_addr);
    const health = port ? await comfyHealth(port) : { ok: false };
    if (!shouldAutostart(settings, health)) return { skipped: true };
    console.log(CAT, 'autostart: ComfyUI is down, launching');
    const result = await startComfy(settings);
    console.log(CAT, 'autostart:', result.ok ? 'up' : `failed: ${result.message}`);
    return result;
}

export function registerComfyProcess(ipcMain, getSettings) {
    ipcMain.handle('comfy-process', async (event, args) => {
        const action = String(args?.action ?? 'state');
        try {
            const settings = getSettings();
            if (action === 'start') return await startComfy(settings);
            if (action === 'stop') return await stopComfy(settings);
            if (action === 'restart') return await restartComfy(settings);
            const port = loopbackPort(settings?.api_addr);
            const health = port ? await comfyHealth(port, 1000) : { ok: false };
            return { ok: true, action: 'state', ...comfyProcessState(), running: health.ok, port };
        } catch (error) {
            setPhase('idle');
            return { ok: false, action, message: error?.message ?? String(error) };
        }
    });
}
