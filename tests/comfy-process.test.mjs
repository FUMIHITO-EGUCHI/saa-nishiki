// Behaviour of scripts/main/comfyProcess.js in plain node: electron, child_process and
// main-common are swapped for stubs through module hooks, ComfyUI is a local HTTP server
// on an ephemeral port, and netstat output comes from the test. Nothing is spawned or
// killed: the stubs only record what the module asked for.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import module from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const stub = {
    userData: fs.mkdtempSync(path.join(os.tmpdir(), 'saa-comfy-process-')),
    listeners: [],      // [{ pid, host, port }] the fake netstat reports
    killed: [],         // pids taskkill was asked to end
    spawned: [],        // FakeChild per spawn
    dialogs: 0,
    dialogResponse: 0,  // 0 = Run, 1 = Cancel
    dialogDelay: 0,     // how long the user takes to answer
    processNames: {},   // pid -> what the fake tasklist reports
    busy: false,        // SAA's generation mutex
    onKill: null,
    onSpawn: null,
    execCalls: [],      // { file, options } per execFile, to see what the module asked for
    killReply: null,    // what the fake taskkill answers with, when a test wants a failure
};
globalThis.__comfyProcessStub = stub;

class FakeChild extends EventEmitter {
    constructor(pid) {
        super();
        this.pid = pid;
    }

    unref() {}
}

function netstatText(listeners) {
    return ['  Proto  Local Address          Foreign Address        State           PID',
        ...listeners.map(({ pid, host, port }) => {
            const v6 = host.includes(':');
            return `  TCP    ${v6 ? `[${host}]` : host}:${port}    ${v6 ? '[::]:0' : '0.0.0.0:0'}    LISTENING    ${pid}`;
        })].join('\r\n');
}

stub.exec = (file, args, options) => {
    stub.execCalls.push({ file, options });
    if (file === 'netstat') return { stdout: netstatText(stub.listeners) };
    if (file === 'tasklist') {
        // tasklist /FI "PID eq <pid>" /FO CSV /NH
        const pid = Number(String(args[1]).replace(/\D/g, ''));
        const name = stub.processNames[pid];
        return { stdout: name ? `"${name}","${pid}","Console","1","2,345 K"` : 'INFO: No tasks are running which match the specified criteria.' };
    }
    if (file === 'taskkill') {
        const pid = Number(args[1]);
        stub.killed.push(pid);
        stub.onKill?.(pid);
        return stub.killReply ?? { stdout: 'SUCCESS' };
    }
    throw new Error(`the test does not run ${file}`);
};
let nextPid = 90_000_000;
stub.spawn = (file, args, options) => {
    const child = new FakeChild(nextPid++);
    child.spec = { file, args, options };
    stub.spawned.push(child);
    stub.onSpawn?.(child);
    return child;
};

const STUBS = {
    electron: `
        const stub = globalThis.__comfyProcessStub;
        export const app = { getPath: () => stub.userData };
        export const BrowserWindow = { getFocusedWindow: () => null, getAllWindows: () => [] };
        export const dialog = { showMessageBox: async () => {
            stub.dialogs++;
            // unref'd: a dialog a test deliberately leaves open must not hold the run open
            if (stub.dialogDelay > 0) await new Promise(resolve => { setTimeout(resolve, stub.dialogDelay).unref?.(); });
            return { response: stub.dialogResponse };
        } };`,
    child_process: `
        const stub = globalThis.__comfyProcessStub;
        export function execFile(file, args, options, callback) {
            let result;
            try { result = stub.exec(file, args, options); } catch (error) { result = { error }; }
            setImmediate(() => callback(result.error ?? null, result.stdout ?? '', result.stderr ?? ''));
        }
        export function spawn(file, args, options) { return stub.spawn(file, args, options); }`,
    main_common: 'export async function getMutexBackendBusy() { return globalThis.__comfyProcessStub.busy; }',
    probe: 'export const hooked = true;',
};
const stubUrl = name => `data:text/javascript,${encodeURIComponent(STUBS[name])}`;

