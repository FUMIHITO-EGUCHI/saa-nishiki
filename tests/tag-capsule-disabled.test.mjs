import assert from 'node:assert/strict';
import test from 'node:test';

import {
    expandAll,
    parsePromptToCapsules,
    serializeCapsules,
    setAllCapsulesDisabled,
    stripDisabledTags,
    toggleCapsuleDisabled,
} from '../scripts/renderer/components/tagCapsuleLogic.js';

test('a leading ~ marks a capsule disabled and round-trips through the text', () => {
    const capsules = parsePromptToCapsules('1girl, ~long hair, ~(blue eyes:1.2), smile');
    assert.deepEqual(capsules.map(c => [c.value, c.disabled === true]), [
        ['1girl', false], ['long hair', true], ['blue eyes', true], ['smile', false],
    ]);
    assert.equal(capsules[2].weightPlan.min, 1.2);
    assert.equal(serializeCapsules(capsules), '1girl, ~long hair, ~(blue eyes:1.20), smile');
});

test('prompt-side serialization drops disabled capsules', () => {
    const capsules = parsePromptToCapsules('1girl, ~long hair, smile');
    assert.equal(serializeCapsules(capsules, { omitDisabled: true }), '1girl, smile');
});

test('toggle flips one capsule; setAll flips every capsule', () => {
    const capsules = parsePromptToCapsules('a, b, c');
    const toggled = toggleCapsuleDisabled(capsules, 1);
    assert.deepEqual(toggled.map(c => c.disabled === true), [false, true, false]);
    assert.deepEqual(toggleCapsuleDisabled(toggled, 1).map(c => c.disabled === true), [false, false, false]);
    assert.deepEqual(setAllCapsulesDisabled(capsules, true).map(c => c.disabled), [true, true, true]);
    assert.equal(toggleCapsuleDisabled(capsules, 9), capsules, 'out of range leaves the list alone');
});

test('stripDisabledTags removes ~tokens from plain field text and keeps the rest verbatim', () => {
    assert.equal(stripDisabledTags('1girl, ~long hair, (smile:1.1)'), '1girl, (smile:1.1)');
    assert.equal(stripDisabledTags('line one, ~x\n~y, line two'), 'line one\n line two');
    assert.equal(stripDisabledTags('no markers here'), 'no markers here');
    assert.equal(stripDisabledTags(''), '');
});

test('expandAll omits disabled capsules and expands custom fields under their own key', () => {
    const rows = expandAll([
        { key: 'positive', capsules: parsePromptToCapsules('1girl, ~hat') },
        { key: 'cf_abc', capsules: parsePromptToCapsules('~red, blue') },
    ], 0, 1);
    assert.equal(rows[0].fields.positive, '1girl');
    assert.equal(rows[0].fields.cf_abc, 'blue');
    assert.equal(rows[0].positive, '1girl');
});
