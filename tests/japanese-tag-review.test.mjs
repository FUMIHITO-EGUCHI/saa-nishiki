import test from 'node:test';
import assert from 'node:assert/strict';

import {
  applyHighConfidenceReviews,
  buildReviewPrompt,
  compactWikiEvidence,
  findSharedAliases,
  formatTagRows,
  isPoliteStyleRow,
  isReviewedBy,
  isSuspiciousTagRow,
  loadBaseIndex,
  loadReferenceAliases,
  normalizeTagKey,
  parseReviewResponse,
  parseTagRows,
  reviewedTags,
  selectReviewRows,
  splitReviewRows,
  validateReviewRows,
  validateVerificationRows,
} from '../scripts/reviewJapaneseTags.mjs';

test('parses the compact two-column Japanese tag CSV', () => {
  assert.deepEqual(parseTagRows('1girl,一人の女の子\naircraft,航空機\n'), [
    { i: 1, tag: '1girl', alias: '一人の女の子' },
    { i: 2, tag: 'aircraft', alias: '航空機' },
  ]);
});

test('preserves empty aliases used by a few symbol tags', () => {
  assert.deepEqual(parseTagRows('=_=,\n'), [
    { i: 1, tag: '=_=', alias: '' },
  ]);
});

test('supports quoted commas and rejects unquoted extra columns', () => {
  assert.deepEqual(parseTagRows('wake_up_girls!,"Wake Up, Girls!"\n'), [
    { i: 1, tag: 'wake_up_girls!', alias: 'Wake Up, Girls!' },
  ]);
  assert.throws(() => parseTagRows('tag,意味,追加情報\n'), /Invalid tag row/);
  assert.equal(formatTagRows([{ tag: 'wake_up_girls!', alias: 'Wake Up, Girls!' }]), 'wake_up_girls!,"Wake Up, Girls!"\n');
});

test('accepts JSON returned inside a markdown fence', () => {
  assert.deepEqual(parseReviewResponse('```json\n{"rows":[]}\n```'), []);
});

test('validates complete conservative review output', () => {
  const input = parseTagRows('aircraft,航空機\nakemi_homura,Akemi Homura\n');
  const reviews = validateReviewRows(input, [
    { i: 2, action: 'change', confidence: 'high', alias: '暁美ほむら' },
    { i: 1, action: 'keep', confidence: 'high', alias: '航空機' },
  ]);
  assert.deepEqual(reviews.map(row => row.i), [1, 2]);
  assert.equal(reviews[1].alias, '暁美ほむら');
});

test('rejects omitted rows and discards stray aliases on keep actions', () => {
  const input = parseTagRows('aircraft,航空機\nakemi_homura,Akemi Homura\n');
  assert.throws(() => validateReviewRows(input, [
    { i: 1, action: 'keep', confidence: 'high', alias: '航空機' },
  ]), /returned 1 rows/);
  assert.deepEqual(validateReviewRows(input, [
    { i: 1, action: 'keep', confidence: 'high', alias: '飛行機' },
    { i: 2, action: 'keep', confidence: 'high', alias: 'Akemi Homura' },
  ])[0].alias, '航空機');
});

test('supports removing an unsafe machine alias conservatively', () => {
  const input = parseTagRows('double_parted_bangs,双分刘海\n');
  const reviews = validateReviewRows(input, [
    { i: 1, action: 'remove', confidence: 'high', alias: '' },
  ]);
  assert.equal(reviews[0].alias, '');

  const applied = applyHighConfidenceReviews(input, [
    {
      i: 1,
      tag: 'double_parted_bangs',
      original: '双分刘海',
      action: 'remove',
      confidence: 'high',
      alias: '',
      verification: { accepted: true, confidence: 'high' },
    },
  ]);
  assert.equal(applied[0].alias, '');
});

test('only high-confidence changes are applied', () => {
  const rows = parseTagRows('aircraft,航空機\nakemi_homura,Akemi Homura\n');
  const result = applyHighConfidenceReviews(rows, [
    { i: 1, tag: 'aircraft', original: '航空機', action: 'change', confidence: 'medium', alias: '飛行機' },
    { i: 2, tag: 'akemi_homura', original: 'Akemi Homura', action: 'change', confidence: 'high', alias: '暁美ほむら', verification: { accepted: true, confidence: 'high' } },
  ]);
  assert.deepEqual(result.map(row => row.alias), ['航空機', '暁美ほむら']);
  assert.equal(formatTagRows(result), 'aircraft,航空機\nakemi_homura,暁美ほむら\n');
});

