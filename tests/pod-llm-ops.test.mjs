// The pod as an LLM worker: model list / pull / unload through the relay,
// keep-alive for Refine / Expand, VRAM handed to ComfyUI before a generation.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
    RECOMMENDED_POD_MODELS,
    isValidOllamaModelName,
    normalizeKeepAlive,
    parseOllamaLoaded,
    parseOllamaTags,
    pullRequest,
    unloadRequest,
} from '../scripts/shared/ollamaModels.js';
import { describePodLlmModels } from '../scripts/renderer/podControl.js';
import { DEFAULT_SETTINGS, SECTION_KEYS } from '../scripts/shared/settingsSections.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8').replace(/\r\n/g, '\n');

test('ollama model helpers: tags / ps parsing, pull and unload requests, name validation', () => {
    const tags = { models: [{ name: 'huihui_ai/qwen3-abliterated:8b' }, { model: 'hf.co/HauhauCS/Gemma4-12B-QAT-Uncensored-HauhauCS-Balanced:Q4_K_M' }, { name: '' }] };
    assert.deepEqual(parseOllamaTags(tags), ['hf.co/HauhauCS/Gemma4-12B-QAT-Uncensored-HauhauCS-Balanced:Q4_K_M', 'huihui_ai/qwen3-abliterated:8b']);
    assert.deepEqual(parseOllamaLoaded({ models: [{ name: 'a:8b' }] }), ['a:8b']);
    assert.deepEqual(parseOllamaTags(null), []);
    assert.deepEqual(unloadRequest('a:8b'), { method: 'POST', path: '/api/generate', body: { model: 'a:8b', prompt: '', keep_alive: 0, stream: false } });
    assert.deepEqual(pullRequest(' huihui_ai/qwen3-abliterated:8b '), { method: 'POST', path: '/api/pull', body: { model: 'huihui_ai/qwen3-abliterated:8b', stream: false } });
    assert.throws(() => pullRequest('../etc/passwd'), /invalid Ollama model name/);
    assert.throws(() => pullRequest('a b'), /invalid Ollama model name/);
    assert.equal(isValidOllamaModelName('hf.co/Org/Repo-Name:Q4_K_M'), true);
    assert.equal(isValidOllamaModelName(''), false);
    for (const entry of RECOMMENDED_POD_MODELS) assert.equal(isValidOllamaModelName(entry.model), true, entry.model);
});

test('keep-alive accepts durations, seconds and 0, and falls back otherwise', () => {
    assert.equal(normalizeKeepAlive('10m'), '10m');
    assert.equal(normalizeKeepAlive('1h'), '1h');
    assert.equal(normalizeKeepAlive('0'), 0);
    assert.equal(normalizeKeepAlive(0), 0);
    assert.equal(normalizeKeepAlive('300'), 300);
    assert.equal(normalizeKeepAlive(-1), -1);
    assert.equal(normalizeKeepAlive('-1'), -1);
    assert.equal(normalizeKeepAlive('forever', '5m'), '5m');
    assert.equal(normalizeKeepAlive(undefined), '10m');
});

test('the pod keep-alive is a persisted app setting used by the pod chat route and the batch client', () => {
    assert.equal(DEFAULT_SETTINGS.ai_pod_keep_alive, '10m');
    assert.ok(SECTION_KEYS.app.includes('ai_pod_keep_alive'));
    const backend = read('scripts/main/remoteAI_backend.js');
    assert.match(backend, /keep_alive: normalizeKeepAlive\(settings\?\.ai_pod_keep_alive, '10m'\),/);
    const batch = read('scripts/llmBatchBackend.mjs');
    assert.match(batch, /normalizeKeepAlive\(raw\?\.data\?\.ai_pod_keep_alive \?\? raw\?\.ai_pod_keep_alive, '10m'\)/);
    assert.match(batch, /await podTransport\.podOllamaUnload\?\.\(\{ settings: podSettings\(\) \}\);/, 'a batch frees the pod GPU when it ends');
});

test('the transport lists / pulls / unloads pod models over the relay and unloads before a workflow', () => {
    const transport = read('scripts/main/podSshTransport.js');
    assert.match(transport, /export async function podOllamaModels\(\{ settings, open = false \}\)/);
    assert.match(transport, /export async function podOllamaPull\(\{ settings, model, timeoutMs = 45 \* 60_000 \}\)/);
    assert.match(transport, /export async function podOllamaUnload\(\{ settings, open = false \}\)/);
    assert.match(transport, /path: '\/api\/ps', body: null, timeout: 5 \}, 8000\)/, 'the unload only asks an open relay, briefly');
    const beforeSubmit = transport.indexOf('await unloadLoadedPodModels();');
    const submit = transport.indexOf("session.request({ cmd: 'submit', workflow, saveNodes })");
    assert.ok(beforeSubmit > 0 && beforeSubmit < submit, 'VRAM is handed to ComfyUI before the workflow is submitted');
    const control = read('scripts/main/runpodControl.js');
    assert.match(control, /ipcMain\.handle\('pod-ollama'/);
    for (const action of ['models', 'pull', 'unload']) assert.match(control, new RegExp(`case '${action}':`));
    assert.match(read('scripts/preload.js'), /podOllama: async \(args\) => ipcRenderer\.invoke\('pod-ollama', args\)/);
});

test('the AI settings page carries the pod LLM buttons and describes the model list', () => {
    const html = read('scripts/html_shared_body.js');
    for (const cls of ['system-settings-ai-pod-keep-alive', 'pod-btn-llm-check', 'pod-btn-llm-pull', 'pod-btn-llm-unload', 'system-settings-ai-pod-llm-result']) {
        assert.match(html, new RegExp(cls), cls);
    }
    const t = (key, fallback) => fallback;
    assert.equal(describePodLlmModels({ ok: false, message: 'pod relay not connected' }, 'x', t), 'models: pod relay not connected');
    assert.equal(describePodLlmModels({ ok: true, models: ['a:8b', 'b:12b'], loaded: ['a:8b'] }, 'b:12b', t), 'pulled: a:8b, b:12b · loaded: a:8b');
    assert.equal(describePodLlmModels({ ok: true, models: ['a:8b'], loaded: [] }, 'c:1b', t), 'pulled: a:8b · not on the pod: c:1b');
    const language = JSON.parse(read('data/language.json'));
    for (const locale of ['en-US', 'zh-CN']) {
        for (const key of ['ai_pod_keep_alive', 'ui_pod_llm_models', 'ui_pod_llm_pull', 'ui_pod_llm_unload', 'ui_settings_pod_llm_note']) {
            assert.equal(typeof language[locale][key], 'string', `${locale} ${key}`);
        }
    }
});

test('bootstrap.sh pulls several models and starts Ollama sized for a 12 GB pod', () => {
    const script = read('scripts/pod/bootstrap.sh');
    assert.match(script, /--pull\) PULL_MODELS="\$PULL_MODELS \$\(printf '%s' "\$2" \| tr ',' ' '\)"; shift 2 ;;/);
    assert.match(script, /for PULL_MODEL in \$PULL_MODELS; do/);
    assert.match(script, /OLLAMA_FLASH_ATTENTION="\$\{OLLAMA_FLASH_ATTENTION:-1\}" OLLAMA_KV_CACHE_TYPE="\$\{OLLAMA_KV_CACHE_TYPE:-q8_0\}"/);
    assert.match(script, /OLLAMA_MAX_LOADED_MODELS="\$\{OLLAMA_MAX_LOADED_MODELS:-1\}"/);
    assert.doesNotMatch(script, /terminate|delete pod/i);
});
