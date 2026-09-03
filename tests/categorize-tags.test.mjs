import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CATEGORIES,
  collectApplicable,
  isNsfwTag,
  mergeCategories,
  parseMergedRows,
  selectCandidates,
  validateAssignmentRows,
  validateVerificationRows,
} from '../scripts/categorizeTags.mjs';

test('explicit tags route to the local model, ordinary tags do not', () => {
  for (const tag of ['sex', 'cum_on_body', 'nipples', 'spread_legs', 'hetero', 'anal_beads']) {
    assert.equal(isNsfwTag(tag), true, tag);
  }
  for (const tag of ['1girl', 'long_hair', 'school_uniform', 'sword', 'glass', 'grass_field', 'cucumber', 'documentary']) {
    assert.equal(isNsfwTag(tag), false, tag);
  }
});

test('category list mirrors the taxonomy without unknown', () => {
  assert.deepEqual(CATEGORIES, ['body', 'pose_action', 'clothing', 'appearance', 'object', 'composition_quality']);
});

test('merged CSV rows parse and candidates are selected by group, heat, and novelty', () => {
  const rows = parseMergedRows([
    '1girl,0,6008644,"1girls,sole_female"',
    'highres,5,5256195,"high_res,hires"',
    'akemi_homura,4,100000,',
    'rare_general_tag,0,999,',
    'known_tag,0,50000,',
  ].join('\n'));
  assert.equal(rows.length, 5);
  assert.deepEqual(rows[0], { tag: '1girl', group: 0, heat: 6008644 });

  const candidates = selectCandidates(rows, { groups: [0, 5], minHeat: 10000, known: new Set(['known_tag']) });
  // character tag, low-heat tag, and already-known tag are all excluded; sorted by heat
  assert.deepEqual(candidates.map(row => row.tag), ['1girl', 'highres']);
  assert.deepEqual(candidates.map(row => row.i), [1, 2]);
});

test('assignment validation enforces ids, categories, and confidence', () => {
  const inputs = [{ i: 1, tag: 'sword', group: 0, heat: 5 }, { i: 2, tag: 'dress', group: 0, heat: 4 }];
  const reviews = validateAssignmentRows(inputs, [
    { i: 2, category: 'clothing', confidence: 'high' },
    { i: 1, category: 'unknown', confidence: 'low' },
  ]);
  assert.deepEqual(reviews.map(row => [row.tag, row.category]), [['sword', 'unknown'], ['dress', 'clothing']]);

  assert.throws(() => validateAssignmentRows(inputs, [{ i: 1, category: 'clothing', confidence: 'high' }]), /returned 1 rows/);
  assert.throws(() => validateAssignmentRows(inputs, [
    { i: 1, category: 'invented', confidence: 'high' },
    { i: 2, category: 'clothing', confidence: 'high' },
  ]), /Invalid category/);
  assert.throws(() => validateVerificationRows(inputs, [
    { i: 1, accept: 'yes', confidence: 'high' },
    { i: 2, accept: true, confidence: 'high' },
  ]), /Invalid accept/);
});

test('only high-confidence verified assignments are applied, never overwriting existing entries', () => {
  const reviews = [
    { tag: 'sword', category: 'object', confidence: 'high', verification: { accepted: true, confidence: 'high' } },
    { tag: 'dress', category: 'clothing', confidence: 'medium', verification: { accepted: true, confidence: 'high' } },
    { tag: 'halo', category: 'object', confidence: 'high', verification: { accepted: false, confidence: 'high' } },
    { tag: 'blurry', category: 'composition_quality', confidence: 'high', verification: { accepted: true, confidence: 'medium' } },
    { tag: 'mystery', category: 'unknown', confidence: 'high', verification: null },
    { tag: 'breasts', category: 'appearance', confidence: 'high', verification: { accepted: true, confidence: 'high' } },
  ];
  assert.deepEqual(collectApplicable(reviews).map(row => row.tag), ['sword', 'breasts']);

  const existing = {
    schemaVersion: 1,
    tags: {
      breasts: { category: 'body', status: 'verified', source: 'Danbooru Wiki', sourceUrl: 'https://danbooru.donmai.us/wiki_pages/breasts.html' },
    },
  };
  const { data, added } = mergeCategories(existing, reviews, 'test-model');
  assert.equal(added, 1);
  // the hand-checked entry wins over the (wrong) LLM proposal
  assert.equal(data.tags.breasts.category, 'body');
  assert.deepEqual(data.tags.sword, { category: 'object', status: 'verified', source: 'LLM', model: 'test-model' });
  assert.equal(data.tags.dress, undefined);
});
