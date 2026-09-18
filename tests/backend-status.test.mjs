// The header status pills: the renderer-side formatting (statusPills.js) and the
// main-side probe (scripts/main/backendStatus.js). The probe is run for real - electron's
// `net` and the pod SSH transport are swapped for stubs through module hooks, and the
// requests go to a local HTTP server on an ephemeral port. Nothing but that server is
// contacted: the electron stub throws if the module ever reaches for it.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import module from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { formatBackendStatus, setupStatusPills } from '../scripts/renderer/components/statusPills.js';
import { withFakeDom } from './helpers/fakeDom.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8').replace(/\r\n/g, '\n');

// ------------------------------------------------------------------ module stubs

const pod = {
    sshEnabled: false,
    session: 'off',
    health: { ok: true, stats: null, message: '' },
    ollama: { ok: true },
    ollamaCalls: [],
    netRequest: null,   // set by the one test that drives the IPC handler, which passes no transport of its own
};
globalThis.__backendStatusPodStub = pod;

const STUBS = {
    electron: `
        const stub = globalThis.__backendStatusPodStub;
        export const net = { request: options => {
            if (!stub.netRequest) throw new Error('the test never lets the probe use electron net');
            return stub.netRequest(options);
        } };`,
    podSsh: `
        const stub = globalThis.__backendStatusPodStub;
        export function isPodSshEnabled() { return stub.sshEnabled; }
        export function podSessionState() { return stub.session; }
        export async function podComfyHealth() { return stub.health; }
        export async function podOllamaRequest(options) { stub.ollamaCalls.push(options); return stub.ollama; }`,
    probe: 'export const hooked = true;',
};
const stubUrl = name => `data:text/javascript,${encodeURIComponent(STUBS[name])}`;

const hooksAvailable = typeof module.registerHooks === 'function';
if (hooksAvailable) {
    module.registerHooks({
        resolve(specifier, context, nextResolve) {
            const fromBackendStatus = String(context.parentURL ?? '').endsWith('/scripts/main/backendStatus.js');
            if (specifier === 'saa-backend-status-hook-probe') return { url: stubUrl('probe'), shortCircuit: true };
            if (fromBackendStatus && specifier === 'electron') return { url: stubUrl('electron'), shortCircuit: true };
            if (fromBackendStatus && specifier === './podSshTransport.js') return { url: stubUrl('podSsh'), shortCircuit: true };
            return nextResolve(specifier, context);
        },
    });
}

// Only with the stubs in place is the module imported at all.
let backendStatus = null;
if (hooksAvailable) {
    const { hooked } = await import('saa-backend-status-hook-probe');
    if (hooked === true) backendStatus = await import('../scripts/main/backendStatus.js');
}
const opts = { skip: backendStatus ? false : 'needs node:module registerHooks', timeout: 20_000 };

// ------------------------------------------------------------------ local backend

const openServers = new Set();

async function closeServer(server) {
    openServers.delete(server);
    server.closeAllConnections();
    await new Promise(resolve => server.close(() => resolve()));
}

test.afterEach(async () => {
    for (const server of [...openServers]) await closeServer(server);
    pod.sshEnabled = false;
    pod.session = 'off';
    pod.health = { ok: true, stats: null, message: '' };
    pod.ollama = { ok: true };
    pod.ollamaCalls = [];
    pod.netRequest = null;
});

// Answers for the paths the probe knows; `seen` records every request that arrived.
async function startBackend(routes) {
    const seen = [];
    const server = http.createServer((request, response) => {
        seen.push({ method: request.method, url: request.url, headers: request.headers });
        const route = routes[request.url.split('?')[0]];
        if (typeof route === 'function') { route(request, response); return; }
        if (route === undefined) { response.writeHead(404).end('{}'); return; }
        response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(route));
    });
    openServers.add(server);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    return { server, seen, port: server.address().port, address: `127.0.0.1:${server.address().port}` };
}

