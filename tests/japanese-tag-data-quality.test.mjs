import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseTagRows } from '../scripts/reviewJapaneseTags.mjs';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const tagDataPath = path.join(testDir, '../data/danbooru_e621_merged_ja.csv');

function loadAliases() {
  return new Map(parseTagRows(fs.readFileSync(tagDataPath, 'utf8')).map(row => [row.tag, row.alias]));
}

test('bad tags use their Danbooru meaning instead of a literal 悪い translation', () => {
  const aliases = loadAliases();
  const expected = {
    bad_id: '削除済みID',
    bad_pixiv_id: '削除済みPixiv ID',
    bad_twitter_id: '削除済みTwitter ID',
    bad_tumblr_id: '削除済みTumblr ID',
    bad_deviantart_id: '削除済みdeviantArt ID',
    bad_nicoseiga_id: '削除済みニコニコ静画ID',
    bad_drawr_id: '削除済みdrawr ID',
    bad_nijie_id: '削除済みnijie ID',
    bad_yandere_id: '削除済みYandere ID',
    bad_artstation_id: '削除済みArtStation ID',
    bad_bcy_id: '削除済みbcy ID',
    bad_instagram_id: '削除済みInstagram ID',
    'bad_hentai-foundry_id': '削除済みHentai Foundry ID',
    bad_drawcrowd_id: '削除済みdrawcrowd ID',
    bad_tinami_id: '削除済みTinami ID',
    bad_cghub_id: '削除済みCGHub ID',
    'bad_google+_id': '削除済みGoogle+ ID',
    bad_poipiku_id: '削除済みpoipiku ID',
    bad_fanbox_id: '削除済みpixivFANBOX ID',
    bad_newgrounds_id: '削除済みNewgrounds ID',
    bad_pawoo_id: '削除済みPawoo ID',
    'bad_e-hentai_id': '削除済みE-Hentai ID',
    bad_weibo_id: '削除済みWeibo ID',
    bad_patreon_id: '削除済みPatreon ID',
    bad_link: '画像直リンク',
    bad_anatomy: '人体の描き間違い',
    bad_source: '不備のある出典',
    bad_feet: '足の描き間違い',
    bad_hands: '手の描き間違い',
    bad_proportions: 'プロポーションの崩れ',
    bad_perspective: 'パースの崩れ',
    bad_end: 'バッドエンド',
    bad_leg: '脚の描き間違い',
    bad_arm: '腕の描き間違い',
    bad_neck: '首の描き間違い',
    bad_aspect_ratio: 'アスペクト比の誤り',
    bad_reflection: '反射の描き間違い',
    bad_vulva: '外陰部の描き間違い',
    bad_face: '顔の描き間違い',
    bad_ass: '尻の描き間違い',
    bad_gun_anatomy: '銃の描き間違い',
    bad_multiple_views: '複数視点の描き間違い',
    bad_singing: '歌が下手',
    false_smile: '作り笑い',
    wrong_feet: '足の描き間違い',
    wrong_hand: '手の描き間違い',
  };

  for (const [tag, alias] of Object.entries(expected)) {
    assert.equal(aliases.get(tag), alias, tag);
  }
});

test('bad-prefixed proper names are not blanket-rewritten as error labels', () => {
  const aliases = loadAliases();
  assert.equal(aliases.get('bad_boy'), '悪ガキ');
  assert.equal(aliases.get('bad_haro'), '悪いハロ');
  assert.equal(aliases.get('bad_idea'), '悪いアイデア');
  assert.equal(aliases.get('bad_kim'), '悪いキム');
});

test('Smile Precure bad-end character names use the established Japanese names', () => {
  const aliases = loadAliases();
  assert.equal(aliases.get('bad_end_precure'), 'バッドエンドプリキュア');
  assert.equal(aliases.get('bad_end_happy'), 'バッドエンドハッピー');
  assert.equal(aliases.get('bad_end_march'), 'バッドエンドマーチ');
  assert.equal(aliases.get('bad_end_peace'), 'バッドエンドピース');
  assert.equal(aliases.get('bad_end_beauty'), 'バッドエンドビューティ');
  assert.equal(aliases.get('bad_end_sunny'), 'バッドエンドサニー');
});

test('holding tags use natural image-state labels', () => {
  const aliases = loadAliases();
  assert.equal(aliases.get('holding_rocket_launcher'), 'ロケットランチャーを持っている');
  assert.equal(aliases.get('holding_staff'), '杖を持っている');
  assert.equal(aliases.get('holding_breath'), '息を止めている');
  assert.equal(aliases.get('holding_halo'), 'ヘイローを手に持っている');
  assert.equal(aliases.get('halo'), 'ヘイロー');
});
