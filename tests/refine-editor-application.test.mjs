import assert from 'node:assert/strict';
import test from 'node:test';

import { applyRefineEditorPatch } from '../scripts/renderer/tools/refineEditorApplication.js';
import { createRefineEditorSnapshot } from '../scripts/renderer/tools/refineEditorState.js';

function snapshot(positive = 'old positive') {
  return createRefineEditorSnapshot({
    mode: 'normal',
    fields: { common: 'old common', positive, positiveRight: '', negative: 'old negative', exclude: 'watermark' },
    plans: { common: [], positive: [{ tokenId: 'old positive#0' }], positiveRight: [], negative: [], exclude: [] },
    batches: {},
    ai: { interface: 'Local', role: 1, promptMode: 'Refine', instruction: 'refine' },
  });
}

function harness() {
  const values = {
    common: 'old common',
    positive: 'old positive',
    positive_right: '',
    negative: 'old negative',
  };
  const controls = Object.fromEntries(Object.keys(values).map(key => [key, {
    getValue: () => values[key],
    setValue: value => { values[key] = value; },
  }]));
  const settings = { ...values };
  const calls = [];
  const tagCapsuleFields = {
    beginBatchUpdate: () => calls.push('begin'),
    endBatchUpdate: () => calls.push('end', 'refresh'),
    get: () => ({ getPlans: () => [] }),
  };
  return { values, controls, settings, calls, tagCapsuleFields };
}

const candidate = {
  format: 'v2',
  validForEditorApply: true,
  editorFields: {
    common: 'new common',
    positive: 'new positive',
    positiveRight: 'new right',
    negative: 'new negative',
  },
};

test('valid V2 patch updates all prompt stores as one batch and refreshes Final prompt once', () => {
  const state = snapshot();
  const h = harness();
  const result = applyRefineEditorPatch({
    candidate,
    snapshot: state,
    currentSnapshot: snapshot(),
    controls: h.controls,
    settings: h.settings,
    tagCapsuleFields: h.tagCapsuleFields,
  });

  assert.equal(result.status, 'applied');
  assert.deepEqual(h.values, {
    common: 'new common',
    positive: 'new positive',
    positive_right: 'new right',
    negative: 'new negative',
  });
  assert.deepEqual(h.settings, h.values);
  assert.deepEqual(h.calls, ['begin', 'end', 'refresh']);
});

test('conflict or non-V2 candidate never partially overwrites current editing work', () => {
  const h = harness();
  const before = structuredClone(h.values);
  const conflict = applyRefineEditorPatch({
    candidate,
    snapshot: snapshot(),
    currentSnapshot: snapshot('user changed this'),
    controls: h.controls,
    settings: h.settings,
    tagCapsuleFields: h.tagCapsuleFields,
  });
  assert.equal(conflict.status, 'conflict');
  assert.deepEqual(h.values, before);
  assert.deepEqual(h.calls, []);

  const invalid = applyRefineEditorPatch({
    candidate: { format: 'legacy', validForEditorApply: false },
    snapshot: snapshot(),
    currentSnapshot: snapshot(),
    controls: h.controls,
    settings: h.settings,
    tagCapsuleFields: h.tagCapsuleFields,
  });
  assert.equal(invalid.status, 'invalid');
  assert.deepEqual(h.values, before);
});