// The seam backendStatus.getJson() leaves open: every probe goes through here, so the
// test sees the exact method / url / headers it asked for, and the socket goes to the
// local server whatever host the url names.
function transportTo(port) {
    const asked = [];
    return {
        asked,
        request: ({ method, url, headers, timeout }) => {
            asked.push({ method, url, headers: headers ?? {} });
            const target = new URL(url);
            return http.request({ host: '127.0.0.1', port, method, path: `${target.pathname}${target.search}`, headers, timeout });
        },
    };
}

const SYSTEM_STATS = {
    system: { comfyui_version: '0.28.0' },
    devices: [{ name: 'NVIDIA RTX 4070', vram_total: 12 * 1024 * 1024 * 1024, vram_free: 10 * 1024 * 1024 * 1024 }],
};

// ------------------------------------------------------------------ renderer side

test('pills: ComfyUI ok with VRAM, busy while a prompt runs, warn then red after repeated failures', () => {
  const ok = formatBackendStatus({ comfy: { configured: true, ok: true, address: '127.0.0.1:8189', vramUsedMiB: 1638, vramTotalMiB: 12282, version: '0.28.0', running: 0 }, ollama: { configured: true, ok: true, mode: 'Small' } });
  assert.deepEqual(ok.map(p => [p.id, p.state, p.label]), [
    ['comfy', 'ok', 'ComfyUI 127.0.0.1:8189 · VRAM 1.6 / 12.0 GB'],
    ['ollama', 'ok', 'Ollama · Small'],
  ]);
  assert.equal(ok[0].title, 'ComfyUI 0.28.0');

  const busy = formatBackendStatus({ comfy: { configured: true, ok: true, address: 'x', running: 1 } });
  assert.equal(busy[0].state, 'busy');

  const down1 = formatBackendStatus({ comfy: { configured: true, ok: false, address: '127.0.0.1:8199', error: 'ECONNREFUSED' } }, { failures: 1 });
  assert.equal(down1[0].state, 'warn');
  assert.equal(down1[0].label, 'ComfyUI 127.0.0.1:8199 · no answer');
  const down3 = formatBackendStatus({ comfy: { configured: true, ok: false, address: 'x' }, ollama: { configured: true, ok: false } }, { failures: 3 });
  assert.deepEqual(down3.map(p => p.state), ['bad', 'bad']);
});

test('pills: nothing for Ollama when the AI is not Local; ComfyUI pill says "not set" for non-loopback addresses', () => {
  const pills = formatBackendStatus({ comfy: { configured: false, address: '192.168.0.5:8188' }, ollama: { configured: false } });
  assert.deepEqual(pills.map(p => [p.id, p.state]), [['comfy', 'off']]);
  assert.deepEqual(formatBackendStatus(null), []);
});

test('pills: a pod-backed Ollama is labeled as Pod', () => {
  const pills = formatBackendStatus({ ollama: { configured: true, ok: true, remote: true, mode: 'Auto' } });
  assert.deepEqual(pills.map(p => [p.id, p.state, p.label]), [['ollama', 'ok', 'Ollama · Pod · Auto']]);
});

test('pills: pod-routed ComfyUI shows Pod state instead of the local address', () => {
  const connected = formatBackendStatus({ comfy: { pod: true, configured: true, ok: true, podState: 'connected', address: 'x@ssh.runpod.io', vramUsedMiB: 10342, vramTotalMiB: 24564 } });
  assert.deepEqual(connected.map(p => [p.id, p.state, p.label]), [['comfy', 'ok', 'ComfyUI · Pod · VRAM 10.1 / 24.0 GB']]);
  assert.equal(connected[0].title, 'x@ssh.runpod.io');
  const standby = formatBackendStatus({ comfy: { pod: true, configured: true, ok: true, podState: 'off' } });
  assert.deepEqual(standby.map(p => [p.state, p.label]), [['off', 'ComfyUI · Pod · standby']]);
  const connecting = formatBackendStatus({ comfy: { pod: true, configured: true, ok: true, podState: 'connecting' } });
  assert.deepEqual(connecting.map(p => [p.state, p.label]), [['busy', 'ComfyUI · Pod · connecting']]);
});

