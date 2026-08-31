import test from 'node:test';
import assert from 'node:assert/strict';

import {
  applyHighConfidenceReviews,
  buildReviewPrompt,
  compactWikiEvidence,
  formatTagRows,
  isSuspiciousTagRow,
  loadReferenceAliases,
  normalizeTagKey,
  parseReviewResponse,
  parseTagRows,
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

test('only high-confidence changes are applied', () => {
  const rows = parseTagRows('aircraft,航空機\nakemi_homura,Akemi Homura\n');
  const result = applyHighConfidenceReviews(rows, [
    { i: 1, tag: 'aircraft', original: '航空機', action: 'change', confidence: 'medium', alias: '飛行機' },
    { i: 2, tag: 'akemi_homura', original: 'Akemi Homura', action: 'change', confidence: 'high', alias: '暁美ほむら', verification: { accepted: true, confidence: 'high' } },
  ]);
  assert.deepEqual(result.map(row => row.alias), ['航空機', '暁美ほむら']);
  assert.equal(formatTagRows(result), 'aircraft,航空機\nakemi_homura,暁美ほむら\n');
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
