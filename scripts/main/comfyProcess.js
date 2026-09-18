// Start / stop / restart of the local ComfyUI backend from inside SAA.
//
// SAA does not own the ComfyUI install: the user points `comfy_launch_command` at
// whatever brings their backend up (a start script, or python main.py with its
// arguments). Start runs that command and waits for /system_stats on the
// configured loopback port; stop asks ComfyUI to unload its models, then kills
// the processes holding that port — only when they are that ComfyUI (it answered
// /system_stats, or SAA launched that pid), so it works even when the launch command
// was a script that returned after spawning python; anything else holding the port is
// named with its pid and program and ended only when the user says so (a hung ComfyUI,
// or one started outside SAA); restart is the two in turn.
// Only the loopback address in `api_addr` is ever touched, never a remote host, and a
// launch command runs only once the user allowed it in a native dialog.
//
// Fast mode may need ComfyUI launch flags (--use-sage-attention, --fast; see
// scripts/shared/comfyLaunchArgs.js). Every start appends the flags the stored
// model type's fast set wants, and ensureComfyLaunchArgs() — called right before a
// generation — restarts a running backend whose flags do not fit that run.
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { app, BrowserWindow, dialog } from 'electron';
import { getMutexBackendBusy } from '../../main-common.js';
import { comfyRequest as request } from './comfyHttp.js';
import { isComfySystemStats, launchPending, launchSpec, listenerPidsForHost, loopbackTarget, parseLsofListeners, parseNetstatListeners, parseTasklistName, shouldAutostart, stopTargets, tailLines } from '../shared/comfyProcessLogic.js';
import { compareLaunchArgs, desiredLaunchArgs, flagGroups, invalidLaunchArgs, managedLaunchFlags } from '../shared/comfyLaunchArgs.js';

const CAT = '[ComfyProcess]';
const START_TIMEOUT_MS = 120_000;
const STOP_TIMEOUT_MS = 12_000;
const IDLE_WAIT_MS = 20_000;
// a start whose launcher is gone (SAA was closed during it) holds the port only this long
const DEAD_LAUNCHER_MS = 15_000;
// how long a start waits for a launch log the last launch still holds
const LOG_OPEN_WAIT_MS = 800;
// how long a generation waits for the launch command dialog before it runs as the backend is
const APPROVAL_WAIT_MS = 120_000;
const LOG_ROTATE_BYTES = 4 * 1024 * 1024;
const LOG_TAIL_BYTES = 64 * 1024;
const NOT_LOOPBACK = 'ComfyUI address is not a loopback address (127.0.0.1 / localhost)';
const NO_COMMAND = 'no launch command configured (Settings > Backend > ComfyUI process)';

const state = { phase: 'idle', message: '', since: 0, lastLog: '' };
// set by a Stop that arrives while a start is under way: the start stops waiting and ends its launch
let cancelStart = false;

function setPhase(phase, message = '') {
    state.phase = phase;
    state.message = message;
    state.since = Date.now();
}

export function comfyProcessState() {
    return { ...state };
}

// 127.0.0.1:8188, [::1]:8188
function shownAddress(target) {
    return target.host.includes(':') ? `[${target.host}]:${target.port}` : `${target.host}:${target.port}`;
}

// The loopback endpoint plus the credentials the generation requests use: a ComfyUI behind a
// local auth proxy answers /system_stats only with them, and without them Stop would take it
// for a program that is not ComfyUI.
function comfyTarget(settings) {
    const target = loopbackTarget(settings?.api_addr);
    if (!target) return null;
    const auth = settings?.webui_auth_enable === 'ON' ? String(settings?.webui_auth ?? '').trim() : '';
    return auth ? { ...target, auth } : target;
}

