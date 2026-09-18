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

test('searches the hidden keywords of an option, given as a list or as a function', () => {
  // a character's works, in every language: searchable, never shown
  const ganyu = { key: 'ganyu', value: 'ganyu', label: 'Ganyu', keywords: ['genshin impact', '原神'] };
  const hutao = { key: 'hu_tao', value: 'hu tao', label: () => 'Hu Tao', keywords: () => ['genshin impact'] };
  const all = [...options, ganyu, hutao];
  assert.deepEqual(filterSelectionOptions(all, { query: '原神' }).map(option => option.key), ['ganyu']);
  assert.deepEqual(filterSelectionOptions(all, { query: 'genshin' }).map(option => option.key), ['ganyu', 'hu_tao']);
  assert.deepEqual(filterSelectionOptions(all, { query: 'hu tao' }).map(option => option.key), ['hu_tao']);
  // a label the option computes (a translated name looked up when it is drawn) is searched
  // as well as its key - the function itself is not the text
  const displayNames = { ei: 'Raiden Shogun' };
  const ei = { key: 'ei', value: 'ei', label: () => displayNames.ei };
  assert.deepEqual(filterSelectionOptions([...all, ei], { query: 'raiden' }).map(option => option.key), ['ei']);
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

test('an option with nothing to key on is no choice at all, in either mode', () => {
  const selected = [options[0]];
  assert.deepEqual(selectOption(selected, { key: '', value: '' }, 'multiple'), [options[0]]);
  assert.deepEqual(selectOption(selected, { value: '   ' }, 'single'), [options[0]], 'blank text does not replace a choice');
  assert.deepEqual(selectOption(selected, {}, 'multiple'), [options[0]]);
  assert.notEqual(selectOption(selected, {}, 'multiple'), selected, 'and the caller gets a list of its own back');
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
  // a list that fits exactly is not cut short
  const exact = limitSelectionOptions(options, 3);
  assert.equal(exact.items.length, 3);
  assert.equal(exact.hasMore, false);
  // a limit that is no limit falls back to 200, and never to zero rows
  assert.equal(limitSelectionOptions(options).items.length, 3);
  assert.equal(limitSelectionOptions(options, 'lots').items.length, 3);
  assert.equal(limitSelectionOptions(options, 0).items.length, 3);
  assert.equal(limitSelectionOptions(options, -5).items.length, 1);
  assert.deepEqual(limitSelectionOptions(null, 2), { items: [], hasMore: false });
});

test('normalizes weighted prompt tokens without stripping escaped parentheses', () => {
  assert.equal(normalizePromptToken(' (BLUE_HAIR:1.20) '), 'blue hair');
  assert.equal(normalizePromptToken('(blue_hair:0.8)'), 'blue hair');
  assert.equal(normalizePromptToken(String.raw`\(blue_hair\)`), String.raw`\(blue hair\)`);
  // a weight applied twice ("((tag:1.1):1.2)") is peeled all the way down
  assert.equal(normalizePromptToken('((blue_hair:1.1):1.2)'), 'blue hair');
  assert.equal(normalizePromptToken('(((blue_hair:1.1):1.2):0.9)'), 'blue hair');
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