const hooksAvailable = process.platform === 'win32' && typeof module.registerHooks === 'function';
if (hooksAvailable) {
    module.registerHooks({
        resolve(specifier, context, nextResolve) {
            const fromComfyProcess = String(context.parentURL ?? '').endsWith('/scripts/main/comfyProcess.js');
            if (specifier === 'saa-comfy-process-hook-probe') return { url: stubUrl('probe'), shortCircuit: true };
            if (fromComfyProcess && specifier === 'electron') return { url: stubUrl('electron'), shortCircuit: true };
            if (fromComfyProcess && specifier === 'node:child_process') return { url: stubUrl('child_process'), shortCircuit: true };
            if (fromComfyProcess && specifier === '../../main-common.js') return { url: stubUrl('main_common'), shortCircuit: true };
            return nextResolve(specifier, context);
        },
    });
}

// Only with the stubs in place is the module loaded at all: without them it would reach real processes.
let comfyProcess = null;
if (hooksAvailable) {
    const { hooked } = await import('saa-comfy-process-hook-probe');
    if (hooked === true) comfyProcess = await import('../scripts/main/comfyProcess.js');
}
const skip = comfyProcess ? false : 'needs Windows and node:module registerHooks';

// Every test gets an end of its own: a wait that never comes back fails this test instead of
// leaving `node --test` running for good (which in CI is no red build, just a job that never
// finishes). The http servers below are the other half of that — see closeOpenServers.
const opts = { skip, timeout: 30_000 };

async function freePort() {
    const server = http.createServer();
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    await new Promise(resolve => server.close(resolve));
    return port;
}

// Every fake backend still listening, closed after the test whatever happened in it. A
// failed assertion used to leave one open, and an open server keeps the test process alive:
// the run then hung instead of reporting the failure.
const openServers = new Set();

async function closeServer(server) {
    openServers.delete(server);
    server.closeAllConnections();
    await new Promise(resolve => server.close(() => resolve()));   // already closed: no error to make of it
}

async function closeOpenServers() {
    for (const server of [...openServers]) await closeServer(server);
}

// A ComfyUI stand-in: /system_stats (as ComfyUI, or 404 with `comfy: false`), /queue, /free.
async function fakeComfy(port, { comfy = true, argv = ['main.py'], queue = 0 } = {}) {
    const calls = [];
    const server = http.createServer((req, res) => {
        calls.push(`${req.method} ${req.url}`);
        req.resume();
        if (comfy && req.url === '/system_stats') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ system: { os: 'nt', argv }, devices: [] }));
        } else if (comfy && req.url === '/queue') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ queue_running: Array.from({ length: queue }, () => []), queue_pending: [] }));
        } else if (comfy && req.url === '/free') {
            req.on('end', () => { res.writeHead(200); res.end('{}'); });
        } else {
            res.writeHead(404);
            res.end('not here');
        }
    });
    // registered before it listens: a server a spawn hook starts is closed even when the
    // test it belongs to never gets hold of it
    openServers.add(server);
    await new Promise(resolve => server.listen(port, '127.0.0.1', resolve));
    return { calls, close: () => closeServer(server) };
}

function settingsFor(port, extra = {}) {
    return { api_interface: 'ComfyUI', api_addr: `127.0.0.1:${port}`, comfy_launch_command: 'C:\\wai-stack\\Start-Comfy.cmd', ...extra };
}

function approve(command) {
    const hash = createHash('sha256').update(command, 'utf8').digest('hex');
    fs.writeFileSync(path.join(stub.userData, 'comfy-launch-approved.json'), JSON.stringify({ approved: [hash] }));
}

function reset() {
    Object.assign(stub, { listeners: [], killed: [], spawned: [], dialogs: 0, dialogResponse: 0, dialogDelay: 0, processNames: {}, busy: false, onKill: null, onSpawn: null, execCalls: [], killReply: null });
    for (const file of ['comfy-launch-args.json', 'comfy-launch-approved.json']) fs.rmSync(path.join(stub.userData, file), { force: true });
    fs.rmSync(path.join(stub.userData, 'logs'), { recursive: true, force: true });
}

function readRecord() {
    return JSON.parse(fs.readFileSync(path.join(stub.userData, 'comfy-launch-args.json'), 'utf8'));
}