// ------------------------------------------------------------------ origins

test('probeOrigin: loopback over any scheme, remote only over https', opts, () => {
    const { loopbackOrigin, probeOrigin } = backendStatus;
    for (const [input, expected] of [
        ['127.0.0.1:8188', 'http://127.0.0.1:8188'],
        ['http://localhost:8188', 'http://localhost:8188'],
        ['https://127.0.0.1:8188', 'https://127.0.0.1:8188'],
        ['http://[::1]:8188', 'http://[::1]:8188'],
        ['  127.0.0.1:8188  ', 'http://127.0.0.1:8188'],
    ]) assert.equal(loopbackOrigin(input), expected, input);
    for (const input of ['192.168.0.5:8188', 'https://x-8188.proxy.runpod.net', '', null, 'not a url']) {
        assert.equal(loopbackOrigin(input), null, `${input} is not loopback`);
    }

    assert.equal(probeOrigin('127.0.0.1:8188'), 'http://127.0.0.1:8188');
    assert.equal(probeOrigin('https://x-8188.proxy.runpod.net'), 'https://x-8188.proxy.runpod.net');
    assert.equal(probeOrigin('https://x-8188.proxy.runpod.net/api/'), 'https://x-8188.proxy.runpod.net', 'the path is dropped');
    for (const input of ['192.168.0.5:8188', 'http://192.168.0.5:8188', 'http://example.com', 'ftp://example.com', '']) {
        assert.equal(probeOrigin(input), null, `${input} is refused`);
    }
});

test('summarizeSystemStats turns ComfyUI bytes into the MiB the pill shows', opts, () => {
    assert.deepEqual(backendStatus.summarizeSystemStats(SYSTEM_STATS), {
        version: '0.28.0',
        deviceName: 'NVIDIA RTX 4070',
        vramTotalMiB: 12_288,
        vramUsedMiB: 2048,
    });
    assert.deepEqual(backendStatus.summarizeSystemStats(null), { version: null, deviceName: null, vramTotalMiB: null, vramUsedMiB: null });
    assert.deepEqual(backendStatus.summarizeSystemStats({ devices: [{ vram_total: 'x', vram_free: 1 }] }).vramTotalMiB, null);
});

// ------------------------------------------------------------------ the probe over HTTP

test('a local ComfyUI is asked for /system_stats and /queue, with GETs and nothing else', opts, async () => {
    const backend = await startBackend({
        '/system_stats': SYSTEM_STATS,
        '/queue': { queue_running: [{ id: 1 }], queue_pending: [{ id: 2 }, { id: 3 }] },
    });
    const transport = transportTo(backend.port);
    const result = await backendStatus.probeBackends({ api_interface: 'ComfyUI', api_addr: backend.address }, transport);

    assert.deepEqual(result.comfy, {
        configured: true,
        ok: true,
        address: backend.address,
        version: '0.28.0',
        deviceName: 'NVIDIA RTX 4070',
        vramTotalMiB: 12_288,
        vramUsedMiB: 2048,
        running: 1,
        pending: 2,
    });
    assert.deepEqual(backend.seen.map(entry => [entry.method, entry.url]), [['GET', '/system_stats'], ['GET', '/queue']]);
    assert.deepEqual([...new Set(transport.asked.map(entry => entry.method))], ['GET'], 'the probe never asks for anything but a GET');
    assert.deepEqual(transport.asked.map(entry => entry.url), [`http://${backend.address}/system_stats`, `http://${backend.address}/queue`]);
    assert.equal(result.ollama.configured, false, 'no AI backend was configured');
});

test('a ComfyUI that answers badly is reported down, and the queue is not asked for', opts, async () => {
    const backend = await startBackend({ '/system_stats': (request, response) => response.writeHead(503).end('busy') });
    const transport = transportTo(backend.port);
    const result = await backendStatus.probeBackends({ api_interface: 'ComfyUI', api_addr: backend.address }, transport);
    assert.equal(result.comfy.ok, false);
    assert.equal(result.comfy.error, 'HTTP 503');
    assert.deepEqual(backend.seen.map(entry => entry.url), ['/system_stats']);
});

