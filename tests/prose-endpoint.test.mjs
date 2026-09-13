import assert from 'node:assert/strict';
import test from 'node:test';

import { POD_SSH_CHAT_URL, isPodSshLlm, resolveLlmEndpoint } from '../scripts/shared/llmEndpoint.js';

// proseEndpoint (renderer) is: pod relay when the pod SSH transport is configured and
// the AI card does not say Local, else the local endpoint. The rule is exercised here on
// the shared pieces it is built from.
function proseEndpoint(settings) {
    const explicitLocal = String(settings.ai_interface ?? '') === 'Local';
    if (!explicitLocal && isPodSshLlm(settings)) return { apiUrl: POD_SSH_CHAT_URL, apiAuth: '' };
    return resolveLlmEndpoint(settings);
}

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
