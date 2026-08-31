import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  TAG_FILTERS,
  extractPromptKeyFromSuggestion,
  getTagFilterOptions,
} from '../scripts/renderer/tagAutoComplete.js';

const testDirectory = path.dirname(fileURLToPath(import.meta.url));

test('exposes the English coarse filter labels and their backend options', () => {
  assert.deepEqual(TAG_FILTERS.map(filter => filter.label), [
    'All',
    'General',
    'Character',
    'Work',
    'Artist',
    'Species',
    'Meta',
    'Lore',
    'Pose / Action',
    'Clothing',
    'Appearance',
    'Object',
    'Composition / Quality',
  ]);
  assert.deepEqual(getTagFilterOptions('all'), undefined);
  assert.deepEqual(getTagFilterOptions('work'), { groupIds: [3, 10] });
  assert.deepEqual(getTagFilterOptions('species'), { groupIds: [12] });
  assert.deepEqual(getTagFilterOptions('pose_action'), { category: 'pose_action' });
  assert.deepEqual(getTagFilterOptions('appearance'), { category: 'appearance' });
});

test('extracts the English prompt key from unchanged suggestion markup', () => {
  assert.equal(
    extractPromptKeyFromSuggestion('<b>holding_halo</b>: (holding halo) (123) [G] [Pose / Action]'),
    'holding_halo',
  );
});

test('keeps renderer filter metadata browser-safe under the Electron CSP', () => {
  const rendererSource = fs.readFileSync(
    path.join(testDirectory, '..', 'scripts', 'renderer', 'tagAutoComplete.js'),
    'utf8',
  );
  const constantsSource = fs.readFileSync(
    path.join(testDirectory, '..', 'scripts', 'main', 'tagCategoryConstants.js'),
    'utf8',
  );

  assert.match(rendererSource, /from ['"]\.\.\/main\/tagCategoryConstants\.js['"]/);
  assert.doesNotMatch(rendererSource, /from ['"]\.\.\/main\/tagCategories\.js['"]/);
  assert.doesNotMatch(constantsSource, /node:fs/);
});