test('a ComfyUI that never answers times out instead of hanging the probe', opts, async () => {
    const backend = await startBackend({ '/system_stats': () => { /* never answers */ } });
    const transport = transportTo(backend.port);
    const result = await backendStatus.probeBackends({ api_interface: 'ComfyUI', api_addr: backend.address }, { ...transport, timeout: 120 });
    assert.equal(result.comfy.ok, false);
    assert.equal(result.comfy.error, 'timeout');
});

test('a remote ComfyUI address is only probed over https, and never over plain http', opts, async () => {
    const backend = await startBackend({ '/system_stats': SYSTEM_STATS, '/queue': {} });

    const plain = transportTo(backend.port);
    const refused = await backendStatus.probeBackends({ api_interface: 'ComfyUI', api_addr: 'http://192.168.0.5:8188' }, plain);
    assert.equal(refused.comfy.configured, false, 'a remote http address is not a backend to probe');
    assert.equal(refused.comfy.address, 'http://192.168.0.5:8188', 'but it is still shown, so the pill can say "not set"');
    assert.deepEqual(plain.asked, [], 'and nothing was sent');

    const secure = transportTo(backend.port);
    const allowed = await backendStatus.probeBackends({ api_interface: 'ComfyUI', api_addr: 'https://abc-8188.proxy.runpod.net' }, secure);
    assert.equal(allowed.comfy.configured, true);
    assert.equal(allowed.comfy.ok, true);
    assert.equal(allowed.comfy.address, 'abc-8188.proxy.runpod.net');
    assert.deepEqual(secure.asked.map(entry => entry.url), [
        'https://abc-8188.proxy.runpod.net/system_stats',
        'https://abc-8188.proxy.runpod.net/queue',
    ]);
    assert.ok(secure.asked.every(entry => entry.url.startsWith('https://')));
});

test('the configured WebUI auth travels with the ComfyUI probe, and only when it is on', opts, async () => {
    const backend = await startBackend({ '/system_stats': SYSTEM_STATS, '/queue': {} });
    const settings = { api_interface: 'ComfyUI', api_addr: backend.address, webui_auth: 'saac_user:secret', webui_auth_enable: 'OFF' };

    const off = transportTo(backend.port);
    await backendStatus.probeBackends(settings, off);
    assert.deepEqual(off.asked[0].headers, {}, 'the auth is off, so no header is sent');

    const on = transportTo(backend.port);
    await backendStatus.probeBackends({ ...settings, webui_auth_enable: 'ON' }, on);
    const expected = `Basic ${Buffer.from('saac_user:secret').toString('base64')}`;
    assert.deepEqual(on.asked.map(entry => entry.headers.Authorization), [expected, expected]);
    assert.equal(backend.seen.at(-1).headers.authorization, expected, 'and it reached the server');
});

test('a local Ollama is asked for /api/tags; a non-loopback ai_local_addr is not asked at all', opts, async () => {
    const backend = await startBackend({ '/api/tags': { models: [{ name: 'gemma3' }] } });

    const local = transportTo(backend.port);
    const result = await backendStatus.probeBackends({ ai_interface: 'Local', ai_local_addr: backend.address, ai_local_model_mode: 'Small' }, local);
    assert.deepEqual(result.ollama, { configured: true, ok: true, remote: false, mode: 'Small' });
    assert.deepEqual(local.asked.map(entry => [entry.method, entry.url]), [['GET', `http://${backend.address}/api/tags`]]);

    const remote = transportTo(backend.port);
    const refused = await backendStatus.probeBackends({ ai_interface: 'Local', ai_local_addr: '192.168.0.5:11434' }, remote);
    assert.equal(refused.ollama.configured, false);
    assert.deepEqual(remote.asked, []);
});

