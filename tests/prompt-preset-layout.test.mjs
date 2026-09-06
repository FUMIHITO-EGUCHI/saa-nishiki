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

test('a preset that carries fields is the authority: fewer fields → fields go, more → fields come', () => {
    const fewer = mergePromptFieldLayout(current, { prompt_custom_fields: [{ ...body, text: 'cat ears' }], prompt_positive_order: ['cf_body0001', 'positive'] });
    assert.deepEqual(fewer.prompt_custom_fields, [{ ...body, text: 'cat ears' }]);
    assert.deepEqual(fewer.prompt_positive_order, ['cf_body0001', 'positive', 'common', 'views', 'background', 'style', 'ai', 'characters']);
    assert.deepEqual(fewer.prompt_negative_order, ['negative']);

    const extra = { id: 'cf_extra001', name: 'Extra', polarity: 'positive', text: 'sword' };
    const more = mergePromptFieldLayout(current, { prompt_custom_fields: [body, gear, bad, extra] });
    assert.deepEqual(more.prompt_custom_fields.map(f => f.id), ['cf_body0001', 'cf_gear0001', 'cf_bad00001', 'cf_extra001']);
    assert.ok(more.prompt_positive_order.includes('cf_extra001'));

    const none = mergePromptFieldLayout(current, { prompt_custom_fields: [] });
    assert.deepEqual(none.prompt_custom_fields, []);
    assert.deepEqual(none.prompt_positive_order, ['common', 'views', 'background', 'style', 'ai', 'characters', 'positive']);
});

test('a preset that predates custom fields (no key) leaves fields and order alone', () => {
    const merged = mergePromptFieldLayout(current, { api_prompt: '1girl', prompt_positive_order: ['positive'] });
    assert.deepEqual(merged.prompt_custom_fields, [body, gear, bad]);
    assert.deepEqual(merged.prompt_positive_order, current.prompt_positive_order);
    assert.deepEqual(merged.prompt_negative_order, current.prompt_negative_order);
});

test('per-field presets are a library: unioned, current wins, never dropped by a preset switch', () => {
    const merged = mergePromptFieldLayout(current, {
        prompt_custom_fields: [gear],
        prompt_field_presets: { cf_gear0001: [{ name: 'g', text: 'armor' }], style: [{ name: 'old', text: 'old' }] },
    });
    assert.deepEqual(merged.prompt_field_presets, {
        cf_gear0001: [{ name: 'g', text: 'armor' }],
        cf_body0001: [{ name: 'fox', text: 'fox ears' }],
        style: [{ name: 's', text: 'anime' }],
    });
    const manager = read('scripts/renderer/components/promptFieldManager.js');
    // the container sweep does not delete preset buckets; only the editor's delete button does
    assert.match(manager, /container\.remove\(\);\s*delete globalThis\.prompt\[id\];\s*globalThis\.prompt\.tagCapsuleFields\?\.remove\?\.\(id\);\s*\}/);
    assert.match(manager, /\/\/ explicit delete: the field's preset bucket goes with it/);
});

test('preset apply goes through the layout merge, undo restores snapshots exactly, and the field manager re-syncs', () => {
    const persistence = read('scripts/renderer/settingsPersistence.js');
    assert.match(persistence, /export function applySectionsData\(sectionData = \{\}, \{ mergeLayout = true \} = \{\}\)/);
    assert.match(persistence, /if \(section === 'prompt' && mergeLayout && data && typeof data === 'object'\) \{\s*data = \{ \.\.\.data, \.\.\.mergePromptFieldLayout\(raw, data\) \};/);
    assert.match(persistence, /restore: snapshots => applySectionsData\(snapshots, \{ mergeLayout: false \}\)/);
    const language = read('scripts/renderer/language.js');
    assert.match(language, /globalThis\.prompt\.fieldManager\?\.refresh\?\.\(\);\s*globalThis\.prompt\.tagCapsuleFields\?\.loadFromSettings\?\.\(SETTINGS\);/, 'field set first, then the capsule plans');
    const manager = read('scripts/renderer/components/promptFieldManager.js');
    assert.match(manager, /refresh: \(\) => \{\s*fields = normalizeCustomFields\(SETTINGS\.prompt_custom_fields\);/);
    assert.match(manager, /if \(control\?\.getValue && String\(control\.getValue\(\) \?\? ''\) !== field\.text\) control\.setValue\(field\.text\)/);
    // text callbacks resolve the field by id so a reloaded `fields` array is never stale
    assert.match(manager, /\(value\) => setFieldText\(field\.id, value\)/);
    assert.doesNotMatch(manager, /field\.text = value;\s*persistFields\(\);/);
});
