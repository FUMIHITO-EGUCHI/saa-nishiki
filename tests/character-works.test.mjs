// Character -> works: the offline build from the Danbooru co-occurrence dump,
// the data file it produces, and the picker searching / showing the works.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
    buildCharacterIndex,
    buildWorksTable,
    chooseWorks,
    normalizeTagKey,
    parseTagsCsv,
    parseWikiCache,
    qualifierWorkMap,
    resolveCharacterTag,
    splitQualifiers,
    toDanbooru,
    toListForm,
} from '../scripts/buildCharacterWorks.mjs';
import { characterWorkSearchTerms, characterWorkTitles, workTitle, worksOf } from '../scripts/shared/characterWorks.js';
import { filterSelectionOptions } from '../scripts/renderer/components/selectionModalLogic.js';
import { getLocalizedCharacterName } from '../scripts/renderer/characterLocalization.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8').replace(/\r\n/g, '\n');
const characterWorks = JSON.parse(read('data/character_works.json'));

const TAGS_CSV = `tag,category,count,alias
hatsune_miku,4,75449,"初音ミク"
2b_(nier:automata),4,20000,
abarai_renji,4,900,
pokemon,3,500000,
vocaloid,3,300000,
nier_(series),3,9000,
nier:automata,3,8000,
bleach,3,7000,
aggron,4,300,
`;

test('list spellings resolve to Danbooru character tags through normalized keys and base names', () => {
    const info = parseTagsCsv(TAGS_CSV);
    assert.equal(info.get('pokemon').category, 3);
    const index = buildCharacterIndex(info);
    assert.equal(resolveCharacterTag('hatsune miku', index), 'hatsune_miku');
    assert.equal(resolveCharacterTag('2b (nier automata)', index), '2b_(nier:automata)', 'colon dropped by the list');
    assert.equal(resolveCharacterTag('abarai renji (bleach)', index), 'abarai_renji', 'a qualifier Danbooru does not use');
    assert.equal(resolveCharacterTag('aggron (pokemon)', index), 'aggron');
    assert.equal(resolveCharacterTag('nobody (pokemon)', index), null);
    assert.equal(normalizeTagKey("Girls' Frontline"), 'girlsfrontline');
    assert.deepEqual(splitQualifiers('artoria pendragon (swimsuit ruler) (fate)'), { base: 'artoria pendragon', qualifiers: ['swimsuit ruler', 'fate'] });
    assert.equal(toDanbooru('aglaea (honkai  star rail)'), 'aglaea_(honkai_star_rail)');
    assert.equal(toListForm('fate/grand_order'), 'fate/grand order');
});

test('a character keeps the works it shares at least a fifth of its posts with, the top one always', () => {
    const pairs = [
        { work: 'fate/stay_night', count: 10461 },
        { work: 'fate_(series)', count: 30844 },
        { work: 'fate/grand_order', count: 19910 },
        { work: 'fate/zero', count: 1454 },
    ];
    assert.deepEqual(chooseWorks(pairs, 30900), ['fate_(series)', 'fate/grand_order', 'fate/stay_night']);
    assert.deepEqual(chooseWorks(pairs, 30900, { maxWorks: 1 }), ['fate_(series)']);
    assert.deepEqual(chooseWorks([{ work: 'x', count: 5 }], 1000), ['x'], 'a rare pairing still names the top work');
    assert.deepEqual(chooseWorks([], 10), []);
});

test('characters unknown to the dump inherit the works of their qualifier siblings', () => {
    const assignments = new Map([
        ['acheron (honkai  star rail)', ['honkai:_star_rail', 'honkai_(series)']],
        ['kafka (honkai  star rail)', ['honkai_(series)', 'honkai:_star_rail']],
        ['seele (honkai  star rail)', ['honkai:_star_rail']],
        ['pikachu (pokemon)', ['pokemon']],
        ['solo character', ['whatever']],
    ]);
    const map = qualifierWorkMap(assignments);
    assert.deepEqual(map.get('honkaistarrail'), ['honkai:_star_rail', 'honkai_(series)']);
    assert.deepEqual(map.get('pokemon'), ['pokemon']);
    assert.equal(map.has(''), false);
});

test('the works table keeps a reviewed Japanese title and takes other names from the wiki cache', () => {
    const wiki = parseWikiCache([
        JSON.stringify({ found: true, name: 'kantai_collection', category: 3, wiki: { otherNames: ['艦これ', '艦隊これくしょん', ''] } }),
        JSON.stringify({ found: true, name: 'hatsune_miku', category: 4, wiki: { otherNames: ['初音ミク'] } }),
        'not json',
    ].join('\n'));
    assert.deepEqual([...wiki.keys()], ['kantai_collection']);
    const table = buildWorksTable(new Set(['kantai_collection', 'vocaloid']), wiki, {
        'kantai collection': { en: 'kantai collection', ja: '艦隊これくしょん' },
        vocaloid: { en: 'vocaloid', aliases: ['ボカロ'] },
    });
    assert.deepEqual(table['kantai collection'], { en: 'kantai collection', ja: '艦隊これくしょん', aliases: ['艦これ', '艦隊これくしょん'] });
    assert.deepEqual(table.vocaloid, { en: 'vocaloid', aliases: ['ボカロ'] }, 'previous aliases survive when the cache has none');
});

