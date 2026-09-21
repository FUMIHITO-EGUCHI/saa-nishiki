import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  normalizeJapaneseTagAlias,
  normalizeJapaneseTagRows,
} from '../scripts/normalizeJapaneseTagAliases.mjs';
import { parseTagRows } from '../scripts/reviewJapaneseTags.mjs';

const testDir = path.dirname(fileURLToPath(import.meta.url));

test('uses official Fate and Toaru work names in direct work tags', () => {
  assert.equal(normalizeJapaneseTagAlias('fate/stay_night', '運命/滞在夜'), 'Fate/stay night');
  assert.equal(normalizeJapaneseTagAlias('fate/apocrypha', '運命/麻痺'), 'Fate/Apocrypha');
  assert.equal(
    normalizeJapaneseTagAlias('fate/extra_ccc_fox_tail', '運命/余分なCCCフォックステール'),
    'Fate/EXTRA CCC FoxTail',
  );
  assert.equal(
    normalizeJapaneseTagAlias('fate/type_redline', '運命/タイプのレッドライン'),
    'Fate/type Redline',
  );
  assert.equal(
    normalizeJapaneseTagAlias('fate/grand_order_waltz_in_the_moonlight/lostroom', '月明かりの中での運命/大秩序ワルツ/ロストルーム'),
    'Fate/Grand Order Waltz in the MOONLIGHT/LOSTROOM',
  );
  assert.equal(
    normalizeJapaneseTagAlias('toaru_majutsu_no_index', 'Toaru Majutsuインデックスなし'),
    'とある魔術の禁書目録',
  );
  assert.equal(
    normalizeJapaneseTagAlias('toaru_kagaku_no_railgun', 'Toaru kagaku no Railgun'),
    'とある科学の超電磁砲',
  );
  assert.equal(
    normalizeJapaneseTagAlias('toaru_kagaku_no_dark_matter', 'Toaru Kagaku暗いことはありません'),
    'とある科学の未元物質',
  );
  assert.equal(
    normalizeJapaneseTagAlias('mahou_shoujo_madoka_magica', 'マホウ・ショーホ・マドカ・マジカ'),
    '魔法少女まどか☆マギカ',
  );
  assert.equal(
    normalizeJapaneseTagAlias('fire_emblem:_three_houses', '火の紋章：3つの家'),
    'ファイアーエムブレム 風花雪月',
  );
  assert.equal(
    normalizeJapaneseTagAlias('tales_of_berseria', '物語のベルセリア'),
    'テイルズ オブ ベルセリア',
  );
  assert.equal(
    normalizeJapaneseTagAlias('the_legend_of_zelda:_breath_of_the_wild', 'ゼルダの伝説：ブレスオブザワイルド'),
    'ゼルダの伝説 ブレス オブ ザ ワイルド',
  );
  assert.equal(
    normalizeJapaneseTagAlias('love_live!_sunshine!!', 'ライブが大好き！日光！！'),
    'ラブライブ！サンシャイン!!',
  );
  assert.equal(
    normalizeJapaneseTagAlias('danganronpa_(series)', 'Danganronpa（シリーズ）'),
    'ダンガンロンパ（シリーズ）',
  );
});

test('replaces work suffixes without translating the character name itself', () => {
  assert.equal(
    normalizeJapaneseTagAlias('artoria_pendragon_(fate)', 'Artoria Pendragon（運命）'),
    'Artoria Pendragon（Fate）',
  );
  assert.equal(
    normalizeJapaneseTagAlias('cu_chulainn_(fate/stay_night)', 'Cu Chulainn（運命/滞在夜）'),
    'Cu Chulainn（Fate/stay night）',
  );
  assert.equal(
    normalizeJapaneseTagAlias('accelerator_(toaru_majutsu_no_index)', 'Accelerator（Toaru Majutsu No Index）'),
    'Accelerator（とある魔術の禁書目録）',
  );
  assert.equal(
    normalizeJapaneseTagAlias('byleth_(fire_emblem)_(female)', 'Byleth（火の紋章）（女性）'),
    'Byleth（ファイアーエムブレム）（女性）',
  );
  assert.equal(
    normalizeJapaneseTagAlias('darjeeling_(girls_und_panzer)', 'ダージリン（女の子とパンツァー）'),
    'ダージリン（ガールズ＆パンツァー）',
  );
});

test('keeps semantic fate tags and applies concise established tag labels', () => {
  assert.equal(normalizeJapaneseTagAlias('string_of_fate', '運命の文字列'), '運命の文字列');
  assert.equal(normalizeJapaneseTagAlias('ear_piercing', '耳にピアスの穴を開ける'), '耳ピアス');
  assert.equal(normalizeJapaneseTagAlias('mole_on_breast', '乳房にモル'), '胸のほくろ');
  assert.equal(normalizeJapaneseTagAlias('sex_from_behind', '後ろからのセックス'), '後背位');
});

test('uses plain state labels for holding tags instead of polite literal translations', () => {
  assert.equal(
    normalizeJapaneseTagAlias('holding_rocket_launcher', 'ロケットランチャーを保持します'),
    'ロケットランチャーを持っている',
  );
  assert.equal(
    normalizeJapaneseTagAlias('holding_staff', 'スタッフを保持します'),
    '杖を持っている',
  );
  assert.equal(
    normalizeJapaneseTagAlias('holding_gun', '銃を持っています'),
    '銃を持っている',
  );
  assert.equal(
    normalizeJapaneseTagAlias('holding_breath', '息を止めます'),
    '息を止めている',
  );
  assert.equal(
    normalizeJapaneseTagAlias('holding_halo', 'ハローを持っている'),
    'ヘイローを手に持っている',
  );
  assert.equal(normalizeJapaneseTagAlias('halo', 'ハロー'), 'ヘイロー');
});

