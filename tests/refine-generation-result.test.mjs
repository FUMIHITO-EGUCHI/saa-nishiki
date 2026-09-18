import assert from 'node:assert/strict';
import test from 'node:test';

import { refineRequestContext, resolveQueuedAiPrompt } from '../scripts/renderer/tools/refineGenerationResult.js';

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

test('V3 Regional output rebuilds every side negative and swaps them with the sides', async () => {
  const result = await resolveQueuedAiPrompt({
    mode: 'Refine',
    content: JSON.stringify({
      schema_version: 3,
      common: '',
      positive: 'logical left',
      positive_right: 'logical right',
      negative: 'worst quality',
      negative_left: 'harsh shadow',
      negative_right: 'lens flare',
      changes: '',
    }),
    marker,
    regional: true,
    regionalSwap: true,
    originalPrompts: { positive: 'old left', positiveRight: 'old right', negative: 'old negative' },
    fixedContext: {
      left: { characters: 'alice' },
      right: { characters: 'bob' },
      negative: {
        chains: {
          both: ['negative'],
          left: ['negative', 'negative_left'],
          right: ['negative', 'negative_right'],
        },
        texts: { negative: 'stale', negative_left: 'stale left', negative_right: 'stale right' },
      },
      characterNegativeLeft: 'alice negative',
      characterNegativeRight: 'bob negative',
    },
  });

  assert.equal(result.envelope.format, 'v3');
  assert.equal(result.negativeLeft, 'worst quality, lens flare, bob negative', 'backend left receives the logical right negative after swap');
  assert.equal(result.negativeRight, 'worst quality, harsh shadow, alice negative');
  assert.equal(result.negative, 'worst quality, harsh shadow, lens flare, alice negative, bob negative');
});

