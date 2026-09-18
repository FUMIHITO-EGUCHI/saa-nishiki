import assert from 'node:assert/strict';
import test from 'node:test';

import {
  captureRefineEditorSnapshot,
  createRefineEditorSnapshot,
  hasRefineEditorConflict,
  mutedRefineFields,
  refineRequestFields,
  snapshotFieldsForPromptOverride,
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

test('the per-side negatives are snapshotted only while Regional is on', () => {
  const sides = { negativeLeft: 'harsh shadow', negativeRight: 'lens flare' };

  const normal = createRefineEditorSnapshot(input({ fields: { ...input().fields, ...sides } }));
  assert.equal(normal.fields.negativeLeft, '');
  assert.equal(normal.fields.negativeRight, '');
  assert.equal(normal.revision, createRefineEditorSnapshot(input()).revision, 'unused side text never moves the revision');

  const regional = createRefineEditorSnapshot(input({ mode: 'regional', fields: { ...input().fields, ...sides } }));
  assert.equal(regional.fields.negativeLeft, 'harsh shadow');
  assert.equal(regional.fields.negativeRight, 'lens flare');
  assert.equal(hasRefineEditorConflict(regional, createRefineEditorSnapshot(input({ mode: 'regional' }))), true);
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

test('outside Regional Positive (right) is not snapshotted either', () => {
  const normal = createRefineEditorSnapshot(input({ fields: { ...input().fields, positiveRight: 'hidden right' } }));
  assert.equal(normal.fields.positiveRight, '');
  assert.equal(normal.revision, createRefineEditorSnapshot(input()).revision);

  const regional = createRefineEditorSnapshot(input({ mode: 'regional', fields: { ...input().fields, positiveRight: 'right side' } }));
  assert.equal(regional.fields.positiveRight, 'right side');
});

test('muted fields are part of the snapshot and read from the Scene mute settings', () => {
  const muted = createRefineEditorSnapshot(input({ muted: ['negative', 'negativeLeft', 'unknown'] }));
  assert.deepEqual(muted.muted, ['negative'], 'a Regional-only field is dropped outside Regional');
  assert.equal(hasRefineEditorConflict(createRefineEditorSnapshot(input()), muted), true, 'muting a field during the run is a conflict');
  assert.deepEqual(createRefineEditorSnapshot(input({ mode: 'regional', muted: ['negativeLeft', 'common'] })).muted, ['common', 'negativeLeft']);

  assert.deepEqual(mutedRefineFields({ prompt_field_muted: ['negative_left', 'common', 'views'] }), ['common', 'negativeLeft']);
  const captured = captureRefineEditorSnapshot({
    mode: 'regional',
    prompt: {},
    settings: { prompt_field_muted: ['negative_right'], negative_right: 'muted text' },
  });
  assert.deepEqual(captured.muted, ['negativeRight']);
  assert.equal(captured.fields.negativeRight, 'muted text', 'the editor text itself stays in the snapshot');
});

test('a structured request carries only the text that reaches the prompt', () => {
  const snapshot = createRefineEditorSnapshot(input({
    mode: 'regional',
    fields: { ...input().fields, negative: 'blurry, ~bad hands, lowres', negativeLeft: 'hat', negativeRight: '~glasses' },
    muted: ['negativeLeft'],
  }));
  const fields = refineRequestFields(snapshot);
  assert.equal(fields.negative, 'blurry, lowres', 'a switched-off tag is not sent');
  assert.equal(fields.negativeLeft, '', 'a muted field goes out empty');
  assert.equal(fields.negativeRight, '');
  assert.equal(fields.common, 'masterpiece');
  assert.equal(snapshot.fields.negative, 'blurry, ~bad hands, lowres', 'the snapshot keeps the raw editor text');

  // the model is told which fields it may not write, or it moves content into an
  // empty-looking one and the answer for it is dropped again
  assert.deepEqual(fields.locked, ['negativeLeft']);
  assert.deepEqual(refineRequestFields(createRefineEditorSnapshot(input())).locked, [], 'nothing muted, nothing locked');
  assert.deepEqual(
    refineRequestFields(createRefineEditorSnapshot(input({ muted: ['exclude', 'common'] }))).locked,
    ['common'],
    'Exclude is no field of the request',
  );
});

// This guard is what stops a Refine answer from overwriting edits made while it ran: a
// snapshot that cannot prove what the editor held when the run started is a conflict, and
// a conflict means the answer waits for the user instead of landing on its own.
test('a snapshot that cannot be compared counts as a conflict', () => {
  const snapshot = createRefineEditorSnapshot(input());

  assert.equal(hasRefineEditorConflict(null, snapshot), true, 'the run carried no snapshot');
  assert.equal(hasRefineEditorConflict(undefined, snapshot), true);
  assert.equal(hasRefineEditorConflict({}, snapshot), true, 'a snapshot without a revision proves nothing');
  assert.equal(hasRefineEditorConflict({ revision: '' }, snapshot), true, 'an empty revision is no revision');
  assert.equal(hasRefineEditorConflict({ fields: snapshot.fields }, snapshot), true);

  assert.equal(hasRefineEditorConflict(snapshot, null), true, 'the editor could not be read back');
  assert.equal(hasRefineEditorConflict(snapshot, {}), true);
  assert.equal(hasRefineEditorConflict({}, {}), true, 'two unknowns are not a match');

  // and a revision that is there and equal is the only way through
  assert.equal(hasRefineEditorConflict(snapshot, createRefineEditorSnapshot(input())), false);
  assert.equal(hasRefineEditorConflict({ revision: 'r1' }, { revision: 'r1' }), false);
  assert.equal(hasRefineEditorConflict({ revision: 'r1' }, { revision: 'r2' }), true, 'a stale snapshot is a conflict');
});

test('snapshotFieldsForPromptOverride names every field the way the settings do', () => {
  const snapshot = createRefineEditorSnapshot(input({
    mode: 'regional',
    fields: {
      common: 'masterpiece',
      positive: '1girl',
      positiveRight: 'right girl',
      negative: 'blurry',
      negativeLeft: 'harsh shadow',
      negativeRight: 'lens flare',
      exclude: 'watermark',
    },
  }));

  const override = snapshotFieldsForPromptOverride(snapshot);
  assert.deepEqual(override, {
    common: 'masterpiece',
    positive: '1girl',
    positive_right: 'right girl',
    negative: 'blurry',
    negative_left: 'harsh shadow',
    negative_right: 'lens flare',
    exclude: 'watermark',
  });
  assert.equal(Object.isFrozen(override), true);

  // it becomes the baseFields of a run, so a field must never come out as undefined
  assert.deepEqual(snapshotFieldsForPromptOverride(null), {
    common: '', positive: '', positive_right: '', negative: '', negative_left: '', negative_right: '', exclude: '',
  });
  assert.deepEqual(snapshotFieldsForPromptOverride({ fields: { positive: 'only this' } }), {
    common: '', positive: 'only this', positive_right: '', negative: '', negative_left: '', negative_right: '', exclude: '',
  });
  // outside Regional the snapshot holds no side text, so neither does the override
  assert.equal(snapshotFieldsForPromptOverride(createRefineEditorSnapshot(input({
    fields: { ...input().fields, negativeLeft: 'ignored' },
  }))).negative_left, '');
});
