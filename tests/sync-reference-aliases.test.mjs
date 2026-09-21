import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { syncReferenceAliases } from '../scripts/syncReferenceAliases.mjs';
import { loadBaseIndex, loadReferenceAliases, parseTagRows } from '../scripts/reviewJapaneseTags.mjs';

const base = loadBaseIndex([
  'hakurei_reimu,4,100,',
  'kaga_(kancolle),4,90,',
  'chen,4,80,',
  'touhou,3,500,',
  'fate/grand_order,3,400,',
  'red_hair,0,900,',
  'shizuka_(fate),4,10,',
].join('\n'));

const references = new Map([
  ['hakurei reimu', '博麗霊夢'],
  ['kaga (kancolle)', '加賀（艦隊これくしょん -艦これ-）'],
  ['chen', '橙'],
  ['touhou', '東方Project'],
  ['fate/grand order', 'Fate/Grand Order'],
  ['red hair', '赤い髪'],
]);

test('rewrites character and copyright rows to the reference, appends missing tags, leaves other groups alone', () => {
  const rows = parseTagRows([
    'hakurei_reimu,hakurei reimu',
    'chen,橙',
    'touhou,東方',
    'red_hair,赤髪',
    'shizuka_(fate),シズカ（Fate）',
  ].join('\n'));
  const { rows: result, changed, added, dropped } = syncReferenceAliases(rows, base, references);
  assert.deepEqual(result.map(row => `${row.tag},${row.alias}`), [
    'hakurei_reimu,博麗霊夢',
    'chen,橙',
    'touhou,東方Project',
    'red_hair,赤髪',
    'shizuka_(fate),シズカ（Fate）',
    'kaga_(kancolle),加賀（艦隊これくしょん -艦これ-）',
    'fate/grand_order,Fate/Grand Order',
  ]);
  assert.deepEqual(changed, [
    { tag: 'hakurei_reimu', from: 'hakurei reimu', to: '博麗霊夢' },
    { tag: 'touhou', from: '東方', to: '東方Project' },
  ]);
  assert.deepEqual(added.map(entry => entry.tag), ['kaga_(kancolle)', 'fate/grand_order']);
  assert.deepEqual(dropped, []);
  // a General tag is never touched even when a reference exists
  assert.equal(result.find(row => row.tag === 'red_hair').alias, '赤髪');
});

test('a repeated row keeps a distinct Japanese alias and loses a duplicate or Latin one', () => {
  const rows = parseTagRows([
    'chen,チェン',
    'chen,橙',
    'chen,Chen',
    'hakurei_reimu,博麗霊夢',
    'hakurei_reimu,霊夢',
  ].join('\n'));
  const { rows: result, dropped } = syncReferenceAliases(rows, base, references);
  assert.deepEqual(result.slice(0, 3).map(row => `${row.tag},${row.alias}`), [
    'chen,橙',
    'hakurei_reimu,博麗霊夢',
    'hakurei_reimu,霊夢',
  ]);
  assert.deepEqual(dropped.map(entry => `${entry.tag},${entry.from}`), ['chen,橙', 'chen,Chen']);
});

test('the reference map carries character names with the curated work title and work titles', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'saa-ref-'));
  const names = path.join(dir, 'character_names.json');
  const official = path.join(dir, 'official_work_names.json');
  const works = path.join(dir, 'character_works.json');
  fs.writeFileSync(names, JSON.stringify({ 'ja-JP': { 'kaga (kancolle)': '加賀（艦隊これくしょん）', 'meteion': 'Meteion' } }));
  fs.writeFileSync(official, JSON.stringify({ kancolle: '艦隊これくしょん -艦これ-' }));
  fs.writeFileSync(works, JSON.stringify({ works: { 'kantai collection': { en: 'kantai collection', ja: '艦隊これくしょん' }, 'unknown': { en: 'unknown', ja: '' } } }));
  const references = loadReferenceAliases(names, { officialWorkNamesPath: official, characterWorksPath: works });
  assert.equal(references.get('kaga (kancolle)'), '加賀（艦隊これくしょん -艦これ-）');
  assert.equal(references.get('kantai collection'), '艦隊これくしょん');
  assert.equal(references.has('meteion'), false, 'a Latin character name is no reference');
  assert.equal(references.has('unknown'), false);
});
