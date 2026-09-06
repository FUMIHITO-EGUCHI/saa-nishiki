import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import test from 'node:test';

import {
  COARSE_GROUP_FILTERS,
  E621_GROUP_IDS,
  createTagFilterMatcher,
  createTagCategoryIndex,
  getCategoryForPrompt,
  loadTagCategories,
  matchesPromptInfo,
  normalizeTagFilterOptions,
} from '../scripts/main/tagCategories.js';

test('loads only verified Danbooru Wiki and verified LLM categories into a prompt-key index', () => {
  const index = createTagCategoryIndex({
    schemaVersion: 1,
    tags: {
      holding_halo: {
        category: 'pose_action',
        status: 'verified',
        source: 'Danbooru Wiki',
        sourceUrl: 'https://danbooru.donmai.us/wiki_pages/holding_halo.html',
      },
      unreviewed_tag: {
        category: 'object',
        status: 'candidate',
        source: 'LLM',
        model: 'some-model',
      },
      llm_verified_tag: {
        category: 'clothing',
        status: 'verified',
        source: 'LLM',
        model: 'some-model',
      },
      llm_without_model: {
        category: 'clothing',
        status: 'verified',
        source: 'LLM',
      },
      unsupported_category: {
        category: 'invented',
        status: 'verified',
        source: 'Danbooru Wiki',
        sourceUrl: 'https://danbooru.donmai.us/wiki_pages/unsupported_category.html',
      },
    },
  });

  assert.equal(index.get('holding_halo'), 'pose_action');
  assert.equal(index.get('llm_verified_tag'), 'clothing');
  assert.equal(index.has('unreviewed_tag'), false);
  assert.equal(index.has('llm_without_model'), false);
  assert.equal(index.has('unsupported_category'), false);
});

test('maps coarse English filters to existing Danbooru and E621 groups', () => {
  assert.deepEqual(COARSE_GROUP_FILTERS.all, null);
  assert.deepEqual(COARSE_GROUP_FILTERS.general, [0, 7]);
  assert.deepEqual(COARSE_GROUP_FILTERS.character, [4, 11]);
  assert.deepEqual(COARSE_GROUP_FILTERS.work, [3, 10]);
  assert.deepEqual(COARSE_GROUP_FILTERS.artist, [1, 8]);
  assert.deepEqual(COARSE_GROUP_FILTERS.species, [12]);
  assert.deepEqual(COARSE_GROUP_FILTERS.meta, [5, 14]);
  assert.deepEqual(COARSE_GROUP_FILTERS.lore, [15]);
  assert.deepEqual(E621_GROUP_IDS, {
    general: 7,
    artist: 8,
    work: 10,
    character: 11,
    species: 12,
    meta: 14,
    lore: 15,
  });
});

test('normalizes category keys consistently with production prompt lookup', () => {
  const index = createTagCategoryIndex({
    schemaVersion: 1,
    tags: {
      ' Holding Halo ': {
        category: 'pose_action',
        status: 'verified',
        source: 'Danbooru Wiki',
        sourceUrl: 'https://danbooru.donmai.us/wiki_pages/holding_halo.html',
      },
    },
  });

  assert.equal(getCategoryForPrompt(index, 'holding_halo'), 'pose_action');
  assert.equal(getCategoryForPrompt(index, 'HOLDING HALO'), 'pose_action');
});

test('matches both group and detailed category filters without changing prompt keys', () => {
  const index = new Map([
    ['holding_halo', 'pose_action'],
    ['halo', 'appearance'],
  ]);
  const prompt = { prompt: 'holding_halo', group: 0 };

  assert.equal(matchesPromptInfo(prompt, { groupIds: [0, 7], category: null }, index), true);
  assert.equal(matchesPromptInfo(prompt, { groupIds: [4, 11], category: null }, index), false);
  assert.equal(matchesPromptInfo(prompt, { groupIds: null, category: 'pose_action' }, index), true);
  assert.equal(matchesPromptInfo(prompt, { groupIds: null, category: 'appearance' }, index), false);
  assert.equal(prompt.prompt, 'holding_halo');
});

