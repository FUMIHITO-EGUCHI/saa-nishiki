import assert from 'node:assert/strict';
import test from 'node:test';

import {
    castAlias,
    castEnabled,
    castFieldId,
    castIndexOf,
    castPlainReferences,
    castReferences,
    castRoster,
    isCastFieldId,
    isDiffusionFieldId,
    syncCastFields,
    unknownCastReferences,
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

const rosterOf = aliases => castRoster({ character_slots: aliases.map((alias, i) => ({ key: `K${i}`, alias })) }, LANG);

test('two slots never share an alias: a duplicate falls back to its default, a taken default gets a suffix', () => {
    assert.deepEqual(rosterOf(['Mia', 'Mia']).map(member => member.alias), ['Mia', 'char2']);
    assert.deepEqual(rosterOf(['char2', '']).map(member => member.alias), ['char2', 'char2_2']);
    assert.equal(castReferences('@Mia hugs @char2', rosterOf(['Mia', 'Mia'])), '@1 hugs @2');
});

test('references are rewritten in one pass, at word boundaries, whatever the alias holds', () => {
    // numeric aliases: a rewritten "@1" is never rewritten again
    assert.equal(castReferences('@2 hugs @1', rosterOf(['2', '1'])), '@1 hugs @2');
    assert.equal(castReferences('@char1 hugs @1', rosterOf(['', '1'])), '@1 hugs @2');
    // an ASCII alias does not eat a longer word; Japanese has no word breaks
    assert.equal(castReferences('@Ann hugs @Annabel', rosterOf(['Ann', 'Bea'])), '@1 hugs @Annabel');
    assert.equal(castReferences('@姫が@執事を見る', rosterOf(['姫', '執事'])), '@1が@2を見る');
    assert.equal(castReferences('@a.b+ hugs @(c)', rosterOf(['a.b+', '(c)'])), '@1 hugs @2');
});

test('castPlainReferences drops the "@" of a reference and leaves Artist tokens alone', () => {
    const roster = rosterOf(['hime', '']);
    assert.equal(castPlainReferences('masterpiece, @hime hugs @char2, @2 smiles', roster), 'masterpiece, hime hugs char2, char2 smiles');
    const artist = rosterOf(['wlop', '']);
    assert.equal(castPlainReferences('(@wlop:0.8), @wlop hugs @char2', artist, { verbatim: ['@wlop'] }), '(@wlop:0.8), @wlop hugs char2');
    assert.equal(castPlainReferences('@hime \\(artist\\), @hime waves', rosterOf(['hime']), { verbatim: ['@hime \\(artist\\)'] }), '@hime \\(artist\\), hime waves');
    assert.equal(castPlainReferences('@7 waves', roster), '@7 waves', 'no slot 7');
    // an Artist token is kept at a word boundary, like an alias: "@ask" is not "@askari"
    assert.equal(castPlainReferences('@ask, @askari smiles', rosterOf(['askari']), { verbatim: ['@ask'] }), '@ask, askari smiles');
});

test('a renamed alias carries the Action with it; an old alias a row keeps is left alone', () => {
    const settings = {
        character_slots: [{ key: 'A', weight: 1, alias: 'princess' }, { key: 'B', weight: 1 }],
        prompt_custom_fields: [
            { id: 'cf_cast1', name: '@hime', polarity: 'positive', text: 'red hair' },
            { id: 'cf_cast2', name: '@char2', polarity: 'positive', text: '' },
            { id: 'cf_action', name: 'Action', polarity: 'positive', text: '@hime hugs @char2, @himeko watches' },
        ],
        prompt_positive_order: ['common', 'views', 'background', 'style', 'artist', 'ai', 'characters', 'cf_cast1', 'cf_cast2', 'positive', 'cf_action'],
    };
    const patch = syncCastFields(settings, LANG);
    assert.equal(patch.prompt_custom_fields.find(field => field.id === 'cf_action').text, '@princess hugs @char2, @himeko watches');
    // a language switch renames a default alias the same way
    const zh = syncCastFields({ ...settings, ...patch }, { cast_default_alias: '角色' });
    assert.equal(zh.prompt_custom_fields.find(field => field.id === 'cf_action').text, '@princess hugs @角色2, @himeko watches');
    // both rows renamed at once, slot 2 taking slot 1's old alias: one pass, each reference to its own slot
    const swapped = syncCastFields({ ...settings, character_slots: [{ key: 'A', alias: 'princess' }, { key: 'B', alias: 'hime' }] }, LANG);
    assert.equal(swapped.prompt_custom_fields.find(field => field.id === 'cf_action').text, '@princess hugs @hime, @himeko watches');
    // two slots stored with one alias: slot 2 falls back to "char2", and "@Mia" keeps meaning slot 1
    const duplicate = syncCastFields({
        character_slots: [{ key: 'A', alias: 'Mia' }, { key: 'B', alias: 'Mia' }],
        prompt_custom_fields: [
            { id: 'cf_cast1', name: '@Mia', polarity: 'positive', text: '' },
            { id: 'cf_cast2', name: '@Mia', polarity: 'positive', text: '' },
            { id: 'cf_action', name: 'Action', polarity: 'positive', text: '@Mia waves' },
        ],
    }, LANG);
    assert.deepEqual(duplicate.prompt_custom_fields.map(field => [field.name, field.text]), [['@Mia', ''], ['@char2', ''], ['Action', '@Mia waves']]);
});

test('a removed slot hands back its row as dropped, and the stash restores it when the slot returns', () => {
    const settings = {
        character_slots: [{ key: 'A' }, { key: 'B' }],
        prompt_custom_fields: [
            { id: 'cf_cast1', name: '@char1', polarity: 'positive', text: 'red hair' },
            { id: 'cf_cast2', name: '@char2', polarity: 'positive', text: 'long black hair, maid outfit', muted: true },
            { id: 'cf_action', name: 'Action', polarity: 'positive', text: '' },
        ],
        prompt_positive_order: ['common', 'views', 'background', 'style', 'artist', 'ai', 'characters', 'cf_cast1', 'cf_cast2', 'positive', 'cf_action'],
    };
    const removed = syncCastFields({ ...settings, character_slots: [{ key: 'A' }] }, LANG);
    assert.deepEqual(removed.dropped.map(field => [field.id, field.text]), [['cf_cast2', 'long black hair, maid outfit']]);
    const stash = Object.fromEntries(removed.dropped.map(field => [field.id, field]));
    const back = syncCastFields({ ...settings, ...removed, character_slots: [{ key: 'A' }, { key: 'B' }] }, LANG, { stash });
    const row = back.prompt_custom_fields.find(field => field.id === 'cf_cast2');
    assert.equal(row.text, 'long black hair, maid outfit');
    assert.equal(row.muted, true);
    assert.equal(syncCastFields({ ...settings, ...removed, character_slots: [{ key: 'A' }, { key: 'B' }] }, LANG).prompt_custom_fields.find(field => field.id === 'cf_cast2').text, '', 'no stash: a blank row');
});

test('unknownCastReferences lists what the action names that no character entry answers to', () => {
    assert.deepEqual(unknownCastReferences('@1 hugs @3, @hime waves; @2が見る', ['@1', '@2']), ['@3', '@hime']);
    assert.deepEqual(unknownCastReferences('@1 hugs @2', ['@1', '@2']), []);
});

test('a seventh character slot gets no cast row', () => {
    const slots = Array.from({ length: 7 }, (_, index) => ({ key: `K${index}`, alias: `A${index}` }));
    const roster = castRoster({ character_slots: slots }, LANG);
    assert.deepEqual(roster.map(member => member.alias), ['A0', 'A1', 'A2', 'A3', 'A4', 'A5']);
    // an id past the last slot is no cast id, so such a row would never be renamed or hidden again
    assert.ok(roster.every(member => isCastFieldId(member.fieldId)), 'every member carries an id the app knows');
    const synced = syncCastFields({ api_model_type: 'Diffusion', character_slots: slots }, LANG);
    assert.deepEqual(
        synced.prompt_custom_fields.filter(field => isCastFieldId(field.id)).map(field => field.id),
        ['cf_cast1', 'cf_cast2', 'cf_cast3', 'cf_cast4', 'cf_cast5', 'cf_cast6'],
    );
});
