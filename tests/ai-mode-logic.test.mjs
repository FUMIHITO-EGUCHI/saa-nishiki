import assert from 'node:assert/strict';
import test from 'node:test';

import { applyAiMode, applyAiRole, deriveAiMode, deriveAiRole, describeAiStatus } from '../scripts/renderer/components/aiModeLogic.js';

test('mode derives from ai_interface + ai_local_prompt_mode without new settings keys', () => {
  assert.equal(deriveAiMode({ ai_interface: 'None', ai_local_prompt_mode: 'Refine' }), 'off');
  assert.equal(deriveAiMode({ ai_interface: 'Local', ai_local_prompt_mode: 'Refine' }), 'refine');
  assert.equal(deriveAiMode({ ai_interface: 'Remote', ai_local_prompt_mode: 'Expand' }), 'expand');
  assert.equal(deriveAiMode({}), 'off');
});

test('switching the segment patches only the existing keys and restores the last backend', () => {
  assert.deepEqual(applyAiMode('off', { ai_interface: 'Local' }), { ai_interface: 'None' });
  assert.deepEqual(applyAiMode('refine', { ai_interface: 'None', ai_prompt_role: 0 }, 'Local'), { ai_interface: 'Local', ai_local_prompt_mode: 'Refine', ai_prompt_role: 1 });
  assert.deepEqual(applyAiMode('expand', { ai_interface: 'None', ai_prompt_role: 2 }, 'Remote'), { ai_interface: 'Remote', ai_local_prompt_mode: 'Expand' });
  assert.deepEqual(applyAiMode('expand', { ai_interface: 'Remote', ai_prompt_role: 3 }), { ai_interface: 'Remote', ai_local_prompt_mode: 'Expand' });
  assert.throws(() => applyAiMode('auto'));
});

test('role maps to ai_prompt_role 1..3; None collapses to Once', () => {
  assert.equal(deriveAiRole({ ai_prompt_role: 0 }), 'once');
  assert.equal(deriveAiRole({ ai_prompt_role: 3 }), 'last');
  assert.deepEqual(applyAiRole('every'), { ai_prompt_role: 2 });
  assert.throws(() => applyAiRole('never'));
});

test('status line', () => {
  assert.equal(describeAiStatus({ ai_interface: 'None' }), 'Off');
  assert.equal(describeAiStatus({ ai_interface: 'Local', ai_local_model_mode: 'Small' }, { lastRunSeconds: 96.4 }), 'Local · Small · last run 96 s');
  assert.equal(describeAiStatus({ ai_interface: 'Remote', remote_ai_model: 'meta-llama/llama-4-maverick' }), 'Remote · llama-4-maverick');
});