test('a Pod Ollama over https carries ai_pod_auth; a down one keeps the error', opts, async () => {
    const backend = await startBackend({ '/api/tags': (request, response) => response.writeHead(401).end('{}') });
    const transport = transportTo(backend.port);
    const result = await backendStatus.probeBackends({
        ai_interface: 'Pod',
        ai_pod_addr: 'https://abc-11434.proxy.runpod.net',
        ai_pod_auth: 'pod-token',
        ai_local_model_mode: 'Auto',
    }, transport);
    assert.equal(result.ollama.configured, true);
    assert.equal(result.ollama.remote, true);
    assert.equal(result.ollama.ok, false);
    assert.equal(result.ollama.error, 'HTTP 401');
    assert.deepEqual(transport.asked.map(entry => [entry.method, entry.url, entry.headers.Authorization]), [
        ['GET', 'https://abc-11434.proxy.runpod.net/api/tags', 'Bearer pod-token'],
    ]);
});

// ------------------------------------------------------------------ the pod SSH branch

test('with pod SSH on, the status never opens a connection: an idle relay is standby', opts, async () => {
    const backend = await startBackend({ '/system_stats': SYSTEM_STATS, '/queue': {} });
    const transport = transportTo(backend.port);
    pod.sshEnabled = true;
    pod.session = 'off';
    const result = await backendStatus.probeBackends({
        api_interface: 'ComfyUI',
        api_addr: backend.address,          // would report the wrong GPU if it were probed
        api_pod_ssh_target: 'root@ssh.runpod.io',
    }, transport);

    assert.deepEqual(result.comfy, { configured: true, ok: true, pod: true, podState: 'off', address: 'root@ssh.runpod.io' });
    assert.deepEqual(transport.asked, [], 'api_addr is not probed while the pod carries the run');
    assert.deepEqual(backend.seen, []);
});

test('a connected relay reports the pod GPU, and a dead ComfyUI behind it is its own state', opts, async () => {
    const transport = transportTo(0);
    pod.sshEnabled = true;
    pod.session = 'connected';
    pod.health = { ok: true, stats: SYSTEM_STATS };
    const settings = { api_interface: 'ComfyUI', api_addr: '127.0.0.1:8188', api_pod_ssh_target: 'root@ssh.runpod.io' };

    const up = await backendStatus.probeBackends(settings, transport);
    assert.equal(up.comfy.ok, true);
    assert.equal(up.comfy.podState, 'connected');
    assert.equal(up.comfy.vramTotalMiB, 12_288);
    assert.equal(up.comfy.vramUsedMiB, 2048);

    pod.health = { ok: false, stats: null, message: 'ComfyUI is not answering on the pod' };
    const down = await backendStatus.probeBackends(settings, transport);
    assert.equal(down.comfy.ok, false);
    assert.equal(down.comfy.error, 'ComfyUI is not answering on the pod');
    assert.deepEqual(transport.asked, [], 'the health comes over the relay, never over a new connection');
});

test('an Ollama behind the SSH relay is asked through the relay, and is standby while it is closed', opts, async () => {
    const transport = transportTo(0);
    const settings = { ai_interface: 'Pod', api_pod_ssh_enable: true, api_pod_ssh_target: 'root@ssh.runpod.io', ai_local_model_mode: 'Auto' };

    pod.session = 'connected';
    pod.ollama = { ok: true };
    const up = await backendStatus.probeBackends(settings, transport);
    assert.deepEqual(up.ollama, { configured: true, ok: true, remote: true, mode: 'Auto' });
    assert.deepEqual(pod.ollamaCalls.map(call => [call.method, call.path]), [['GET', '/api/tags']]);

    pod.session = 'off';
    pod.ollamaCalls = [];
    const idle = await backendStatus.probeBackends(settings, transport);
    assert.deepEqual(idle.ollama, { configured: true, ok: false, remote: true, mode: 'Auto', standby: true, error: 'pod relay not connected' });
    assert.deepEqual(pod.ollamaCalls, [], 'a status poll never dials the pod');
    assert.deepEqual(transport.asked, []);
});

