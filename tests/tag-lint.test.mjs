import assert from 'node:assert/strict';
import test from 'node:test';

import { classifyTag, isModelVocabulary, lintKey, looksLikeSentence, SENTENCE_MIN_WORDS } from '../scripts/shared/tagLint.js';

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

test('classifyTag: quality, rating, date and score tags the checkpoints know are never marked', () => {
    const lookup = () => false;   // the Danbooru dictionary lists none of them
    // the default Positive / Negative prompts (settingsSections.js)
    for (const value of ['masterpiece', 'best quality', 'amazing quality', 'bad quality', 'worst quality', 'worst detail',
        '(very aesthetic:1.1)', 'newest', 'sensitive', 'score_9', 'score_8_up', 'rating_explicit', 'year 2024']) {
        assert.equal(classifyTag(value, lookup), 'known', value);
        assert.equal(isModelVocabulary(lintKey(value)), true, value);
    }
    // an ordinary word the dictionary lacks is still marked
    assert.equal(classifyTag('censor', lookup), 'unknown');
    assert.equal(isModelVocabulary('best_quality_ever'), false);
});

test('lintKey drops the weight of emphasis parentheses, whole or split by the comma', () => {
    assert.equal(lintKey('((long hair:1.3))'), 'long_hair');
    assert.equal(lintKey('(red hair'), 'red_hair');                 // "(red hair, blue eyes:1.2)" as two chips
    assert.equal(lintKey('blue eyes:1.2)'), 'blue_eyes');
    assert.equal(lintKey('blue eyes: .8)'), 'blue_eyes');
    assert.equal(lintKey('(hatsune miku \\(vocaloid\\):1.1)'), 'hatsune_miku_(vocaloid)');
    assert.equal(lintKey('hatsune miku \\(vocaloid\\):0.9)'), 'hatsune_miku_(vocaloid)');
    // tags that hold a colon keep it
    assert.equal(lintKey('4:3'), '4:3');
    assert.equal(lintKey('(16:9)'), '16:9');
    assert.equal(lintKey(':3'), ':3');
    assert.equal(lintKey('(:d)'), ':d');
    assert.equal(lintKey('blue eyes:1.2'), 'blue_eyes:1.2', 'no parentheses: not weight syntax, looked up as written');
});

test('a weighted group the chips keep whole is not looked up as one tag', async () => {
    const { parsePromptToCapsules } = await import('../scripts/renderer/components/tagCapsuleLogic.js');
    const values = parsePromptToCapsules('smile, (red hair, blue eyes:1.2)').map(capsule => capsule.value);
    assert.deepEqual(values, ['smile', 'red hair, blue eyes']);
    const group = values[1];
    assert.equal(lintKey(group), null);
    assert.equal(classifyTag(group, () => false), 'skip');
});

test('the model vocabulary patterns match a key whole, never a part of one', () => {
    for (const key of ['score_9', 'score_8_up', 'rating_general', 'rating_explicit', 'source_pony', 'source_furry', 'year_2024']) {
        assert.equal(isModelVocabulary(key), true, key);
    }
    for (const key of ['score_10', 'score_9_down', 'my_score_9', 'rating_awful', 'not_rating_explicit',
        'source_photo', 'sub_source_pony', 'year_24', 'year_20240', 'my_year_2024', '']) {
        assert.equal(isModelVocabulary(key), false, key);
    }
    assert.equal(isModelVocabulary(null), false);
    assert.equal(isModelVocabulary(undefined), false);
});

test('lintKey: an embedding is no tag whatever its case, and empty parentheses are nothing', () => {
    assert.equal(lintKey('Embedding:EasyNegative'), null);
    assert.equal(lintKey('EMBEDDING:bad-hands'), null);
    assert.equal(lintKey(null), null);
    assert.equal(lintKey(undefined), null);
    assert.equal(lintKey('()'), null);
    assert.equal(lintKey('(   )'), null);
});

