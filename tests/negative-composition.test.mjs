import assert from 'node:assert/strict';
import test from 'node:test';

import { composeNegativeChain, composeRegionalNegatives } from '../scripts/shared/negativeComposition.js';

test('a normal negative follows the chain order and ends on the character negatives', () => {
  const negative = composeNegativeChain({
    chain: ['neg_custom', 'negative', 'missing_unit'],
    texts: { negative: 'worst quality', neg_custom: ' jpeg artifacts ', empty: 'unused' },
    characterNegative: 'extra arms',
  });

  assert.equal(negative, 'jpeg artifacts, worst quality, extra arms');
});

test('an empty chain still returns the character negatives alone', () => {
  assert.equal(composeNegativeChain({ characterNegative: 'extra arms' }), 'extra arms');
  assert.equal(composeNegativeChain(), '');
});

test('regional sides share the "both" units and keep their own after them', () => {
  const { left, right, merged } = composeRegionalNegatives({
    chains: {
      both: ['negative', 'neg_both'],
      left: ['negative', 'neg_both', 'negative_left'],
      right: ['negative', 'neg_both', 'negative_right', 'neg_right'],
    },
    texts: {
      negative: 'worst quality',
      neg_both: 'jpeg artifacts',
      negative_left: 'harsh shadow',
      negative_right: 'lens flare',
      neg_right: 'right custom',
    },
    characterLeft: 'alice negative',
    characterRight: 'bob negative',
  });

  assert.equal(left, 'worst quality, jpeg artifacts, harsh shadow, alice negative');
  assert.equal(right, 'worst quality, jpeg artifacts, lens flare, right custom, bob negative');
  assert.equal(merged, 'worst quality, jpeg artifacts, harsh shadow, lens flare, right custom, alice negative, bob negative');
});

test('a side unit repeating a "both" unit is written once, not twice', () => {
  const { left, merged } = composeRegionalNegatives({
    chains: { both: ['negative'], left: ['negative', 'negative_left'], right: ['negative'] },
    texts: { negative: 'worst quality', negative_left: 'worst quality' },
  });

  assert.equal(left, 'worst quality');
  assert.equal(merged, 'worst quality');
});