test('Expand and failed Refine leave the regional side negatives untouched', async () => {
  const expanded = await resolveQueuedAiPrompt({
    mode: 'Expand',
    content: 'soft light',
    marker,
    regional: true,
    originalPrompts: { positive: `left, ${marker}`, positiveRight: `right, ${marker}`, negative: 'keep bad' },
  });
  assert.equal(expanded.positive, 'left, soft light');
  assert.equal(expanded.positiveRight, 'right, soft light');
  assert.equal(expanded.negativeLeft, undefined, 'Expand never rebuilds a negative');

  const invalid = await resolveQueuedAiPrompt({
    mode: 'Refine',
    content: '{broken',
    marker,
    regional: true,
    originalPrompts: { positive: 'old left', positiveRight: 'old right', negative: 'keep bad' },
  });
  assert.equal(invalid.ok, false);
  assert.equal(invalid.negativeLeft, undefined);
  assert.equal(invalid.negative, 'keep bad');
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

test('legacy Regional output also applies backend swap at the final boundary', async () => {
  const legacy = await resolveQueuedAiPrompt({
    mode: 'Refine',
    content: JSON.stringify({ positive: 'logical left', positive_right: 'logical right', negative: 'bad' }),
    marker,
    regional: true,
    regionalSwap: true,
    originalPrompts: { positive: 'old left', positiveRight: 'old right', negative: 'old bad' },
  });
  assert.equal(legacy.envelope.format, 'legacy');
  assert.equal(legacy.positive, 'logical right');
  assert.equal(legacy.positiveRight, 'logical left');
  // legacy output is one finished negative, so it reaches both masked sides
  assert.equal(legacy.negativeLeft, 'bad');
  assert.equal(legacy.negativeRight, 'bad');
});

test('structured output from a non-Ollama path cannot drive generation or editor apply', async () => {
  const result = await resolveQueuedAiPrompt({
    mode: 'Refine',
    content: JSON.stringify({ schema_version: 2, common: '', positive: 'untrusted v2', positive_right: '', negative: '', changes: '' }),
    marker,
    allowStructured: false,
    originalPrompts: { positive: 'keep me', positiveRight: '', negative: 'keep bad' },
  });
  assert.equal(result.ok, false);
  assert.equal(result.envelope.format, 'invalid');
  assert.equal(result.editorFields, null);
  assert.equal(result.positive, 'keep me');
  assert.equal(result.negative, 'keep bad');
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

const REGIONAL_CONTEXT = Object.freeze({
  left: { chain: [{ id: 'common', text: 'masterpiece, ' }, { id: 'positive', text: 'left' }] },
  right: { chain: [{ id: 'common', text: 'masterpiece, ' }, { id: 'positive_right', text: 'right' }] },
  negative: {
    chains: { both: ['negative'], left: ['negative', 'negative_left'], right: ['negative', 'negative_right'] },
    texts: { negative: 'lowres', negative_left: 'hat', negative_right: 'glasses' },
  },
  characterNegativeLeft: 'ponytail',
  characterNegativeRight: 'beard',
});

test('the queued context records the request schema and the muted fields', () => {
  const settings = { prompt_field_muted: ['negative_left'] };
  assert.equal(refineRequestContext(null, { structuredRefine: true, settings }), null, 'Run Same has no context');
  const structured = refineRequestContext(REGIONAL_CONTEXT, { structuredRefine: true, refineSystemPrompt: '', settings });
  assert.equal(structured.requestSchema, 3, 'an empty setting sends the default');
  assert.deepEqual(structured.muted, ['negativeLeft']);
  assert.equal(structured.negative, REGIONAL_CONTEXT.negative);
  assert.equal(refineRequestContext(REGIONAL_CONTEXT, { structuredRefine: true, refineSystemPrompt: 'Return "schema_version": 2' }).requestSchema, 2);
  assert.equal(refineRequestContext(REGIONAL_CONTEXT, { structuredRefine: false, refineSystemPrompt: '' }).requestSchema, 0, 'nothing structured went out');
});

test('a schema 3 answer to a schema 2 request keeps the generated side negatives', async () => {
  const result = await resolveQueuedAiPrompt({
    mode: 'Refine',
    content: JSON.stringify({
      schema_version: 3, common: '', positive: 'left', positive_right: 'right', negative: 'worst quality', negative_left: '', negative_right: '', changes: '',
    }),
    marker,
    regional: true,
    originalPrompts: { positive: 'old left', positiveRight: 'old right', negative: 'old negative' },
    fixedContext: { ...REGIONAL_CONTEXT, requestSchema: 2, muted: [] },
  });
  assert.equal(result.envelope.format, 'v2');
  assert.equal(result.negativeLeft, 'worst quality, hat, ponytail');
  assert.equal(result.negativeRight, 'worst quality, glasses, beard');
  assert.equal(result.editorFields.negativeLeft, null, 'nor may the editor apply empty them');
});

test('a structured request answered without schema_version keeps the original prompts', async () => {
  const result = await resolveQueuedAiPrompt({
    mode: 'Refine',
    content: JSON.stringify({ common: '', positive: 'side only', positive_right: 'side only', negative: 'lowres', changes: '' }),
    marker,
    regional: true,
    originalPrompts: { positive: 'full left', positiveRight: 'full right', negative: 'lowres, hat, glasses, ponytail, beard' },
    fixedContext: { ...REGIONAL_CONTEXT, requestSchema: 3, muted: [] },
  });
  assert.equal(result.ok, false);
  assert.equal(result.envelope.format, 'invalid');
  assert.equal(result.positive, 'full left');
  assert.equal(result.negativeLeft, undefined, 'the generated side negatives stay');
});

test('muted fields and switched-off tags stay out of a structured Refine result', async () => {
  const result = await resolveQueuedAiPrompt({
    mode: 'Refine',
    content: JSON.stringify({
      schema_version: 3,
      common: 'masterpiece',
      positive: 'left',
      positive_right: 'right',
      negative: 'lowres, ~bad hands',
      negative_left: 'muted left text',
      negative_right: 'glasses',
      changes: '',
    }),
    marker,
    regional: true,
    originalPrompts: { positive: 'old left', positiveRight: 'old right', negative: 'old negative' },
    fixedContext: {
      ...REGIONAL_CONTEXT,
      // Negative (left) was muted, so generation gave its unit no text
      negative: { ...REGIONAL_CONTEXT.negative, texts: { ...REGIONAL_CONTEXT.negative.texts, negative_left: '' } },
      requestSchema: 3,
      muted: ['negativeLeft'],
    },
  });
  assert.equal(result.envelope.format, 'v3');
  assert.equal(result.negativeLeft, 'lowres, ponytail');
  assert.equal(result.negativeRight, 'lowres, glasses, beard');
  assert.doesNotMatch(result.negative, /muted left text|bad hands/);
});

test('a legacy Regional negative keeps each side\'s own tags on that side', async () => {
  const legacy = await resolveQueuedAiPrompt({
    mode: 'Refine',
    content: JSON.stringify({ positive: 'full left', positive_right: 'full right', negative: 'lowres, hat, glasses, ponytail, beard, bad hands' }),
    marker,
    regional: true,
    originalPrompts: { positive: 'old left', positiveRight: 'old right', negative: 'lowres, hat, glasses, ponytail, beard' },
    fixedContext: { ...REGIONAL_CONTEXT, requestSchema: 0, muted: [] },
  });
  assert.equal(legacy.envelope.format, 'legacy');
  assert.equal(legacy.negativeLeft, 'lowres, hat, ponytail, bad hands');
  assert.equal(legacy.negativeRight, 'lowres, glasses, beard, bad hands');
  assert.equal(legacy.negative, 'lowres, hat, glasses, ponytail, beard, bad hands', 'the merged negative is the answer itself');
});
test('an answer reused by the AI role "Last" keeps this run\'s Regional sides', async () => {
  // what an earlier run outside Regional answered: every Regional-only field is empty
  const content = JSON.stringify({
    schema_version: 3, common: 'masterpiece', positive: '1girl', positive_right: '',
    negative: 'worst quality', negative_left: '', negative_right: '', changes: '',
  });
  const options = {
    mode: 'Refine',
    content,
    marker,
    regional: true,
    originalPrompts: { positive: 'old left', positiveRight: 'old right', negative: 'old negative' },
    fixedContext: { ...REGIONAL_CONTEXT, requestSchema: 3, muted: [] },
  };

  const reused = await resolveQueuedAiPrompt({ ...options, reusedAnswer: true });
  assert.equal(reused.envelope.format, 'v3');
  assert.equal(reused.positive, 'masterpiece, 1girl');
  assert.equal(reused.positiveRight, 'masterpiece, right', 'the right side keeps what generation made of it');
  assert.equal(reused.negativeLeft, 'worst quality, hat, ponytail');
  assert.equal(reused.negativeRight, 'worst quality, glasses, beard');

  // this run's own answer empties them, as it always did
  const fresh = await resolveQueuedAiPrompt(options);
  assert.equal(fresh.positiveRight, 'masterpiece');
  assert.equal(fresh.negativeLeft, 'worst quality, ponytail');
});
