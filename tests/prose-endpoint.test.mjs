import assert from 'node:assert/strict';
import test from 'node:test';

import { POD_SSH_CHAT_URL } from '../scripts/shared/llmEndpoint.js';
import { describeProseEndpoint, proseEndpoint } from '../scripts/renderer/prosePipeline.js';

const POD = { api_pod_ssh_enable: true, api_pod_ssh_target: 'pod@ssh.runpod.io', ai_local_addr: 'http://127.0.0.1:11434/api/chat' };

test('Prose goes to the pod relay when the pod is configured, whatever the AI card mode', () => {
    assert.equal(proseEndpoint({ ...POD, ai_interface: 'None' }).apiUrl, POD_SSH_CHAT_URL);
    assert.equal(proseEndpoint({ ...POD, ai_interface: 'Pod' }).apiUrl, POD_SSH_CHAT_URL);
    assert.equal(proseEndpoint({ ...POD }).apiUrl, POD_SSH_CHAT_URL);
});

test('an explicit Local AI card, or no pod, keeps Prose on the local Ollama', () => {
    assert.equal(proseEndpoint({ ...POD, ai_interface: 'Local' }).apiUrl, 'http://127.0.0.1:11434/api/chat');
    assert.equal(proseEndpoint({ ...POD, api_pod_ssh_enable: false, ai_interface: 'None' }).apiUrl, 'http://127.0.0.1:11434/api/chat');
});

test('the endpoint is read from the settings passed in, not from the global settings', () => {
    globalThis.globalSettings = { ...POD };
    try {
        assert.equal(proseEndpoint({ ai_interface: 'Local', ai_local_addr: 'http://localhost:11434/api/chat' }).apiUrl, 'http://localhost:11434/api/chat');
    } finally {
        delete globalThis.globalSettings;
    }
});

test('the Prose card names the pod whenever the paragraph goes there, relay or HTTPS', () => {
    assert.equal(describeProseEndpoint({ ...POD, ai_pod_model: 'huihui_ai/qwen3-abliterated:8b' }), 'Pod · qwen3-abliterated:8b');
    const https = { ai_interface: 'Pod', ai_pod_addr: 'https://abc123-11434.proxy.runpod.net', ai_local_model_mode: 'Large' };
    assert.equal(proseEndpoint(https).apiUrl, 'https://abc123-11434.proxy.runpod.net/api/chat');
    assert.equal(describeProseEndpoint(https), 'Pod · Large');
    assert.equal(describeProseEndpoint({ ...POD, ai_interface: 'Local' }), 'Local · Auto');
});
