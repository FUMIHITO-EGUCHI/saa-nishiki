// A LoRA switched off takes its trigger words out of the positive rows and puts them back
// when it is switched on again (renderer/loraWordSwitch.js).
import assert from 'node:assert/strict';
import test from 'node:test';

import { putWordsBack, retakeWords, takeWordsOut } from '../scripts/renderer/loraWordSwitch.js';

test('switched off: the words leave every row they are in, weights and all, the rest as written', () => {
    const texts = { common: 'masterpiece, best quality', positive: '1girl, (charturn:1.2), solo, multiple_views', views: 'from side' };
    const { texts: next, taken } = takeWordsOut(texts, ['charturn', 'multiple views']);
    assert.deepEqual(next, { positive: '1girl, solo' }, 'only the row that changed, no comma left behind');
    assert.deepEqual(taken, [
        { id: 'positive', index: 1, token: '(charturn:1.2)', next: 'solo' },
        { id: 'positive', index: 3, token: 'multiple_views', next: '' },
    ]);
    assert.deepEqual(takeWordsOut(texts, []), { texts: {}, taken: [] });
    assert.deepEqual(takeWordsOut({ positive: 'charturn' }, ['charturn']).texts, { positive: '' });
});

test('switched on: each word back in front of the tag that followed it, or at the end', () => {
    const texts = { positive: '1girl, (charturn:1.2), solo, multiple_views' };
    const { texts: off, taken } = takeWordsOut(texts, ['charturn', 'multiple views']);
    assert.deepEqual(putWordsBack(off, taken), texts, 'as it was');

    // a tag added and one removed since: the word goes in front of the one it stood before
    assert.deepEqual(putWordsBack({ positive: 'solo, smile' }, taken), { positive: '(charturn:1.2), solo, smile, multiple_views' });
    // that one gone too: its old place
    assert.deepEqual(putWordsBack({ positive: 'a, b, c' }, taken), { positive: 'a, (charturn:1.2), b, c, multiple_views' });
    assert.deepEqual(putWordsBack({ positive: '' }, taken), { positive: '(charturn:1.2), multiple_views' });
});

test('a word written again since is not put back twice, and a row gone is skipped', () => {
    const { taken } = takeWordsOut({ positive: '1girl, charturn', common: 'charturn, masterpiece' }, ['charturn']);
    assert.equal(taken.length, 2);
    assert.deepEqual(putWordsBack({ positive: '1girl, charturn', common: 'masterpiece' }, taken), {}, 'typed in the Positive row again');
    assert.deepEqual(putWordsBack({ positive: '1girl' }, taken), { positive: '1girl, charturn' }, 'the Common row is not there');
});

test('a group holding the word is not taken apart, and the lines stay', () => {
    const texts = { positive: '(charturn, solo:1.1), smile\ncharturn' };
    const { texts: next, taken } = takeWordsOut(texts, ['charturn']);
    assert.deepEqual(next, { positive: '(charturn, solo:1.1), smile\n' });
    assert.deepEqual(putWordsBack(next, taken), texts);
});

test('Batch (Last): the last prompt loses the words taken out now and gets back the ones put back since', () => {
    const rows = { positive: '1girl, charturn, solo', common: 'masterpiece' };
    const { taken } = takeWordsOut(rows, ['charturn']);
    const last = 'masterpiece, 1girl, (charturn:1.1), solo, smile';
    assert.equal(retakeWords(last, [], taken), 'masterpiece, 1girl, solo, smile', 'switched off since the last run');
    assert.equal(retakeWords('masterpiece, 1girl, solo, smile', taken, []), 'masterpiece, 1girl, charturn, solo, smile', 'switched on since: in front of the tag it stood before');
    assert.equal(retakeWords('masterpiece, smile', taken, []), 'masterpiece, smile, charturn', 'that tag not in the prompt: at the end');
    assert.equal(retakeWords('1girl, solo', taken, taken), '1girl, solo', 'off then and now');
    assert.equal(retakeWords(last, [], []), last);
});
