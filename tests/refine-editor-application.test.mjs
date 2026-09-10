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
  const settings = {
    custom_prompt: values.common,
    api_prompt: values.positive,
    api_prompt_right: values.positive_right,
    api_neg_prompt: values.negative,
  };
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
  assert.deepEqual(h.settings, {
    custom_prompt: 'new common',
    api_prompt: 'new positive',
    api_prompt_right: 'new right',
    api_neg_prompt: 'new negative',
  });
  assert.deepEqual(h.calls, ['begin', 'end', 'refresh']);
});

function regionalSnapshot() {
  return createRefineEditorSnapshot({
    mode: 'regional',
    fields: {
      common: 'old common',
      positive: 'old positive',
      positiveRight: 'old right',
      negative: 'old negative',
      negativeLeft: 'old left negative',
      negativeRight: 'old right negative',
      exclude: 'watermark',
    },
    ai: { interface: 'Local', role: 1, promptMode: 'Refine', instruction: 'refine' },
  });
}

function regionalHarness() {
  const h = harness();
  h.values.negative_left = 'old left negative';
  h.values.negative_right = 'old right negative';
  for (const key of ['negative_left', 'negative_right']) {
    h.controls[key] = { getValue: () => h.values[key], setValue: value => { h.values[key] = value; } };
  }
  h.settings.api_neg_prompt_left = h.values.negative_left;
  h.settings.api_neg_prompt_right = h.values.negative_right;
  return h;
}

test('a V3 candidate rewrites the Regional side negatives, a V2 one leaves them alone', () => {
  const h = regionalHarness();
  const applied = applyRefineEditorPatch({
    candidate: {
      format: 'v3',
      validForEditorApply: true,
      editorFields: { ...candidate.editorFields, negativeLeft: 'new left negative', negativeRight: 'new right negative' },
    },
    snapshot: regionalSnapshot(),
    currentSnapshot: regionalSnapshot(),
    controls: h.controls,
    settings: h.settings,
    tagCapsuleFields: h.tagCapsuleFields,
  });

  assert.equal(applied.status, 'applied');
  assert.equal(h.values.negative_left, 'new left negative');
  assert.equal(h.values.negative_right, 'new right negative');
  assert.equal(h.settings.api_neg_prompt_left, 'new left negative');
  assert.equal(h.settings.api_neg_prompt_right, 'new right negative');

  const kept = regionalHarness();
  const v2 = applyRefineEditorPatch({
    candidate,
    snapshot: regionalSnapshot(),
    currentSnapshot: regionalSnapshot(),
    controls: kept.controls,
    settings: kept.settings,
    tagCapsuleFields: kept.tagCapsuleFields,
  });

  assert.equal(v2.status, 'applied');
  assert.equal(kept.values.negative, 'new negative');
  assert.equal(kept.values.negative_left, 'old left negative');
  assert.equal(kept.values.negative_right, 'old right negative');

  // outside Regional the side fields are not part of the prompt, so nothing may write them
  const normalMode = regionalHarness();
  applyRefineEditorPatch({
    candidate: {
      format: 'v3',
      validForEditorApply: true,
      editorFields: { ...candidate.editorFields, negativeLeft: 'stray left', negativeRight: 'stray right' },
    },
    snapshot: snapshot(),
    currentSnapshot: snapshot(),
    controls: normalMode.controls,
    settings: normalMode.settings,
    tagCapsuleFields: normalMode.tagCapsuleFields,
  });
  assert.equal(normalMode.values.negative_left, 'old left negative');
  assert.equal(normalMode.values.negative_right, 'old right negative');
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
