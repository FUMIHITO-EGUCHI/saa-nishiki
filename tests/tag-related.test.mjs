import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
    RELATED_SCORE_SCALE,
    familyMatches,
    familyWord,
    formatRelatedLine,
    jaccard,
    lookupKey,
    npmi,
    parseRelatedLine,
    promptTagForm,
    trimTop,
} from '../scripts/shared/tagRelated.js';
import { aliasKey } from '../scripts/shared/tagAliases.js';

const projectRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = relativePath => fs.readFileSync(path.join(projectRoot, relativePath), 'utf8');

test('lookupKey maps prompt spellings to dictionary keys', () => {
    assert.equal(lookupKey('Long Hair'), 'long_hair');
    assert.equal(lookupKey('(long hair:1.20)'), 'long_hair');
    assert.equal(lookupKey('~blue  eyes'), 'blue_eyes');
    assert.equal(lookupKey(''), '');
});

test('one tag, one key: underscores, spaces, case and prompt escapes all name the same tag', () => {
    const key = lookupKey('1990s_(style)');
    for (const spelling of ['1990s (style)', String.raw`1990s \(style\)`, String.raw`(1990s \(style\):1.2)`, String.raw`~1990S  \(Style\)`]) {
        assert.equal(lookupKey(spelling), key, spelling);
    }
    assert.equal(lookupKey('long_hair'), lookupKey('long hair'));
    assert.equal(familyWord(String.raw`1990s \(style\)`), '(style)', 'an escaped chip finds its family too');
    // aliasKey (the popover's translation line) agrees
    assert.equal(aliasKey(String.raw`1990s \(style\)`), '1990s_(style)');
    assert.equal(aliasKey('long hair'), 'long_hair');
});

test('the Related tab marks a tag present in any spelling and inserts the autocomplete form', () => {
    // presence as weightPopover.js checks it: the field's values and the suggestion through lookupKey
    const presentIn = (values, tag) => new Set(values.map(lookupKey)).has(lookupKey(tag));
    assert.equal(presentIn(['long_hair'], 'long_hair'), true, 'underscored chip');
    assert.equal(presentIn(['Long Hair'], 'long_hair'), true, 'spaced, other case');
    assert.equal(presentIn([String.raw`1990s \(style\)`], '1990s_(style)'), true, 'escaped chip');
    assert.equal(presentIn(['long hair'], 'very_long_hair'), false);
    const popover = read('scripts/renderer/components/weightPopover.js');
    assert.match(popover, /const present = new Set\(\[\.\.\.\(typeof session\?\.presentTags === 'function' \? session\.presentTags\(\) : \[\]\)\]\.map\(lookupKey\)\);/);
    assert.match(popover, /const known = present\.has\(lookupKey\(item\.tag\)\);/);
    assert.match(popover, /button\.dataset\.value = promptTagForm\(item\.tag\);/);
    assert.match(popover, /const tag = button\.dataset\.value;/, 'a click writes the prompt form');

    // the prompt form is exactly what the autocomplete inserts (formatSuggestion, not exported)
    const autoComplete = read('scripts/renderer/tagAutoComplete.js');
    const body = /function formatSuggestion\(suggestion\) \{([\s\S]*?)\n\}/.exec(autoComplete);
    assert.ok(body, 'formatSuggestion found');
    const formatSuggestion = new Function('suggestion', body[1]);
    for (const tag of ['1990s_(style)', 'long_hair', 'hatsune_miku_(cosplay)', ':d', '__my_wildcard__', String.raw`\m/`, '^_^']) {
        assert.equal(promptTagForm(tag), formatSuggestion(tag), tag);
    }
    assert.equal(promptTagForm('1990s_(style)'), String.raw`1990s \(style\)`);
});

test('familyWord is the last underscore part', () => {
    assert.equal(familyWord('long_hair'), 'hair');
    assert.equal(familyWord('very long hair'), 'hair');
    assert.equal(familyWord('smile'), 'smile');
    assert.equal(familyWord(''), '');
});

test('npmi rewards specific pairs over mega tags', () => {
    const total = 1_000_000;
    // "very_long_hair" (20k posts) appears almost only with long_hair (300k)
    const specific = npmi(300_000, 20_000, 19_000, total);
    // "1girl" (600k) co-occurs with long_hair a lot, but only in proportion to its size
    const generic = npmi(300_000, 600_000, 200_000, total);
    assert.ok(specific > generic, `${specific} > ${generic}`);
    assert.ok(specific > 0 && specific <= 1);
    assert.equal(npmi(10, 10, 0, total), 0);
    assert.equal(npmi(0, 10, 5, total), 0);
    assert.ok(Math.abs(npmi(100, 100, 10, total) - npmi(100, 100, 10, total)) < 1e-12);
});