test('does not apply changes that drop unworn or removed semantics', () => {
  const rows = parseTagRows('unworn_thighhighs,太ももが削除されました\npresenting_removed_panties,パンティーを提示します\n');
  const result = applyHighConfidenceReviews(rows, [
    {
      i: 1,
      tag: 'unworn_thighhighs',
      original: '太ももが削除されました',
      action: 'change',
      confidence: 'high',
      alias: '太もも',
      verification: { accepted: true, confidence: 'high' },
    },
    {
      i: 2,
      tag: 'presenting_removed_panties',
      original: 'パンティーを提示します',
      action: 'change',
      confidence: 'high',
      alias: 'パンティを提示',
      verification: { accepted: true, confidence: 'high' },
    },
  ]);
  assert.deepEqual(result.map(row => row.alias), ['太ももが削除されました', 'パンティーを提示します']);
});

test('verification can reject a semantically wrong candidate', () => {
  const candidates = [{ i: 1, tag: 'pussy', current: 'マンコ', candidate: 'オナニー' }];
  const rejected = validateVerificationRows(candidates, [
    { i: 1, accept: false, confidence: 'high' },
  ]);
  assert.deepEqual(rejected[0], {
    i: 1,
    tag: 'pussy',
    accepted: false,
    confidence: 'high',
    alias: 'マンコ',
  });
});

test('review prompt includes the English semantic source and current alias', () => {
  const prompt = buildReviewPrompt([{ i: 1, tag: 'aircraft', alias: '航空機' }]);
  assert.match(prompt, /aircraft/);
  assert.match(prompt, /航空機/);
});

test('review prompt includes compact Wiki evidence without allowing context to grow unbounded', () => {
  const evidence = compactWikiEvidence({
    found: true,
    category: 0,
    wiki: {
      id: 1,
      title: 'aircraft',
      body: 'A'.repeat(2500),
      otherNames: ['航空機'],
    },
  }, { maxBodyChars: 100 });
  const prompt = buildReviewPrompt([{ i: 1, tag: 'aircraft', alias: '航空機', wiki: evidence }]);
  assert.match(prompt, /航空機/);
  assert.ok(!prompt.includes('A'.repeat(101)));
});

test('splits invalid batches without losing order', () => {
  const rows = [1, 2, 3, 4, 5].map(i => ({ i, tag: `tag${i}`, alias: `訳${i}` }));
  const [first, second] = splitReviewRows(rows);
  assert.deepEqual(first.map(row => row.i), [1, 2, 3]);
  assert.deepEqual(second.map(row => row.i), [4, 5]);
  assert.deepEqual(splitReviewRows([rows[0]]), [[rows[0]]]);
});

test('flags untranslated and known machine-like aliases without flagging normal Japanese', () => {
  assert.equal(isSuspiciousTagRow({ tag: 'aircraft', alias: '航空機' }), false);
  assert.equal(isSuspiciousTagRow({ tag: 'highleg', alias: 'highleg' }), true);
  assert.equal(isSuspiciousTagRow({ tag: 'check_translation', alias: '翻訳を確認してください' }), true);
  assert.equal(isSuspiciousTagRow({ tag: '=_=', alias: '' }), true);
  assert.equal(isSuspiciousTagRow({ tag: 'bad_anatomy', alias: '悪い解剖学' }), true);
  assert.equal(isSuspiciousTagRow({ tag: 'bad_haro', alias: '悪いハロ' }), false);
});

test('normalizes tag keys and loads Japanese character references', () => {
  assert.equal(normalizeTagKey('Akemi_Homura'), 'akemi homura');
  const references = loadReferenceAliases();
  assert.equal(references.get('akemi homura'), '暁美ほむら');
});

test('keeps a matching reference on each validated review row', () => {
  const input = [{ i: 1, tag: 'akemi_homura', alias: 'Akemi Homura', reference: '暁美ほむら' }];
  const review = validateReviewRows(input, [
    { i: 1, action: 'change', confidence: 'high', alias: '暁美ほむら' },
  ]);
  assert.equal(review[0].reference, '暁美ほむら');
});

test('style and shared-alias selectors flag machine forms and collisions', () => {
  assert.equal(isPoliteStyleRow({ tag: 'leaning_forward', alias: '前方に傾いています' }), true);
  assert.equal(isPoliteStyleRow({ tag: 'holding_sword', alias: '剣を持っている' }), false);
  const shared = findSharedAliases([
    { tag: 'stuffed_toy', alias: 'ぬいぐるみ' },
    { tag: 'stuffed_cat', alias: 'ぬいぐるみ' },
    { tag: 'hat', alias: '帽子' },
  ]);
  assert.deepEqual([...shared], [['ぬいぐるみ', ['stuffed_toy', 'stuffed_cat']]]);
  assert.equal(isSuspiciousTagRow({ tag: ':3', alias: '：3' }), true);
});