export async function comfyHealth(target, timeout = 2000) {
    if (!target) return { ok: false, error: 'no loopback address' };
    const reply = await request(target, { pathname: '/system_stats', timeout });
    if (!reply.ok) return { ok: false, error: reply.error ?? `HTTP ${reply.status}` };
    return isComfySystemStats(reply.text) ? { ok: true } : { ok: false, error: 'the answer is not ComfyUI system stats' };
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

// Keeps the launch log bounded: a launch that hands it to ComfyUI as stdout (a .cmd or python
// command) appends everything ComfyUI prints for as long as it runs.
function rotateLog(file) {
    try {
        if (fs.statSync(file).size > LOG_ROTATE_BYTES) fs.renameSync(file, file.replace(/\.log$/, '.previous.log'));
    } catch { /* no log yet, or held by a running launch: it is rotated at a later start */ }
}

// The last lines of the log, read from its end only.
function logTail(file, lines = 30) {
    let fd = null;
    try {
        fd = fs.openSync(file, 'r');
        const size = fs.fstatSync(fd).size;
        const length = Math.min(size, LOG_TAIL_BYTES);
        const buffer = Buffer.alloc(length);
        fs.readSync(fd, buffer, 0, length, size - length);
        let text = buffer.toString('utf8');
        if (length < size) text = text.slice(text.search(/[\r\n]/) + 1);   // drop the line the read cut into
        return tailLines(text, lines);
    } catch {
        return '';
    } finally {
        if (fd !== null) try { fs.closeSync(fd); } catch { /* already closed */ }
    }
}

// A restart opens the log while the PowerShell of the launch it just stopped may still hold it
// (Out-File keeps the file to itself, and it lets go only once the script is over — a few
// milliseconds after ComfyUI ended). Retried for a moment rather than failing the start.
async function openLogForAppend(file, waitMs = LOG_OPEN_WAIT_MS) {
    const deadline = Date.now() + waitMs;
    for (;;) {
        try {
            return fs.openSync(file, 'a');
        } catch (error) {
            if (Date.now() >= deadline) throw error;
            await sleep(50);
        }
    }
}

function run(file, args, options = {}) {
    return new Promise(resolve => {
        execFile(file, args, { windowsHide: true, ...options }, (error, stdout, stderr) => {
            resolve({ ok: !error, stdout: String(stdout ?? ''), stderr: String(stderr ?? ''), error: error?.message });
        });
    });
}

// Pids of whatever listens where a request to the target lands (Windows: netstat, IPv4 and
// IPv6, read without its localized state column; POSIX: lsof).
export async function listenerPids(target) {
    if (!target) return [];
    if (process.platform === 'win32') {
        const result = await run('netstat', ['-ano'], { maxBuffer: 64 * 1024 * 1024 });
        return listenerPidsForHost(parseNetstatListeners(result.stdout, target.port), target.host);
    }
    const result = await run('lsof', ['-nP', `-iTCP:${target.port}`, '-sTCP:LISTEN', '-Fpn']);
    return listenerPidsForHost(parseLsofListeners(result.stdout), target.host);
}

// The program behind a listener pid, for the dialog that asks whether to end it
// ("python.exe"); '' when it cannot be read.
async function processName(pid) {
    try {
        if (process.platform === 'win32') {
            const result = await run('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH']);
            return parseTasklistName(result.stdout);
        }
        const result = await run('ps', ['-o', 'comm=', '-p', String(pid)]);
        return result.stdout.trim().split(/\r?\n/)[0] ?? '';
    } catch {
        return '';
    }
}

