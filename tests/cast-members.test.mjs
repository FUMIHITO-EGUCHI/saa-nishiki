import assert from 'node:assert/strict';
import test from 'node:test';

import {
    castAlias,
    castEnabled,
    castFieldId,
    castIndexOf,
    castReferences,
    castRoster,
    isCastFieldId,
    isDiffusionFieldId,
    syncCastFields,
} from '../scripts/shared/castMembers.js';
import { normalizeSection } from '../scripts/shared/settingsSections.js';

const LANG = { cast_default_alias: 'char' };

test('cast rows are custom fields with a reserved id, one per slot', () => {
    assert.equal(castFieldId(2), 'cf_cast2');
    assert.equal(castIndexOf('cf_cast6'), 6);
    assert.equal(castIndexOf('cf_cast7'), 0, 'six slots at most');
    assert.equal(castIndexOf('cf_1a2b3c4d'), 0);
    assert.ok(isCastFieldId('cf_cast1'));
    assert.ok(!isCastFieldId('positive'));
});

test('the cast exists for the Diffusion model type only', () => {
    assert.equal(castEnabled({ api_model_type: 'Diffusion' }), true);
    assert.equal(castEnabled({ api_model_type: 'Checkpoint' }), false);
    assert.equal(castEnabled({}), false);
});

test('an alias falls back to the language word plus the slot number', () => {
    assert.equal(castAlias({ alias: ' 姫 ' }, 0, LANG), '姫');
    assert.equal(castAlias({}, 1, LANG), 'char2');
    assert.equal(castAlias({ alias: '' }, 2, {}), 'char3');
    assert.equal(castAlias({ alias: 'x'.repeat(30) }, 0, LANG).length, 20);
});

test('the roster follows the slots in order with alias, key, weight and row id', () => {
    const roster = castRoster({ character_slots: [{ key: 'hakurei reimu', weight: 1.2, alias: '姫' }, { key: 'Random', weight: 1 }] }, LANG);
    assert.deepEqual(roster, [
        { index: 1, alias: '姫', key: 'hakurei reimu', weight: 1.2, fieldId: 'cf_cast1' },
        { index: 2, alias: 'char2', key: 'Random', weight: 1, fieldId: 'cf_cast2' },
    ]);
});

test('syncCastFields adds a row per slot right after the characters block; a user Action field is left alone', () => {
    const settings = {
        character_slots: [{ key: 'A', weight: 1, alias: '姫' }, { key: 'B', weight: 1 }],
        prompt_custom_fields: [{ id: 'cf_action1', name: 'Action', polarity: 'positive', text: 'x' }],
        prompt_positive_order: ['common', 'views', 'background', 'style', 'artist', 'ai', 'characters', 'positive', 'cf_action1'],
    };
    const patch = syncCastFields(settings, LANG);
    assert.equal(patch.changed, true);
    assert.deepEqual(patch.prompt_custom_fields.map(field => [field.id, field.name]), [
        ['cf_action1', 'Action'], ['cf_cast1', '@姫'], ['cf_cast2', '@char2'],
    ]);
    assert.deepEqual(patch.prompt_positive_order, ['common', 'views', 'background', 'style', 'artist', 'ai', 'characters', 'cf_cast1', 'cf_cast2', 'positive', 'cf_action1']);
});

test('without an Action field the fixed Action row is added at the end of the chain', () => {
    const settings = {
        character_slots: [{ key: 'A', weight: 1 }],
        prompt_custom_fields: [{ id: 'cf_extra', name: 'Extra', polarity: 'positive', text: '' }],
        prompt_positive_order: ['common', 'views', 'background', 'style', 'artist', 'ai', 'characters', 'positive', 'cf_extra'],
    };
    const patch = syncCastFields(settings, LANG);
    assert.deepEqual(patch.prompt_custom_fields.map(field => field.id), ['cf_extra', 'cf_cast1', 'cf_action']);
    assert.deepEqual(patch.prompt_positive_order, ['common', 'views', 'background', 'style', 'artist', 'ai', 'characters', 'cf_cast1', 'positive', 'cf_extra', 'cf_action']);
    const again = syncCastFields({ ...settings, ...patch }, LANG);
    assert.equal(again.changed, false);
    assert.ok(isDiffusionFieldId('cf_action') && isDiffusionFieldId('cf_cast3') && !isDiffusionFieldId('cf_extra'));
});

test('syncCastFields renames, keeps the text and the stored position, and drops rows of removed slots', () => {
    const settings = {
        character_slots: [{ key: 'A', weight: 1, alias: '執事' }],
        prompt_custom_fields: [
            { id: 'cf_cast1', name: '@姫', polarity: 'positive', text: 'black hair, black suit' },
            { id: 'cf_cast2', name: '@char2', polarity: 'positive', text: 'blonde hair' },
        ],
        prompt_positive_order: ['common', 'views', 'background', 'style', 'artist', 'ai', 'characters', 'positive', 'cf_cast1', 'cf_cast2'],
    };
    const patch = syncCastFields(settings, LANG);
    assert.equal(patch.changed, true);
    assert.deepEqual(patch.prompt_custom_fields, [
        { id: 'cf_cast1', name: '@執事', polarity: 'positive', text: 'black hair, black suit' },
        { id: 'cf_action', name: 'Action', polarity: 'positive', text: '' },
    ]);
    assert.deepEqual(patch.prompt_positive_order, ['common', 'views', 'background', 'style', 'artist', 'ai', 'characters', 'positive', 'cf_cast1', 'cf_action']);
    assert.equal(syncCastFields({ ...settings, ...patch }, LANG).changed, false, 'a second sync is a no-op');
});

test('an alias change alone renames the row (and never mutates the stored fields)', () => {
    const stored = [{ id: 'cf_cast1', name: '@char1', polarity: 'positive', text: 'red eyes' }];
    const settings = {
        character_slots: [{ key: 'A', weight: 1, alias: '姫' }],
        prompt_custom_fields: stored,
        prompt_positive_order: ['common', 'views', 'background', 'style', 'artist', 'ai', 'characters', 'cf_cast1', 'positive'],
    };
    const patch = syncCastFields(settings, LANG);
    assert.equal(patch.changed, true);
    assert.equal(patch.prompt_custom_fields[0].name, '@姫');
    assert.equal(patch.prompt_custom_fields[0].text, 'red eyes');
    assert.equal(stored[0].name, '@char1');
    assert.deepEqual(patch.prompt_positive_order, [...settings.prompt_positive_order, 'cf_action']);
});

test('"@alias" in the action becomes "@<slot>", longest alias first, bare numbers untouched', () => {
    const roster = castRoster({ character_slots: [{ key: 'A', alias: '姫' }, { key: 'B', alias: '姫様' }, { key: 'C' }] }, LANG);
    assert.equal(castReferences('@姫様が@姫を抱く。@3 は見ている', roster), '@2が@1を抱く。@3 は見ている');
    assert.equal(castReferences('@char3 sits', roster), '@3 sits');
    assert.equal(castReferences('', roster), '');
});

test('the settings keep a slot alias and drop an empty one', () => {
    const section = normalizeSection('prompt', {
        character_slots: [{ key: 'A', weight: 1, alias: ' 姫 ' }, { key: 'B', weight: 1, alias: '' }, { key: 'C', weight: 1 }],
    });
    assert.deepEqual(section.character_slots, [{ key: 'A', weight: 1, alias: '姫' }, { key: 'B', weight: 1 }, { key: 'C', weight: 1 }]);
});