test('selectReviewRows scopes by base group and heat, dedupes rows, adds siblings and missing tags', () => {
  const rows = parseTagRows('1girl,一人の女の子\n1girl,一人の女の子\nstuffed_cat,ぬいぐるみ\nstuffed_toy,ぬいぐるみ\nleg_up,足を上げます\nsome_artist,作家\n');
  const base = loadBaseIndex('1girl,0,600,\nstuffed_cat,0,300,\nstuffed_toy,0,400,\nleg_up,0,50,\nsome_artist,1,900,\nfox_ears,0,500,\n');
  const all = selectReviewRows(rows, { base, groups: [0], minHeat: 100, select: ['all'] });
  assert.deepEqual(all.map(row => row.tag), ['1girl', 'stuffed_toy', 'stuffed_cat']);
  assert.deepEqual(all[2].siblings, ['stuffed_toy']);
  const ambiguous = selectReviewRows(rows, { base, groups: [0], select: ['ambiguous'] });
  assert.deepEqual(ambiguous.map(row => row.tag), ['stuffed_toy', 'stuffed_cat']);
  const style = selectReviewRows(rows, { base, groups: [0], select: ['style'] });
  assert.deepEqual(style.map(row => row.tag), ['leg_up']);
  const missing = selectReviewRows(rows, { base, groups: [0], select: ['missing'] });
  assert.deepEqual(missing, [{ i: 7, tag: 'fox_ears', alias: '', heat: 500, siblings: [], missing: true }]);
  assert.equal(selectReviewRows(rows, { select: ['all'] }).length, 5);
});

test('apply matches repeated rows by tag, appends missing translations and drops removed aliases', () => {
  const rows = parseTagRows('1girl,一人の女の子\n1girl,一人の女の子\nsolo,一人の女の子\n:3,：3\n');
  const verified = { accepted: true, confidence: 'high' };
  const applied = applyHighConfidenceReviews(rows, [
    { i: 3, tag: 'solo', original: '一人の女の子', action: 'change', confidence: 'high', alias: '一人', verification: verified },
    { i: 4, tag: ':3', original: '：3', action: 'remove', confidence: 'high', alias: '', verification: verified },
    { i: 5, tag: 'fox_ears', original: '', action: 'change', confidence: 'high', alias: '狐耳', missing: true, verification: verified },
    { i: 6, tag: 'capelet', original: '', action: 'change', confidence: 'medium', alias: 'ケープレット', missing: true, verification: verified },
  ]);
  assert.deepEqual(applied.map(row => [row.tag, row.alias]), [
    ['1girl', '一人の女の子'], ['1girl', '一人の女の子'], ['solo', '一人'], [':3', ''], ['fox_ears', '狐耳'],
  ]);
  const duplicated = applyHighConfidenceReviews(rows, [
    { i: 1, tag: '1girl', original: '一人の女の子', action: 'change', confidence: 'high', alias: '女の子1人', verification: verified },
  ]);
  assert.deepEqual(duplicated.slice(0, 2).map(row => row.alias), ['女の子1人', '女の子1人']);
});

test('a change without a replacement alias becomes an unsure keep', () => {
  const review = validateReviewRows([{ i: 1, tag: 'grass_root_youkai_network', alias: '' }], [{ i: 1, action: 'change', confidence: 'high', alias: '' }]);
  assert.deepEqual([review[0].action, review[0].confidence, review[0].alias], ['keep', 'low', '']);
});

test('a proposed alias with a comma or line break becomes an unsure keep instead of failing the batch', () => {
  const input = [{ i: 1, tag: 'wake_up_girls!', alias: 'ウェイクアップガールズ' }];
  const review = validateReviewRows(input, [{ i: 1, action: 'change', confidence: 'high', alias: 'Wake Up, Girls!' }]);
  assert.equal(review[0].action, 'keep');
  assert.equal(review[0].confidence, 'low');
  assert.equal(review[0].alias, 'ウェイクアップガールズ');
});

test('a fallback model answer is neither done nor applied under --only-model', () => {
  const luna = { tag: 'touhou', original: '東方', model: 'gpt-5.6-luna', verification: { model: 'gpt-5.6-luna' } };
  const lunaUnverified = { tag: 'kancolle', original: '', model: 'gpt-5.6-luna', missing: true };
  const fallback = { tag: 'fate', original: 'フェイト', model: 'qwen', verification: { model: 'qwen' } };
  const mixed = { tag: 'pokemon', original: 'ポケモン', model: 'gpt-5.6-luna', verification: { model: 'qwen' } };
  assert.equal(isReviewedBy(luna, 'gpt-5.6-luna'), true);
  assert.equal(isReviewedBy(lunaUnverified, 'gpt-5.6-luna'), true);
  assert.equal(isReviewedBy(fallback, 'gpt-5.6-luna'), false);
  assert.equal(isReviewedBy(mixed, 'gpt-5.6-luna'), false);
  assert.equal(isReviewedBy(fallback, ''), true, 'no model filter accepts everything');
  assert.deepEqual([...reviewedTags([luna, lunaUnverified, fallback, mixed], 'gpt-5.6-luna')], ['touhou', 'kancolle']);
});

test('a change to the identical alias is recorded as keep', () => {
  const review = validateReviewRows([{ i: 1, tag: 'hat', alias: '帽子' }], [{ i: 1, action: 'change', confidence: 'high', alias: '帽子' }]);
  assert.equal(review[0].action, 'keep');
});
