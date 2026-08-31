import assert from 'node:assert/strict';
import test from 'node:test';

import {
  filterSelectionOptions,
  insertTagsAtCursor,
  limitSelectionOptions,
  normalizePromptToken,
  normalizeSearchText,
  normalizeSelectionKey,
  removeSelectedOption,
  selectOption,
} from '../scripts/renderer/components/selectionModalLogic.js';

const options = [
  { key: 'blue_hair', value: 'blue hair', label: '青い髪', category: 'appearance', attributes: ['color', 'hair'] },
  { key: 'holding_halo', value: 'holding halo', label: 'Halo holder', category: 'pose_action', attributes: ['pose'] },
  { key: 'school_uniform', value: 'school uniform', label: '制服', category: 'clothing', attributes: ['outfit'] },
];

test('normalizes search text with NFKC, whitespace, and case folding', () => {
  assert.equal(normalizeSearchText('  Ｂｌｕｅ　ＨＡＩＲ  '), 'blue hair');
});

test('filters by all searchable fields and requires every query term', () => {
  assert.deepEqual(
    filterSelectionOptions(options, { query: '青い hair' }).map(option => option.key),
    ['blue_hair'],
  );
  assert.deepEqual(
    filterSelectionOptions(options, { category: 'pose_action' }).map(option => option.key),
    ['holding_halo'],
  );
  assert.deepEqual(
    filterSelectionOptions(options, { attribute: 'outfit' }).map(option => option.key),
    ['school_uniform'],
  );
});

test('keeps selection order for multiple mode and replaces selection for single mode', () => {
  const selected = selectOption([], options[1], 'multiple');
  const both = selectOption(selected, options[0], 'multiple');
  assert.deepEqual(both.map(option => option.key), ['holding_halo', 'blue_hair']);
  assert.deepEqual(selectOption(both, options[1], 'multiple').map(option => option.key), ['blue_hair']);
  assert.deepEqual(selectOption(selected, options[0], 'single').map(option => option.key), ['blue_hair']);
});

test('matches prompt selections across underscore and display-space spellings', () => {
  assert.equal(normalizeSelectionKey('(blue_hair:1.1)'), 'blue hair');
  assert.deepEqual(selectOption([{ key: 'blue hair' }], { key: 'blue_hair' }, 'multiple'), []);
});

test('removes a selected option without affecting other selections', () => {
  assert.deepEqual(
    removeSelectedOption([options[0], options[1]], 'blue_hair').map(option => option.key),
    ['holding_halo'],
  );
});

test('limits rendered options while reporting whether more results exist', () => {
  const result = limitSelectionOptions(options, 2);
  assert.deepEqual(result.items.map(option => option.key), ['blue_hair', 'holding_halo']);
  assert.equal(result.hasMore, true);
  assert.equal(limitSelectionOptions(options, 10).hasMore, false);
});

test('normalizes weighted prompt tokens without stripping escaped parentheses', () => {
  assert.equal(normalizePromptToken(' (BLUE_HAIR:1.20) '), 'blue hair');
  assert.equal(normalizePromptToken('(blue_hair:0.8)'), 'blue hair');
  assert.equal(normalizePromptToken(String.raw`\(blue_hair\)`), String.raw`\(blue hair\)`);
});

test('inserts unique tags at the cursor with safe comma boundaries', () => {
  assert.deepEqual(
    insertTagsAtCursor('', ['blue_hair', 'holding_halo'], 0, 0),
    { value: 'blue hair, holding halo', cursor: 23 },
  );
  assert.deepEqual(
    insertTagsAtCursor('school uniform', ['blue_hair'], 14, 14),
    { value: 'school uniform, blue hair', cursor: 25 },
  );
  assert.deepEqual(
    insertTagsAtCursor('school uniform, blue hair', ['(BLUE_HAIR:1.2)', 'holding_halo'], 25, 25),
    { value: 'school uniform, blue hair, holding halo', cursor: 39 },
  );
  assert.deepEqual(
    insertTagsAtCursor('blue hair, school uniform', ['holding_halo'], 10, 10),
    { value: 'blue hair, holding halo, school uniform', cursor: 23 },
  );
});
