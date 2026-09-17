import assert from 'node:assert/strict';
import test from 'node:test';

import { parseArtistProfiles } from '../scripts/shared/artistProfiles.js';
import { flattenGroups, matchRange, rankArtists, searchKey } from '../scripts/shared/artistSearch.js';

const ARTISTS = [
    { tag: 'sakura_oriko', heat: 900, aliases: [] },
    { tag: 'sakurazawa_izumi', heat: 700, aliases: [] },
    { tag: 'horiguchi_yukiko', heat: 600, aliases: [] },
    { tag: 'ikari_manatsu', heat: 500, aliases: [] },
    { tag: 'ask_(askzy)', heat: 470, aliases: ['asukaziye'] },
    { tag: 'nnn_yryr', heat: 57, aliases: [] },
];

const PROFILES = parseArtistProfiles([
    'sakura_oriko\t1506\tcat_girl:28,cat_tail:29\toriginal:37',
    'horiguchi_yukiko\t978\tsakuragaoka_high_school_uniform:19,cover:21\tk-on!:44',
    'ikari_manatsu\t1172\tsakuragaoka_high_school_uniform:10,upper_body:47\tk-on!:37',
].join('\n'));

const options = extra => ({ artists: ARTISTS, profiles: PROFILES, ...extra });

test('a query is normalized the way danbooru spells a tag', () => {
    assert.equal(searchKey(' @Sakura Oriko '), 'sakura_oriko');
    assert.equal(searchKey('school uniform'), 'school_uniform');
    assert.equal(searchKey(''), '');
});

test('one query hits names and profile tags, names first', () => {
    const groups = rankArtists('sakura', options());
    assert.deepEqual(groups.map(group => group.group), ['name', 'tag']);
    assert.deepEqual(groups[0].entries.map(entry => entry.key), ['sakura_oriko', 'sakurazawa_izumi']);
    assert.deepEqual(groups[1].entries.map(entry => entry.key), ['horiguchi_yukiko', 'ikari_manatsu']);
});

test('a tag hit carries the tags that matched, strongest artist first', () => {
    const [, byTag] = rankArtists('sakura', options());
    const [first, second] = byTag.entries;
    assert.deepEqual(first.matchedTags, [{ tag: 'sakuragaoka_high_school_uniform', percent: 19 }]);
    assert.equal(second.key, 'ikari_manatsu', '10 % of their posts, so below the 19 % artist');
});

test('an artist is never listed twice: a name hit wins over its own tag hit', () => {
    const groups = rankArtists('cat', options());
    // sakura_oriko draws cat_girl but has no "cat" in the name
    assert.deepEqual(groups.map(group => group.group), ['tag']);
    assert.deepEqual(groups[0].entries.map(entry => entry.key), ['sakura_oriko']);
    assert.equal(flattenGroups(rankArtists('sakura_oriko', options())).length, 1);
});

test('name ranking prefers a prefix, then a word start, then anywhere, then an alias', () => {
    const artists = [
        { tag: 'moriko', heat: 10, aliases: [] },
        { tag: 'mahou_oriko_x', heat: 10, aliases: [] },
        { tag: 'oriko_sakura', heat: 10, aliases: [] },
        { tag: 'unrelated', heat: 10, aliases: ['oriko_alias'] },
    ];
    const ranked = flattenGroups(rankArtists('oriko', { artists })).map(entry => entry.key);
    assert.deepEqual(ranked, ['oriko_sakura', 'mahou_oriko_x', 'moriko', 'unrelated']);
});

test('an alias finds the artist', () => {
    const groups = rankArtists('asukaziye', options());
    assert.equal(groups[0].entries[0].key, 'ask_(askzy)');
});

test('spaces match the underscored spelling', () => {
    const groups = rankArtists('school uniform', options());
    assert.deepEqual(groups.map(group => group.group), ['tag']);
    assert.equal(groups[0].entries.length, 2);
});

test('an empty query opens on favourites, then recents, then the busiest', () => {
    const groups = rankArtists('', options({ favorites: ['nnn_yryr'], recent: ['@ask (askzy)'], limit: 2 }));
    assert.deepEqual(groups.map(group => group.group), ['favorite', 'recent', 'top']);
    assert.deepEqual(groups[0].entries.map(entry => entry.key), ['nnn_yryr']);
    assert.deepEqual(groups[1].entries.map(entry => entry.key), ['ask_(askzy)']);
    assert.deepEqual(groups[2].entries.map(entry => entry.key), ['sakura_oriko', 'sakurazawa_izumi']);
    assert.equal(groups[0].entries[0].favorite, true);
});

test('the profile rides along with every entry', () => {
    const [byName] = rankArtists('sakura_oriko', options());
    const entry = byName.entries[0];
    assert.equal(entry.posts, 1506);
    assert.deepEqual(entry.series, [{ tag: 'original', percent: 37 }]);
    assert.equal(entry.draws.length, 2);
});

test('an artist with no profile still shows up, with nothing to show', () => {
    const [byName] = rankArtists('nnn', options());
    assert.equal(byName.entries[0].posts, 0);
    assert.deepEqual(byName.entries[0].draws, []);
});

test('nothing matches means no groups at all', () => {
    assert.deepEqual(rankArtists('ciloranco', options()), []);
});

test('matchRange points at the part to highlight', () => {
    assert.deepEqual(matchRange('sakurazawa_izumi', 'sakura'), { start: 0, length: 6 });
    assert.deepEqual(matchRange('sakuragaoka high school uniform', 'school uniform'), { start: 17, length: 14 });
    assert.equal(matchRange('sakura_oriko', 'wlop'), null);
    assert.equal(matchRange('sakura_oriko', ''), null);
});
