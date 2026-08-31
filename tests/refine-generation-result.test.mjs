import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveQueuedAiPrompt } from '../scripts/renderer/tools/refineGenerationResult.js';

const marker = '_|AI|_';

test('V2 normal output is recomposed from editor fields and fixed generation context', async () => {
  const result = await resolveQueuedAiPrompt({
    mode: 'Refine',
    content: JSON.stringify({
      schema_version: 2,
      common: 'masterpiece',
      positive: 'portrait, detailed eyes, {day|night}',
      positive_right: '',
      negative: 'worst quality',
      changes: 'Strengthened the eyes.',
    }),
    marker,
    originalPrompts: { positive: `old ${marker}`, positiveRight: '', negative: 'old negative' },
    fixedContext: {
      beforePrompts: 'json start',
      views: 'city',
      characters: 'alice',
      characterNegative: 'extra arms',
      exclude: 'city',
      slotLora: '<lora:slot:0.8>',
      seed: 42,
    },
    planWeights: { 'positive/detailed eyes#0': 1.2 },
    resolveComponent: async value => value.replace('{day|night}', 'night'),
  });

  assert.equal(result.ok, true);
  assert.equal(result.envelope.format, 'v2');
  assert.equal(result.editorFields.positive, 'portrait, detailed eyes, {day|night}', 'candidate stays raw and editable');
  assert.match(result.positive, /json start.*masterpiece.*alice.*portrait.*\(detailed eyes:1\.20\).*night/);
  assert.doesNotMatch(result.positive, /city/);
  assert.equal(result.positive.match(/<lora:slot:0\.8>/g)?.length, 1);
  assert.equal(result.negative, 'worst quality, extra arms');
  assert.equal(result.preview, 'Strengthened the eyes.');
});

test('V2 Regional output stays logical until the final backend swap', async () => {
  const result = await resolveQueuedAiPrompt({
    mode: 'Refine',
    content: JSON.stringify({
      schema_version: 2,
      common: 'masterpiece',
      positive: 'logical left',
      positive_right: 'logical right',
      negative: '',
      changes: '',
    }),
    marker,
    regional: true,
    regionalSwap: true,
    originalPrompts: { positive: 'old left', positiveRight: 'old right', negative: '' },
    fixedContext: {
      left: { characters: 'alice' },
      right: { characters: 'bob' },
      leftSeed: 1,
      rightSeed: 2,
      slotLora: '<lora:slot:1>',
    },
  });

  assert.match(result.positive, /bob.*logical right/, 'backend left receives logical right after swap');
  assert.match(result.positiveRight, /alice.*logical left/, 'backend right receives logical left after swap');
  assert.doesNotMatch(result.positive, /<lora:slot:1>/, 'slot LoRA stays on logical left');
  assert.match(result.positiveRight, /<lora:slot:1>/);
});

test('legacy Refine remains generation-only and invalid output preserves originals', async () => {
  const originalPrompts = { positive: `old positive ${marker}`, positiveRight: '', negative: 'old negative' };
  const legacy = await resolveQueuedAiPrompt({
    mode: 'Refine',
    content: JSON.stringify({ positive: 'legacy final', negative: 'legacy bad', changes: 'legacy' }),
    marker,
    originalPrompts,
  });
  assert.equal(legacy.envelope.format, 'legacy');
  assert.equal(legacy.editorFields, null);
  assert.equal(legacy.positive, 'legacy final');

  const invalid = await resolveQueuedAiPrompt({ mode: 'Refine', content: '{broken', marker, originalPrompts });
  assert.equal(invalid.ok, false);
  assert.equal(invalid.envelope.format, 'invalid');
  assert.equal(invalid.positive, 'old positive');
  assert.equal(invalid.negative, 'old negative');
});

test('Expand retains marker replacement and per-image plan weights', async () => {
  const result = await resolveQueuedAiPrompt({
    mode: 'Expand',
    content: 'soft light',
    marker,
    originalPrompts: { positive: `detailed eyes, ${marker}`, positiveRight: '', negative: '' },
    planWeights: { 'positive/detailed eyes#0': 1.1 },
  });
  assert.equal(result.positive, '(detailed eyes:1.10), soft light');
  assert.equal(result.envelope, null);
});
