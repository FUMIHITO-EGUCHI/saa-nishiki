// scripts/main/tagAutoComplete_backend.js with a dictionary of its own: electron is swapped
// for a stub through module hooks and the app root is a temp folder, so the module under test
// is the one the app runs, fed a small CSV whose heats and aliases are known.
//
// What is pinned here is the order the suggestions come back in (the popularity of a tag is
// the whole point of the list), which of them are kept when there are more than the limit,
// the alias and wildcard matches, and that a dictionary that did not load answers nothing.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import module from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const appRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'saa-tag-backend-'));
const dataDir = path.join(appRoot, 'data');
const tagFile = path.join(dataDir, 'danbooru_e621_merged.csv');
const japaneseFile = path.join(dataDir, 'danbooru_e621_merged_ja.csv');
fs.mkdirSync(dataDir, { recursive: true });

// `tag,group,heat,"alias,alias"`. Popularity (heat) is what the order is read from, so the
// numbers here are the ones the assertions name.
const ROWS = [
    'hair,0,1000,""',                                  // prefix match, unpopular
    'hair_ornament,0,500000,""',                       // prefix match, popular
    'long_hair,0,4350743,"/lh,longhair"',              // substring only, the most popular of all
    'short_hair,0,2000000,""',                         // substring only
    'breasts,0,3000000,"boobs,tits"',                  // found by its aliases alone
    'blue_sky,0,5000,"sky_blue"',
    'Blue_Sky,0,77,""',                                // the same key spelled differently, far less popular
    'hatsune_miku,4,900000,"miku"',                    // character
    'vocaloid,3,800000,""',                            // copyright
    'wake_up_girls!,3,300,"Wake Up Girls"',            // an alias with real spaces
    // more matches for one word than the 50 a request answers with
    ...Array.from({ length: 60 }, (unused, index) => `zzz_${String(index + 1).padStart(3, '0')},0,${(index + 1) * 10},""`),
];

function writeTagFile() {
    fs.writeFileSync(tagFile, ROWS.join('\n'));
}
writeTagFile();

// one verified category, so the category filter has something to keep
fs.writeFileSync(path.join(dataDir, 'tag_categories.json'), JSON.stringify({
    schemaVersion: 1,
    tags: {
        long_hair: { category: 'appearance', status: 'verified', source: 'Danbooru Wiki', sourceUrl: 'https://danbooru.donmai.us/wiki_pages/long_hair' },
        short_hair: { category: 'appearance', status: 'verified', source: 'LLM', model: 'gemma4' },
    },
}));

const stub = { handlers: {}, errorBoxes: [] };
globalThis.__tagBackendStub = stub;

const ELECTRON = `
    const stub = globalThis.__tagBackendStub;
    export const app = { isPackaged: false, getAppPath: () => ${JSON.stringify(appRoot)}, getPath: () => ${JSON.stringify(appRoot)} };
    export const ipcMain = { handle: (channel, handler) => { stub.handlers[channel] = handler; }, on() {} };
    export const dialog = { showErrorBox: (title, message) => { stub.errorBoxes.push(message); } };`;
const electronUrl = `data:text/javascript,${encodeURIComponent(ELECTRON)}`;

const hooksAvailable = typeof module.registerHooks === 'function';
if (hooksAvailable) {
    module.registerHooks({
        resolve(specifier, context, nextResolve) {
            if (specifier === 'electron' || specifier === 'saa-tag-backend-hook-probe') return { url: electronUrl, shortCircuit: true };
            return nextResolve(specifier, context);
        },
    });
}

// Loaded only with the stub in place: the real electron is not there to import.
let backend = null;
if (hooksAvailable) {
    const probe = await import('saa-tag-backend-hook-probe');
    if (typeof probe.app === 'object') backend = await import('../scripts/main/tagAutoComplete_backend.js');
}
const opts = { skip: backend ? false : 'needs node:module registerHooks', timeout: 30_000 };

test.after(() => {
    fs.rmSync(appRoot, { recursive: true, force: true });
});

// The tags of a rendered suggestion list, in the order the renderer shows them.
const names = items => items.map(([key]) => /<b>(.*?)<\/b>/.exec(key)[1]);
const heatOf = (items, tag) => Number(/\((\d+)\)/.exec(items[names(items).indexOf(tag)][0])[1]);

// updateSuggestions only answers the part of the text that changed, so each query starts from
// a freshly loaded dictionary rather than from what the test before it typed.
async function suggest(text, options = null) {
    assert.equal(await backend.tagReload('en-US'), true);
    return backend.tagGet(text, options);
}

