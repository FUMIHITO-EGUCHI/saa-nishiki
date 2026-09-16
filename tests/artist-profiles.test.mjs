import assert from 'node:assert/strict';
import test from 'node:test';

import {
    formatArtistProfileLine,
    parseArtistProfileLine,
    parseArtistProfiles,
    profileKey,
    profileLift,
} from '../scripts/shared/artistProfiles.js';

test('a prompt spelling becomes the profile key', () => {
    assert.equal(profileKey('@ciloranko'), 'ciloranko');
    assert.equal(profileKey('hammer (sunset beach)'), 'hammer_(sunset_beach)');
    assert.equal(profileKey('  @Ask (askzy) '), 'ask_(askzy)');
    assert.equal(profileKey(''), '');
    assert.equal(profileKey(null), '');
});

test('lift compares the artist rate with the site rate', () => {
    // 40 % of this artist's posts, 20 % of the site → twice as often.
    assert.equal(profileLift(0.4, 2_000_000, 10_000_000), 2);
    assert.equal(profileLift(0.2, 2_000_000, 10_000_000), 1);
    assert.equal(profileLift(0, 2_000_000, 10_000_000), 0, 'never used → no lift');
    assert.equal(profileLift(0.4, 0, 10_000_000), 0, 'unknown tag count → no lift');
    assert.equal(profileLift(0.4, 2_000_000, 0), 0, 'unknown site size → no lift');
});

test('a profile survives a format and parse round trip', () => {
    const line = formatArtistProfileLine({
        artist: 'ciloranko',
        posts: 252,
        draws: [{ tag: 'dress', percent: 42.1 }, { tag: 'white_dress', percent: 14.3 }],
        series: [{ tag: 'arknights', percent: 21 }],
    });
    assert.equal(line, 'ciloranko\t252\tdress:42,white_dress:14\tarknights:21');

    const parsed = parseArtistProfileLine(line);
    assert.equal(parsed.artist, 'ciloranko');
    assert.equal(parsed.posts, 252);
    assert.deepEqual(parsed.draws, [{ tag: 'dress', percent: 42 }, { tag: 'white_dress', percent: 14 }]);
    assert.deepEqual(parsed.series, [{ tag: 'arknights', percent: 21 }]);
});

test('an artist with no tags above the threshold keeps its line', () => {
    const line = formatArtistProfileLine({ artist: 'kaska', posts: 18 });
    assert.equal(line, 'kaska\t18\t\t');
    const parsed = parseArtistProfileLine(line);
    assert.deepEqual(parsed, { artist: 'kaska', posts: 18, draws: [], series: [] });
});

test('a tag holding a colon keeps its name', () => {
    const parsed = parseArtistProfileLine('x\t10\t:>:8,:d:33\t');
    assert.deepEqual(parsed.draws, [{ tag: ':>', percent: 8 }, { tag: ':d', percent: 33 }]);
});

test('bad lines are skipped, not thrown on', () => {
    assert.equal(parseArtistProfileLine(''), null);
    assert.equal(parseArtistProfileLine('no-tab-here'), null);
    assert.equal(parseArtistProfileLine('\t12\ta:1\t'), null, 'no artist name');
    assert.equal(parseArtistProfileLine('x\tnot-a-number\ta:1\t').posts, 0);
});

test('the whole file becomes a map keyed by the prompt spelling', () => {
    const profiles = parseArtistProfiles([
        'ciloranko\t252\tdress:42\tarknights:21',
        '',
        'broken line without a tab',
        'hammer_(sunset_beach)\t5627\that:38\ttouhou:89',
    ].join('\n'));
    assert.equal(profiles.size, 2);
    assert.equal(profiles.get(profileKey('@hammer (sunset beach)')).series[0].tag, 'touhou');
    assert.equal(profiles.get('ciloranko').draws[0].percent, 42);
});
