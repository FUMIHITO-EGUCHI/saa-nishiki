import assert from 'node:assert/strict';
import test from 'node:test';

import { isOllamaChatUrl } from '../scripts/shared/ollamaUrl.js';
import {
  OLLAMA_POD_PORT, POD_SSH_CHAT_URL, derivePodOllamaOrigin, isPodSshChatUrl, isPodSshLlm, resolveLlmEndpoint, resolvePodOrigin,
} from '../scripts/shared/llmEndpoint.js';

test('isOllamaChatUrl keys on the /api/chat path, loopback for HTTP and any host for HTTPS', () => {
  assert.equal(isOllamaChatUrl('http://127.0.0.1:11434/api/chat'), true);
  assert.equal(isOllamaChatUrl('http://localhost:11434/api/chat/'), true);
  assert.equal(isOllamaChatUrl('http://[::1]:11434/api/chat'), true);
  // no longer pinned to port 11434 on loopback
  assert.equal(isOllamaChatUrl('http://127.0.0.1:8081/api/chat'), true);
  // remote Ollama must be HTTPS (Runpod proxy etc.)
  assert.equal(isOllamaChatUrl('https://abc123-11434.proxy.runpod.net/api/chat'), true);
  assert.equal(isOllamaChatUrl('http://example.com:11434/api/chat'), false);
  // non-Ollama dialects stay excluded
  assert.equal(isOllamaChatUrl('http://127.0.0.1:8080/chat/completions'), false);
  assert.equal(isOllamaChatUrl('https://api.groq.com/openai/v1/chat/completions'), false);
  assert.equal(isOllamaChatUrl('not a url'), false);
});

test('derivePodOllamaOrigin swaps the Runpod proxy port label to Ollama', () => {
  assert.equal(OLLAMA_POD_PORT, 11434);
  assert.equal(derivePodOllamaOrigin('https://abc123-8188.proxy.runpod.net'), 'https://abc123-11434.proxy.runpod.net');
  assert.equal(derivePodOllamaOrigin('https://abc123-8188.proxy.runpod.net/'), 'https://abc123-11434.proxy.runpod.net');
  // non-proxy addresses keep the host and swap the port (bare host:port stays bare)
  assert.equal(derivePodOllamaOrigin('https://my.pod.example:8188'), 'https://my.pod.example:11434');
  assert.equal(derivePodOllamaOrigin('192.168.0.5:8188'), '192.168.0.5:11434');
  assert.equal(derivePodOllamaOrigin(''), '');
});

test('resolveLlmEndpoint routes Pod to the pod endpoint with auth, everything else to the local address', () => {
  const local = resolveLlmEndpoint({ ai_interface: 'Local', ai_local_addr: 'http://127.0.0.1:11434/api/chat' });
  assert.deepEqual(local, { apiUrl: 'http://127.0.0.1:11434/api/chat', apiAuth: '' });

  const pod = resolveLlmEndpoint({
    ai_interface: 'Pod',
    ai_pod_addr: 'https://abc123-11434.proxy.runpod.net',
    ai_pod_auth: 'token123',
  });
  assert.deepEqual(pod, { apiUrl: 'https://abc123-11434.proxy.runpod.net/api/chat', apiAuth: 'token123' });

  const shared = resolveLlmEndpoint({
    ai_interface: 'Pod',
    ai_pod_share_host: true,
    api_addr: 'https://abc123-8188.proxy.runpod.net',
    ai_pod_addr: 'https://ignored.example',
    ai_pod_auth: 'token123',
  });
  assert.equal(shared.apiUrl, 'https://abc123-11434.proxy.runpod.net/api/chat');
  assert.equal(resolvePodOrigin({ ai_pod_share_host: true, api_addr: 'https://abc123-8188.proxy.runpod.net' }),
    'https://abc123-11434.proxy.runpod.net');

  const unconfigured = resolveLlmEndpoint({ ai_interface: 'Pod' });
  assert.deepEqual(unconfigured, { apiUrl: '', apiAuth: '' });
});

test('the pod LLM takes the SSH relay when one is configured, the HTTPS proxy when not', () => {
  const ssh = {
    ai_interface: 'Pod',
    api_pod_ssh_enable: true,
    api_pod_ssh_target: 'pod-user@ssh.runpod.io',
    ai_pod_addr: 'https://abc123-11434.proxy.runpod.net',
    ai_pod_auth: 'token123',
  };
  assert.equal(isPodSshLlm(ssh), true);
  assert.deepEqual(resolveLlmEndpoint(ssh), { apiUrl: POD_SSH_CHAT_URL, apiAuth: '' }, 'the relay carries no auth of its own');

  // the switch is on but no target is named: the proxy stays the fallback
  assert.equal(isPodSshLlm({ ...ssh, api_pod_ssh_target: '   ' }), false);
  assert.deepEqual(resolveLlmEndpoint({ ...ssh, api_pod_ssh_target: '   ' }),
    { apiUrl: 'https://abc123-11434.proxy.runpod.net/api/chat', apiAuth: 'token123' });
  assert.equal(isPodSshLlm({ ...ssh, api_pod_ssh_enable: 'yes' }), false, 'only the boolean counts');
  assert.equal(isPodSshLlm({}), false);
  // a Local run never goes to the relay, whatever the pod settings say
  assert.equal(resolveLlmEndpoint({ ...ssh, ai_interface: 'Local', ai_local_addr: ' http://127.0.0.1:11434/api/chat ' }).apiUrl,
    'http://127.0.0.1:11434/api/chat');
  assert.deepEqual(resolveLlmEndpoint({}), { apiUrl: '', apiAuth: '' });
});

test('the relay marker is recognised by that URL alone', () => {
  assert.equal(POD_SSH_CHAT_URL, 'pod-ssh://ollama/api/chat');
  assert.equal(isPodSshChatUrl(POD_SSH_CHAT_URL), true);
  assert.equal(isPodSshChatUrl(`  ${POD_SSH_CHAT_URL}  `), true);
  assert.equal(isPodSshChatUrl('pod-ssh://ollama/api/chat/'), false);
  assert.equal(isPodSshChatUrl('http://127.0.0.1:11434/api/chat'), false);
  assert.equal(isPodSshChatUrl(''), false);
  assert.equal(isPodSshChatUrl(undefined), false);
});

test('a pod address that is no URL gives no origin, and the caller picks the port', () => {
  assert.equal(derivePodOllamaOrigin('http://['), '', 'not a URL: no guessing');
  assert.equal(derivePodOllamaOrigin('   '), '');
  assert.equal(derivePodOllamaOrigin(undefined), '');
  assert.equal(derivePodOllamaOrigin('https://abc123-8188.proxy.runpod.net', 8888), 'https://abc123-8888.proxy.runpod.net');
  assert.equal(derivePodOllamaOrigin('192.168.0.5:8188', 8888), '192.168.0.5:8888');
  // without ai_pod_share_host the address is taken as typed, trimmed of spaces and trailing slashes
  assert.equal(resolvePodOrigin({ ai_pod_addr: ' https://my.pod.example:11434// ' }), 'https://my.pod.example:11434');
  assert.equal(resolvePodOrigin({}), '');
  assert.equal(resolvePodOrigin({ ai_pod_share_host: true, api_addr: 'http://[' }), '');
});
