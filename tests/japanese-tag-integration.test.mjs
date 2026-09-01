import test from 'node:test';
import assert from 'node:assert/strict';

import {
  mergeGeneralJapaneseAliases,
  parseBaseTagRows,
  splitJapaneseReviewCandidates,
} from '../scripts/integrateJapaneseTagAliases.mjs';

test('parses prompt groups from the four-column base tag CSV', () => {
  assert.deepEqual(parseBaseTagRows([
    'tag,0,123,',
    'artist_name,1,42,',
    'quoted_tag,3,5,"alias,with,commas"',
  ].join('\n')), [
    { tag: 'tag', group: 0 },
    { tag: 'artist_name', group: 1 },
    { tag: 'quoted_tag', group: 3 },
  ]);
});

test('merges only new Danbooru General aliases with Japanese text', () => {
  const result = mergeGeneralJapaneseAliases({
    baseText: [
      'general_tag,0,100,',
      'new_general,0,95,',
      'english_only,0,10,',
      'artist_name,1,90,',
      'work_name,3,80,',
      'character_name,4,70,',
      'e621_general,7,60,',
    ].join('\n'),
    existingText: 'general_tag,既存の一般タグ\n',
    sourceText: [
      'general_tag,新しい別名',
      'new_general,新規一般タグ',
      'artist_name,作家名',
      'work_name,作品名',
      'character_name,キャラクター名',
      'e621_general,e621一般',
      'unlisted,未収録',
      'english_only,english only',
    ].join('\n'),
  });

  assert.deepEqual(result.rows, [
    { tag: 'general_tag', alias: '既存の一般タグ,新しい別名' },
    { tag: 'new_general', alias: '新規一般タグ' },
  ]);
  assert.deepEqual(result.candidateRows, [
    { tag: 'new_general', alias: '新規一般タグ' },
  ]);
  assert.deepEqual(result.stats, {
    sourceRows: 8,
    matchedBaseRows: 7,
    eligibleGeneralRows: 2,
    addedRows: 1,
    mergedAliasRows: 1,
    skippedNonGeneralRows: 4,
    skippedUnlistedRows: 1,
    skippedNonJapaneseRows: 1,
  });
});

test('normalizes underscore and space variants to the base tag spelling', () => {
  const result = mergeGeneralJapaneseAliases({
    baseText: 'long_hair,0,100,',
    existingText: '',
    sourceText: 'long hair,長い髪',
  });

  assert.deepEqual(result.rows, [{ tag: 'long_hair', alias: '長い髪' }]);
  assert.equal(result.stats.addedRows, 1);
});

test('preserves quoted comma aliases from the existing dictionary', () => {
  const result = mergeGeneralJapaneseAliases({
    baseText: 'wake_up_girls!,0,100,',
    existingText: 'wake_up_girls!,"Wake Up, Girls!"',
    sourceText: 'wake_up_girls!,"Wake Up, Girls!"',
  });

  assert.deepEqual(result.rows, [{ tag: 'wake_up_girls!', alias: 'Wake Up, Girls!' }]);
  assert.equal(result.stats.mergedAliasRows, 0);
});

test('separates kana candidates from kanji-only aliases for manual review', () => {
  assert.deepEqual(splitJapaneseReviewCandidates([
    { tag: 'kana_tag', alias: 'チェック柄' },
    { tag: 'kanji_tag', alias: '格子衣服' },
    { tag: 'latin_tag', alias: 'english' },
  ]), {
    kanaRows: [{ tag: 'kana_tag', alias: 'チェック柄' }],
    kanjiOnlyRows: [{ tag: 'kanji_tag', alias: '格子衣服' }],
  });
});