test('jaccard and the line format round-trip', () => {
    assert.equal(jaccard(100, 50, 25), 25 / 125);
    assert.equal(jaccard(0, 0, 0), 0);
    const line = formatRelatedLine('long_hair', [{ tag: 'very_long_hair', score: 212.4 }, { tag: 'blue_hair', score: 90 }]);
    assert.equal(line, 'long_hair\tvery_long_hair:212 blue_hair:90');
    assert.deepEqual(parseRelatedLine(line), { tag: 'long_hair', related: [{ tag: 'very_long_hair', score: 212 }, { tag: 'blue_hair', score: 90 }] });
    assert.equal(parseRelatedLine('no tab here'), null);
    assert.deepEqual(parseRelatedLine('x\t'), { tag: 'x', related: [] });
});

test('familyMatches finds whole-word matches from the autocomplete list, most used first', () => {
    const candidates = [
        { prompt: 'hair_ornament', group: 0, heat: 900 },
        { prompt: 'long_hair', group: 0, heat: 5000 },
        { prompt: 'hairband', group: 0, heat: 800 },   // substring only
        { prompt: 'blue_hair', group: 4, heat: 700 },  // wrong group
        { prompt: 'hair', group: 0, heat: 10 },
    ];
    const matches = familyMatches('hair', candidates, { limit: 5, exclude: new Set(['hair']), allowGroups: new Set([0]) });
    assert.deepEqual(matches.map(m => m.tag), ['long_hair', 'hair_ornament']);
    assert.deepEqual(familyMatches('', candidates), []);
});

test('trimTop keeps the strongest entries', () => {
    const entries = [{ tag: 'a', score: 1 }, { tag: 'b', score: 9 }, { tag: 'c', score: 5 }];
    assert.deepEqual(trimTop(entries, 2).map(e => e.tag), ['b', 'c']);
});

test('the shipped dictionary parses and carries hair modifiers for long_hair', () => {
    const dictionary = path.join(projectRoot, 'data', 'tag_related.txt');
    assert.ok(fs.existsSync(dictionary), 'data/tag_related.txt is generated by scripts/buildTagRelated.mjs');
    const text = fs.readFileSync(dictionary, 'utf8');
    const line = text.split('\n').find(candidate => candidate.startsWith('long_hair\t'));
    assert.ok(line, 'long_hair has an entry');
    const parsed = parseRelatedLine(line);
    assert.ok(parsed.related.length >= 5);
    assert.ok(parsed.related.some(entry => entry.tag.endsWith('_hair')), 'a hair modifier shows up among the neighbours');
    for (let i = 1; i < parsed.related.length; i++) assert.ok(parsed.related[i - 1].score >= parsed.related[i].score, 'sorted by score');
});

