import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assignCapsuleIds,
  capsuleStats,
  collectPlans,
  excludedTagSet,
  expandAll,
  handleChipKey,
  insertCapsules,
  isTerminalAt,
  moveCapsule,
  normalizeBatch,
  nudgeCapsuleWeight,
  parsePlans,
  parsePromptToCapsules,
  reconcilePlans,
  removeCapsule,
  resolveBatchPlan,
  serializePlans,
  setCapsulePlan,
  weightWarning,
} from '../scripts/renderer/components/tagCapsuleLogic.js';

// SAA-tag-ui-redesign.md §13.4 / §13.14 / §14.2

test('capsule ids are normalized name + ordinal so duplicates stay distinct and follow reordering', () => {
  const capsules = parsePromptToCapsules('Blue  Hair, blue hair, (blue hair:1.2)');
  assert.deepEqual(capsules.map(c => c.id), ['blue hair#0', 'blue hair#1', 'blue hair#2']);
  const moved = moveCapsule(capsules, 2, 0);
  assert.deepEqual(moved.map(c => c.value), ['blue hair', 'Blue  Hair', 'blue hair']);
  assert.deepEqual(moved.map(c => c.id), ['blue hair#0', 'blue hair#1', 'blue hair#2']);
  assert.equal(moved[0].weightPlan.min, 1.2);
  assert.equal(assignCapsuleIds(removeCapsule(moved, 1)).length, 2);
});

test('sidecar plans re-match by id after a text edit and report discarded entries', () => {
  const plans = {
    'detailed eyes#0': { mode: 'increment', min: 1, max: 1.3, step: 0.05, seed: 0 },
    'soft lighting#0': { mode: 'random', min: 0.8, max: 1.2, step: 0.05, seed: 0 },
    'ignored#0': { mode: 'fixed', min: 1.2, max: 1.2, step: 0.05, seed: 0 },
  };
  const kept = reconcilePlans(parsePromptToCapsules('1girl, detailed eyes, soft lighting'), plans);
  assert.deepEqual(kept.discarded, []);
  assert.equal(kept.capsules[1].weightPlan.mode, 'increment');
  assert.equal(kept.capsules[2].weightPlan.mode, 'random');
  assert.deepEqual(Object.keys(kept.plans).sort(), ['detailed eyes#0', 'soft lighting#0']);

  const edited = reconcilePlans(parsePromptToCapsules('1girl, detailed eyes'), plans);
  assert.deepEqual(edited.discarded, ['soft lighting#0']);
  assert.deepEqual(Object.keys(edited.plans), ['detailed eyes#0']);
});

test('plans serialize to the settings.json array form and back, dropping fixed entries', () => {
  const capsules = setCapsulePlan(parsePromptToCapsules('a, b, c'), 'b#0', { mode: 'decrement', min: 0.9, max: 1.1, step: 0.1 });
  const serialized = serializePlans(collectPlans(capsules));
  assert.deepEqual(serialized, [{ id: 'b#0', mode: 'decrement', min: 0.9, max: 1.1, step: 0.1, seed: 0 }]);
  const parsed = parsePlans([...serialized, { id: 'x#0', mode: 'fixed', min: 1.2, max: 1.2 }, null, { id: '' }]);
  assert.deepEqual(Object.keys(parsed), ['b#0']);
  assert.deepEqual(normalizeBatch({ enabled: 'yes', count: 999 }), { enabled: true, count: 32 });
  assert.deepEqual(normalizeBatch({}), { enabled: false, count: 4 });
});

test('stats, warnings, nudges, insert and exclude matching follow the spec thresholds', () => {
  const capsules = parsePromptToCapsules('a, (b:1.2), (c:0.4)');
  const withPlan = setCapsulePlan(capsules, 'a#0', { mode: 'random', min: 0.8, max: 1.2, step: 0.05 });
  assert.deepEqual(capsuleStats(withPlan), { total: 3, weighted: 2, variable: 1 });
  assert.equal(weightWarning({ mode: 'fixed', min: 0.4, max: 0.4 }), true);
  assert.equal(weightWarning({ mode: 'fixed', min: 1.5, max: 1.5 }), false);
  assert.equal(weightWarning({ mode: 'increment', min: 1, max: 1.6, step: 0.05 }), true);
  const nudged = nudgeCapsuleWeight(capsules, 1, 0.05);
  assert.equal(nudged[1].weightPlan.min, 1.25);
  assert.equal(nudgeCapsuleWeight(withPlan, 0, 0.05), withPlan, 'variable plans are not nudged');
  assert.deepEqual(insertCapsules(capsules, ['d', '(e:1.1)'], 1).map(c => c.value), ['a', 'd', 'e', 'b', 'c']);
  assert.deepEqual([...excludedTagSet('Blue hair, red:pink,  , hat')], ['blue hair', 'red', 'hat']);
});

