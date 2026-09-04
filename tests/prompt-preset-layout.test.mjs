import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { mergePromptFieldLayout } from '../scripts/shared/promptFieldOrder.js';

const read = relativePath => fs.readFileSync(path.join(process.cwd(), relativePath), 'utf8');

const body = { id: 'cf_body0001', name: 'Body', polarity: 'positive', text: 'fox ears' };
const gear = { id: 'cf_gear0001', name: 'Equipment', polarity: 'positive', text: 'armor' };
const bad = { id: 'cf_bad00001', name: 'Bad', polarity: 'negative', text: 'blurry' };

const current = {
    prompt_custom_fields: [body, gear, bad],
    prompt_positive_order: ['common', 'views', 'background', 'style', 'ai', 'characters', 'positive', 'cf_gear0001', 'cf_body0001'],
    prompt_negative_order: ['negative', 'cf_bad00001'],
    prompt_field_presets: { cf_body0001: [{ name: 'fox', text: 'fox ears' }], style: [{ name: 's', text: 'anime' }] },
};

test('a preset saved without custom fields keeps every field, only empties their text', () => {
    const merged = mergePromptFieldLayout(current, { prompt_custom_fields: [], prompt_positive_order: ['positive', 'common'], prompt_negative_order: ['negative'] });
    assert.deepEqual(merged.prompt_custom_fields.map(f => [f.id, f.name, f.text]), [
        ['cf_body0001', 'Body', ''], ['cf_gear0001', 'Equipment', ''], ['cf_bad00001', 'Bad', ''],
    ]);
    // layout order is the current one, not the preset's
    assert.deepEqual(merged.prompt_positive_order, current.prompt_positive_order);
    assert.deepEqual(merged.prompt_negative_order, current.prompt_negative_order);
    assert.deepEqual(merged.prompt_field_presets, current.prompt_field_presets);
});

test('a preset that predates custom fields (no key) leaves texts alone', () => {
    const merged = mergePromptFieldLayout(current, { api_prompt: '1girl' });
    assert.deepEqual(merged.prompt_custom_fields, [body, gear, bad]);
});

test('a preset carrying fields supplies their text and adds unknown fields at the end', () => {
    const extra = { id: 'cf_extra001', name: 'Extra', polarity: 'positive', text: 'sword' };
    const merged = mergePromptFieldLayout(current, {
        prompt_custom_fields: [{ ...body, name: 'Renamed', text: 'cat ears' }, extra],
        prompt_positive_order: ['cf_extra001', 'positive', 'cf_body0001'],
        prompt_field_presets: { cf_extra001: [{ name: 'x', text: 'sword' }], style: [{ name: 'old', text: 'old' }] },
    });
    const byId = Object.fromEntries(merged.prompt_custom_fields.map(f => [f.id, f]));
    assert.equal(byId.cf_body0001.text, 'cat ears');
    assert.equal(byId.cf_body0001.name, 'Body', 'the current name (layout) wins over the preset name');
    assert.equal(byId.cf_gear0001.text, '', 'fields the preset does not know are emptied');
    assert.equal(byId.cf_extra001.text, 'sword');
    assert.deepEqual(merged.prompt_positive_order, [...current.prompt_positive_order, 'cf_extra001']);
    assert.deepEqual(merged.prompt_field_presets.style, current.prompt_field_presets.style, 'current per-field presets win');
    assert.deepEqual(merged.prompt_field_presets.cf_extra001, [{ name: 'x', text: 'sword' }], 'new buckets are adopted');
});

test('empty layout adopts the preset fields wholesale', () => {
    const merged = mergePromptFieldLayout({}, { prompt_custom_fields: [body], prompt_positive_order: ['positive'] });
    assert.deepEqual(merged.prompt_custom_fields, [body]);
    assert.deepEqual(merged.prompt_positive_order, ['common', 'views', 'background', 'style', 'ai', 'characters', 'positive', 'cf_body0001']);
});

test('preset apply merges the layout, undo restores snapshots exactly, and the field manager re-syncs', () => {
    const persistence = read('scripts/renderer/settingsPersistence.js');
    assert.match(persistence, /export function applySectionsData\(sectionData = \{\}, \{ mergeLayout = true \} = \{\}\)/);
    assert.match(persistence, /if \(section === 'prompt' && mergeLayout && data && typeof data === 'object'\) \{\s*data = \{ \.\.\.data, \.\.\.mergePromptFieldLayout\(raw, data\) \};/);
    assert.match(persistence, /restore: snapshots => applySectionsData\(snapshots, \{ mergeLayout: false \}\)/);
    const language = read('scripts/renderer/language.js');
    assert.match(language, /tagCapsuleFields\?\.loadFromSettings\?\.\(SETTINGS\);[\s\S]{0,300}globalThis\.prompt\.fieldManager\?\.refresh\?\.\(\)/);
    const manager = read('scripts/renderer/components/promptFieldManager.js');
    assert.match(manager, /refresh: \(\) => \{\s*fields = normalizeCustomFields\(SETTINGS\.prompt_custom_fields\);/);
    assert.match(manager, /if \(control\?\.getValue && String\(control\.getValue\(\) \?\? ''\) !== field\.text\) control\.setValue\(field\.text\)/);
    // text callbacks resolve the field by id so a reloaded `fields` array is never stale
    assert.match(manager, /\(value\) => setFieldText\(field\.id, value\)/);
    assert.doesNotMatch(manager, /field\.text = value;\s*persistFields\(\);/);
});
