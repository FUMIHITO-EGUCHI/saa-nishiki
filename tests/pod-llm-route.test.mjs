import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { POD_SSH_CHAT_URL, isPodSshChatUrl, isPodSshLlm, resolveLlmEndpoint } from '../scripts/shared/llmEndpoint.js';
import { isOllamaChatUrl } from '../scripts/shared/ollamaUrl.js';

const projectRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = relativePath => fs.readFileSync(path.join(projectRoot, relativePath), 'utf8');

test('Pod LLM goes over the SSH relay when the pod SSH transport is configured', () => {
    const ssh = { ai_interface: 'Pod', api_pod_ssh_enable: true, api_pod_ssh_target: 'abc-1@ssh.runpod.io', ai_pod_addr: 'https://abc-11434.proxy.runpod.net', ai_pod_auth: 'tok' };
    assert.equal(isPodSshLlm(ssh), true);
    assert.deepEqual(resolveLlmEndpoint(ssh), { apiUrl: POD_SSH_CHAT_URL, apiAuth: '' }, 'the relay wins over the HTTPS proxy');
    // without SSH the HTTPS proxy path is unchanged
    const proxy = { ...ssh, api_pod_ssh_enable: false };
    assert.equal(isPodSshLlm(proxy), false);
    assert.equal(resolveLlmEndpoint(proxy).apiUrl, 'https://abc-11434.proxy.runpod.net/api/chat');
    assert.equal(isPodSshLlm({ api_pod_ssh_enable: true, api_pod_ssh_target: '  ' }), false);
    // the marker speaks Ollama's native dialect
    assert.equal(isPodSshChatUrl(POD_SSH_CHAT_URL), true);
    assert.equal(isPodSshChatUrl('https://x/api/chat'), false);
    assert.equal(isOllamaChatUrl(POD_SSH_CHAT_URL), true);
    assert.equal(isOllamaChatUrl('pod-ssh://ollama/v1/chat/completions'), false);
});

test('the relay answers an `ollama` command on the pod loopback only, on its own thread', () => {
    const relay = read('scripts/pod/comfy_ws_relay.py');
    assert.match(relay, /OLLAMA_BASE = 'http:\/\/127\.0\.0\.1:11434'/);
    assert.match(relay, /elif cmd == 'ollama':/);
    assert.match(relay, /if not path\.startswith\('\/api\/'\):/, 'only Ollama API paths');
    assert.match(relay, /urllib\.request\.Request\(OLLAMA_BASE \+ path/);
    assert.match(relay, /threading\.Thread\(target=call, daemon=True\)\.start\(\)/, 'a long generation must not block ping / stats');
    assert.match(relay, /emit\(\{'id': rid, 'ok': True, 'status': response\.status, 'json': payload\}\)/);
});

test('the main process routes the pod-ssh marker through podOllamaRequest and probes it via the open relay', () => {
    const transport = read('scripts/main/podSshTransport.js');
    assert.match(transport, /export async function podOllamaRequest\(\{ settings, method = 'POST', path = '\/api\/chat', body = null, timeoutMs = 300_000 \}\)/);
    assert.match(transport, /session\.request\(\{ cmd: 'ollama', method, path, body, timeout: Math\.ceil\(timeoutMs \/ 1000\) \}, timeoutMs \+ 5000\)/);
    const backend = read('scripts/main/remoteAI_backend.js');
    assert.match(backend, /if \(isPodSshChatUrl\(apiUrl\)\) \{/);
    assert.match(backend, /podOllamaRequest\(\{ settings, method: 'POST', path: '\/api\/chat', body: podBody, timeoutMs: timeout \}\)/);
    assert.match(backend, /normalizeOllamaChatResponse\(JSON\.stringify\(reply\.json\)\)/, 'same normalization as the HTTP path');
    const status = read('scripts/main/backendStatus.js');
    assert.match(status, /if \(settings\?\.ai_interface === 'Pod' && isPodSshLlm\(settings\)\) \{/);
    assert.match(status, /podSessionState\(\) === 'connected'/, 'a status poll never opens the SSH session');
    assert.match(status, /path: '\/api\/tags', timeoutMs: 5000/);
});

test('categorizeTags: Codex first, the pod (or local Ollama) only for refused batches', () => {
    const script = read('scripts/categorizeTags.mjs');
    assert.match(script, /\['auto', 'ollama', 'codex', 'pod'\]\.includes\(args\.backend\)/);
    assert.match(script, /args\.fallback = podConfigured \? 'pod' : 'ollama';/);
    assert.match(script, /: \[\{ backend: 'codex', rows: selected \}\]\)/, 'auto = everything to Codex');
    assert.match(script, /args\.nsfwDirect/, 'the old pre-split survives as --nsfw-direct');
    assert.match(script, /return \(await assignAndValidate\(args\.fallback, args, rows\)\)/);
    assert.match(script, /return verifyAndValidate\(args\.fallback, args, rows\);/);
    assert.match(script, /if \(backend === 'pod'\) return callOllamaJson\(await podModelFor\(args\), systemPrompt, userContent, schema, \{ via: 'pod', args \}\);/);
    assert.match(script, /podTransport\.podOllamaRequest\(\{ settings: await podSettings\(args\), method: 'POST', path: '\/api\/chat', body: payload, timeoutMs: 600_000 \}\)/);
    assert.match(script, /keep_alive: via === 'pod' \? '5m' : 0,/);
});

test('bootstrap.sh restores the volatile pieces and keeps generated files off the pod disks', () => {
    const script = read('scripts/pod/bootstrap.sh');
    assert.match(script, /grep -v 'git\+' "\$IMPACT_REQ"/, 'the sam2 git+ line would prompt for GitHub credentials');
    assert.match(script, /OLLAMA_MODELS=\/workspace\/ollama\/models OLLAMA_HOST=127\.0\.0\.1:11434/, 'Ollama stays on loopback with durable models');
    assert.match(script, /--output-directory \/dev\/shm\/comfy_out --temp-directory \/dev\/shm\/comfy_tmp/);
    assert.match(script, /--pull\) PULL_MODEL="\$2"/);
    assert.doesNotMatch(script, /terminate|delete pod/i);
});

test('the pod route uses the pod model setting instead of the local Small / Large mapping', () => {
    const sections = read('scripts/shared/settingsSections.js');
    assert.match(sections, /ai_pod_model: 'huihui_ai\/qwen3-abliterated:8b',/);
    assert.match(sections, /'ai_pod_addr', 'ai_pod_share_host', 'ai_pod_auth', 'ai_pod_model',/);
    const backend = read('scripts/main/remoteAI_backend.js');
    assert.match(backend, /const podBody = podModel \? \{ \.\.\.requestBody, model: podModel \} : requestBody;/);
    const renderer = read('scripts/renderer.js');
    assert.match(renderer, /pod_model: setupTextbox\('system-settings-ai-pod-model', LANG\.ai_pod_model/);
    const html = read('scripts/html_shared_body.js');
    assert.match(html, /system-settings-ai-pod-model/);
    const script = read('scripts/categorizeTags.mjs');
    assert.match(script, /raw\?\.data\?\.ai_pod_model/, 'the batch script reads the same setting from the sectioned app.json');
});