test('a missing tag file is reported instead of registering the tag channels', opts, async () => {
    fs.rmSync(tagFile);
    stub.handlers = {};
    stub.errorBoxes = [];
    try {
        assert.equal(await backend.setupTagAutoCompleteBackend('en-US'), false);
        assert.deepEqual(Object.keys(stub.handlers), [], 'no channel answers while there is no dictionary');
        assert.equal(stub.errorBoxes.length, 1);
        assert.match(stub.errorBoxes[0], /Tag file not found/);
    } finally {
        writeTagFile();
    }
});

test('the tag channels are registered once the dictionary loaded, and answer through them', opts, async () => {
    stub.handlers = {};
    stub.errorBoxes = [];
    assert.equal(await backend.setupTagAutoCompleteBackend('en-US'), true);
    assert.deepEqual(Object.keys(stub.handlers).sort(), ['tag-aliases', 'tag-get-suggestions', 'tag-lookup', 'tag-reload', 'tag-search']);
    assert.deepEqual(stub.errorBoxes, []);
    const items = await stub.handlers['tag-get-suggestions']({}, 'hatsune');
    assert.deepEqual(names(items), ['hatsune_miku']);
    assert.deepEqual(await stub.handlers['tag-lookup']({}, ['hatsune_miku', 'nonsense']), { loaded: true, known: ['hatsune_miku'] });
});

test('the dictionary is kept in popularity order', opts, async () => {
    assert.equal(await backend.tagReload('en-US'), true);
    const heats = backend.getPromptList().map(entry => entry.heat);
    assert.equal(heats.length, ROWS.length);
    assert.deepEqual(heats, [...heats].sort((a, b) => b - a), 'the most popular tag comes first');
    assert.equal(heats[0], 4350743);
    assert.equal(heats.at(-1), 10);
});

test('prefix matches come before the rest, and the more popular tag comes first inside each band', opts, async () => {
    const items = await suggest('hair');
    assert.deepEqual(names(items), ['hair_ornament', 'hair', 'long_hair', 'short_hair']);
    // and nothing about the band order hides how popular a tag is
    assert.equal(heatOf(items, 'hair'), 1000);
    assert.equal(heatOf(items, 'long_hair'), 4350743);
});

test('with more matches than a request answers with, the popular ones are the ones kept', opts, async () => {
    const shown = names(await suggest('zzz'));
    assert.equal(shown.length, 50);
    assert.equal(shown[0], 'zzz_060', 'the most popular match');
    assert.equal(shown.at(-1), 'zzz_011');
    assert.equal(shown.includes('zzz_001'), false, 'the ten least popular matches are the ones left out');
});

test('tagSearch pages through the whole ranked result and says how big it is', opts, async () => {
    assert.equal(await backend.tagReload('en-US'), true);
    const first = backend.tagSearch('zzz', { offset: 0, limit: 50 });
    assert.equal(first.total, 60, 'every match is counted, not just the page');
    assert.deepEqual([first.offset, first.limit, first.items.length], [0, 50, 50]);
    assert.equal(names(first.items)[0], 'zzz_060');
    const second = backend.tagSearch('zzz', { offset: 50, limit: 50 });
    assert.deepEqual([second.total, second.items.length], [60, 10]);
    assert.equal(names(second.items)[0], 'zzz_010', 'the next page starts where the first one stopped');
    assert.equal(names(second.items).at(-1), 'zzz_001');
    // the same word again is answered again (updateSuggestions would say "nothing changed")
    assert.equal(backend.tagSearch('zzz', { offset: 0, limit: 5 }).items.length, 5);
    assert.deepEqual(backend.tagSearch('', {}), { items: [], total: 0, offset: 0, limit: 50 });
    // the filter rides on the same options
    assert.equal(backend.tagSearch('hair', { category: 'appearance', limit: 50 }).total, 2);
});

test('a tag is found by an alias alone, and the alias it was found by is shown', opts, async () => {
    const items = await suggest('boobs');
    assert.deepEqual(names(items), ['breasts']);
    assert.match(items[0][0], /\(boobs\)/, 'the alias that matched is named, not the whole synonym list');
    assert.deepEqual(names(await suggest('tits')), ['breasts'], 'the last alias of a row finds it too');
    assert.deepEqual(names(await suggest('lh')), ['long_hair']);
});

