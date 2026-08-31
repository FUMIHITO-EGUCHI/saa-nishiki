import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { getLocalizedCharacterName } from '../scripts/renderer/characterLocalization.js';
import { escapeHtml, parseTranslationLine } from '../scripts/main/tagTranslation.js';

const characterNames = {
  'ja-JP': {
    'hatsune miku': '初音ミク',
    'artoria pendragon (fate)': 'アルトリア・ペンドラゴン（運命）',
  },
  officialWorkNames: {
    fate: 'Fate',
    "girls' frontline": "Girls' Frontline",
  },
};

const testDir = path.dirname(fileURLToPath(import.meta.url));
const bundledCharacterNames = JSON.parse(fs.readFileSync(
  path.join(testDir, '../data/character_names.json'),
  'utf8',
));
bundledCharacterNames.officialWorkNames = JSON.parse(fs.readFileSync(
  path.join(testDir, '../data/official_work_names.json'),
  'utf8',
));

test('Japanese uses the localized character name when available', () => {
  assert.equal(
    getLocalizedCharacterName({
      key: '初音未来（VOCALOID）',
      tag: 'hatsune miku',
      language: 'ja-JP',
      characterNames,
    }),
    '初音ミク',
  );
});

test('Japanese falls back to the English generation tag when untranslated', () => {
  assert.equal(
    getLocalizedCharacterName({
      key: '未翻訳キャラ',
      tag: 'untranslated character',
      language: 'ja-JP',
      characterNames,
    }),
    'untranslated character',
  );
});

test('English continues to display the generation tag', () => {
  assert.equal(
    getLocalizedCharacterName({
      key: '初音未来（VOCALOID）',
      tag: 'hatsune miku',
      language: 'en-US',
      characterNames,
    }),
    'hatsune miku',
  );
});

test('Chinese keeps the existing internal display key', () => {
  assert.equal(
    getLocalizedCharacterName({
      key: '初音未来（VOCALOID）',
      tag: 'hatsune miku',
      language: 'zh-CN',
      characterNames,
    }),
    '初音未来（VOCALOID）',
  );
});

test('bundled Japanese data localizes a real character without changing its tag', () => {
  assert.equal(
    getLocalizedCharacterName({
      key: '初音未来（VOCALOID）',
      tag: 'hatsune miku',
      language: 'ja-JP',
      characterNames: bundledCharacterNames,
    }),
    '初音ミク',
  );
});

test('Japanese translation rows support the compact two-column format', () => {
  assert.deepEqual(
    parseTranslationLine('hatsune_miku,初音ミク'),
    { prompt: 'hatsune_miku', group: 0, aliases: '初音ミク' },
  );
});

test('Japanese translation rows support quoted commas in official titles', () => {
  assert.deepEqual(
    parseTranslationLine('wake_up_girls!,"Wake Up, Girls!"'),
    { prompt: 'wake_up_girls!', group: 0, aliases: 'Wake Up, Girls!' },
  );
});

test('existing grouped translation rows keep their group and aliases', () => {
  assert.deepEqual(
    parseTranslationLine('1girl,0,一人の女の子'),
    { prompt: '1girl', group: 0, aliases: '一人の女の子' },
  );
});

test('bundled Japanese tag data contains parseable Japanese aliases', () => {
  const row = fs.readFileSync(
    path.join(testDir, '../data/danbooru_e621_merged_ja.csv'),
    'utf8',
  ).split(/\r?\n/).find(line => line.startsWith('hatsune_miku,'));

  assert.deepEqual(parseTranslationLine(row), {
    prompt: 'hatsune_miku',
    group: 0,
    aliases: '初音ミク',
  });
});

test('tag display values escape HTML-sensitive characters', () => {
  assert.equal(escapeHtml('<o> & "quoted"'), '&lt;o&gt; &amp; &quot;quoted&quot;');
});

test('Japanese character names restore official work names without changing character names', () => {
  assert.equal(
    getLocalizedCharacterName({
      key: 'artoria pendragon (fate)',
      tag: 'artoria pendragon (fate)',
      language: 'ja-JP',
      characterNames,
    }),
    'アルトリア・ペンドラゴン（Fate）',
  );
});

test('official work lookup tolerates spacing differences in source tags', () => {
  assert.equal(
    getLocalizedCharacterName({
      tag: 'acheron (honkai  star rail)',
      language: 'ja-JP',
      characterNames: {
        'ja-JP': {
          'acheron (honkai  star rail)': '黄泉（旧タイトル）',
        },
        officialWorkNames: {
          'honkai star rail': '崩壊：スターレイル',
        },
      },
    }),
    '黄泉（崩壊：スターレイル）',
  );
});

test('bundled character data does not translate a work title', () => {
  assert.equal(
    getLocalizedCharacterName({
      key: 'abigail williams (fate)',
      tag: 'abigail williams (fate)',
      language: 'ja-JP',
      characterNames: bundledCharacterNames,
    }),
    'アビゲイル・ウィリアムズ（Fate）',
  );
});