function writeRecord(record) {
    fs.writeFileSync(path.join(stub.userData, 'comfy-launch-args.json'), JSON.stringify(record));
}

async function until(check, timeoutMs = 10_000) {
    const deadline = Date.now() + timeoutMs;
    while (!check()) {
        if (Date.now() > deadline) throw new Error('timed out waiting');
        await new Promise(resolve => setTimeout(resolve, 20));
    }
}

// the fake backend goes away when taskkill is asked for its pid
function killEnds(pid, comfy) {
    stub.onKill = killedPid => {
        if (killedPid !== pid) return;
        stub.listeners = stub.listeners.filter(listener => listener.pid !== pid);
        comfy?.close();
    };
}

test.afterEach(async () => {
    stub.onSpawn = null;
    stub.onKill = null;
    await closeOpenServers();
});

test.after(async () => {
    await closeOpenServers();
    fs.rmSync(stub.userData, { recursive: true, force: true });
});

test('Stop ends the ComfyUI that answers, and leaves a listener on another address alone', opts, async () => {
    reset();
    const port = await freePort();
    const comfy = await fakeComfy(port);
    stub.listeners = [{ pid: 90_100_001, host: '127.0.0.1', port }, { pid: 90_100_002, host: '192.168.0.21', port }];
    killEnds(90_100_001, comfy);
    const result = await comfyProcess.stopComfy(settingsFor(port));
    assert.equal(result.ok, true, result.message);
    assert.deepEqual(stub.killed, [90_100_001]);
    assert.ok(comfy.calls.includes('POST /free'), 'the models are unloaded first');
});

test('Stop asks about a listener that does not answer as ComfyUI, and Start does not launch beside it', opts, async () => {
    reset();
    approve('C:\\wai-stack\\Start-Comfy.cmd');
    const port = await freePort();
    const other = await fakeComfy(port, { comfy: false });
    stub.listeners = [{ pid: 90_100_011, host: '0.0.0.0', port }];
    stub.processNames[90_100_011] = 'node.exe';
    try {
        const stopped = await comfyProcess.stopComfy(settingsFor(port));
        assert.equal(stopped.ok, false);
        assert.equal(stopped.needsUnverified, true, 'the panel asks instead of ending it unasked');
        assert.deepEqual(stopped.holders, [{ pid: 90_100_011, name: 'node.exe' }], 'the pid and the program are named');
        assert.match(stopped.message, /held by pid 90100011 \(node\.exe\), which does not answer as ComfyUI/);
        const started = await comfyProcess.startComfy(settingsFor(port));
        assert.equal(started.ok, false);
        assert.match(started.message, /not starting a second backend/);
        assert.deepEqual(stub.killed, []);
        assert.deepEqual(stub.spawned, []);
        assert.equal(other.calls.includes('POST /free'), false);
    } finally {
        await other.close();
    }
});

test('a hung ComfyUI is ended once the user allowed it, and SAA itself never is', opts, async () => {
    reset();
    const port = await freePort();
    // answers on TCP but never as ComfyUI: a backend hung in a model load, or someone else's program
    const hung = await fakeComfy(port, { comfy: false });
    stub.listeners = [{ pid: process.pid, host: '127.0.0.1', port }, { pid: 90_100_051, host: '127.0.0.1', port }];
    stub.processNames[90_100_051] = 'python.exe';
    killEnds(90_100_051, hung);
    try {
        const asked = await comfyProcess.stopComfy(settingsFor(port));
        assert.equal(asked.needsUnverified, true);
        assert.deepEqual(asked.holders.map(holder => holder.pid), [90_100_051], "SAA's own pid is not offered");
        const stopped = await comfyProcess.stopComfy(settingsFor(port), { unverified: true });
        assert.equal(stopped.ok, true, stopped.message);
        assert.deepEqual(stub.killed, [90_100_051], 'only the pid the user was shown');
        assert.match(stopped.message, new RegExp(`pid ${process.pid} left alone`));
    } finally {
        await hung.close();
    }
});

