// Start / stop / restart of the local ComfyUI backend from inside SAA.
//
// SAA does not own the ComfyUI install: the user points `comfy_launch_command` at
// whatever brings their backend up (a start script, or python main.py with its
// arguments). Start runs that command and waits for /system_stats on the
// configured loopback port; stop asks ComfyUI to unload its models, then kills
// whichever processes hold that port (so it works even when the launch command
// was a script that returned after spawning python); restart is the two in turn.
// Only the loopback address in `api_addr` is ever touched, never a remote host.
//
// Fast mode may need ComfyUI launch flags (--use-sage-attention, --fast; see
// scripts/shared/comfyLaunchArgs.js). Every start appends the flags the stored
// model type's fast set wants, and ensureComfyLaunchArgs() — called right before a
// generation — restarts a running backend whose flags do not fit that run.
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { app } from 'electron';
import { launchSpec, loopbackPort, parseLsofPids, parseNetstatPids, shouldAutostart } from '../shared/comfyProcessLogic.js';
import { compareLaunchArgs, desiredLaunchArgs, flagGroups, invalidLaunchArgs, managedLaunchFlags } from '../shared/comfyLaunchArgs.js';

const CAT = '[ComfyProcess]';
const START_TIMEOUT_MS = 120_000;
const STOP_TIMEOUT_MS = 12_000;
const IDLE_WAIT_MS = 20_000;

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

// Which flags SAA itself started the backend on a port with. Kept in a file beside the
// launch log because ComfyUI outlives SAA: the next session must still know that the
// --fast it finds was SAA's to take away, and that a flag the user launches with
// themselves (no record, or another process) is not.
function launchRecordFile() {
    return path.join(app.getPath('userData'), 'comfy-launch-args.json');
}

function readLaunchRecord() {
    try {
        const record = JSON.parse(fs.readFileSync(launchRecordFile(), 'utf8'));
        return record && Array.isArray(record.args) && Array.isArray(record.pids) ? record : null;
    } catch {
        return null;
    }
}

function writeLaunchRecord(record) {
    try {
        fs.writeFileSync(launchRecordFile(), JSON.stringify(record));
    } catch (error) {
        console.warn(CAT, 'could not record the launch flags:', error?.message ?? error);
    }
}

// Written at spawn with no pids yet (pending), completed once the port answers — also
// when that happens only after the start wait gave up, so a slow start that does come
// up with the flags is still known as SAA's.
function recordPendingLaunch(port, args) {
    const record = { port, pids: [], args, at: new Date().toISOString() };
    writeLaunchRecord(record);
    return record.at;
}

async function completeLaunchRecord(port, at) {
    const record = readLaunchRecord();
    if (!record || record.at !== at || record.port !== port) return;  // a later start owns the record now
    const pids = await listenerPids(port);
    if (pids.length > 0) writeLaunchRecord({ ...record, pids });
}

const LATE_START_WATCH_MS = 10 * 60_000;

function watchLateStart(port, at) {
    const deadline = Date.now() + LATE_START_WATCH_MS;
    const timer = setInterval(async () => {
        const record = readLaunchRecord();
        if (!record || record.at !== at || Date.now() > deadline) {
            clearInterval(timer);
            return;
        }
        if ((await comfyHealth(port, 1500)).ok) {
            clearInterval(timer);
            await completeLaunchRecord(port, at);
            console.log(CAT, `ComfyUI came up late on 127.0.0.1:${port}; launch flags recorded`);
        }
    }, 3000);
    timer.unref?.();
}

// The flags SAA launched the process now listening on `port` with; null when that
// process was not started by SAA (or the record is gone / still pending).
async function launchedArgs(port) {
    const record = readLaunchRecord();
    if (!record || record.port !== port || record.pids.length === 0) return null;
    const pids = await listenerPids(port);
    return pids.some(pid => record.pids.includes(pid)) ? record.args.map(String) : null;
}

// Flags the record says SAA launched this port's backend with (unverified: no pid check).
function recordedFlags(port) {
    const record = readLaunchRecord();
    if (!record || record.port !== port) return [];
    return flagGroups(record.args).map(group => group.flag);
}