test('a space in the typed word is the "_" of the dictionary key, and still a space in an alias', opts, async () => {
    assert.equal(await backend.tagReload('en-US'), true);
    const search = word => names(backend.tagSearch(word, { limit: 50 }).items);
    // "white d" on its way to white_dress: the picker sends the space as typed
    assert.deepEqual(search('long h'), ['long_hair']);
    assert.deepEqual(search('long_h'), ['long_hair']);
    assert.deepEqual(search('hair o'), ['hair_ornament']);
    assert.deepEqual(search('long h*'), ['long_hair'], 'a wildcard pattern too');
    // an alias that holds a real space is found by either spelling
    assert.deepEqual(search('wake up'), ['wake_up_girls!']);
    assert.deepEqual(search('up girls'), ['wake_up_girls!'], 'the space form matches the alias');
    assert.deepEqual(search('up_girls'), ['wake_up_girls!'], 'the key form matches the key');
    assert.deepEqual(search('  '), [], 'blanks alone are no word');
});

test('a wildcard anchors the match where it is written', opts, async () => {
    assert.deepEqual(names(await suggest('hair*')).sort(), ['hair', 'hair_ornament'], 'x* starts with');
    assert.deepEqual(names(await suggest('*hair')).sort(), ['hair', 'long_hair', 'short_hair'], '*x ends with');
    assert.deepEqual(names(await suggest('*hair*')).sort(), ['hair', 'hair_ornament', 'long_hair', 'short_hair'], '*x* anywhere');
    // an alias is matched by the same pattern
    const items = await suggest('boob*');
    assert.deepEqual(names(items), ['breasts']);
    assert.match(items[0][0], /\(boobs\)/);
    assert.deepEqual(names(await suggest('*nothing_here*')), []);
});

test('two rows spelled the same keep the popular one', opts, async () => {
    const items = await suggest('blue_sky');
    assert.deepEqual(names(items), ['blue_sky']);
    assert.equal(heatOf(items, 'blue_sky'), 5000, 'not the 77 of the other spelling');
    assert.doesNotMatch(items[0][0], /sky_blue/, 'a row found by its own name lists none of its synonyms');
    // found through the alias: the row says which alias it was, and only that one
    const byAlias = await suggest('sky_blue');
    assert.deepEqual(names(byAlias), ['blue_sky']);
    assert.match(byAlias[0][0], /^<b>blue_sky<\/b>: \(sky_blue\) \(5000\)/);
});

test('the group and category filters leave the tags they were given out', opts, async () => {
    assert.deepEqual(names(await suggest('miku', { groupIds: [4] })), ['hatsune_miku']);
    assert.deepEqual(names(await suggest('miku', { groupIds: [3] })), [], 'a character is not a copyright');
    assert.deepEqual(names(await suggest('hair', { category: 'appearance' })), ['long_hair', 'short_hair']);
    assert.deepEqual(names(await suggest('hair', { category: 'clothing' })), []);
    // typing nothing new is answered with nothing, until the filter itself changes: the same
    // word is then looked up again under the filter that is on now
    assert.deepEqual(names(backend.tagGet('hair', { category: 'appearance' })), ['long_hair', 'short_hair']);
    assert.deepEqual(backend.tagGet('hair', { category: 'appearance' }), [], 'nothing changed, nothing to suggest');
    assert.deepEqual(names(backend.tagGet('hair', { groupIds: [0] })), ['hair_ornament', 'hair', 'long_hair', 'short_hair']);
});

test('the group of a tag is shown, and a character is not marked as general', opts, async () => {
    const items = await suggest('hatsune');
    assert.match(items[0][0], /\[C\]/);
    assert.match((await suggest('vocaloid'))[0][0], /\[©\]/);
    assert.match((await suggest('hair_orn'))[0][0], /\[G\]/);
});

test('a language file that cannot be read leaves the dictionary unusable, not half loaded', opts, async () => {
    // the shape of any failure while loading: the tag rows were parsed, the language file
    // was not, and `dataLoaded` stayed false. Nothing may be answered from that state.
    fs.mkdirSync(japaneseFile, { recursive: true });
    try {
        assert.equal(await backend.tagReload('ja-JP'), false, 'a language file that cannot be read fails the load');
        assert.deepEqual(backend.tagGet('hair'), [], 'no suggestions out of a dictionary that did not load');
        assert.deepEqual(backend.tagLookup(['long_hair']), { loaded: false, known: [] });
        assert.deepEqual(backend.getTagAliases(['long_hair']), { loaded: false, aliases: {} });
        assert.deepEqual(backend.getPromptList(), []);
    } finally {
        fs.rmSync(japaneseFile, { recursive: true, force: true });
        assert.equal(await backend.tagReload('en-US'), true);
    }
});

test('an empty word is answered with nothing at all', opts, async () => {
    assert.deepEqual(await suggest(''), []);
    assert.deepEqual(await suggest('long_hair, '), [], 'a trailing comma is not a search for everything');
});