test('a launch record whose launcher is gone does not block Start for long', opts, async () => {
    reset();
    approve('C:\\wai-stack\\Start-Comfy.cmd');
    const port = await freePort();
    // SAA was closed during a start: the launcher pid is nowhere any more
    writeRecord({ port, pids: [], args: [], launcher: 999_999_999, at: new Date(Date.now() - 30_000).toISOString() });
    let comfy = null;
    stub.onSpawn = child => {
        fakeComfy(port).then(server => {
            comfy = server;
            stub.listeners = [{ pid: child.pid + 1, host: '127.0.0.1', port }];
        });
    };
    try {
        const started = await comfyProcess.startComfy(settingsFor(port));
        assert.equal(started.ok, true, started.message);
        assert.equal(stub.spawned.length, 1);
    } finally {
        await comfy?.close();
    }
});

test('Stop clears a pending record another SAA session left behind', opts, async () => {
    reset();
    approve('C:\\wai-stack\\Start-Comfy.cmd');
    const port = await freePort();
    // its launcher is still running (a start script waiting for a backend that never came up),
    // so the record would refuse every Start for ten minutes; SAA must not end a foreign pid
    writeRecord({ port, pids: [], args: [], launcher: process.pid, at: new Date(Date.now() - 30_000).toISOString() });
    const blocked = await comfyProcess.startComfy(settingsFor(port));
    assert.equal(blocked.ok, false);
    assert.match(blocked.message, /Stop ends it/);
    const stopped = await comfyProcess.stopComfy(settingsFor(port));
    assert.equal(stopped.ok, true, stopped.message);
    assert.deepEqual(stub.killed, [], 'the launcher of another session is never killed by pid');
    assert.equal(readRecord().ended, true);

    let comfy = null;
    stub.onSpawn = child => {
        fakeComfy(port).then(server => {
            comfy = server;
            stub.listeners = [{ pid: child.pid + 1, host: '127.0.0.1', port }];
        });
    };
    try {
        const started = await comfyProcess.startComfy(settingsFor(port));
        assert.equal(started.ok, true, started.message);
    } finally {
        await comfy?.close();
    }
});

test('a launch log still held by the previous launch is waited for, not given up on', opts, async () => {
    reset();
    approve('C:\\wai-stack\\Start-Comfy.cmd');
    const port = await freePort();
    // a log that cannot be opened for writing stands in for the PowerShell of the last launch
    // still holding it (Out-File keeps it to itself): every open fails until it lets go
    const log = path.join(stub.userData, 'logs', 'comfy-launch.log');
    fs.mkdirSync(path.dirname(log), { recursive: true });
    fs.writeFileSync(log, '');
    fs.chmodSync(log, 0o444);
    setTimeout(() => fs.chmodSync(log, 0o666), 250);
    let comfy = null;
    stub.onSpawn = child => {
        fakeComfy(port).then(server => {
            comfy = server;
            stub.listeners = [{ pid: child.pid + 1, host: '127.0.0.1', port }];
        });
    };
    try {
        const started = await comfyProcess.startComfy(settingsFor(port));
        assert.equal(started.ok, true, started.message);
        assert.equal(stub.spawned.length, 1);
        assert.ok(fs.readFileSync(log, 'utf8').includes('start:'), 'the launch is written to the log that came free');
    } finally {
        await comfy?.close();
    }
});

test('an unanswered launch command dialog lets the generation go on instead of holding it', opts, async () => {
    reset();
    const port = await freePort();
    const comfy = await fakeComfy(port, { argv: ['main.py', '--port', String(port)] });
    stub.listeners = [{ pid: 90_100_061, host: '127.0.0.1', port }];
    stub.dialogDelay = 3000;      // the user does not answer
    stub.dialogResponse = 1;      // and says no in the end, so nothing is remembered
    try {
        // its own command, so the dialog this test leaves open belongs to no other test
        const settings = settingsFor(port, { comfy_launch_command: 'C:\\wai-stack\\Slow-Comfy.cmd', api_fast_enable: true, api_fast_diff_comfy_args: '--fast' });
        const started = Date.now();
        const result = await comfyProcess.ensureComfyLaunchArgs(settings, { diffusion: true, approvalWaitMs: 1000 });
        assert.equal(result.ok, true, 'the run goes on with the flags the backend has');
        assert.equal(result.skipped, 'launch command not answered');
        assert.ok(Date.now() - started < 9000, `waited ${Date.now() - started} ms`);
        assert.deepEqual(stub.killed, [], 'nothing is stopped while the dialog is open');
        assert.deepEqual(stub.spawned, []);
    } finally {
        await comfy.close();
    }
});

