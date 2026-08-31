import assert from 'node:assert/strict';
import test from 'node:test';

import { formatElapsed, parseLoadingMessage } from '../scripts/renderer/components/runProgress.js';

test('loading messages from generate.js are split into label, step/total and extra lines', () => {
  assert.deepEqual(parseLoadingMessage('148ad401\n[2/4] <6/22>'), { label: '[2/4]', step: 6, total: 22, extra: '148ad401' });
  assert.deepEqual(parseLoadingMessage('Wait for AI promot ...'), { label: 'Wait for AI promot ...', step: null, total: null, extra: '' });
  assert.deepEqual(parseLoadingMessage('Creating prompts 1/4……'), { label: 'Creating prompts 1/4……', step: null, total: null, extra: '' });
  assert.deepEqual(parseLoadingMessage(null), { label: '', step: null, total: null, extra: '' });
  assert.deepEqual(parseLoadingMessage('MiraITU: 123\n1024x1024 -> 2048x2048\n <3/10>'), { label: '1024x1024 -> 2048x2048', step: 3, total: 10, extra: 'MiraITU: 123' });
});

test('elapsed time formatting', () => {
  assert.equal(formatElapsed(0), '0 s');
  assert.equal(formatElapsed(59_900), '59 s');
  assert.equal(formatElapsed(102_000), '1 m 42 s');
  assert.equal(formatElapsed(-5), '0 s');
});