test('normalizes a batch without changing tag keys or row count', () => {
  const rows = [
    { i: 1, tag: 'fate/stay_night', alias: '運命/滞在夜' },
    { i: 2, tag: 'ear_piercing', alias: '耳にピアスの穴を開ける' },
  ];
  assert.deepEqual(normalizeJapaneseTagRows(rows), [
    { i: 1, tag: 'fate/stay_night', alias: 'Fate/stay night' },
    { i: 2, tag: 'ear_piercing', alias: '耳ピアス' },
  ]);
});

test('bundled work aliases do not regress to translated Fate or Toaru names', () => {
  const rows = parseTagRows(fs.readFileSync(
    path.join(testDir, '../data/danbooru_e621_merged_ja.csv'),
    'utf8',
  ));
  const fateRows = rows.filter(row => {
    const tag = row.tag.replace(/_/g, ' ').toLowerCase();
    return tag.startsWith('fate/') || /\(fate(?:\/|\))/.test(tag);
  });
  const toaruRows = rows.filter(row => {
    const tag = row.tag.replace(/_/g, ' ').toLowerCase();
    return tag.startsWith('toaru ') || /\(toaru(?: |\))/.test(tag);
  });
  assert.deepEqual(fateRows.filter(row => /運命/.test(row.alias)), []);
  assert.deepEqual(toaruRows.filter(row => /Toaru|toaru|インデックスなし/.test(row.alias)), []);
});

test('normalizes additional direct work titles without translating established names', () => {
  const cases = {
    'phoenix_wright:_ace_attorney_-_dual_destinies': '逆転裁判5',
    doom_eternal: 'DOOM Eternal',
    'takt op._destiny': 'takt op.Destiny',
    'gundam_side_story:_the_blue_destiny': '機動戦士ガンダム外伝 THE BLUE DESTINY',
    blue_destiny_01: 'ブルーディスティニー1号機',
    destiny_child: 'デスティニーチャイルド',
    tales_of_destiny_2: 'テイルズ オブ デスティニー2',
    'mahou_shoujo_lyrical_nanoha_a\'s_portable:_the_gears_of_destiny': "魔法少女リリカルなのはA's PORTABLE -THE GEARS OF DESTINY-",
    ikkitousen_dragon_destiny: '一騎当千 Dragon Destiny',
    destiny_gundam: 'デスティニーガンダム',
    'mona_(destiny_child)': 'モナ（デスティニーチャイルド）',
    'demeter_(destiny_child)': 'デメテル（デスティニーチャイルド）',
    'crucible_(doom)': 'るつぼ（DOOM）',
    'destiny_(takt_op.)': 'Destiny（takt op.）',
    'tales_of_(series)': 'テイルズ オブ（シリーズ）',
    'smile_precure!': 'スマイルプリキュア！',
    suite_precure: 'スイートプリキュア♪',
    infinite_stratos: 'IS 〈インフィニット・ストラトス〉',
    'char\'s_counterattack': '機動戦士ガンダム 逆襲のシャア',
    "persona_4:_the_ultimate_in_mayonaka_arena": 'ペルソナ4 ジ・アルティマックス ウルトラスープレックスホールド',
    'gundam_hathaway\'s_flash': '機動戦士ガンダム 閃光のハサウェイ',
    'delicious_party_precure': 'デリシャスパーティ♡プリキュア',
    "the_king_of_fighters_'98": "THE KING OF FIGHTERS '98",
    'the_legend_of_zelda:_oracle_of_ages': 'ゼルダの伝説 ふしぎの木の実 時空の章',
  };
  for (const [tag, alias] of Object.entries(cases)) {
    const currentAlias = tag === 'destiny_child'
      ? 'Destiny Child'
      : tag === 'tales_of_destiny_2'
        ? 'Tales of Destiny 2'
        : tag.includes('gears_of_destiny')
          ? "Mahou shoujo lylical nanoha aのポータブル：The Gears of Destiny"
          : tag === 'ikkitousen_dragon_destiny'
            ? 'Ikkitousen Dragon Destiny'
            : tag === 'destiny_gundam'
              ? 'Destiny Gundam'
              : tag === 'destiny_(takt_op.)'
                ? 'Destiny（Takt op。）'
                : tag === 'tales_of_(series)'
                  ? '物語の（シリーズ）'
                    : tag === 'smile_precure!'
                    ? '笑顔の精密！'
                    : tag === 'suite_precure'
                      ? 'スイートの精度'
                      : tag === 'infinite_stratos'
                        ? '無限のストラト'
                        : tag === "char's_counterattack"
                          ? 'Charの反撃'
                          : tag === 'persona_4:_the_ultimate_in_mayonaka_arena'
                            ? 'ペルソナ4：マヨナカアリーナの究極'
                            : tag === "gundam_hathaway's_flash"
                              ? 'ガンダムハサウェイのフラッシュ'
                              : tag === 'delicious_party_precure'
                                ? 'おいしいパーティーの純生'
                                : tag === "the_king_of_fighters_'98"
                                  ? '王の王98'
                                  : tag === 'the_legend_of_zelda:_oracle_of_ages'
                                    ? 'ゼルダの伝説：年齢のオラクル'
                : tag.includes('_(doom)')
      ? 'るつぼ（運命）'
              : tag === 'mona_(destiny_child)'
                ? 'モナ（運命の子供）'
                : tag === 'demeter_(destiny_child)'
                  ? 'デメテル（運命の子供）'
                : '直訳された作品名';
    assert.equal(normalizeJapaneseTagAlias(tag, currentAlias), alias, tag);
  }
});