test("Stop never ends SAA's own process, even when the port answers as ComfyUI", opts, async () => {
    reset();
    const port = await freePort();
    const comfy = await fakeComfy(port);
    stub.listeners = [{ pid: process.pid, host: '127.0.0.1', port }];
    try {
        const result = await comfyProcess.stopComfy(settingsFor(port));
        assert.equal(result.ok, false);
        assert.match(result.message, /SAA itself/);
        assert.deepEqual(stub.killed, []);
    } finally {
        await comfy.close();
    }
});

test('two starts at once launch once; the launch command is asked for once and remembered', opts, async () => {
    reset();
    const port = await freePort();
    let comfy = null;
    stub.onSpawn = child => {
        fakeComfy(port).then(server => {
            comfy = server;
            stub.listeners = [{ pid: child.pid + 1, host: '127.0.0.1', port }];
        });
    };
    const [first, second] = await Promise.all([comfyProcess.startComfy(settingsFor(port)), comfyProcess.startComfy(settingsFor(port))]);
    try {
        assert.equal(first.ok, true, first.message);
        assert.match(second.message, /^busy: starting/);
        assert.equal(stub.spawned.length, 1);
        assert.equal(stub.dialogs, 1);
        const record = JSON.parse(fs.readFileSync(path.join(stub.userData, 'comfy-launch-args.json'), 'utf8'));
        assert.deepEqual(record.pids, [stub.spawned[0].pid + 1], 'the record names the listener that came up');

        // a later restart runs the same command without asking again
        killEnds(stub.spawned[0].pid + 1, comfy);
        stub.onSpawn = child => {
            fakeComfy(port).then(server => {
                comfy = server;
                stub.listeners = [{ pid: child.pid + 1, host: '127.0.0.1', port }];
            });
        };
        const restarted = await comfyProcess.restartComfy(settingsFor(port));
        assert.equal(restarted.ok, true, restarted.message);
        assert.equal(stub.dialogs, 1);
        assert.equal(stub.spawned.length, 2);
    } finally {
        await comfy?.close();
    }
});

test('a launch command the user does not allow never runs, and Restart then stops nothing', opts, async () => {
    reset();
    stub.dialogResponse = 1;
    const port = await freePort();
    const started = await comfyProcess.startComfy(settingsFor(port));
    assert.equal(started.ok, false);
    assert.equal(started.notAllowed, true);
    assert.deepEqual(stub.spawned, []);

    const comfy = await fakeComfy(port);
    stub.listeners = [{ pid: 90_100_021, host: '127.0.0.1', port }];
    try {
        const restarted = await comfyProcess.restartComfy(settingsFor(port));
        assert.equal(restarted.notAllowed, true);
        assert.deepEqual(stub.killed, []);
        assert.equal(comfy.calls.includes('POST /free'), false);
        assert.equal(stub.dialogs, 2);
    } finally {
        await comfy.close();
    }
});

test('Stop during a start cancels it and ends the launcher; the next start is not blocked', opts, async () => {
    reset();
    approve('C:\\wai-stack\\Start-Comfy.cmd');
    const port = await freePort();
    const starting = comfyProcess.startComfy(settingsFor(port));
    await until(() => stub.spawned.length === 1);
    const stopped = await comfyProcess.stopComfy(settingsFor(port));
    const started = await starting;
    assert.equal(started.cancelled, true);
    assert.deepEqual(stub.killed, [stub.spawned[0].pid], 'the launcher tree is ended');
    assert.equal(stopped.ok, true, stopped.message);
    const record = JSON.parse(fs.readFileSync(path.join(stub.userData, 'comfy-launch-args.json'), 'utf8'));
    assert.equal(record.ended, true);

    let comfy = null;
    stub.onSpawn = child => {
        fakeComfy(port).then(server => {
            comfy = server;
            stub.listeners = [{ pid: child.pid + 1, host: '127.0.0.1', port }];
        });
    };
    try {
        const again = await comfyProcess.startComfy(settingsFor(port));
        assert.equal(again.ok, true, again.message);
    } finally {
        await comfy?.close();
    }
});

