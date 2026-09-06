// Original characters share the character slots through `oc:` keys.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { ORIGINAL_KEY_PREFIX, isNoneKey, isOriginalKey, originalCharacterName, originalKey } from '../scripts/shared/characterKeys.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8').replace(/\r\n/g, '\n');

test('oc: keys mark original characters and round-trip their names', () => {
    assert.equal(ORIGINAL_KEY_PREFIX, 'oc:');
    assert.equal(originalKey('Alice'), 'oc:Alice');
    assert.equal(originalKey('oc:Alice'), 'oc:Alice', 'already prefixed keys are left alone');
    assert.equal(originalKey(''), 'None');
    assert.equal(isOriginalKey('oc:Alice'), true);
    assert.equal(isOriginalKey('hatsune_miku'), false);
    assert.equal(isOriginalKey('Random'), false);
    assert.equal(originalCharacterName('oc:Alice'), 'Alice');
    assert.equal(originalCharacterName('oc:Random'), 'Random');
    assert.equal(originalCharacterName('hatsune_miku'), 'hatsune_miku');
    assert.equal(isNoneKey('none'), true);
    assert.equal(isNoneKey('oc:None'), false);
});

test('the picker lists both kinds in one list and the slot button carries an OC badge', () => {
    const modal = read('scripts/renderer/components/characterSelectionModal.js');
    assert.match(modal, /return \[\n\s+specialOption\('Random', 'random', 'character'\),\n\s+specialOption\('None', 'none', 'character'\),\n\s+\.\.\.characterEntries,\n\s+\{ \.\.\.specialOption\('Random', 'random', 'original'\), key: originalKey\('Random'\) \},\n\s+\.\.\.originalEntries,\n\s+\];/);
    assert.match(modal, /const exact = options\.find\(option => option\.key === value\);/, 'an oc: key resolves before the fuzzy name match');
    assert.match(modal, /badge\.className = 'character-selection-oc-badge';/);
    assert.doesNotMatch(modal, /getKind/, 'no per-slot kind any more');
    assert.match(modal, /dropdownCount: 2,\n\s+labels,\n\s+callback,/, 'regional has one slot per side');
    assert.match(modal, /dropdownCount: count,/, 'the variable list has no fixed OC slot');
});

test('generation resolves original characters by key, on any slot and either side', () => {
    const standard = read('scripts/renderer/generate.js');
    assert.match(standard, /const isOriginalCharacter = isOriginalKey\(character\);/);
    assert.match(standard, /handleOriginalCharacter\(originalCharacterName\(character\), seed, isValueOnly, index, FILES\)/);
    assert.match(standard, /for\(let index=0; index < slotCount; index\+\+\)/);
    assert.doesNotMatch(standard, /ocIndex/);
    const regional = read('scripts/renderer/generate_regional.js');
    assert.match(regional, /const isOriginalCharacter = isOriginalKey\(character\);/);
    assert.match(regional, /for\(let index=0; index < 2; index\+\+\)/);
    assert.doesNotMatch(regional, /index === 2|index === 3/);
    const callbacks = read('scripts/renderer/callbacks.js');
    assert.match(callbacks, /updateDefaults\(SETTINGS\.character_left, SETTINGS\.character_right\);/);
    const manager = read('scripts/renderer/components/promptFieldManager.js');
    assert.match(manager, /list\.updateDefaults\(keys\[1\], keys\[0\]\);/);
    assert.match(manager, /trigger\.querySelector\('\.character-selection-oc-badge'\) \? `\$\{name\} \(OC\)` : name/, 'the Prompts card side row names an OC as "Name (OC)"');
    const lang = JSON.parse(read('data/language.json'));
    for (const locale of ['en-US', 'zh-CN']) {
        assert.equal(lang[locale].regional_origina_character_left, undefined, `${locale}: OC side labels are gone`);
        assert.equal(typeof lang[locale].regional_strength, 'string');
    }
});

test('regional strength is a number box beside the side area; ratio and overlap stay sliders', () => {
    const html = read('scripts/html_shared_body.js');
    assert.match(html, /<div class="regional-condition-side regional-condition-side-left">\n\s+<div class="regional-condition-option-left"><\/div>\n\s+<div class="regional-condition-strength-left run-number"><\/div>/);
    assert.match(html, /<div class="regional-condition-settings-1">\n\s+<div class="regional-condition-image-ratio"><\/div>\n\s+<div class="regional-condition-overlap-ratio"><\/div>\n\s+<\/div>/);
    for (const css of ['html/index_dark.css', 'html/index_light.css']) {
        const text = read(css);
        assert.match(text, /\.characters-card \.regional-condition-settings-2 \{ display: grid; grid-template-columns: repeat\(2, minmax\(0, 1fr\)\);/);
        assert.match(text, /\.character-selection-oc-badge \{/);
    }
});
