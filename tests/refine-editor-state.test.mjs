import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createRefineEditorSnapshot,
  hasRefineEditorConflict,
} from '../scripts/renderer/tools/refineEditorState.js';

const input = overrides => ({
  mode: 'normal',
  fields: {
    common: 'masterpiece',
    positive: '1girl',
    positiveRight: '',
    negative: 'blurry',
    exclude: 'watermark',
  },
  plans: {
    common: [],
    positive: [{ tokenId: '1girl#0', min: 1, max: 1.2 }],
    positiveRight: [],
    negative: [],
    exclude: [],
  },
  batches: {
    common: { enabled: false, count: 4 },
    positive: { enabled: true, count: 3 },
    positiveRight: { enabled: false, count: 4 },
    negative: { enabled: false, count: 4 },
    exclude: { enabled: false, count: 4 },
  },
  ai: {
    interface: 'Local',
    role: 'Every',
    promptMode: 'Refine',
    instruction: '背景を弱めて',
  },
  ...overrides,
});

test('editor snapshot revision covers fields, plans, batches, mode and queued AI settings', () => {
  const snapshot = createRefineEditorSnapshot(input());
  assert.equal(Object.isFrozen(snapshot), true);
  assert.equal(Object.isFrozen(snapshot.fields), true);
  assert.equal(hasRefineEditorConflict(snapshot, createRefineEditorSnapshot(input())), false);

  const changedField = createRefineEditorSnapshot(input({ fields: { ...input().fields, positive: '2girls' } }));
  assert.equal(hasRefineEditorConflict(snapshot, changedField), true);

  const changedPlan = createRefineEditorSnapshot(input({
    plans: { ...input().plans, positive: [{ tokenId: '1girl#0', min: 1, max: 1.3 }] },
  }));
  assert.equal(hasRefineEditorConflict(snapshot, changedPlan), true);

  const changedRole = createRefineEditorSnapshot(input({ ai: { ...input().ai, role: 'Once' } }));
  assert.equal(hasRefineEditorConflict(snapshot, changedRole), true);
});

test('snapshot canonicalization is stable across object key order and detached from mutable input', () => {
  const mutable = input();
  const snapshot = createRefineEditorSnapshot(mutable);
  mutable.fields.positive = 'mutated later';
  mutable.plans.positive[0].max = 9;

  const reordered = createRefineEditorSnapshot({
    ai: { instruction: '背景を弱めて', promptMode: 'Refine', role: 'Every', interface: 'Local' },
    batches: mutable.batches,
    plans: { negative: [], positiveRight: [], common: [], exclude: [], positive: [{ max: 1.2, min: 1, tokenId: '1girl#0' }] },
    fields: { negative: 'blurry', positiveRight: '', common: 'masterpiece', exclude: 'watermark', positive: '1girl' },
    mode: 'normal',
  });

  assert.equal(snapshot.fields.positive, '1girl');
  assert.equal(snapshot.plans.positive[0].max, 1.2);
  assert.equal(snapshot.revision, reordered.revision);
});