test('a start another SAA session recorded moments ago is not launched a second time', opts, async () => {
    reset();
    approve('C:\\wai-stack\\Start-Comfy.cmd');
    const port = await freePort();
    fs.writeFileSync(path.join(stub.userData, 'comfy-launch-args.json'), JSON.stringify({ port, pids: [], args: [], launcher: 0, at: new Date().toISOString() }));
    const started = await comfyProcess.startComfy(settingsFor(port));
    assert.equal(started.ok, false);
    assert.match(started.message, /may still bring ComfyUI up/);
    assert.deepEqual(stub.spawned, []);
});

test('flags are only blamed when the launcher itself failed', opts, async () => {
    reset();
    approve('C:\\wai-stack\\Start-Comfy.cmd');
    const port = await freePort();
    // the launcher could not run at all: no second launch without the flags
    stub.onSpawn = child => setImmediate(() => child.emit('error', new Error('spawn cmd.exe ENOENT')));
    const broken = await comfyProcess.startComfy(settingsFor(port), { extraArgs: ['--fast'] });
    assert.equal(broken.ok, false);
    assert.equal(broken.flagsFailed, undefined);
    assert.equal(stub.spawned.length, 1);

    // the launcher exited 1 with the flags: ComfyUI comes back without them
    let comfy = null;
    stub.onSpawn = child => {
        if (child.spec.options.windowsVerbatimArguments && child.spec.args.at(-1).includes('--fast')) {
            setImmediate(() => child.emit('exit', 1, null));
            return;
        }
        fakeComfy(port).then(server => {
            comfy = server;
            stub.listeners = [{ pid: child.pid + 1, host: '127.0.0.1', port }];
        });
    };
    try {
        const fallback = await comfyProcess.startComfy(settingsFor(port), { extraArgs: ['--fast'] });
        assert.deepEqual(fallback.flagsFailed, ['--fast']);
        assert.equal(fallback.running, true);
        assert.equal(stub.spawned.length, 3);
    } finally {
        await comfy?.close();
    }
});

test("a web client's run does not restart ComfyUI for its flags", opts, async () => {
    reset();
    approve('C:\\wai-stack\\Start-Comfy.cmd');
    const port = await freePort();
    const comfy = await fakeComfy(port, { argv: ['main.py', '--port', String(port)] });
    stub.listeners = [{ pid: 90_100_031, host: '127.0.0.1', port }];
    try {
        const settings = settingsFor(port, { api_fast_enable: true, api_fast_diff_comfy_args: '--fast' });
        const result = await comfyProcess.ensureComfyLaunchArgs(settings, { diffusion: true, remote: true });
        assert.equal(result.ok, true);
        assert.equal(result.skipped, 'web client');
        assert.deepEqual(stub.killed, []);
        assert.deepEqual(stub.spawned, []);
    } finally {
        await comfy.close();
    }
});

test('no address, no processes to look for: nothing is run at all', opts, async () => {
    reset();
    for (const target of [null, undefined]) {
        assert.deepEqual(await comfyProcess.listenerPids(target), []);
    }
    assert.deepEqual(stub.execCalls, [], 'netstat is not run without an address to look up');
    // and the same the other way round: the settings decide, not a leftover address
    const stopped = await comfyProcess.stopComfy({ api_addr: '192.168.0.21:8188' });
    assert.equal(stopped.ok, false);
    assert.match(stopped.message, /not a loopback address/);
    assert.deepEqual(stub.execCalls, []);
});