test('looksLikeSentence: the word count is the threshold and end punctuation beats it', () => {
    assert.equal(SENTENCE_MIN_WORDS, 4);
    assert.equal(looksLikeSentence('a girl sits'), false, 'three words is still a phrase');
    assert.equal(looksLikeSentence('a girl sits down'), true, 'four words reads as a sentence');
    assert.equal(looksLikeSentence('stop!'), true);
    assert.equal(looksLikeSentence('why?'), true);
    assert.equal(looksLikeSentence('stop! now'), false, 'the mark has to end the value');
    assert.equal(looksLikeSentence('hatsune_miku_(vocaloid) sings a song.'), false, 'an underscore says tag, not sentence');
    assert.equal(looksLikeSentence(''), false);
    assert.equal(looksLikeSentence('   '), false);
    assert.equal(looksLikeSentence(null), false);
});

test('classifyTag asks the dictionary about real tags only', () => {
    const asked = [];
    const lookup = key => { asked.push(key); return false; };
    assert.equal(classifyTag('BREAK', lookup), 'skip');
    assert.equal(classifyTag('masterpiece', lookup), 'known', 'model vocabulary is never looked up');
    assert.deepEqual(asked, [], 'neither of them reached the dictionary');

    assert.equal(classifyTag('long staff', lookup), 'unknown');
    assert.deepEqual(asked, ['long_staff'], 'the dictionary key is what goes out, not the capsule value');
    assert.equal(classifyTag('the girl pats her head', lookup), 'sentence');
    assert.equal(classifyTag('the girl pats her head', () => true), 'known', 'a sentence the dictionary knows is a tag');
});

// ------------------------------------------------------------ renderer lookups (tagDictionaryStatus.js)
async function freshStatus(tag, lookup) {
    globalThis.inBrowser = false;
    globalThis.globalSettings = { api_model_type: 'Checkpoint' };
    globalThis.document ??= { dispatchEvent() {} };
    globalThis.api = { tagLookup: lookup };
    return import(`../scripts/renderer/components/tagDictionaryStatus.js?${tag}`);
}

async function waitFor(check, timeout = 2000) {
    const start = performance.now();
    while (!check()) {
        if (performance.now() - start > timeout) throw new Error('timed out');
        await new Promise(resolve => setTimeout(resolve, 10));
    }
}

test('dictionary status: a burst past the backend cap goes out in several lookups, none cut off', async () => {
    const calls = [];
    const status = await freshStatus('batch', async keys => {
        calls.push(keys.length);
        return { loaded: true, known: keys.filter(key => key.endsWith('0')) };
    });
    const values = Array.from({ length: status.LOOKUP_BATCH + 500 }, (_, index) => `tag ${index}`);
    for (const value of values) assert.equal(status.tagStatus(value), 'pending');
    await waitFor(() => values.every(value => status.tagStatus(value) !== 'pending'));
    assert.deepEqual(calls, [status.LOOKUP_BATCH, 500]);
    assert.equal(status.tagStatus('tag 2490'), 'known');
    assert.equal(status.tagStatus('tag 2499'), 'unknown', 'a key past the cap is answered, not assumed unknown');
});

test('dictionary status: a failed lookup pauses the marks, then tries again', async () => {
    let fail = true;
    let calls = 0;
    const status = await freshStatus('retry', async keys => {
        calls += 1;
        if (fail) throw new Error("No handler registered for 'tag-lookup'");
        return { loaded: true, known: keys };
    });
    const realNow = Date.now;
    let now = realNow();
    Date.now = () => now;
    try {
        assert.equal(status.tagStatus('long hair'), 'pending');
        await waitFor(() => status.tagStatus('long hair') === 'skip');
        assert.equal(calls, 1);
        fail = false;
        now += status.RETRY_AFTER_MS;
        assert.equal(status.tagStatus('long hair'), 'pending');
        await waitFor(() => status.tagStatus('long hair') === 'known');
        assert.equal(calls, 2);
    } finally {
        Date.now = realNow;
    }
});