test('official work dictionary keeps the Fate series brand name', () => {
  assert.equal(bundledCharacterNames.officialWorkNames['fate (series)'], 'Fate');
});

test('bundled character data restores several English work titles', () => {
  assert.equal(
    getLocalizedCharacterName({
      key: 'anya (spy x family)',
      tag: 'anya (spy x family)',
      language: 'ja-JP',
      characterNames: bundledCharacterNames,
    }),
    'アーニャ（SPY×FAMILY）',
  );
  assert.equal(
    getLocalizedCharacterName({
      key: 'chara (undertale)',
      tag: 'chara (undertale)',
      language: 'ja-JP',
      characterNames: bundledCharacterNames,
    }),
    'チャラ（UNDERTALE）',
  );
  assert.equal(
    getLocalizedCharacterName({
      key: 'roll (mega man)',
      tag: 'roll (mega man)',
      language: 'ja-JP',
      characterNames: bundledCharacterNames,
    }),
    'ロール（ロックマン）',
  );
});

test('bundled Japanese character data contains reviewed character names', () => {
  assert.equal(
    getLocalizedCharacterName({
      key: 'admiral hipper (azur lane)',
      tag: 'admiral hipper (azur lane)',
      language: 'ja-JP',
      characterNames: bundledCharacterNames,
    }),
    'アドミラル・ヒッパー（アズールレーン）',
  );
  assert.equal(
    getLocalizedCharacterName({
      key: 'chise (blue archive)',
      tag: 'chise (blue archive)',
      language: 'ja-JP',
      characterNames: bundledCharacterNames,
    }),
    '和楽チセ（ブルーアーカイブ）',
  );
  assert.equal(
    getLocalizedCharacterName({
      key: 'airi (blue archive)',
      tag: 'airi (blue archive)',
      language: 'ja-JP',
      characterNames: bundledCharacterNames,
    }),
    '栗村アイリ（ブルーアーカイブ）',
  );
});

test('bundled Japanese data covers every character tag in the current character list', () => {
  const tags = fs.readFileSync(
    path.join(testDir, '../data/waiIllustriousSDXL_v160_characters.csv'),
    'utf8',
  ).split(/\r?\n/).slice(1).filter(Boolean)
    .map(line => line.split(',')[1]?.trim())
    .filter(Boolean);

  const missing = tags.filter(tag => !bundledCharacterNames['ja-JP']?.[tag]);
  assert.deepEqual(missing, []);
});

test('bundled Japanese data does not retain known machine-translation errors', () => {
  const names = bundledCharacterNames['ja-JP'];
  assert.equal(names['admire vega (umamusume)'], 'アドマイヤベガ（ウマ娘 プリティーダービー）');
  assert.equal(names['aether (genshin impact)'], '空（原神）');
  assert.equal(names['agatsuma zenitsu'], '我妻善逸');
  assert.equal(names['aihara mei'], '藍原芽衣');
  assert.equal(names['akashi (azur lane)'], '明石（アズールレーン）');
  assert.equal(names['chise (blue archive)'], '和楽チセ（ブルーアーカイブ）');
  assert.equal(names['dawn (pokemon)'], 'ヒカリ（ポケモン）');
  assert.equal(names['ines fujin (umamusume)'], 'アイネスフウジン（ウマ娘 プリティーダービー）');
  assert.equal(names['katarina (league of legends)'], 'カタリナ（リーグ・オブ・レジェンド）');
  assert.equal(names['moze (honkai  star rail)'], 'モゼ（崩壊：スターレイル）');
  assert.equal(names['projekt red (arknights)'], 'レッド（アークナイツ）');
  assert.equal(names['siberian chipmunk (kemono friends)'], 'シマリス（けものフレンズ）');
  assert.equal(names['sommie (fire emblem)'], 'Sommie（ファイアーエムブレム）');
  assert.equal(names['thresh (league of legends)'], 'スレッシュ（リーグ・オブ・レジェンド）');
});

test('bundled Japanese data uses Japanese or official work titles for reviewed groups', () => {
  const names = bundledCharacterNames['ja-JP'];
  assert.equal(names['hashibira inosuke (kimetsu no yaiba)'], '嘴平伊之助（鬼滅の刃）');
  assert.equal(names['byleth (female) (fire emblem)'], 'ベレス（女性）（ファイアーエムブレム）');
  assert.equal(names['byleth (male) (fire emblem)'], 'ベレト（男性）（ファイアーエムブレム）');
  assert.equal(names['byleth (fire emblem)'], 'ベレト/ベレス（ファイアーエムブレム）');
  assert.equal(
    names['fujimaru ritsuka (female) (decisive battle chaldea uniform)'],
    '藤丸立香（女性）（決戦用カルデア制服）',
  );
  assert.equal(names['neptune (neptunia)'], 'ネプテューヌ（超次元ゲイム ネプテューヌ）');
  assert.equal(names['if (neptunia)'], 'アイエフ（超次元ゲイム ネプテューヌ）');
  assert.equal(names['belle (zenless zone zero)'], 'リン（ゼンレスゾーンゼロ）');
});