test('every helper process is run without a console window of its own', opts, async () => {
    reset();
    const port = await freePort();
    const comfy = await fakeComfy(port);
    stub.listeners = [{ pid: 90_100_071, host: '127.0.0.1', port }, { pid: 90_100_072, host: '0.0.0.0', port }];
    stub.processNames[90_100_072] = 'python.exe';
    killEnds(90_100_071, comfy);
    try {
        // a stop that looks the listeners up (netstat), names one (tasklist) and ends one (taskkill)
        await comfyProcess.stopComfy(settingsFor(port));
        const files = new Set(stub.execCalls.map(call => call.file));
        assert.deepEqual([...files].sort(), ['netstat', 'taskkill']);
        for (const call of stub.execCalls) {
            assert.equal(call.options?.windowsHide, true, `${call.file} would flash a console window`);
        }
        // netstat -ano on a busy machine is long: its output must not be cut off, or a
        // listener of ours would be missed and the backend left running
        const netstat = stub.execCalls.find(call => call.file === 'netstat');
        assert.ok(netstat.options.maxBuffer >= 64 * 1024 * 1024, `maxBuffer ${netstat.options.maxBuffer}`);
    } finally {
        await comfy.close();
    }
});

test('a taskkill that reports a failure is judged by the port, not by what it printed', opts, async () => {
    reset();
    const port = await freePort();
    const comfy = await fakeComfy(port);
    stub.listeners = [{ pid: 90_100_081, host: '127.0.0.1', port }];
    // a Japanese Windows says its own "there is no such process", in its own code page: the
    // stop is not decided on that line, it is decided on the port going quiet
    stub.killReply = { error: new Error('Command failed: taskkill'), stderr: 'エラー: PID 90100081 のプロセスが見つかりませんでした。' };
    killEnds(90_100_081, comfy);
    try {
        const stopped = await comfyProcess.stopComfy(settingsFor(port));
        assert.equal(stopped.ok, true, stopped.message);
        assert.deepEqual(stub.killed, [90_100_081]);
    } finally {
        await comfy.close();
    }
});

test('the launch log is moved aside once it grows past its limit, and not a byte before', opts, async () => {
    reset();
    approve('C:\\wai-stack\\Start-Comfy.cmd');
    const port = await freePort();
    const log = path.join(stub.userData, 'logs', 'comfy-launch.log');
    const previous = path.join(stub.userData, 'logs', 'comfy-launch.previous.log');
    fs.mkdirSync(path.dirname(log), { recursive: true });
    // the launcher gives up at once: this start is only here for the log it writes
    stub.onSpawn = child => setImmediate(() => child.emit('exit', 1, null));
    const limit = 4 * 1024 * 1024;

    fs.writeFileSync(log, Buffer.alloc(limit));
    await comfyProcess.startComfy(settingsFor(port));
    assert.equal(fs.existsSync(previous), false, 'a log exactly at the limit is still the one in use');
    assert.ok(fs.statSync(log).size > limit, 'and the launch was written to its end');

    fs.writeFileSync(log, Buffer.alloc(limit + 1));
    await comfyProcess.startComfy(settingsFor(port));
    assert.equal(fs.existsSync(previous), true, 'one byte more and it is kept as the previous log');
    assert.equal(fs.statSync(previous).size, limit + 1);
    assert.ok(fs.statSync(log).size < 4096, `the launch starts a new log (${fs.statSync(log).size} bytes)`);
});

test('the panel is asked to confirm before Stop ends running jobs', opts, async () => {
    reset();
    const port = await freePort();
    const comfy = await fakeComfy(port, { queue: 2 });
    stub.listeners = [{ pid: 90_100_041, host: '127.0.0.1', port }];
    killEnds(90_100_041, comfy);
    const handlers = {};
    comfyProcess.registerComfyProcess({ handle: (name, handler) => { handlers[name] = handler; } }, () => settingsFor(port));
    const asked = await handlers['comfy-process']({}, { action: 'stop' });
    assert.equal(asked.needsConfirm, true);
    assert.equal(asked.jobs, 2);
    assert.deepEqual(stub.killed, []);
    const forced = await handlers['comfy-process']({}, { action: 'stop', force: true });
    assert.equal(forced.ok, true, forced.message);
    assert.deepEqual(stub.killed, [90_100_041]);
});
