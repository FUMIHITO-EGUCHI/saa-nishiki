import assert from 'node:assert/strict';
import test from 'node:test';

import { getAiPromptResult } from '../scripts/renderer/remoteAI.js';

test('Once cache is scoped to the current generation run', async () => {
  const priorRun = { lastAiPrompt: 'prior run output' };
  const currentRun = { lastAiPrompt: '' };
  const cached = await getAiPromptResult(1, '', 'None', 1, null, priorRun);
  const isolated = await getAiPromptResult(1, '', 'None', 1, null, currentRun);
  assert.deepEqual(cached, { content: 'prior run output', fresh: false, source: 'run-cache' });
  assert.deepEqual(isolated, { content: '', fresh: false, source: 'run-cache' });
});

test('explicit None role is not replaced by the current UI role', async () => {
  globalThis.ai = { interface: { getValue: () => 'Local' }, ai_select: { getValue: () => 2 } };
  const result = await getAiPromptResult(0, '', 'Local', 0);
  assert.deepEqual(result, { content: '', fresh: false, source: 'none' });
});
