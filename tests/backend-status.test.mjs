import assert from 'node:assert/strict';
import test from 'node:test';

import { formatBackendStatus } from '../scripts/renderer/components/statusPills.js';

// scripts/main/backendStatus.js imports electron; only its pure helpers are checked via source.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8').replace(/\r\n/g, '\n');

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

test('main-side probe reports the pod session instead of probing api_addr when pod SSH is on', () => {
  const source = read('scripts/main/backendStatus.js');
  assert.match(source, /isPodSshEnabled\(settings\)/);
  assert.match(source, /podSessionState\(\)/);
  assert.match(source, /podSessionStats\(\)/, 'VRAM comes over the existing SSH relay, never a new connection');
  const transport = read('scripts/main/podSshTransport.js');
  assert.match(transport, /export function podSessionState\(\)/);
  assert.match(transport, /if \(podSessionState\(\) !== 'connected'\) return null;/, 'stats never open a connection');
  assert.match(read('scripts/pod/comfy_ws_relay.py'), /elif cmd == 'stats':/);
});

test('main-side probe covers the Pod target with its auth', () => {
  const source = read('scripts/main/backendStatus.js');
  assert.match(source, /ai_interface === 'Local' \|\| settings\?\.ai_interface === 'Pod'/);
  assert.match(source, /resolvePodOrigin/);
  assert.match(source, /ai_pod_auth/);
});

test('main-side probe: GET only; loopback over http, remote only over https', () => {
  const source = read('scripts/main/backendStatus.js');
  assert.match(source, /LOOPBACK_HOSTS = new Set\(\['127\.0\.0\.1', 'localhost', '::1', '\[::1\]'\]\)/);
  assert.match(source, /method: 'GET'/);
  assert.doesNotMatch(source, /method: 'POST'/);
  assert.match(source, /\/system_stats/);
  assert.match(source, /\/api\/tags/);
  // remote origins are https-only and carry the configured auth header
  assert.match(source, /probeOrigin/);
  assert.match(source, /\^https:\\\/\\\//);
  assert.match(source, /backendAuthHeaders/);
  assert.match(read('main.js'), /registerBackendStatus\(ipcMain, getGlobalSettings\)/);
  assert.match(read('scripts/preload.js'), /getBackendStatus: async \(\) => ipcRenderer\.invoke\('get-backend-status'\)/);
});
