import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  beginImageOverride,
  describeOverrideWeights,
  endImageOverride,
  getActiveOverride,
  overrideSeed,
  planBatchExpansion,
  readPromptValue,
} from '../scripts/renderer/tools/promptBatchExpansion.js';
import { expandAll, parsePromptToCapsules, setCapsulePlan } from '../scripts/renderer/components/tagCapsuleLogic.js';

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.join(testDirectory, '..');
const read = relativePath => fs.readFileSync(path.join(projectRoot, relativePath), 'utf8');

function fakeFieldSet(count, enabled = true) {
  const positive = setCapsulePlan(parsePromptToCapsules('1girl, detailed eyes'), 'detailed eyes#0', { mode: 'increment', min: 1, max: 1.3, step: 0.05 });
  const fields = [
    { key: 'common', capsules: parsePromptToCapsules('masterpiece') },
    { key: 'positive', capsules: positive, batch: { enabled, count } },
    { key: 'negative', capsules: parsePromptToCapsules('blurry') },
    { key: 'exclude', capsules: [] },
  ];
  return {
    getBatchExpansion: () => ({ enabled, count, variable: 1 }),
    getPromptOverrides: (imageIndex, seed) => {
      const row = expandAll(fields, seed, imageIndex + 1)[imageIndex];
      return { ...row.fields, weights: row.weights, terminal: row.terminal };
    },
  };
}

test('a single generate becomes count × batch_size=1 sends with expanded prompts and seed + n − 1', () => {
  const set = fakeFieldSet(8);
  const expansion = planBatchExpansion({ loops: 1, runSame: false }, { fieldSet: set, sliderSeed: 20260825 });
  assert.deepEqual(
    { loops: expansion.loops, enabled: expansion.enabled, count: expansion.count, baseSeed: expansion.baseSeed },
    { loops: 8, enabled: true, count: 8, baseSeed: 20260825 },
  );
  assert.equal(expansion.rows.length, 8, 'all expansion rows are frozen at generate click');

  const seen = [];
  for (let loop = 0; loop < expansion.loops; loop += 1) {
    const override = beginImageOverride(expansion, loop, { fieldSet: set });
    seen.push({
      seed: overrideSeed(-1),
      positive: readPromptValue('positive'),
      common: readPromptValue('common'),
      weights: override.weights,
      terminal: override.terminal,
    });
    endImageOverride();
  }
  assert.equal(getActiveOverride(), null);
  assert.deepEqual(seen.map(s => s.seed), [20260825, 20260826, 20260827, 20260828, 20260829, 20260830, 20260831, 20260832]);
  assert.equal(seen[0].positive, '1girl, detailed eyes');
  assert.equal(seen[1].positive, '1girl, (detailed eyes:1.05)');
  assert.equal(seen[6].positive, '1girl, (detailed eyes:1.30)');
  assert.equal(seen[7].positive, '1girl, (detailed eyes:1.30)');
  assert.deepEqual(seen[7].terminal, ['positive/detailed eyes#0']);
  assert.equal(seen[0].common, 'masterpiece');
  assert.equal(describeOverrideWeights({ imageIndex: 7, weights: seen[7].weights, terminal: seen[7].terminal }), 'Weights #8: positive/detailed eyes=1.30 ■');
});

test('prompt values and expansion rows are frozen before queue preparation starts', () => {
  let livePositive = 'before';
  const set = {
    getBatchExpansion: () => ({ enabled: true, count: 2, variable: 1 }),
    getPromptOverrides: imageIndex => ({
      common: 'shared',
      positive: `${livePositive}-${imageIndex}`,
      positive_right: '',
      negative: 'bad',
      exclude: '',
      weights: {},
      terminal: [],
    }),
  };
  const expansion = planBatchExpansion(
    { loops: 1 },
    {
      fieldSet: set,
      sliderSeed: 7,
      baseFields: { common: 'shared', positive: 'before', positive_right: '', negative: 'bad', exclude: '' },
    },
  );

  livePositive = 'after';
  const expanded = beginImageOverride(expansion, 1, { fieldSet: set });
  assert.equal(expanded.fields.positive, 'before-1');
  endImageOverride();

  const fixed = planBatchExpansion(
    { loops: 1, runSame: true },
    { fieldSet: set, baseFields: { positive: 'snapshot value' } },
  );
  assert.equal(beginImageOverride(fixed, 0, { fieldSet: set }), null);
  assert.equal(readPromptValue('positive'), 'snapshot value', 'disabled expansion still reads the run snapshot');
  endImageOverride();
});

test('expansion is skipped for Batch (Last), disabled fields, and keeps the caller loop count when larger', () => {
  const set = fakeFieldSet(4);
  assert.deepEqual(planBatchExpansion({ loops: 1, runSame: true }, { fieldSet: set, sliderSeed: 5 }), { loops: 1, enabled: false, count: 1, baseSeed: -1 });
  assert.deepEqual(planBatchExpansion({ loops: 3 }, { fieldSet: fakeFieldSet(4, false), sliderSeed: 5 }), { loops: 3, enabled: false, count: 1, baseSeed: -1 });
  const bigger = planBatchExpansion({ loops: 10 }, { fieldSet: set, sliderSeed: 5 });
  assert.equal(bigger.loops, 10);
  const random = planBatchExpansion({ loops: 1 }, { fieldSet: set, sliderSeed: -1, generateRandomSeed: () => 4242 });
  assert.equal(random.baseSeed, 4242, 'seed -1 draws one base seed for the whole batch');
  assert.equal(beginImageOverride({ enabled: false }, 0, { fieldSet: set }), null);
  assert.equal(overrideSeed(99), 99);
});