// "pid 1234 (python.exe), pid 99 (unknown)"
async function describeHolders(pids) {
    const holders = [];
    for (const pid of pids) holders.push({ pid, name: (await processName(pid)) || 'unknown' });
    return holders;
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

// Written whole, then moved into place: a second SAA instance sharing this userData folder
// never reads half a file (and then takes it for no record at all).
function writeJsonAtomic(file, data) {
    const temporary = `${file}.${process.pid}.tmp`;
    try {
        fs.writeFileSync(temporary, JSON.stringify(data));
        fs.renameSync(temporary, file);
        return true;
    } catch (error) {
        try { fs.rmSync(temporary, { force: true }); } catch { /* nothing to clean up */ }
        throw error;
    }
}

function writeLaunchRecord(record) {
    try {
        writeJsonAtomic(launchRecordFile(), record);
    } catch (error) {
        console.warn(CAT, 'could not record the launch flags:', error?.message ?? error);
    }
}

// Written at spawn with no pids yet (pending), completed once the port answers — also
// when that happens only after the start wait gave up, so a slow start that does come
// up with the flags is still known as SAA's. The launcher pid lets a later session see
// that the start may still be coming up (launchPending), never to end it.
function recordPendingLaunch(port, args, launcher) {
    const record = { port, pids: [], args, launcher, at: new Date().toISOString() };
    writeLaunchRecord(record);
    return record.at;
}

async function completeLaunchRecord(target, at) {
    const record = readLaunchRecord();
    if (!record || record.at !== at || record.port !== target.port) return;  // a later start owns the record now
    const pids = await listenerPids(target);
    if (pids.length > 0) writeLaunchRecord({ ...record, pids });
}

// A launch that will not bring the backend up (its launcher failed, or Stop ended it) is no longer pending.
function endLaunchRecord(at) {
    const record = readLaunchRecord();
    if (record && record.at === at && record.pids.length === 0) writeLaunchRecord({ ...record, ended: true });
}

// Stop also ends a pending record another SAA session left behind (it was closed or crashed
// during a start): nothing else clears it, and until it ages out it refuses every new Start.
function endPendingRecord(record, port) {
    if (!record || record.port !== port || record.ended === true) return false;
    if (!Array.isArray(record.pids) || record.pids.length > 0) return false;
    writeLaunchRecord({ ...record, ended: true });
    return true;
}

const LATE_START_WATCH_MS = 10 * 60_000;

function watchLateStart(target, at) {
    const deadline = Date.now() + LATE_START_WATCH_MS;
    const timer = setInterval(async () => {
        const record = readLaunchRecord();
        if (!record || record.at !== at || record.ended === true || Date.now() > deadline) {
            clearInterval(timer);
            return;
        }
        if ((await comfyHealth(target, 1500)).ok) {
            clearInterval(timer);
            await completeLaunchRecord(target, at);
            console.log(CAT, `ComfyUI came up late on ${shownAddress(target)}; launch flags recorded`);
        }
    }, 3000);
    timer.unref?.();
}

// The launch this session started last: { pid, port, at, exited }. Stop can end its launcher
// while the start is still pending. A launcher from an earlier session is never ended by pid
// (the pid may belong to another process by now), only taken as a sign of a start under way.
let currentLaunch = null;

function launcherAlive(record) {
    if (currentLaunch && currentLaunch.at === record?.at) return currentLaunch.exited === null;
    const pid = Number(record?.launcher);
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try {
        process.kill(pid, 0);   // signal 0 only tests that the process exists
        return true;
    } catch (error) {
        return error?.code === 'EPERM';
    }
}

// Ends a launch that has not brought the backend up: its launcher's process tree while that
// still runs (a start script waiting for ComfyUI, or cmd.exe hosting python), and its record.
async function endLaunch(launch) {
    let ended = 0;
    if (launch.pid > 0 && launch.exited === null) {
        console.log(CAT, 'end launcher tree', launch.pid);
        await killTree(launch.pid);
        ended = launch.pid;
    }
    endLaunchRecord(launch.at);
    return ended;
}

// The flags SAA launched the process now listening on the target with; null when that
// process was not started by SAA (or the record is gone / still pending).
async function launchedArgs(target) {
    const record = readLaunchRecord();
    if (!record || record.port !== target.port || record.pids.length === 0) return null;
    const pids = await listenerPids(target);
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

// ---- launch command approval
// The renderer can write settings, so a launch command put there must not run unseen: SAA runs
// a command only after the user allowed it once in a native dialog. Allowed commands are kept
// as hashes in userData, so everyday Start / Restart / autostart asks once per command.
const NOT_ALLOWED = 'the launch command was not allowed to run (Settings > Backend > ComfyUI process)';
const NOT_ANSWERED = 'the launch command dialog was not answered (Settings > Backend > ComfyUI process)';
const approvalPrompts = new Map();

// The dialog is native, so it cannot read the renderer's language file itself: main.js hands
// it the strings of the language in use (data/language.json), English when it does not.
const DIALOG_TEXT = {
    ui_comfy_approve_title: 'ComfyUI launch command',
    ui_comfy_approve_message: 'Run this ComfyUI launch command?',
    ui_comfy_approve_detail: '{0}\n\nSAA runs it for Start, Restart and "Start ComfyUI with SAA", and asks once for each new command. Allow it only if you set this command yourself.',
    ui_comfy_approve_run: 'Run',
    ui_comfy_approve_cancel: 'Cancel',
};
let getDialogText = () => ({});

export function setComfyDialogText(getter) {
    getDialogText = typeof getter === 'function' ? getter : () => ({});
}

function dialogText(key, ...args) {
    let text = DIALOG_TEXT[key];
    try {
        const value = getDialogText()?.[key];
        if (typeof value === 'string' && value) text = value;
    } catch { /* no language file loaded: English */ }
    return args.reduce((line, value, index) => line.replaceAll(`{${index}}`, String(value)), text);
}

function approvalFile() {
    return path.join(app.getPath('userData'), 'comfy-launch-approved.json');
}

function approvedHashes() {
    try {
        const data = JSON.parse(fs.readFileSync(approvalFile(), 'utf8'));
        return Array.isArray(data?.approved) ? data.approved.filter(hash => typeof hash === 'string') : [];
    } catch {
        return [];
    }
}

/**
 * Whether the launch command may run: 'yes', 'no' (the user said no), or 'waiting' — the
 * dialog is still open and the caller may not wait any longer (a generation holds the
 * backend mutex while this runs, so it never waits for the dialog for good). An answer that
 * comes in later is still kept, so the next start goes through without asking again.
 */
async function launchCommandApproved(command, { waitMs = 0, isCancelled = null } = {}) {
    const hash = createHash('sha256').update(command, 'utf8').digest('hex');
    if (approvedHashes().includes(hash)) return 'yes';
    // one dialog per command, however many starts ask at once
    if (!approvalPrompts.has(hash)) {
        approvalPrompts.set(hash, askLaunchApproval(command, hash).finally(() => approvalPrompts.delete(hash)));
    }
    const prompt = approvalPrompts.get(hash);
    const answered = prompt.then(allowed => (allowed ? 'yes' : 'no'));
    if (waitMs <= 0 && !isCancelled) return answered;
    let settled = false;
    prompt.finally(() => { settled = true; });
    const waiting = Symbol('waiting');
    const deadline = waitMs > 0 ? Date.now() + waitMs : Infinity;
    // give up on the dialog when the run is cancelled or the wait is over; the dialog stays
    // open, and the answer it gets is still remembered for the next start
    const giveUp = (async () => {
        while (!settled && Date.now() < deadline) {
            if (isCancelled?.() === true) return waiting;
            await sleep(250);
        }
        return waiting;   // the answer won the race already if it settled
    })();
    const answer = await Promise.race([answered, giveUp]);
    return answer === waiting ? 'waiting' : answer;
}

async function askLaunchApproval(command, hash) {
    const options = {
        type: 'warning',
        title: dialogText('ui_comfy_approve_title'),
        message: dialogText('ui_comfy_approve_message'),
        detail: dialogText('ui_comfy_approve_detail', command),
        buttons: [dialogText('ui_comfy_approve_run'), dialogText('ui_comfy_approve_cancel')],
        defaultId: 1,
        cancelId: 1,
        noLink: true,
    };
    let response = 1;
    try {
        const window = approvalWindow();
        ({ response } = window ? await dialog.showMessageBox(window, options) : await dialog.showMessageBox(options));
    } catch (error) {
        console.warn(CAT, 'launch command approval could not be asked:', error?.message ?? error);
        return false;
    }
    if (response !== 0) {
        console.warn(CAT, 'launch command not allowed by the user');
        return false;
    }
    try {
        // merged with what is on disk: another SAA instance on the same userData may have
        // written its own approval since, and losing it would only ask the user again
        writeJsonAtomic(approvalFile(), { approved: [...new Set([...approvedHashes(), hash])] });
    } catch (error) {
        console.warn(CAT, 'could not keep the launch command approval:', error?.message ?? error);
    }
    return true;
}

// The window the dialog belongs to, brought back from the taskbar first: a modal dialog on a
// minimized window is invisible, and the start would look like it hangs.
function approvalWindow() {
    const window = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows().find(candidate => !candidate.isDestroyed?.());
    if (!window || window.isDestroyed?.()) return null;
    try {
        if (window.isMinimized?.()) window.restore();
        window.show?.();
        window.focus?.();
    } catch (error) {
        console.warn(CAT, 'could not bring the window up for the approval dialog:', error?.message ?? error);
    }
    return window;
}

// Why the settings cannot start ComfyUI at all ('' when they can): checked before anything
// is stopped, so a restart that could not start again never leaves the backend down.
function startProblem(settings) {
    if (!loopbackTarget(settings?.api_addr)) return NOT_LOOPBACK;
    const command = String(settings?.comfy_launch_command ?? '').trim();
    if (!command) return NO_COMMAND;
    return launchSpec(command, process.platform, { exists: file => fs.existsSync(file) })?.error ?? '';
}

export async function startComfy(settings, { extraArgs = launchArgsFromSettings(settings), locked = false, approval = {} } = {}) {
    const problem = startProblem(settings);
    if (problem) return { ok: false, action: 'start', message: problem };
    const target = comfyTarget(settings);
    const port = target.port;
    const command = String(settings?.comfy_launch_command ?? '').trim();
    // taken before the first await, so two starts (autostart and a click) cannot both get through;
    // `locked`: restartComfy holds the phase already
    if (!locked && state.phase !== 'idle') return { ok: false, action: 'start', message: `busy: ${state.phase}` };
    cancelStart = false;
    setPhase('starting', `running ${[command, ...extraArgs].join(' ')}`);
    try {
        if ((await comfyHealth(target)).ok) return { ok: true, action: 'start', message: `already running on ${shownAddress(target)}`, running: true };
        // the port held without a ComfyUI answer: one still loading, a hung one, or another program
        const holders = await listenerPids(target);
        if (holders.length > 0) {
            // named the same way Stop names them, so the panel line says what to end
            const shownHolders = (await describeHolders(holders)).map(holder => `pid ${holder.pid} (${holder.name})`).join(', ');
            return { ok: false, action: 'start', message: `${shownAddress(target)} is held by ${shownHolders}, which does not answer as ComfyUI; not starting a second backend`, running: false };
        }
        const record = readLaunchRecord();
        if (launchPending(record, port, { waitMs: START_TIMEOUT_MS, lateMs: LATE_START_WATCH_MS, deadMs: DEAD_LAUNCHER_MS, launcherAlive: launcherAlive(record) })) {
            const ours = currentLaunch?.at === record.at;
            return { ok: false, action: 'start', message: `a launch started at ${record.at}${record.launcher ? ` (launcher pid ${record.launcher})` : ''} may still bring ComfyUI up; ${ours ? 'wait for it, or Stop ends it' : 'Stop ends it'}`, running: false };
        }
        const allowed = await launchCommandApproved(command, approval);
        if (allowed === 'waiting') return { ok: false, action: 'start', notAllowed: true, approvalPending: true, message: NOT_ANSWERED, running: false };
        if (allowed !== 'yes') return { ok: false, action: 'start', notAllowed: true, message: NOT_ALLOWED, running: false };
        if (cancelStart) return { ok: false, action: 'start', cancelled: true, message: 'start cancelled', running: false };

        const first = await launch(command, target, extraArgs);
        if (first.up) return { ok: true, action: 'start', message: `ComfyUI is up on ${shownAddress(target)}`, running: true };
        if (first.cancelled) return { ok: false, action: 'start', cancelled: true, message: first.message, log: first.log, running: false };
        // Flags can keep ComfyUI from starting at all (--use-sage-attention without the
        // sageattention package exits; attention flags are mutually exclusive). When the
        // launcher failed outright, bring the backend back without them rather than
        // leaving it down; a start that is merely slow is left alone (watchLateStart), and
        // a launch that could not run at all (log in use, spawn error) is no flag problem.
        if (extraArgs.length > 0 && first.failed && !first.launchError) {
            console.warn(CAT, `start with [${extraArgs.join(' ')}] failed (${first.message}); starting without them`);
            setPhase('starting', `running ${command}`);
            const plain = await launch(command, target, []);
            if (plain.cancelled) return { ok: false, action: 'start', cancelled: true, message: plain.message, log: plain.log, running: false };
            const why = `ComfyUI did not start with ${extraArgs.join(' ')} (${first.message})`;
            if (plain.up) {
                return { ok: false, action: 'start', message: `${why}; it runs without them now`, log: first.log, running: true, flagsFailed: extraArgs };
            }
            return { ok: false, action: 'start', message: `${why}, and not without them either (${plain.message})`, log: plain.log, running: false, flagsFailed: extraArgs };
        }
        return { ok: false, action: 'start', message: first.message, log: first.log, running: false };
    } finally {
        cancelStart = false;
        if (!locked) setPhase('idle');
    }
}

// One run of the launch command: spawn, wait for the port, record the flags.
// { up, failed (the launcher exited non-zero), launchError (it could not run at all), cancelled, message, log }
async function launch(command, target, extraArgs) {
    const port = target.port;
    const file = logFile();
    rotateLog(file);
    // the log is passed on: a .ps1 on Windows writes its output there itself (see launchSpec)
    const spec = launchSpec(command, process.platform, { log: file, extraArgs, exists: candidate => fs.existsSync(candidate) });
    if (!spec || spec.error) return { up: false, failed: false, launchError: true, message: spec?.error ?? NO_COMMAND, log: '' };
    const shown = [command, ...extraArgs].join(' ');
    console.log(CAT, 'start:', spec.file, spec.script ?? spec.args.join(' '));

    const current = { pid: 0, port, at: '', exited: null };
    let out = null;
    try {
        out = await openLogForAppend(file);
    } catch (error) {
        // an earlier launch's PowerShell still appending to it: that start may still be running
        return { up: false, failed: false, launchError: true, message: `the launch log is in use (${error?.code ?? error?.message ?? error}); an earlier launch may still be running`, log: '' };
    }
    try {
        fs.writeSync(out, `\n===== ${new Date().toISOString()} start: ${shown}\n`);
        // a self-logging spec appends to the file itself, so it must not inherit our handle
        if (spec.selfLogged) {
            fs.closeSync(out);
            out = null;
        }
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
        child.on('exit', (code, signal) => { current.exited = { code, signal }; });
        child.on('error', error => { current.exited = { code: -1, signal: null, error: error.message }; });
        child.unref();
        current.pid = child.pid ?? 0;
        current.at = recordPendingLaunch(port, extraArgs, current.pid);
        currentLaunch = current;
    } catch (error) {
        return { up: false, failed: false, launchError: true, message: `launch failed: ${error?.message ?? error}`, log: '' };
    } finally {
        if (out !== null) try { fs.closeSync(out); } catch { /* already closed */ }
    }

    // a launcher script exiting 0 is normal (it spawned python and returned); a
    // non-zero exit before the port answers ends the wait early as a failure, and so does a Stop
    await waitFor(async () => cancelStart || (current.exited && current.exited.code !== 0) || (await comfyHealth(target)).ok, START_TIMEOUT_MS);
    if (cancelStart) {
        const ended = await endLaunch(current);
        state.lastLog = logTail(file);
        return { up: false, failed: false, cancelled: true, message: `start cancelled${ended ? ` (launcher pid ${ended} ended)` : ''}`, log: state.lastLog };
    }
    const up = (await comfyHealth(target)).ok;
    state.lastLog = logTail(file);
    if (up) {
        await completeLaunchRecord(target, current.at);
        return { up: true, failed: false, message: '', log: state.lastLog };
    }
    const failed = Boolean(current.exited && current.exited.code !== 0);
    if (failed) endLaunchRecord(current.at);
    else watchLateStart(target, current.at);
    const message = failed ? `launch command exited with ${current.exited.error ?? current.exited.code}` : 'ComfyUI did not answer within 120 s';
    return { up: false, failed, launchError: Boolean(current.exited?.error), message, log: state.lastLog };
}

export async function stopComfy(settings, { quiet = false, locked = false, unverified = false } = {}) {
    const target = comfyTarget(settings);
    if (!target) return { ok: false, action: 'stop', message: NOT_LOOPBACK };
    const port = target.port;
    if (!locked && state.phase === 'starting') {
        // Stop during a start cancels it: the start stops waiting and ends its launcher, then this stop runs
        cancelStart = true;
        await waitFor(async () => state.phase === 'idle', STOP_TIMEOUT_MS, 200);
    }
    if (!locked && state.phase !== 'idle') return { ok: false, action: 'stop', message: `busy: ${state.phase}` };
    if (!locked) setPhase('stopping', `stopping ComfyUI on ${shownAddress(target)}`);
    try {
        const wasUp = (await comfyHealth(target)).ok;
        if (wasUp) {
            // let it drop the models first so VRAM is released even if the kill races
            await request(target, { method: 'POST', pathname: '/free', body: '{"unload_models":true,"free_memory":true}', timeout: 3000 });
        }
        // a start of this session that gave up waiting may still be bringing ComfyUI up: end it too
        const record = readLaunchRecord();
        const ours = Boolean(currentLaunch && record?.at === currentLaunch.at && record.ended !== true && record.pids.length === 0);
        const endedLauncher = ours ? await endLaunch(currentLaunch) : 0;
        // a pending record of another session (SAA was closed during its start) would refuse
        // every Start until it aged out; Stop is the one place that can say it is over
        const endedRecord = !ours && endPendingRecord(record, port);
        const pids = await listenerPids(target);
        // only the ComfyUI SAA talks to is ended: it answered, SAA launched that pid, or the
        // user was asked about the program holding the port and said to end it anyway
        const { kill, spared } = stopTargets(pids, {
            answered: wasUp,
            launchedPids: record?.port === port ? record.pids : [],
            protectedPids: [process.pid, process.ppid],
            unverified,
        });
        if (kill.length === 0) {
            if (pids.length === 0 && (!wasUp || endedLauncher || endedRecord)) {
                const message = endedLauncher ? `pending start ended (launcher pid ${endedLauncher})`
                    : endedRecord ? 'ComfyUI is not running; a pending start of an earlier SAA session was cleared'
                    : ours ? 'ComfyUI is not running; the start script had already returned, so a backend it spawned may still come up'
                    : (quiet ? '' : 'ComfyUI is not running');
                return { ok: true, action: 'stop', message, running: false };
            }
            if (pids.length === 0) return { ok: false, action: 'stop', message: `something answers on ${shownAddress(target)} but no local listener was found`, running: true };
            // Not ours as far as SAA can tell (it does not answer as ComfyUI and no launch
            // record names it): the panel asks about it by pid and program, and a Stop that
            // comes back with `unverified` ends it. Only pids such a Stop could really end are
            // offered — SAA's own process, its parent and system pids never are.
            const endable = stopTargets(pids, { unverified: true, protectedPids: [process.pid, process.ppid] }).kill;
            const holders = await describeHolders(endable.length > 0 ? endable : spared);
            const shownHolders = holders.map(holder => `pid ${holder.pid} (${holder.name})`).join(', ');
            if (endable.length > 0 && !wasUp) {
                return { ok: false, action: 'stop', needsUnverified: true, holders, running: false,
                    message: `${shownAddress(target)} is held by ${shownHolders}, which does not answer as ComfyUI` };
            }
            const who = wasUp ? 'SAA itself or a system process' : 'not answering as ComfyUI and not started by SAA';
            return { ok: false, action: 'stop', message: `${shownAddress(target)} is held by ${shownHolders} (${who}); not ending it`, running: wasUp };
        }
        for (const pid of kill) {
            console.log(CAT, 'kill tree', pid);
            await killTree(pid);
        }
        const down = await waitFor(async () => !(await comfyHealth(target, 1000)).ok
            && !(await listenerPids(target)).some(pid => kill.includes(pid)), STOP_TIMEOUT_MS, 500);
        if (!down) return { ok: false, action: 'stop', message: `ComfyUI still runs on ${shownAddress(target)} (pid ${kill.join(', ')})`, running: true };
        const left = spared.length > 0 ? `; pid ${spared.join(', ')} left alone` : '';
        return { ok: true, action: 'stop', message: `ComfyUI stopped (pid ${kill.join(', ')})${left}`, running: false };
    } finally {
        if (!locked) setPhase('idle');
    }
}

export async function restartComfy(settings, { unverified = false, approval = {}, ...options } = {}) {
    const problem = startProblem(settings);
    if (problem) return { ok: false, action: 'restart', message: problem };
    if (state.phase !== 'idle') return { ok: false, action: 'restart', message: `busy: ${state.phase}` };
    setPhase('restarting', `restarting ComfyUI on ${shownAddress(loopbackTarget(settings?.api_addr))}`);
    try {
        // asked before the stop: a command the user refuses must not leave the backend down
        const allowed = await launchCommandApproved(String(settings?.comfy_launch_command ?? '').trim(), approval);
        if (allowed === 'waiting') return { ok: false, action: 'restart', notAllowed: true, approvalPending: true, message: NOT_ANSWERED };
        if (allowed !== 'yes') return { ok: false, action: 'restart', notAllowed: true, message: NOT_ALLOWED };
        const stopped = await stopComfy(settings, { quiet: true, locked: true, unverified });
        if (!stopped.ok) return { ...stopped, action: 'restart' };
        const started = await startComfy(settings, { ...options, locked: true, approval });
        return { ...started, action: 'restart' };
    } finally {
        setPhase('idle');
    }
}

// sys.argv of the ComfyUI answering on the target, or null (down, or no argv reported).
export async function comfyArgv(target, timeout = 3000) {
    if (!target) return null;
    const reply = await request(target, { pathname: '/system_stats', timeout });
    if (!reply.ok) return null;
    try {
        const argv = JSON.parse(reply.text)?.system?.argv;
        return Array.isArray(argv) ? argv.map(String) : null;
    } catch {
        return null;
    }
}

// Jobs ComfyUI is running or holding (a browser tab on the same backend, say); null if unknown.
async function comfyQueueLength(target) {
    const reply = await request(target, { pathname: '/queue', timeout: 3000 });
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
async function removableFlags(target, argv, desired) {
    const wanted = new Set(flagGroups(desired).map(group => group.flag));
    const recorded = new Set(recordedFlags(target.port));
    const extra = flagGroups(argv).some(group => recorded.has(group.flag) && !wanted.has(group.flag));
    if (!extra) return new Set();
    const launched = await launchedArgs(target);
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
 * backend, a pod run, a backend that does not answer, or a busy one, and a run from a
 * web client (remote) never restarts it.
 *   onStatus(status)  — what the run bar should say while this takes: { key, text, args }
 *                       (a language key, its English template with {0}, the values), null when done
 *   isCancelled()     — the user cancelled the run: stop waiting, do not restart
 * Returns { ok, restarted?, skipped?, cancelled?, message? }; ok:false ends the run.
 */
export async function ensureComfyLaunchArgs(settings, { diffusion = false, remote = false, onStatus = () => {}, isCancelled = () => false, approvalWaitMs = APPROVAL_WAIT_MS } = {}) {
    if (settings?.api_interface !== 'ComfyUI' || settings?.api_pod_ssh_enable === true) return { ok: true, skipped: 'not a local ComfyUI run' };
    const target = comfyTarget(settings);
    if (!target) return { ok: true, skipped: 'not a loopback address' };
    if (managedLaunchFlags(settings).size === 0 && recordedFlags(target.port).length === 0) return { ok: true, skipped: 'no fast-mode launch flags configured or launched' };
    const invalid = invalidLaunchArgs(settings, { diffusion });
    if (invalid.length > 0) {
        const message = `fast-mode ComfyUI flags refused (not shell-safe): ${invalid.join(' ')}`;
        console.warn(CAT, message);
        return { ok: true, skipped: 'invalid flags', message };
    }

    const argv = await comfyArgv(target);
    if (!argv) return { ok: true, skipped: 'ComfyUI did not report its argv' };  // down: the run reports that itself
    const desired = desiredLaunchArgs(settings, { diffusion });
    const difference = compareLaunchArgs(argv, desired, await removableFlags(target, argv, desired));
    if (difference.match) return { ok: true };

    const summary = describeDifference(difference);
    // the run bar names the target, not the diff; with no flags left to ask for, the run
    // bar says so in words instead of showing an empty list
    const restartKey = desired.length > 0 ? 'ui_fast_restart_status' : 'ui_fast_restart_plain';
    const restartText = desired.length > 0
        ? 'Restarting ComfyUI with launch flags: {0}'
        : 'Restarting ComfyUI without its launch flags';
    const shownFlags = desired.length > 0 ? desired.join(' ') : '—';
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
    // a web client's run goes on with the backend as it is: only the SAA window restarts ComfyUI
    if (remote) {
        const message = `ComfyUI launch flags differ (${summary}); a run from a web client does not restart ComfyUI`;
        console.warn(CAT, message);
        return { ok: true, skipped: 'web client', message };
    }

    // never pull the process out from under someone else's job; an unanswered /queue counts as busy
    try {
        const deadline = Date.now() + IDLE_WAIT_MS;
        let queued = await comfyQueueLength(target);
        while (queued !== 0 && Date.now() < deadline) {
            if (isCancelled()) return CANCELLED;
            onStatus({ key: 'ui_fast_restart_wait', text: 'ComfyUI busy ({0} job(s)) · waiting to restart it with launch flags: {1}', args: [queued ?? '?', shownFlags] });
            await sleep(1000);
            queued = await comfyQueueLength(target);
        }
        if (queued !== 0) {
            const why = queued === null ? 'ComfyUI does not answer /queue' : `ComfyUI has ${queued} job(s) in its queue`;
            return { ok: false, message: `${why}; fast mode needs a restart (${summary}). Try again once it is idle.` };
        }
        if (isCancelled()) return CANCELLED;

        console.log(CAT, `launch flags differ (${summary}); restarting with [${desired.join(' ')}]`);
        onStatus({ key: restartKey, text: restartText, args: desired.length > 0 ? [shownFlags] : [] });
        // the dialog is only waited on for as long as a generation may stand still: an
        // unanswered one leaves the backend as it is instead of holding the run for good
        const restarted = await restartComfy(settings, { extraArgs: desired, approval: { waitMs: approvalWaitMs, isCancelled } });
        if (restarted.approvalPending) {
            // not remembered as unfixable: the user may allow the command in the dialog yet
            const message = `${restarted.message}; this run goes on with the flags the backend has`;
            console.warn(CAT, message);
            return { ok: true, skipped: 'launch command not answered', message };
        }
        if (restarted.notAllowed) {
            // the user refused the launch command: runs go on with the flags the backend has
            unfixable.set(signature, restarted.message);
            return { ok: true, skipped: 'launch command not allowed', message: restarted.message };
        }
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

    const after = await comfyArgv(target);
    if (!after) return { ok: true, restarted: true };  // unknown for now: judged again next run, not cached
    const check = compareLaunchArgs(after, desired, await removableFlags(target, after, desired));
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
    const target = comfyTarget(settings);
    const health = target ? await comfyHealth(target) : { ok: false };
    if (!shouldAutostart(settings, health)) return { skipped: true };
    console.log(CAT, 'autostart: ComfyUI is down, launching');
    const result = await startComfy(settings);
    console.log(CAT, 'autostart:', result.ok ? 'up' : `failed: ${result.message}`);
    return result;
}

// Work a Stop / Restart would cut short: jobs in ComfyUI's queue (another tab, a web client)
// and SAA's own local run. 0 when idle, or when ComfyUI does not answer.
async function backendJobs(settings) {
    const target = comfyTarget(settings);
    const queued = target ? await comfyQueueLength(target) : null;
    const generating = settings?.api_pod_ssh_enable !== true && await getMutexBackendBusy();
    return Math.max(queued ?? 0, generating ? 1 : 0);
}

export function registerComfyProcess(ipcMain, getSettings) {
    ipcMain.handle('comfy-process', async (event, args) => {
        const action = String(args?.action ?? 'state');
        try {
            const settings = getSettings();
            if (action === 'start') return await startComfy(settings);
            // the panel confirms before a Stop / Restart ends running work ({ force: true } then);
            // a Stop during a start only cancels that start
            if ((action === 'stop' || action === 'restart') && args?.force !== true && state.phase === 'idle') {
                const jobs = await backendJobs(settings);
                if (jobs > 0) return { ok: false, action, needsConfirm: true, jobs, running: true, message: `ComfyUI has ${jobs} job(s) running or queued` };
            }
            // `unverified`: the panel asked about the program holding the port and the user
            // said to end it anyway (a hung ComfyUI, or one started outside SAA)
            const unverified = args?.unverified === true;
            if (action === 'stop') return await stopComfy(settings, { unverified });
            if (action === 'restart') return await restartComfy(settings, { unverified });
            const target = comfyTarget(settings);
            const port = target?.port ?? null;
            const health = target ? await comfyHealth(target, 1000) : { ok: false };
            // the fast-mode launch flags the running backend has, so the panel can show them
            const managed = new Set([...managedLaunchFlags(settings), ...recordedFlags(port)]);
            const argv = health.ok && managed.size > 0 ? await comfyArgv(target, 1000) : null;
            const fastFlags = argv ? flagGroups(argv).filter(group => managed.has(group.flag)).map(group => [group.flag, ...group.values].join(' ')) : [];
            return { ok: true, action: 'state', ...comfyProcessState(), running: health.ok, port, fastFlags };
        } catch (error) {
            // no phase reset here: start / stop / restart release their own, and another one may be running
            return { ok: false, action, message: error?.message ?? String(error) };
        }
    });
}