// ------------------------------------------------------------------ the IPC handler

test('registerBackendStatus answers the renderer, and a failed probe is an empty status rather than a throw', opts, async () => {
    const backend = await startBackend({ '/system_stats': SYSTEM_STATS, '/queue': {} });
    const handlers = new Map();
    const ipcMain = { handle: (channel, handler) => handlers.set(channel, handler) };

    // the handler passes no transport, so this is the one probe that goes through the
    // `net.request` electron gives the main process
    const transport = transportTo(backend.port);
    pod.netRequest = transport.request;

    backendStatus.registerBackendStatus(ipcMain, () => ({ api_interface: 'ComfyUI', api_addr: backend.address }));
    assert.deepEqual([...handlers.keys()], ['get-backend-status']);
    const ok = await handlers.get('get-backend-status')();
    assert.equal(ok.comfy.ok, true);
    assert.ok(Number.isFinite(ok.checkedAt));
    assert.deepEqual(transport.asked.map(entry => entry.method), ['GET', 'GET']);

    handlers.clear();
    backendStatus.registerBackendStatus(ipcMain, () => { throw new Error('settings are not loaded yet'); });
    const failed = await handlers.get('get-backend-status')();
    assert.deepEqual(failed.comfy, { configured: false, ok: false });
    assert.deepEqual(failed.ollama, { configured: false, ok: false });
});

// ------------------------------------------------------- wiring that lives in other files

test('the probe is registered by main.js and reaches the renderer through the preload bridge', () => {
    assert.match(read('main.js'), /registerBackendStatus\(ipcMain, getGlobalSettings\)/);
    assert.match(read('scripts/preload.js'), /getBackendStatus: async \(\) => ipcRenderer\.invoke\('get-backend-status'\)/);
});

test('the pod relay answers a stats frame, and its own stats never open a connection', () => {
    const transport = read('scripts/main/podSshTransport.js');
    assert.match(transport, /export function podSessionState\(\)/);
    assert.match(transport, /if \(podSessionState\(\) !== 'connected'\) return \{ ok: false, stats: null, message: 'pod relay not connected' \};/);
    assert.match(read('scripts/pod/comfy_ws_relay.py'), /elif cmd == 'stats':/);
});

test('pills: read with no options at all, a silent backend is a warning in the default English', () => {
  const [pill] = formatBackendStatus({ comfy: { configured: true, ok: false, address: '127.0.0.1:8189', error: 'ECONNREFUSED' } });
  assert.equal(pill.state, 'warn', 'no failure count given means none have been counted yet');
  assert.equal(pill.label, 'ComfyUI 127.0.0.1:8189 · no answer');
  assert.equal(pill.title, 'ECONNREFUSED', 'no version yet: the error is the tooltip');
  const [pod] = formatBackendStatus({ comfy: { pod: true, configured: true, ok: true, podState: 'off' } });
  assert.deepEqual([pod.state, pod.label], ['off', 'ComfyUI · Pod · standby']);
  // the same two calls with a language given
  const text = { noAnswer: '無応答', pod: 'ポッド', podStandby: '待機' };
  assert.equal(formatBackendStatus({ comfy: { configured: true, ok: false, address: 'x' } }, { text })[0].label, 'ComfyUI x · 無応答');
  assert.equal(formatBackendStatus({ comfy: { pod: true, configured: true, ok: true, podState: 'off' } }, { text })[0].label,
    'ComfyUI · ポッド · 待機');
});

// ------------------------------------------------------------- the pills on a fake DOM
const flush = async () => { for (let index = 0; index < 8; index++) await Promise.resolve(); };

