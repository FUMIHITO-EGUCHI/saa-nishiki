import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { aliasKey, aliasMapFor, translationAlias } from '../scripts/shared/tagAliases.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

test('the chip alias shows only while the chip is hovered or focused (C2); the popover header always shows it', () => {
    for (const file of ['html/index_dark.css', 'html/index_light.css']) {
        const css = read(file);
        assert.match(css, /\.tag-capsule-chip-alias \{ display: none;/, `${file}: hidden at rest`);
        assert.match(css, /\.tag-capsule-chip:hover \.tag-capsule-chip-alias,\s*\.tag-capsule-chip:focus \.tag-capsule-chip-alias,\s*\.tag-capsule-chip:focus-visible \.tag-capsule-chip-alias \{ display: inline; \}/, `${file}: shown on hover / focus`);
        assert.match(css, /\.tag-weight-popover-title-alias \{/, `${file}: translation line in the popover header`);
    }
    assert.match(read('scripts/renderer/components/weightPopover.js'), /function applyTitleAlias\(\)/);
});

test('the translation is the first non-ASCII alias, not the English synonym in front of it', () => {
    assert.equal(translationAlias('1girls,sole_female,1人の女の子,女孩'), '1人の女の子');
    assert.equal(translationAlias('白背景'), '白背景');
    assert.equal(translationAlias('1girls,sole_female'), '', 'English-only aliases are not a translation');
    assert.equal(translationAlias(''), '');
    assert.equal(translationAlias(undefined), '');
});

test('chip values map to dictionary keys the way the CSV spells them', () => {
    assert.equal(aliasKey('White Background'), 'white_background');
    assert.equal(aliasKey('  long  hair '), 'long_hair');
});

test('aliasMapFor answers every value, blank when unknown or untranslated', () => {
    const entries = new Map([
        ['white_background', { prompt: 'white_background', aliases: 'white_bg,白背景' }],
        ['1girl', { prompt: '1girl', aliases: '1girls,sole_female' }],
    ]);
    assert.deepEqual(aliasMapFor(entries, ['white background', '1girl', 'nonsense tag']), {
        'white background': '白背景',
        '1girl': '',
        'nonsense tag': '',
    });
    assert.deepEqual(aliasMapFor({ white_background: { aliases: '白背景' } }, ['white background']), { 'white background': '白背景' }, 'a plain object works too');
});