test('unknown tags remain searchable in All and coarse filters but do not become detailed matches', () => {
  const index = new Map();
  const prompt = { prompt: 'unreviewed_tag', group: 0 };

  assert.equal(getCategoryForPrompt(index, prompt.prompt), 'unknown');
  assert.equal(matchesPromptInfo(prompt, { groupIds: null, category: null }, index), true);
  assert.equal(matchesPromptInfo(prompt, { groupIds: [0], category: null }, index), true);
  assert.equal(matchesPromptInfo(prompt, { groupIds: null, category: 'object' }, index), false);
});

test('invalid filter values are ignored safely and do not throw', () => {
  assert.deepEqual(
    normalizeTagFilterOptions({ groupIds: ['0', null, -1, 0, 0], category: 'not-a-category' }),
    { groupIds: [0], category: null },
  );
  assert.deepEqual(normalizeTagFilterOptions(null), { groupIds: null, category: null });
  assert.deepEqual(normalizeTagFilterOptions('invalid'), { groupIds: null, category: null });
  assert.equal(
    normalizeTagFilterOptions({ groupIds: Array.from({ length: 100 }, (_, index) => index) }).groupIds.length,
    32,
  );
});

test('loads the bundled category dictionary without reading Japanese translation data', () => {
  const categoryPath = path.join(process.cwd(), 'data', 'tag_categories.json');
  const promptPath = path.join(process.cwd(), 'data', 'danbooru_e621_merged.csv');
  const translationPath = path.join(process.cwd(), 'data', 'danbooru_e621_merged_ja.csv');
  const index = loadTagCategories(categoryPath);
  const categoryData = JSON.parse(fs.readFileSync(categoryPath, 'utf8'));
  const promptKeys = new Set(fs.readFileSync(promptPath, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map(line => line.split(',', 1)[0]));
  const holdingHaloRow = [...promptKeys].find(prompt => prompt === 'holding_halo');

  assert.ok(holdingHaloRow);
  assert.equal(getCategoryForPrompt(index, holdingHaloRow), 'pose_action');
  assert.equal(index.get('holding_halo'), 'pose_action');
  assert.equal(index.get('halo'), 'appearance');
  assert.equal(index.get('holding_rocket_launcher'), 'pose_action');
  assert.equal(index.get('rocket_launcher'), 'object');
  for (const category of ['body', 'pose_action', 'clothing', 'appearance', 'object', 'scenery', 'composition_quality']) {
    assert.ok(
      [...index.values()].filter(value => value === category).length > 0,
      `expected at least one bundled ${category} record`,
    );
  }
  for (const prompt of Object.keys(categoryData.tags)) {
    assert.equal(promptKeys.has(prompt), true, `category dictionary tag is absent from CSV: ${prompt}`);
  }
  assert.equal(categoryData.tags.holding_halo.alias, undefined);
  assert.equal(fs.existsSync(translationPath), true);
});

test('malformed or missing dictionaries fall back to an empty index', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'saa-tag-category-'));
  const malformedPath = path.join(tempDir, 'malformed.json');
  fs.writeFileSync(malformedPath, '{"schemaVersion":1,"tags":', 'utf8');

  try {
    assert.equal(loadTagCategories(malformedPath).size, 0);
    assert.equal(loadTagCategories(path.join(tempDir, 'missing.json')).size, 0);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('filters a merged-CSV-sized in-memory prompt list after one Map load', () => {
  const prompts = Array.from({ length: 221_787 }, (_, index) => ({
    prompt: index === 221_786 ? 'holding_halo' : `tag_${index}`,
    group: 0,
  }));
  const matcher = createTagFilterMatcher(
    { category: 'pose_action' },
    new Map([['holding_halo', 'pose_action']]),
  );

  const startedAt = performance.now();
  const matches = prompts.filter(matcher);
  const elapsedMs = performance.now() - startedAt;
  assert.deepEqual(matches.map(prompt => prompt.prompt), ['holding_halo']);
  assert.ok(elapsedMs < 250, `category filtering took ${elapsedMs.toFixed(1)}ms`);
});