test('data/character_works.json covers the bundled character lists and names every work it references', () => {
    assert.equal(characterWorks.schemaVersion, 1);
    const listed = new Set();
    for (const file of fs.readdirSync(path.join(root, 'data')).filter(name => name.endsWith('_characters.csv'))) {
        for (const line of read(`data/${file}`).replace(/^﻿/, '').split('\n')) {
            const comma = line.indexOf(',');
            if (comma > 0) listed.add(line.slice(comma + 1).trim());
        }
    }
    const covered = [...listed].filter(tag => Array.isArray(characterWorks.characters[tag]) && characterWorks.characters[tag].length > 0);
    assert.ok(covered.length / listed.size >= 0.95, `${covered.length} of ${listed.size} characters have a work`);
    for (const [tag, works] of Object.entries(characterWorks.characters)) {
        for (const work of works) assert.ok(characterWorks.works[work], `${tag}: unknown work ${work}`);
    }
    assert.deepEqual(characterWorks.characters['hatsune miku'], ['vocaloid']);
    assert.ok(characterWorks.characters['kaga (kancolle)'].includes('kantai collection'));
    assert.ok(characterWorks.characters['artoria pendragon (fate)'].includes('fate/grand order'));
    assert.ok(characterWorks.works['kantai collection'].aliases.includes('艦これ'));
});

test('the picker finds a character by any name of its works and shows the works after the name', () => {
    const works = {
        characters: { 'kaga (kancolle)': ['kantai collection'], 'hatsune miku': ['vocaloid'] },
        works: {
            'kantai collection': { en: 'kantai collection', ja: '艦隊これくしょん', aliases: ['艦これ', '艦隊Collection', '칸코레'] },
            vocaloid: { en: 'vocaloid', aliases: ['ボカロ'] },
        },
    };
    assert.deepEqual(worksOf(works, 'kaga (kancolle)'), ['kantai collection']);
    assert.deepEqual(worksOf(works, 'nobody'), []);
    assert.equal(workTitle(works, 'kantai collection', 'ja-JP'), '艦隊これくしょん');
    assert.equal(workTitle(works, 'kantai collection', 'en-US'), 'kantai collection');
    assert.equal(workTitle(works, 'vocaloid', 'ja-JP'), 'vocaloid', 'no Japanese title yet: the tag');
    assert.deepEqual(characterWorkTitles(works, 'kaga (kancolle)', 'ja-JP'), ['艦隊これくしょん']);
    assert.deepEqual(characterWorkSearchTerms(works, 'kaga (kancolle)'), ['kantai collection', '艦隊これくしょん', '艦これ', '艦隊Collection', '칸코레']);

    const options = [
        { key: '加贺', value: 'kaga (kancolle)', label: '加賀（艦隊これくしょん）', category: 'character', attributes: [], keywords: () => characterWorkSearchTerms(works, 'kaga (kancolle)') },
        { key: '初音未来', value: 'hatsune miku', label: '初音ミク', category: 'character', attributes: [], keywords: characterWorkSearchTerms(works, 'hatsune miku') },
    ];
    const keys = query => filterSelectionOptions(options, { query }).map(option => option.value);
    assert.deepEqual(keys('艦これ'), ['kaga (kancolle)']);
    assert.deepEqual(keys('kantai 加賀'), ['kaga (kancolle)']);
    assert.deepEqual(keys('ボカロ'), ['hatsune miku']);
    assert.deepEqual(keys('칸코레'), ['kaga (kancolle)']);
    assert.deepEqual(keys('zelda'), []);
});

test('the official work titles reach the localizer under their own key and the works reach both renderers', () => {
    const cached = read('scripts/main/cachedFiles.js');
    assert.match(cached, /cachedCharacterNames\.officialWorkNames = officialWorkNames;/);
    assert.match(cached, /loadFileEx\('data', 'character_works\.json', cachedCharacterWorks\)/);
    assert.equal((cached.match(/characterWorks: cachedCharacterWorks,/g) ?? []).length, 3, 'ipc, getCachedFiles, getCachedFilesWithoutThumb');
    assert.match(read('scripts/renderer.js'), /characterWorks: cachedFiles\.characterWorks,/);
    const web = read('scripts/webserver/wsRenderer.js');
    assert.match(web, /characterNames: cachedFiles\.characterNames,/, 'the browser UI localizes names too');
    assert.match(web, /characterWorks: cachedFiles\.characterWorks,/);
    assert.equal(getLocalizedCharacterName({
        tag: 'kaga (kancolle)',
        language: 'ja-JP',
        characterNames: { 'ja-JP': { 'kaga (kancolle)': '加賀（kancolle）' }, officialWorkNames: { kancolle: '艦隊これくしょん' } },
    }), '加賀（艦隊これくしょん）');
});