// The flags a start from the settings alone carries: the stored model type picks the fast set.
export function launchArgsFromSettings(settings) {
    return desiredLaunchArgs(settings, { diffusion: settings?.api_model_type === 'Diffusion' });
}

export async function startComfy(settings, { extraArgs = launchArgsFromSettings(settings) } = {}) {
    const port = loopbackPort(settings?.api_addr);
    if (!port) return { ok: false, action: 'start', message: 'ComfyUI address is not a loopback address (127.0.0.1 / localhost)' };
    const command = String(settings?.comfy_launch_command ?? '').trim();
    if (!command) return { ok: false, action: 'start', message: 'no launch command configured (Settings > Backend > ComfyUI process)' };
    if (state.phase !== 'idle') return { ok: false, action: 'start', message: `busy: ${state.phase}` };

    if ((await comfyHealth(port)).ok) return { ok: true, action: 'start', message: `already running on 127.0.0.1:${port}`, running: true };

    setPhase('starting', `running ${[command, ...extraArgs].join(' ')}`);
    try {
        const first = await launch(command, port, extraArgs);
        if (first.up) return { ok: true, action: 'start', message: `ComfyUI is up on 127.0.0.1:${port}`, running: true };
        // Flags can keep ComfyUI from starting at all (--use-sage-attention without the
        // sageattention package exits; attention flags are mutually exclusive). When the
        // launcher failed outright, bring the backend back without them rather than
        // leaving it down; a start that is merely slow is left alone (watchLateStart).
        if (extraArgs.length > 0 && first.failed) {
            console.warn(CAT, `start with [${extraArgs.join(' ')}] failed (${first.message}); starting without them`);
            setPhase('starting', `running ${command}`);
            const plain = await launch(command, port, []);
            const why = `ComfyUI did not start with ${extraArgs.join(' ')} (${first.message})`;
            if (plain.up) {
                return { ok: false, action: 'start', message: `${why}; it runs without them now`, log: first.log, running: true, flagsFailed: extraArgs };
            }
            return { ok: false, action: 'start', message: `${why}, and not without them either (${plain.message})`, log: plain.log, running: false, flagsFailed: extraArgs };
        }
        return { ok: false, action: 'start', message: first.message, log: first.log, running: false };
    } finally {
        setPhase('idle');
    }
}

