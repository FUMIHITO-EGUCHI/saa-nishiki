import assert from 'node:assert/strict';
import test from 'node:test';

import { backendAuthHeaders, httpApiUrl, isSecureApiAddress, normalizeApiAddress, wsApiUrl } from '../scripts/shared/backendAddress.js';

test('normalizeApiAddress keeps https origins and flattens http to host:port', () => {
  assert.equal(normalizeApiAddress('127.0.0.1:8188'), '127.0.0.1:8188');
  assert.equal(normalizeApiAddress(' http://127.0.0.1:58189/ '), '127.0.0.1:58189');
  assert.equal(normalizeApiAddress('https://abc-8188.proxy.runpod.net'), 'https://abc-8188.proxy.runpod.net');
  assert.equal(normalizeApiAddress('https://abc-8188.proxy.runpod.net/'), 'https://abc-8188.proxy.runpod.net');
  assert.equal(normalizeApiAddress('ftp://example.com'), '');
  assert.equal(normalizeApiAddress(''), '');
  assert.equal(normalizeApiAddress(null), '');
});

test('httpApiUrl / wsApiUrl follow the address protocol', () => {
  assert.equal(httpApiUrl('127.0.0.1:8188', 'prompt'), 'http://127.0.0.1:8188/prompt');
  assert.equal(httpApiUrl('127.0.0.1:8188'), 'http://127.0.0.1:8188/');
  assert.equal(httpApiUrl('https://abc.proxy.runpod.net', '/sdapi/v1/txt2img'), 'https://abc.proxy.runpod.net/sdapi/v1/txt2img');
  assert.equal(wsApiUrl('127.0.0.1:8188', 'ws?clientId=x'), 'ws://127.0.0.1:8188/ws?clientId=x');
  assert.equal(wsApiUrl('https://abc.proxy.runpod.net', 'ws?clientId=x'), 'wss://abc.proxy.runpod.net/ws?clientId=x');
  assert.equal(isSecureApiAddress('https://abc.proxy.runpod.net'), true);
  assert.equal(isSecureApiAddress('127.0.0.1:8188'), false);
});

test('backendAuthHeaders: empty none, user:pass Basic, token Bearer', () => {
  assert.deepEqual(backendAuthHeaders(''), {});
  assert.deepEqual(backendAuthHeaders(undefined), {});
  assert.deepEqual(backendAuthHeaders('user:pass'), { Authorization: `Basic ${Buffer.from('user:pass').toString('base64')}` });
  assert.deepEqual(backendAuthHeaders('rp_token_123'), { Authorization: 'Bearer rp_token_123' });
  assert.deepEqual(backendAuthHeaders('  '), {});
});
