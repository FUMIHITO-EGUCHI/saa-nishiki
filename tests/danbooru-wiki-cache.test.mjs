import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildTagLookupUrl,
  deduplicateTagNames,
  mapTagLookupResponse,
  parseWikiCacheLines,
  splitTagBatches,
} from '../scripts/fetchDanbooruWiki.mjs';

test('deduplicates tag names by the same normalized key while preserving first spelling', () => {
  assert.deepEqual(deduplicateTagNames([
    { tag: 'hakurei_reimu' },
    { tag: 'Hakurei Reimu' },
    { tag: 'aircraft' },
    { tag: ' aircraft ' },
  ]), ['hakurei_reimu', 'aircraft']);
});

test('builds a batched Danbooru tag lookup with narrowly selected fields', () => {
  const url = new URL(buildTagLookupUrl(['dark_skin', 'aircraft']));
  assert.equal(url.pathname, '/tags.json');
  assert.equal(url.searchParams.get('search[name_normalize]'), 'dark_skin,aircraft');
  assert.equal(url.searchParams.get('limit'), '2');
  assert.match(url.searchParams.get('only'), /name/);
  assert.match(url.searchParams.get('only'), /wiki_page\[id,title,body,other_names\]/);
});

test('splits batches before the URL becomes too large', () => {
  const tags = Array.from({ length: 20 }, (_, index) => `very_long_tag_name_${index}_${'x'.repeat(20)}`);
  const batches = splitTagBatches(tags, { maxUrlLength: 500 });
  assert.ok(batches.length > 1);
  assert.deepEqual(batches.flat(), tags);
  for (const batch of batches) assert.ok(buildTagLookupUrl(batch).length <= 500);
});

test('maps returned wiki metadata and records missing tags for negative caching', () => {
  const records = mapTagLookupResponse(['dark_skin', 'missing_tag'], [
    {
      name: 'dark_skin',
      category: 0,
      wiki_page: {
        id: 5838,
        title: 'dark_skin',
        body: 'Skin that is darker in tone.',
        other_names: ['褐色肌'],
      },
    },
  ], '2026-08-28T00:00:00.000Z');
  assert.deepEqual(records, [
    {
      normalizedTag: 'dark skin',
      requestedTag: 'dark_skin',
      fetchedAt: '2026-08-28T00:00:00.000Z',
      found: true,
      name: 'dark_skin',
      category: 0,
      wiki: {
        id: 5838,
        title: 'dark_skin',
        body: 'Skin that is darker in tone.',
        otherNames: ['褐色肌'],
      },
    },
    {
      normalizedTag: 'missing tag',
      requestedTag: 'missing_tag',
      fetchedAt: '2026-08-28T00:00:00.000Z',
      found: false,
      name: '',
      category: null,
      wiki: null,
    },
  ]);
});

test('loads valid JSONL cache entries and rejects malformed lines', () => {
  const valid = JSON.stringify({ normalizedTag: 'aircraft', requestedTag: 'aircraft', found: false });
  assert.deepEqual(parseWikiCacheLines(`${valid}\n`).get('aircraft'), {
    normalizedTag: 'aircraft',
    requestedTag: 'aircraft',
    found: false,
  });
  assert.throws(() => parseWikiCacheLines('{bad json}\n'), /cache line 1/);
});
