import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { register } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { aliasKey, aliasMapFor, translationOf } from '../scripts/shared/tagAliases.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

test('the chips carry no translation (neither at rest, on hover nor on focus); the popover header carries it', () => {
    for (const file of ['html/index_dark.css', 'html/index_light.css']) {
        const css = read(file);
        assert.doesNotMatch(css, /tag-capsule-chip-alias/, `${file}: no chip alias rule`);
        assert.match(css, /\.tag-weight-popover-title-alias \{/, `${file}: translation line in the popover header`);
    }
    assert.doesNotMatch(read('scripts/renderer/components/tagCapsuleChip.js'), /alias/i, 'the chip renders no translation');
    assert.match(read('scripts/renderer/components/weightPopover.js'), /function applyTitleAlias\(\)/);
});

test('text the chips write back is not answered with tag suggestions', () => {
    assert.match(read('scripts/renderer/components/tagCapsuleField.js'), /new CustomEvent\('input', \{ bubbles: true, detail: \{ source: 'capsules' \} \}\)/);
    // nor text written into the hidden textarea of a capsule field ("+ Add tag" → selection modal)
    assert.match(read('scripts/renderer/tagAutoComplete.js'), /if \(event\?\.detail\?\.source === 'capsules' \|\| textbox\.getClientRects\(\)\.length === 0\) \{/);
});

test('the translation is the language file text kept on the entry, never an English synonym', () => {
    assert.equal(translationOf({ aliases: 'legendary_pokémon', translation: '伝説のポケモン' }), '伝説のポケモン');
    assert.equal(translationOf({ aliases: 'legendary_pokémon' }), '', 'a non-ASCII CSV synonym is not a translation');
    assert.equal(translationOf({ translation: ' Wake Up, Girls！ステージの天使 ' }), 'Wake Up, Girls！ステージの天使', 'a comma inside stays');
    assert.equal(translationOf(undefined), '');
});

test('chip values map to dictionary keys the way the CSV spells them', () => {
    assert.equal(aliasKey('White Background'), 'white_background');
    assert.equal(aliasKey('  long  hair '), 'long_hair');
    assert.equal(aliasKey(String.raw`1990s \(style\)`), '1990s_(style)', 'the escaped form the autocomplete inserts');
});

test('aliasMapFor answers every value, blank when unknown or untranslated', () => {
    const entries = new Map([
        ['white_background', { prompt: 'white_background', aliases: 'white_bg,白背景', translation: '白背景' }],
        ['1girl', { prompt: '1girl', aliases: '1girls,sole_female' }],
    ]);
    assert.deepEqual(aliasMapFor(entries, ['white background', '1girl', 'nonsense tag']), {
        'white background': '白背景',
        '1girl': '',
        'nonsense tag': '',
    });
    assert.deepEqual(aliasMapFor({ white_background: { translation: '白背景' } }, ['white background']), { 'white background': '白背景' }, 'a plain object works too');
});

test('a failed lookup pauses the alias requests instead of ending them for the session', () => {
    const client = read('scripts/renderer/tagAliasClient.js');
    assert.match(client, /retryAt = Date\.now\(\) \+ RETRY_DELAY_MS;/);
    assert.match(client, /if \(Date\.now\(\) < retryAt\) return;/);
    assert.doesNotMatch(client, /catch \(error\) \{[^}]*unavailable = true;/, 'an error no longer disables translations until a language change');
});

// The backend the app runs (tagAutoComplete_backend.js), fed a small main CSV and the
// shipped Japanese file: electron is stubbed so the module loads under node:test.
test('the app backend answers translations from the language file (Japanese)', async () => {
    const appRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'saa-tag-aliases-'));
    try {
        fs.mkdirSync(path.join(appRoot, 'data', 'wildcards'), { recursive: true });
        fs.writeFileSync(path.join(appRoot, 'data', 'danbooru_e621_merged.csv'), [
            'long_hair,0,4350743,"/lh,longhair,very_long_hair"',
            'legendary_pokemon,12,58287,"legendary_pokémon,mythical_pokemon"',
            '1990s_(style),5,20000,"90s"',
            'lying,0,446035,"lay,laying,laying_down,lying_down"',
            'covered_nipples,0,159741,"covered_erect_nipples,erect_nipple"',
            'puff_of_air,0,11580,=3',
            'wake_up_girls!_stage_no_tenshi,3,100,',
            // the alias field holds several synonyms, quoted because of its commas
            '1girl,0,6008644,"1girls,sole_female"',
            'breasts,0,3000000,"boobs,tits"',
        ].join('\n'));
        fs.copyFileSync(path.join(root, 'data', 'danbooru_e621_merged_ja.csv'), path.join(appRoot, 'data', 'danbooru_e621_merged_ja.csv'));
        const electron = `export const app = { isPackaged: false, getAppPath: () => ${JSON.stringify(appRoot)}, getPath: () => ${JSON.stringify(appRoot)} };
export const ipcMain = { handle() {}, on() {} };
export const dialog = { showErrorBox() {} };`;
        register('data:text/javascript,' + encodeURIComponent(`export async function resolve(specifier, context, next) {
    if (specifier === 'electron') return { url: 'data:text/javascript,' + encodeURIComponent(${JSON.stringify(electron)}), shortCircuit: true };
    return next(specifier, context);
}`));
        const backend = await import('../scripts/main/tagAutoComplete_backend.js');
        assert.equal(await backend.setupTagAutoCompleteBackend('ja-JP'), true);
        const { loaded, aliases } = backend.getTagAliases(['long hair', 'legendary pokemon', String.raw`1990s \(style\)`, 'lying', 'covered nipples', 'puff of air', 'wake up girls! stage no tenshi', 'nonsense']);
        assert.equal(loaded, true);
        assert.deepEqual(aliases, {
            'long hair': 'ロングヘア',
            'legendary pokemon': '',                                            // no Japanese line; "legendary_pokémon" is a synonym
            [String.raw`1990s \(style\)`]: '1990年代風',                         // the escaped chip value
            lying: '横たわる',                                                  // hand-reviewed aliases, as the app shows them
            'covered nipples': '浮き乳首',
            'puff of air': '鼻息',
            'wake up girls! stage no tenshi': 'Wake Up, Girls！ステージの天使',  // not cut at its comma
            nonsense: '',
        });
        await backend.tagReload('en-US');
        assert.deepEqual(backend.getTagAliases(['long hair', 'legendary pokemon']).aliases, { 'long hair': '', 'legendary pokemon': '' }, 'no language file, no translation');
        // every synonym of a row is kept, not just the one before the first comma:
        // a search for a later alias has to find its tag
        const shown = async word => JSON.stringify(await backend.tagGet(word, 10));
        assert.match(await shown('sole_female'), /1girl/, 'the second alias of a row still finds its tag');
        assert.match(await shown('tits'), /breasts/, 'the last alias of a row still finds its tag');
    } finally {
        fs.rmSync(appRoot, { recursive: true, force: true });
    }
});