// One run of the launch command: spawn, wait for the port, record the flags.
// { up, failed (the launcher exited non-zero), message, log }
async function launch(command, port, extraArgs) {
    const file = logFile();
    // the log is passed on: a .ps1 on Windows writes its output there itself (see launchSpec)
    const spec = launchSpec(command, process.platform, { log: file, extraArgs });
    const shown = [command, ...extraArgs].join(' ');
    console.log(CAT, 'start:', spec.file, spec.args.join(' '));

    let exited = null;
    let recordAt = '';
    try {
        const out = fs.openSync(file, 'a');
        fs.writeSync(out, `\n===== ${new Date().toISOString()} start: ${shown}\n`);
        // a self-logging spec appends to the file itself, so it must not inherit our handle
        if (spec.selfLogged) fs.closeSync(out);
        recordAt = recordPendingLaunch(port, extraArgs);
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
        return { up: false, failed: true, message: `launch failed: ${error?.message ?? error}`, log: '' };
    }

    // a launcher script exiting 0 is normal (it spawned python and returned); a
    // non-zero exit before the port answers ends the wait early as a failure
    await waitFor(async () => (exited && exited.code !== 0) || (await comfyHealth(port)).ok, START_TIMEOUT_MS);
    const up = (await comfyHealth(port)).ok;
    state.lastLog = logTail(file);
    if (up) {
        await completeLaunchRecord(port, recordAt);
        return { up: true, failed: false, message: '', log: state.lastLog };
    }
    const failed = Boolean(exited && exited.code !== 0);
    if (!failed) watchLateStart(port, recordAt);
    const message = failed ? `launch command exited with ${exited.error ?? exited.code}` : 'ComfyUI did not answer within 120 s';
    return { up: false, failed, message, log: state.lastLog };
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

export async function restartComfy(settings, options = {}) {
    const stopped = await stopComfy(settings, { quiet: true });
    if (!stopped.ok) return { ...stopped, action: 'restart' };
    const started = await startComfy(settings, options);
    return { ...started, action: 'restart' };
}

// sys.argv of the ComfyUI answering on the port, or null (down, or no argv reported).
export async function comfyArgv(port, timeout = 3000) {
    if (!port) return null;
    const reply = await request(port, { pathname: '/system_stats', timeout });
    if (!reply.ok) return null;
    try {
        const argv = JSON.parse(reply.text)?.system?.argv;
        return Array.isArray(argv) ? argv.map(String) : null;
    } catch {
        return null;
    }
}

// Jobs ComfyUI is running or holding (a browser tab on the same backend, say); null if unknown.
async function comfyQueueLength(port) {
    const reply = await request(port, { pathname: '/queue', timeout: 3000 });
    if (!reply.ok) return null;
    try {
        const queue = JSON.parse(reply.text);
        return (Array.isArray(queue?.queue_running) ? queue.queue_running.length : 0)
            + (Array.isArray(queue?.queue_pending) ? queue.queue_pending.length : 0);
    } catch {
        return null;
    }
}

// Flag differences a restart could not fix (the launch command does not pass extra
// arguments on, or ComfyUI would not start with the flags): tried once per SAA session.
const unfixable = new Map();

// Flags on the running process that a run may take away: only the ones SAA launched
// it with (the launch record, pid-checked), whether or not a setting still names them —
// a flag deleted from the settings must not stay behind. Flags from the user's own
// launch are never taken. The record is only pid-checked when there is something to take.
async function removableFlags(port, argv, desired) {
    const wanted = new Set(flagGroups(desired).map(group => group.flag));
    const recorded = new Set(recordedFlags(port));
    const extra = flagGroups(argv).some(group => recorded.has(group.flag) && !wanted.has(group.flag));
    if (!extra) return new Set();
    const launched = await launchedArgs(port);
    return new Set(flagGroups(launched ?? []).map(group => group.flag));
}

// "add --use-sage-attention --fast; drop --lowvram" (log and error text)
function describeDifference({ missing, unwanted }) {
    return [
        missing.length > 0 ? `add ${missing.join(' ')}` : '',
        unwanted.length > 0 ? `drop ${unwanted.join(' ')}` : '',
    ].filter(Boolean).join('; ');
}

const CANCELLED = { ok: false, cancelled: true, message: 'Cancelled' };

/**
 * Makes the local ComfyUI run with the launch flags this generation's fast set wants,
 * restarting it through the launch command when they differ. Never touches a remote
 * backend, a pod run, a backend that does not answer, or a busy one.
 *   onStatus(status)  — what the run bar should say while this takes: { key, text, args }
 *                       (a language key, its English template with {0}, the values), null when done
 *   isCancelled()     — the user cancelled the run: stop waiting, do not restart
 * Returns { ok, restarted?, skipped?, cancelled?, message? }; ok:false ends the run.
 */
export async function ensureComfyLaunchArgs(settings, { diffusion = false, onStatus = () => {}, isCancelled = () => false } = {}) {
    if (settings?.api_interface !== 'ComfyUI' || settings?.api_pod_ssh_enable === true) return { ok: true, skipped: 'not a local ComfyUI run' };
    const port = loopbackPort(settings?.api_addr);
    if (!port) return { ok: true, skipped: 'not a loopback address' };
    if (managedLaunchFlags(settings).size === 0 && recordedFlags(port).length === 0) return { ok: true, skipped: 'no fast-mode launch flags configured or launched' };
    const invalid = invalidLaunchArgs(settings, { diffusion });
    if (invalid.length > 0) {
        const message = `fast-mode ComfyUI flags refused (not shell-safe): ${invalid.join(' ')}`;
        console.warn(CAT, message);
        return { ok: true, skipped: 'invalid flags', message };
    }

    const argv = await comfyArgv(port);
    if (!argv) return { ok: true, skipped: 'ComfyUI did not report its argv' };  // down: the run reports that itself
    const desired = desiredLaunchArgs(settings, { diffusion });
    const difference = compareLaunchArgs(argv, desired, await removableFlags(port, argv, desired));
    if (difference.match) return { ok: true };

    const summary = describeDifference(difference);
    const shownFlags = desired.length > 0 ? desired.join(' ') : '—';  // the run bar names the target, not the diff
    // keyed by the target flags alone: the difference to the running process changes after
    // a failed start (it falls back to no flags), the target that failed does not
    const signature = JSON.stringify(desired);
    if (unfixable.has(signature)) return { ok: true, skipped: 'restart did not help before', message: unfixable.get(signature) };
    if (!String(settings?.comfy_launch_command ?? '').trim()) {
        const message = `ComfyUI launch flags differ (${summary}) and no launch command is set to restart it with (Settings > Backend > ComfyUI process)`;
        console.warn(CAT, message);
        unfixable.set(signature, message);
        return { ok: true, skipped: 'no launch command', message };
    }

    // never pull the process out from under someone else's job; an unanswered /queue counts as busy
    try {
        const deadline = Date.now() + IDLE_WAIT_MS;
        let queued = await comfyQueueLength(port);
        while (queued !== 0 && Date.now() < deadline) {
            if (isCancelled()) return CANCELLED;
            onStatus({ key: 'ui_fast_restart_wait', text: 'ComfyUI busy ({0} job(s)) · waiting to restart it with launch flags: {1}', args: [queued ?? '?', shownFlags] });
            await sleep(1000);
            queued = await comfyQueueLength(port);
        }
        if (queued !== 0) {
            const why = queued === null ? 'ComfyUI does not answer /queue' : `ComfyUI has ${queued} job(s) in its queue`;
            return { ok: false, message: `${why}; fast mode needs a restart (${summary}). Try again once it is idle.` };
        }
        if (isCancelled()) return CANCELLED;

        console.log(CAT, `launch flags differ (${summary}); restarting with [${desired.join(' ')}]`);
        onStatus({ key: 'ui_fast_restart_status', text: 'Restarting ComfyUI with launch flags: {0}', args: [shownFlags] });
        const restarted = await restartComfy(settings, { extraArgs: desired });
        if (restarted.flagsFailed) {
            // ComfyUI refused the flags; it runs without them if it could (startComfy fell back)
            unfixable.set(signature, restarted.message);
            return { ok: false, message: `${restarted.message}${restarted.log ? `\n${restarted.log}` : ''}` };
        }
        if (!restarted.ok) {
            return { ok: false, message: `ComfyUI restart for the fast-mode flags (${summary}) failed: ${restarted.message}${restarted.log ? `\n${restarted.log}` : ''}` };
        }
    } finally {
        onStatus(null);
    }

    const after = await comfyArgv(port);
    if (!after) return { ok: true, restarted: true };  // unknown for now: judged again next run, not cached
    const check = compareLaunchArgs(after, desired, await removableFlags(port, after, desired));
    if (!check.match) {
        const message = `ComfyUI restarted but its flags still differ (${describeDifference(check)}): the launch command must pass its extra arguments on to main.py, and must not add fast-mode flags itself`;
        console.warn(CAT, message);
        unfixable.set(signature, message);
        return { ok: true, restarted: true, message };
    }
    console.log(CAT, `ComfyUI restarted with [${desired.join(' ')}]`);
    return { ok: true, restarted: true };
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
            // the fast-mode flags the running backend has, so the panel can show them
            const managed = new Set([...managedLaunchFlags(settings), ...recordedFlags(port)]);
            const argv = health.ok && managed.size > 0 ? await comfyArgv(port, 1000) : null;
            const fastFlags = argv ? flagGroups(argv).filter(group => managed.has(group.flag)).map(group => [group.flag, ...group.values].join(' ')) : [];
            return { ok: true, action: 'state', ...comfyProcessState(), running: health.ok, port, fastFlags };
        } catch (error) {
            setPhase('idle');
            return { ok: false, action, message: error?.message ?? String(error) };
        }
    });
}
