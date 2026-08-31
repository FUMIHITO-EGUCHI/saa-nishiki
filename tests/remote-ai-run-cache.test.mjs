import assert from 'node:assert/strict';
import test from 'node:test';

import { getAiPromptResult, isStructuredRefineRequest } from '../scripts/renderer/remoteAI.js';

test('Once cache is scoped to the current generation run', async () => {
  const priorRun = { lastAiPrompt: 'prior run output' };
  const currentRun = { lastAiPrompt: '' };
  const cached = await getAiPromptResult(1, '', 'None', 1, null, priorRun);
  const isolated = await getAiPromptResult(1, '', 'None', 1, null, currentRun);
  assert.deepEqual(cached, { content: 'prior run output', fresh: false, source: 'run-cache' });
  assert.deepEqual(isolated, { content: '', fresh: false, source: 'none' }, 'missing first queue item retries instead of accepting an empty Once cache');
});

test('structured Refine is limited to Local loopback Ollama and excludes runSame', () => {
  const eligible = { aiInterface: 'Local', aiOptions: { promptMode: 'Refine', apiUrl: 'http://127.0.0.1:11434/api/chat' } };
  assert.equal(isStructuredRefineRequest(eligible), true);
  assert.equal(isStructuredRefineRequest({ ...eligible, runSame: true }), false);
  assert.equal(isStructuredRefineRequest({ ...eligible, aiInterface: 'Remote' }), false);
  assert.equal(isStructuredRefineRequest({ ...eligible, aiOptions: { ...eligible.aiOptions, apiUrl: 'http://127.0.0.1:8080/completion' } }), false);
  assert.equal(isStructuredRefineRequest({ ...eligible, aiOptions: { ...eligible.aiOptions, apiUrl: 'http://example.com:11434/api/chat' } }), false);
});

test('explicit None role is not replaced by the current UI role', async () => {
  globalThis.ai = { interface: { getValue: () => 'Local' }, ai_select: { getValue: () => 2 } };
  const result = await getAiPromptResult(0, '', 'Local', 0);
  assert.deepEqual(result, { content: '', fresh: false, source: 'none' });
});