test('chip keyboard reducer implements §9.2 (roving index, Ctrl moves, Delete focus, type-to-add)', () => {
  const s = { index: 1, count: 3 };
  assert.deepEqual(handleChipKey(s, 'ArrowRight'), { index: 2, action: null });
  assert.deepEqual(handleChipKey({ index: 3, count: 3 }, 'ArrowRight'), { index: 3, action: null });
  assert.deepEqual(handleChipKey(s, 'ArrowLeft', { ctrlKey: true }), { index: 0, action: 'move-left' });
  assert.deepEqual(handleChipKey({ index: 0, count: 3 }, 'ArrowLeft', { ctrlKey: true }), { index: 0, action: null });
  assert.deepEqual(handleChipKey(s, 'ArrowUp', { ctrlKey: true }), { index: 1, action: 'weight-up' });
  assert.deepEqual(handleChipKey(s, 'ArrowUp'), { index: 1, action: null });
  assert.deepEqual(handleChipKey(s, 'Home'), { index: 0, action: null });
  assert.deepEqual(handleChipKey(s, 'End'), { index: 3, action: null });
  assert.deepEqual(handleChipKey(s, 'Enter'), { index: 1, action: 'open' });
  assert.deepEqual(handleChipKey({ index: 3, count: 3 }, ' '), { index: 3, action: 'add' });
  assert.deepEqual(handleChipKey({ index: 2, count: 3 }, 'Delete'), { index: 1, action: 'delete' });
  assert.deepEqual(handleChipKey({ index: 0, count: 3 }, 'Backspace'), { index: 0, action: 'delete' });
  assert.deepEqual(handleChipKey({ index: 0, count: 1 }, 'Delete'), { index: 0, action: 'delete' });
  assert.deepEqual(handleChipKey(s, 'Escape'), { index: 1, action: 'exit' });
  assert.deepEqual(handleChipKey(s, 'b'), { index: 3, action: 'type' });
  assert.deepEqual(handleChipKey(s, 'Tab'), { index: 1, action: null });
});

test('expandAll produces one row per image with seed + n − 1, exclude applied, and terminal markers', () => {
  const positive = setCapsulePlan(parsePromptToCapsules('1girl, detailed eyes, hat'), 'detailed eyes#0', { mode: 'increment', min: 1, max: 1.1, step: 0.05 });
  const fields = [
    { key: 'common', capsules: parsePromptToCapsules('masterpiece'), batch: { enabled: false, count: 4 } },
    { key: 'positive', capsules: positive, batch: { enabled: true, count: 4 } },
    { key: 'negative', capsules: parsePromptToCapsules('(blurry:1.2)') },
    { key: 'exclude', capsules: parsePromptToCapsules('hat') },
  ];
  const rows = expandAll(fields, 100, 4, {
    applyExclude: (prompt, exclude) => prompt.split(', ').filter(t => !exclude.split(', ').includes(t)).join(', '),
  });
  assert.equal(rows.length, 4);
  assert.deepEqual(rows.map(r => r.seed), [100, 101, 102, 103]);
  assert.equal(rows[0].positive, 'masterpiece, 1girl, detailed eyes');
  assert.equal(rows[1].positive, 'masterpiece, 1girl, (detailed eyes:1.05)');
  assert.equal(rows[2].positive, 'masterpiece, 1girl, (detailed eyes:1.10)');
  assert.equal(rows[3].positive, 'masterpiece, 1girl, (detailed eyes:1.10)');
  assert.deepEqual(rows[3].terminal, ['positive/detailed eyes#0']);
  assert.deepEqual(rows[2].terminal, []);
  assert.equal(rows[0].negative, '(blurry:1.20)');
  assert.equal(rows[0].fields.positive, '1girl, detailed eyes, hat');
  assert.equal(isTerminalAt({ mode: 'increment', min: 1, max: 1.1, step: 0.05 }, 3), true);
  assert.deepEqual(resolveBatchPlan(fields), { enabled: true, count: 4, variable: 1 });
  assert.deepEqual(
    resolveBatchPlan([{ key: 'positive', capsules: parsePromptToCapsules('a'), batch: { enabled: true, count: 8 } }]),
    { enabled: false, count: 1, variable: 0 },
  );
});

test('the same tag in two fields resolves random weights independently (field prefix in token id)', () => {
  const plan = { mode: 'random', min: 0.8, max: 1.3, step: 0.05, seed: 0 };
  const left = setCapsulePlan(parsePromptToCapsules('soft lighting'), 'soft lighting#0', plan);
  const rows = expandAll([{ key: 'positive', capsules: left }, { key: 'positive_right', capsules: left }], 7, 6);
  const leftWeights = rows.map(r => r.weights['positive/soft lighting#0']);
  const rightWeights = rows.map(r => r.weights['positive_right/soft lighting#0']);
  assert.notDeepEqual(leftWeights, rightWeights);
  const again = expandAll([{ key: 'positive', capsules: left }], 7, 6).map(r => r.weights['positive/soft lighting#0']);
  assert.deepEqual(leftWeights, again, 'reproducible for the same generation seed');
});
