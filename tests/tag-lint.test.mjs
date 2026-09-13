import assert from 'node:assert/strict';
import test from 'node:test';

import { classifyTag, lintKey, looksLikeSentence } from '../scripts/shared/tagLint.js';

test('lintKey maps a capsule value onto the dictionary key form', () => {
    assert.equal(lintKey('long hair'), 'long_hair');
    assert.equal(lintKey('  Wooden   Staff '), 'wooden_staff');
    assert.equal(lintKey('hatsune miku \\(vocaloid\\)'), 'hatsune_miku_(vocaloid)');
    assert.equal(lintKey('((masterpiece))'), 'masterpiece');
    assert.equal(lintKey("hand on another's head"), "hand_on_another's_head");
});

test('lintKey leaves tokens that are not tags alone', () => {
    for (const value of ['', '   ', 'BREAK', '<lora:detail:0.6>', '__hair_color__', '{red|blue} hair',
        '[cat:dog:10]', 'embedding:easynegative']) {
        assert.equal(lintKey(value), null, value);
    }
});

test('looksLikeSentence: four words or end punctuation, never an underscore tag', () => {
    assert.equal(looksLikeSentence('the girl pats her head'), true);
    assert.equal(looksLikeSentence('she waves.'), true);
    assert.equal(looksLikeSentence('long ancient staff'), false);
    assert.equal(looksLikeSentence('hand_on_another\'s_head_pat'), false);
});

test('classifyTag: known tags pass, unknown ones are marked, sentences are told apart', () => {
    const dictionary = new Set(['wooden_staff', 'hand_on_another\'s_head', 'staff']);
    const lookup = key => dictionary.has(key);
    assert.equal(classifyTag('wooden staff', lookup), 'known');
    assert.equal(classifyTag('long staff', lookup), 'unknown');
    assert.equal(classifyTag('ancient staff', lookup), 'unknown');
    // a real four-word tag is known, not a sentence
    assert.equal(classifyTag("hand on another's head", lookup), 'known');
    assert.equal(classifyTag('the girl on the left pats the head of the girl on the right', lookup), 'sentence');
    assert.equal(classifyTag('<lora:x:1>', lookup), 'skip');
    assert.equal(classifyTag('wooden staff', () => undefined), 'pending');
});