test('the header pills: each pill carries its backend, its state, its tooltip and its click', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  await withFakeDom(async document => {
    const container = document.body.appendChild(document.createElement('div'));
    const clicked = [];
    const pills = setupStatusPills({
      container,
      getStatus: async () => ({
        comfy: { configured: true, ok: true, address: '127.0.0.1:8189', version: '0.28.0', deviceName: 'RTX 4070', running: 0 },
        ollama: { configured: true, ok: true, mode: 'Small', error: '' },
      }),
      onClick: id => clicked.push(id),
      pollMs: 10_000,
    });
    await flush();
    assert.equal(container.classList.contains('status-pills'), true);
    const [comfy, ollama] = container.children;
    assert.equal(comfy.tagName, 'BUTTON');
    assert.equal(comfy.type, 'button', 'never a submit inside a form');
    assert.equal(comfy.className, 'status-pill is-ok');
    assert.equal(comfy.dataset.backend, 'comfy');
    assert.equal(comfy.title, 'ComfyUI 0.28.0 · RTX 4070', 'the version and the device are the tooltip');
    assert.equal(ollama.title, '', 'nothing to say: no tooltip, not the string "undefined"');
    comfy.click();
    ollama.click();
    assert.deepEqual(clicked, ['comfy', 'ollama'], 'a pill click names its own backend');
    pills.destroy();
  });
});

// Counts the timers that are armed right now: what a teardown leaves behind is the whole
// question, and a handle the poller re-arms after destroy() is a poll that never stops.
function trackTimers() {
  const live = new Set();
  const { setTimeout: armTimer, clearTimeout: disarmTimer } = globalThis;
  return {
    live,
    globals: {
      setTimeout(callback, ms, ...rest) {
        const handle = armTimer((...args) => { live.delete(handle); callback(...args); }, ms, ...rest);
        live.add(handle);
        return handle;
      },
      clearTimeout(handle) { live.delete(handle); disarmTimer(handle); },
    },
    dispose() { for (const handle of live) disarmTimer(handle); live.clear(); },
  };
}

test('the header pills stop polling for good once they are destroyed', async () => {
  const timers = trackTimers();
  try {
    await withFakeDom(async document => {
      const container = document.body.appendChild(document.createElement('div'));
      const answer = { comfy: { configured: true, ok: true, address: '127.0.0.1:8189' } };
      let calls = 0;
      let release = () => {};
      const pills = setupStatusPills({
        container,
        getStatus: () => { calls += 1; return new Promise(resolve => { release = resolve; }); },
        pollMs: 60_000,
      });
      assert.equal(calls, 1, 'the first poll goes out at once');
      release(answer);
      await flush();
      assert.equal(container.children.length, 1);
      assert.equal(timers.live.size, 1, 'the next probe is armed');

      pills.refresh();          // a probe is in the air again
      assert.equal(calls, 2);
      pills.destroy();          // the header is torn down while it is
      assert.equal(timers.live.size, 0, 'the teardown disarms the probe that was waiting');
      release(answer);
      await flush();
      assert.equal(timers.live.size, 0, 'and the answer that outlived the teardown arms no new one');

      document.dispatchEvent({ type: 'visibilitychange' });
      await flush();
      assert.equal(calls, 2, 'nor does the window coming back wake a destroyed poller');
      assert.equal(timers.live.size, 0);
    }, timers.globals);
  } finally {
    timers.dispose();
  }
});

test('the header pills skip the probe while a generation runs, and pick it up again afterwards', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  await withFakeDom(async document => {
    const container = document.body.appendChild(document.createElement('div'));
    let busy = true;
    let calls = 0;
    const pills = setupStatusPills({
      container,
      getStatus: async () => { calls += 1; return { comfy: { configured: true, ok: true, address: 'x' } }; },
      isBusy: () => busy,
      pollMs: 1000,
    });
    await flush();
    assert.equal(calls, 0, 'the backend is busy generating: no probe competes with it');
    t.mock.timers.tick(1000);
    await flush();
    assert.equal(calls, 0, 'still busy');
    busy = false;
    t.mock.timers.tick(1000);
    await flush();
    assert.equal(calls, 1, 'the run ended: the polling picks up where it left off');
    assert.equal(container.children.length, 1);
    pills.destroy();
  });
});
