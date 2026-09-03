import assert from 'node:assert/strict';
import test from 'node:test';

import { isOllamaChatUrl } from '../scripts/shared/ollamaUrl.js';
import { OLLAMA_POD_PORT, derivePodOllamaOrigin, resolveLlmEndpoint, resolvePodOrigin } from '../scripts/shared/llmEndpoint.js';

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