test('generate.js and generate_regional.js read prompts and seeds through the expansion bridge', () => {
  for (const file of ['scripts/renderer/generate.js', 'scripts/renderer/generate_regional.js']) {
    const source = read(file);
    assert.match(source, /planBatchExpansion\(dataPack, \{[\s\S]*?generateRandomSeed,[\s\S]*?baseFields: snapshotFieldsForPromptOverride\(refineSnapshot\),[\s\S]*?\}\)/, `${file} plans the expansion from the frozen editor snapshot`);
    assert.match(source, /beginImageOverride\(expansion, loop\)/, `${file} sets the per-image override`);
    assert.match(source, /endImageOverride\(\)/, `${file} clears the override`);
    assert.match(source, /overrideSeed\(globalThis\.generate\.seed\.getValue\(\)\)/, `${file} uses seed + n − 1`);
    assert.doesNotMatch(source, /globalThis\.prompt\.(?:common|positive|positive_right|negative|exclude)\.getValue\(\)/, `${file} must not bypass readPromptValue`);
    assert.match(source, /describeOverrideWeights\(imageOverride\)/, `${file} records weights in the info panel`);
  }
});

test('planned weights survive AI Refine: re-applied by name + ordinal on the refined prompt trio', async () => {
  const { applyPlanWeights, planWeightEntries, reapplyPlanWeights } = await import('../scripts/renderer/tools/promptBatchExpansion.js');
  const weights = { 'positive/detailed eyes#0': 1.1, 'common/nsfw#0': 1, 'negative/blurry#0': 1.3, 'positive/blue hair#1': 0.9 };
  assert.deepEqual(planWeightEntries(weights).positive, [{ name: 'detailed eyes', ordinal: 0, weight: 1.1 }, { name: 'blue hair', ordinal: 1, weight: 0.9 }]);

  // Refine rewrote weights and reordered tags; image #2 must still get (detailed eyes:1.10)
  const refined = 'masterpiece, (nsfw:1.20), 1girl, detailed eyes, blue hair, (blue hair:1.30), soft lighting';
  assert.equal(
    applyPlanWeights(refined, planWeightEntries(weights).positive.concat(planWeightEntries(weights).common)),
    'masterpiece, nsfw, 1girl, (detailed eyes:1.10), blue hair, (blue hair:0.90), soft lighting',
  );
  assert.equal(applyPlanWeights('a, b', []), 'a, b');
  assert.equal(applyPlanWeights('', [{ name: 'a', ordinal: 0, weight: 1.2 }]), '');

  const trio = reapplyPlanWeights({ ok: true, positive: 'detailed eyes, hat', positiveRight: 'detailed eyes', negative: '(blurry:1.10), bad hands' }, weights);
  assert.equal(trio.positive, '(detailed eyes:1.10), hat');
  assert.equal(trio.positiveRight, 'detailed eyes', 'positive_right has no plan of its own');
  assert.equal(trio.negative, '(blurry:1.30), bad hands');
  assert.equal(trio.ok, true);

  const generate = read('scripts/renderer/generate.js').replace(/\r\n/g, '\n');
  assert.match(generate, /planWeights: imageOverride\?\.weights \?\? null,/);
  assert.match(generate, /if \(queueManager\.planWeights\) \{\n\s*\/\/ AI Refine[^\n]*\n\s*promptResult = reapplyPlanWeights\(promptResult, queueManager\.planWeights\);/);
  assert.match(read('scripts/renderer/generate_regional.js'), /planWeights: imageOverride\?\.weights \?\? null,/);
});

test('the prompt section carries per-field weight plan / batch keys with defaults', async () => {
  const { DEFAULT_SETTINGS, SECTION_KEYS } = await import('../scripts/shared/settingsSections.js');
  for (const key of ['common', 'positive', 'positive_right', 'negative', 'exclude']) {
    assert.deepEqual(DEFAULT_SETTINGS[`${key}_weight_plans`], [], `${key}_weight_plans default`);
    assert.deepEqual(DEFAULT_SETTINGS[`${key}_batch`], { enabled: false, count: 4 }, `${key}_batch default`);
    assert.ok(SECTION_KEYS.prompt.includes(`${key}_weight_plans`) && SECTION_KEYS.prompt.includes(`${key}_batch`), `${key} keys live in the prompt section`);
  }
  const language = read('scripts/renderer/language.js');
  assert.match(language, /tagCapsuleFields\?\.loadFromSettings\?\.\(SETTINGS\)/);
  assert.match(language, /tagCapsuleFields\?\.updateLanguage\?\.\(\)/);
});
