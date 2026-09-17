import assert from 'node:assert/strict';
import test from 'node:test';

import { parseArtistIndex, parseArtistRow } from '../scripts/shared/artistIndex.js';

test('only Danbooru artist rows are taken', () => {
    assert.equal(parseArtistRow('1girl,0,6008644,"1girls,sole_female"'), null, 'general');
    assert.equal(parseArtistRow('fuf,8,4977,'), null, 'e621 artist');
    assert.deepEqual(parseArtistRow('ebifurya,1,5924,'), { tag: 'ebifurya', heat: 5924, aliases: [] });
});

test('a quoted alias field may hold commas', () => {
    assert.deepEqual(
        parseArtistRow('ruu_(tksymkw),1,3891,"rakugakiyarou,tksymkw,tsurukou_(tksymkw)"'),
        { tag: 'ruu_(tksymkw)', heat: 3891, aliases: ['rakugakiyarou', 'tksymkw', 'tsurukou_(tksymkw)'] },
    );
    assert.deepEqual(parseArtistRow('hammer_(sunset_beach),1,5418,aenobas').aliases, ['aenobas']);
});

test('a broken row is skipped rather than thrown on', () => {
    assert.equal(parseArtistRow(''), null);
    assert.equal(parseArtistRow('no-commas'), null);
    assert.equal(parseArtistRow(',1,10,'), null, 'no tag');
    assert.equal(parseArtistRow('x,1,not-a-number,').heat, 0);
});

test('the whole file becomes the artist list', () => {
    const artists = parseArtistIndex([
        '1girl,0,6008644,"1girls,sole_female"',
        'ebifurya,1,5924,',
        '',
        'fuf,8,4977,',
        'wlop,1,365,wang_ling',
    ].join('\n'));
    assert.deepEqual(artists.map(artist => artist.tag), ['ebifurya', 'wlop']);
    assert.deepEqual(artists[1].aliases, ['wang_ling']);
});
