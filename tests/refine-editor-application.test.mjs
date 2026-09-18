import assert from 'node:assert/strict';
import test from 'node:test';

import { applyRefineEditorPatch, describeRefineCandidate } from '../scripts/renderer/tools/refineEditorApplication.js';
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
  // Positive (right) is not part of a normal prompt, so a normal run leaves it alone
  assert.deepEqual(h.values, {
    common: 'new common',
    positive: 'new positive',
    positive_right: '',
    negative: 'new negative',
  });
  assert.deepEqual(h.settings, {
    custom_prompt: 'new common',
    api_prompt: 'new positive',
    api_prompt_right: '',
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

test('a normal run never writes the hidden Positive (right) text', () => {
  const h = harness();
  h.values.positive_right = 'kept for Regional';
  h.settings.api_prompt_right = 'kept for Regional';
  const result = applyRefineEditorPatch({
    candidate: { ...candidate, editorFields: { ...candidate.editorFields, positiveRight: '' } },
    snapshot: snapshot(),
    currentSnapshot: snapshot(),
    controls: h.controls,
    settings: h.settings,
    tagCapsuleFields: h.tagCapsuleFields,
  });
  assert.equal(result.status, 'applied');
  assert.equal(h.values.positive_right, 'kept for Regional');
  assert.equal(h.settings.api_prompt_right, 'kept for Regional');
});

function mutedRegionalSnapshot(fields = {}) {
  return createRefineEditorSnapshot({
    mode: 'regional',
    fields: {
      common: 'old common',
      positive: 'old positive',
      positiveRight: 'old right',
      negative: 'old negative, ~bad hands',
      negativeLeft: 'old left negative',
      negativeRight: 'old right negative',
      exclude: 'watermark',
      ...fields,
    },
    muted: ['negativeLeft'],
    ai: { interface: 'Local', role: 1, promptMode: 'Refine', instruction: 'refine' },
  });
}

test('a muted field and switched-off tags survive an apply', () => {
  const h = regionalHarness();
  h.values.negative = 'old negative, ~bad hands';
  h.settings.api_neg_prompt = h.values.negative;
  const result = applyRefineEditorPatch({
    candidate: {
      format: 'v3',
      validForEditorApply: true,
      editorFields: {
        ...candidate.editorFields,
        negative: 'new negative, ~invented',
        negativeLeft: '',
        negativeRight: 'new right negative',
      },
    },
    snapshot: mutedRegionalSnapshot(),
    currentSnapshot: mutedRegionalSnapshot(),
    controls: h.controls,
    settings: h.settings,
    tagCapsuleFields: h.tagCapsuleFields,
  });

  assert.equal(result.status, 'applied');
  assert.equal(h.values.negative_left, 'old left negative', 'the muted field keeps its text');
  assert.equal(h.settings.api_neg_prompt_left, 'old left negative');
  // "~bad hands" sat behind "old negative", and stays behind the tags that replaced it
  assert.equal(h.values.negative, 'new negative, ~bad hands', 'the switched-off tag stays, a "~" the model wrote does not');
  assert.equal(h.settings.api_neg_prompt, 'new negative, ~bad hands');
  assert.equal(h.values.negative_right, 'new right negative');
});

test('the pending summary lists exactly the fields an apply writes', () => {
  const v3 = {
    format: 'v3',
    validForEditorApply: true,
    changes: 'Moved the shadow.',
    editorFields: { ...candidate.editorFields, negativeLeft: '', negativeRight: 'lens flare' },
  };
  assert.equal(describeRefineCandidate(v3, regionalSnapshot()), [
    'Changes: Moved the shadow.',
    'Common: new common',
    'Positive: new positive',
    'Positive Right: new right',
    'Negative: new negative',
    'Negative Left: ',
    'Negative Right: lens flare',
  ].join('\n'), 'an emptied side negative is listed, since the apply empties it');

  assert.equal(describeRefineCandidate(v3, snapshot()), [
    'Changes: Moved the shadow.',
    'Common: new common',
    'Positive: new positive',
    'Negative: new negative',
  ].join('\n'), 'outside Regional nothing Regional-only is listed');

  assert.doesNotMatch(describeRefineCandidate(candidate, regionalSnapshot()), /Negative Left|Negative Right/, 'a schema 2 answer keeps the side negatives');

  // a switched-off field is not written, and the panel says so instead of staying silent
  const muted = describeRefineCandidate(v3, mutedRegionalSnapshot());
  assert.doesNotMatch(muted, /^Negative Left:/m, 'a muted field is not written');
  assert.match(muted, /^Switched off, kept as they are: Negative Left$/m);
  assert.doesNotMatch(describeRefineCandidate(v3, regionalSnapshot()), /Switched off/, 'nothing muted, nothing to say');
});
test('a switched-off tag keeps its place and the panel shows the text the apply writes', () => {
  const state = createRefineEditorSnapshot({
    mode: 'normal',
    fields: {
      common: 'old common',
      positive: 'girl, ~(red hair, blue eyes:1.2), smile, ~lowres',
      positiveRight: '',
      negative: 'old negative',
      exclude: '',
    },
    ai: { interface: 'Local', role: 1, promptMode: 'Refine', instruction: 'refine' },
  });
  const answer = {
    format: 'v3',
    validForEditorApply: true,
    changes: 'Reordered.',
    editorFields: {
      common: 'new common',
      positive: 'girl, smile, looking at viewer, ~invented',
      positiveRight: '',
      negative: 'new negative',
      negativeLeft: null,
      negativeRight: null,
    },
  };
  const h = harness();
  h.values.positive = state.fields.positive;
  const result = applyRefineEditorPatch({
    candidate: answer,
    snapshot: state,
    currentSnapshot: state,
    controls: h.controls,
    settings: h.settings,
    tagCapsuleFields: h.tagCapsuleFields,
  });

  assert.equal(result.status, 'applied');
  // the group is one switched-off tag, back at its own place; the trailing one stays last
  assert.equal(h.values.positive, 'girl, ~(red hair, blue eyes:1.2), smile, looking at viewer, ~lowres');
  // the panel shows exactly that, not the raw answer
  const text = describeRefineCandidate(answer, state);
  assert.match(text, /^Positive: girl, ~\(red hair, blue eyes:1\.2\), smile, looking at viewer, ~lowres$/m);
  assert.doesNotMatch(text, /~invented/);
});
