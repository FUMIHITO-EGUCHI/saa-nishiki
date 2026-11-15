import assert from 'node:assert/strict';
import test from 'node:test';

import {
    appendTagsToText,
    parsePromptToCapsules,
    pasteCapsules,
    removeTagsFromText,
    serializeCapsules,
    transferCapsule,
} from '../scripts/renderer/components/tagCapsuleLogic.js';

test('transferCapsule moves a capsule with its weight plan and disabled state', () => {
    const source = parsePromptToCapsules('1girl, ~(long hair:1.20), smile');
    const target = parsePromptToCapsules('blue sky');
    const result = transferCapsule(source, target, source[1].id, { at: 0 });
    assert.equal(serializeCapsules(result.source), '1girl, smile');
    assert.equal(serializeCapsules(result.target), '~(long hair:1.20), blue sky');
    assert.equal(result.moved.value, 'long hair');
    assert.equal(result.moved.disabled, true);
    assert.equal(result.moved.weightPlan.min, 1.2);
    assert.equal(result.moved.id, result.target[0].id);
});

test('copy keeps the source untouched; unknown ids and out-of-range positions are tolerated', () => {
    const source = parsePromptToCapsules('a, b');
    const target = parsePromptToCapsules('c');
    const copied = transferCapsule(source, target, source[0].id, { copy: true, at: 99 });
    assert.equal(copied.source, source);
    assert.equal(serializeCapsules(copied.target), 'c, a');
    const missing = transferCapsule(source, target, 'nope#0');
    assert.equal(missing.moved, null);
    assert.equal(missing.source, source);
    assert.equal(missing.target, target);
});

test('duplicate names get fresh ordinals in the target', () => {
    const source = parsePromptToCapsules('smile');
    const target = parsePromptToCapsules('smile, hat');
    const result = transferCapsule(source, target, 'smile#0', { at: 2 });
    assert.deepEqual(result.target.map(c => c.id), ['smile#0', 'hat#0', 'smile#1']);
});

test('text-mode helpers append with a separator and remove the first matching token', () => {
    assert.equal(appendTagsToText('', ['a', 'b']), 'a, b');
    assert.equal(appendTagsToText('x, y, ', ['a']), 'x, y, a');
    assert.equal(appendTagsToText('x', []), 'x');
    assert.equal(removeTagsFromText('1girl, (long hair:1.2), smile', ['long hair']), '1girl, smile');
    assert.equal(removeTagsFromText('a, b\nc, ~b', ['b']), 'a\nc, ~b');
    assert.equal(removeTagsFromText('a, b', ['zzz']), 'a, b');
    assert.equal(removeTagsFromText('only', ['only']), '');
});

test('pasted tags keep their weight and disabled state, land at the place, and never double a tag', () => {
    const field = parsePromptToCapsules('1girl, smile, outdoors');
    const copied = parsePromptToCapsules('(blue eyes:1.2), ~hat, Smile');
    const { capsules, pasted } = pasteCapsules(field, copied, 1);
    assert.equal(serializeCapsules(capsules), '1girl, (blue eyes:1.20), ~hat, smile, outdoors');
    assert.deepEqual(pasted.map(capsule => capsule.value), ['blue eyes', 'hat']);
    assert.equal(new Set(capsules.map(capsule => capsule.id)).size, capsules.length, 'fresh ids');
    const again = pasteCapsules(capsules, copied, 0);
    assert.equal(again.capsules, capsules, 'nothing new: the field is unchanged');
    assert.deepEqual(again.pasted, []);
    assert.equal(serializeCapsules(pasteCapsules([], parsePromptToCapsules('a, b')).capsules), 'a, b', 'an empty field takes them at the end');
});
