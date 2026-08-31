import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildWeightCandidates,
  formatTagWeight,
  parsePromptToCapsules,
  previewBatch,
  resolveWeight,
  serializeCapsules,
  stableHash32,
} from '../scripts/renderer/components/tagCapsuleLogic.js';

test('parses plain and weighted prompt tokens into capsule data', () => {
  const capsules = parsePromptToCapsules('blue hair, (school uniform:1.2)\nsolo');

  assert.deepEqual(capsules.map(capsule => capsule.value), ['blue hair', 'school uniform', 'solo']);
  assert.equal(capsules[0].weightPlan.mode, 'fixed');
  assert.equal(capsules[0].weightPlan.min, 1);
  assert.equal(capsules[1].weightPlan.min, 1.2);
  assert.equal(capsules[1].weightPlan.max, 1.2);
  assert.deepEqual(capsules.map(capsule => capsule.id), ['blue hair#0', 'school uniform#0', 'solo#0']);
});

test('serializes weight 1 without markup and formats other weights for ComfyUI', () => {
  const capsules = parsePromptToCapsules('blue hair, (school uniform:1.2)');

  assert.equal(serializeCapsules(capsules), 'blue hair, (school uniform:1.20)');
  assert.equal(formatTagWeight(1), '1.00');
  assert.equal(formatTagWeight(1.05), '1.05');
});

test('truncates increment and decrement candidates at the terminal in-range value', () => {
  assert.deepEqual(
    buildWeightCandidates({ mode: 'increment', min: 1, max: 1.3, step: 0.05 }),
    [1, 1.05, 1.1, 1.15, 1.2, 1.25, 1.3],
  );
  assert.deepEqual(
    buildWeightCandidates({ mode: 'increment', min: 1, max: 1.3, step: 0.2 }),
    [1, 1.2],
  );
  assert.deepEqual(
    buildWeightCandidates({ mode: 'decrement', min: 0.8, max: 1.3, step: 0.2 }),
    [1.3, 1.1, 0.9],
  );
});

test('treats min equal to max as a single constant candidate for every mode', () => {
  for (const mode of ['increment', 'decrement', 'random']) {
    assert.deepEqual(
      buildWeightCandidates({ mode, min: 1.1, max: 1.1, step: 0.05 }),
      [1.1],
    );
  }
});

test('resolves incremental and decremental batch weights and holds the terminal value', () => {
  const increment = { mode: 'increment', min: 1, max: 1.1, step: 0.05 };
  const decrement = { mode: 'decrement', min: 0.9, max: 1.1, step: 0.05 };

  assert.equal(resolveWeight(increment, { imageIndex: 0 }), 1);
  assert.equal(resolveWeight(increment, { imageIndex: 2 }), 1.1);
  assert.equal(resolveWeight(increment, { imageIndex: 99 }), 1.1);
  assert.equal(resolveWeight(decrement, { imageIndex: 0 }), 1.1);
  assert.equal(resolveWeight(decrement, { imageIndex: 99 }), 0.9);
});

test('random weights are reproducible from generation seed, plan seed, token id, and image index', () => {
  const plan = { mode: 'random', min: 0.8, max: 1.3, step: 0.05, seed: 17 };
  const args = { imageIndex: 4, generationSeed: 123456, tokenId: 'tag-2' };

  assert.equal(resolveWeight(plan, args), resolveWeight(plan, args));
  assert.ok(buildWeightCandidates(plan).includes(resolveWeight(plan, args)));
  assert.notEqual(
    resolveWeight(plan, args),
    resolveWeight(plan, { ...args, imageIndex: 5 }),
    'the test vector should vary across these adjacent image indexes',
  );
});

test('uses a byte-stable UTF-8 FNV-1a hash input for random plans', () => {
  const hashInput = ['123456', 17, 'tag-2', 4].join(String.fromCharCode(31));
  assert.equal(stableHash32(hashInput), 1744125764);
});

test('previews one final prompt per batch item without changing the capsule list', () => {
  const capsules = parsePromptToCapsules('blue hair, (school uniform:1.2)');
  capsules[0].weightPlan = { mode: 'increment', min: 1, max: 1.1, step: 0.05 };

  const result = previewBatch(capsules, 3, 42);

  assert.deepEqual(result.map(item => item.imageIndex), [0, 1, 2]);
  assert.deepEqual(result.map(item => item.weights[0]), [1, 1.05, 1.1]);
  assert.equal(result[0].prompt, 'blue hair, (school uniform:1.20)');
  assert.equal(capsules[0].weightPlan.mode, 'increment');
});