test('renderer, preload, web socket API and main process are wired for related tags', () => {
    assert.match(read('scripts/preload.js'), /tagRelated: async \(tag, options\) => ipcRenderer\.invoke\('tag-related', tag, options\)/);
    assert.match(read('scripts/webserver/back/wsService.js'), /'tagRelated': \(params = \[\]\)=> getRelatedTags\(\.\.\.params\)/);
    assert.match(read('main.js'), /setupTagRelatedBackend\(\)/);
    assert.match(read('scripts/renderer.js'), /fetchRelated: value => fetchRelatedTags\(value\)/);
    // related tags live in the chip popover's Related tab; the field only opens it there
    const field = read('scripts/renderer/components/tagCapsuleField.js');
    assert.doesNotMatch(field, /tag-capsule-suggest-chip|tag-capsule-suggest-body|scheduleSuggestions\(/, 'no in-field panel, nothing opens on chip focus');
    assert.match(field, /function openRelated\(index\)/);
    assert.match(field, /openPopover\(at, \{ tab: 'related' \}\)/, 'the spark button, Ctrl+R and the context menu all open the popover on Related');
    assert.match(field, /showRelated: id =>[\s\S]*?openRelated\(index\)/);
    assert.match(field, /event\.key\.toLowerCase\(\) === 'r'\) \{\s*event\.preventDefault\(\);\s*if \(!onAdd\) openRelated\(focusIndex\);/, 'Ctrl+R opens it for the focused chip and never reaches Reload, the add slot included');
    assert.match(read('scripts/renderer/components/weightPopover.js'), /String\(event\.key\)\.toLowerCase\(\) === 'r'\) \{\s*event\.preventDefault\(\);/, 'Ctrl+R inside the popover is consumed too');
    assert.match(field, /fetchRelated: typeof fetchRelated === 'function' \? fetchRelated : null,/, 'the field hands the popover the loader');
    assert.match(field, /onPick: \(tag, \{ replace = false \} = \{\}\) =>/, 'click adds, Shift+click replaces');
    const popover = read('scripts/renderer/components/weightPopover.js');
    assert.match(popover, /relatedTab\.dataset\.tab = 'related'/);
    assert.match(popover, /tag-weight-related-chip/);
    assert.match(popover, /button\.classList\.toggle\('is-present', known\)/, 'tags already in the field are marked and inert');
    assert.match(popover, /const replace = event\.shiftKey;/);
    assert.match(popover, /let lastTabKind = 'weight';/, 'the tab kind is remembered for the next open');
    assert.match(popover, /aliasFor\(tag\)/, 'each suggestion carries its translation');
    for (const file of ['html/index_dark.css', 'html/index_light.css']) {
        const css = read(file);
        assert.match(css, /\.tag-weight-related \{[^}]*max-height: 220px;/, `${file}: the Related tab scrolls inside the popover`);
        assert.match(css, /\.tag-weight-related-chip\.is-present \{/, `${file}: present tags dimmed`);
        assert.doesNotMatch(css, /\.tag-capsule-suggest \{/, `${file}: the old in-field panel is gone`);
    }
    const language = JSON.parse(read('data/language.json'));
    for (const key of ['tag_ui_related_title', 'tag_ui_related_cooccur', 'tag_ui_related_family', 'tag_ui_related_none', 'tag_ui_related_toggle', 'tag_ui_tab_related', 'tag_ui_related_hint']) {
        assert.equal(typeof language['en-US'][key], 'string', `${key} en`);
        assert.equal(typeof language['zh-CN'][key], 'string', `${key} zh`);
    }
    assert.match(read('data/THIRD_PARTY_NOTICES.md'), /SpadeA\/danbooru-tag-csv/);
});

test('a pair that always appears together tops the list instead of breaking it', () => {
    // both tags on every post: the normalized PMI is 1 by definition, and a division by
    // log(1) would put Infinity or NaN where the strongest neighbour should be
    assert.equal(npmi(100, 100, 100, 100), 1);
    assert.equal(npmi(10, 10, 20, 10), 1, 'counts that overshoot the corpus still land on 1');
    const neighbours = [
        { tag: '1girl', score: npmi(300_000, 600_000, 200_000, 1_000_000) },
        { tag: 'inseparable', score: npmi(100, 100, 100, 100) },
        { tag: 'very_long_hair', score: npmi(300_000, 20_000, 19_000, 1_000_000) },
    ].sort((a, b) => b.score - a.score);
    assert.deepEqual(neighbours.map(entry => entry.tag), ['inseparable', 'very_long_hair', '1girl']);
});

test('a dictionary score is the normalized PMI per mille', () => {
    // scripts/buildTagRelated.mjs writes Math.round(npmi * RELATED_SCORE_SCALE)
    const score = (a, b, both, total) => Math.round(npmi(a, b, both, total) * RELATED_SCORE_SCALE);
    assert.equal(score(100, 100, 100, 1000), 1000, 'tags that only appear together sit at the top of the scale');
    assert.equal(score(300_000, 20_000, 19_000, 1_000_000), 291);
    assert.equal(
        formatRelatedLine('long_hair', [{ tag: 'very_long_hair', score: npmi(300_000, 20_000, 19_000, 1_000_000) * RELATED_SCORE_SCALE }]),
        'long_hair\tvery_long_hair:291',
    );
});

test('familyMatches keeps twenty tags unless the caller asks for another number', () => {
    const candidates = Array.from({ length: 25 }, (_, index) => ({ prompt: `hair_${index}`, group: 0, heat: 1000 - index }));
    const matches = familyMatches('hair', candidates);
    assert.equal(matches.length, 20);
    assert.equal(matches.at(-1).tag, 'hair_19', 'the twentieth by use, and nothing below it');
    assert.equal(familyMatches('hair', candidates, { limit: 3 }).length, 3);
    assert.equal(familyMatches('hair', candidates, { limit: 0 }).length, 0);
});

test('trimTop leaves a list that still fits exactly as it is', () => {
    const entries = [{ tag: 'a', score: 1 }, { tag: 'b', score: 9 }];
    const kept = trimTop(entries, 5);
    assert.equal(kept.length, 2, 'never padded out to the limit');
    assert.deepEqual(kept.map(entry => entry.tag), ['a', 'b'], 'and not sorted while there is room');
    assert.deepEqual(trimTop(entries, 2).map(entry => entry.tag), ['a', 'b'], 'a list exactly at the limit still fits');
    assert.deepEqual(trimTop([...entries, { tag: 'c', score: 5 }], 2).map(entry => entry.tag), ['b', 'c'], 'one too many, so the weakest goes');
});

test('a dictionary saved with CRLF parses like any other', () => {
    const [first] = 'long_hair\tvery_long_hair:212 blue_hair:90\r\nshort_hair\tbob_cut:180\r\n'.split('\n');
    assert.deepEqual(parseRelatedLine(first), { tag: 'long_hair', related: [{ tag: 'very_long_hair', score: 212 }, { tag: 'blue_hair', score: 90 }] });
});
