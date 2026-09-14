import test from 'node:test';
import assert from 'node:assert/strict';

import {
    applyRefinePlanWeights,
    composeNormalRefinePrompt,
    composeRegionalRefinePrompt,
    mapRegionalBackendPrompts,
} from '../scripts/renderer/tools/refinePromptComposition.js';

test('normal v2 fields are expanded before fixed context, exclude and slot LoRA are applied once', async () => {
    const result = await composeNormalRefinePrompt({
        editorFields: {
            common: 'masterpiece',
            positive: 'portrait, {day|night}',
            positiveRight: '',
            negative: 'worst quality',
        },
        fixedContext: {
            beforePrompts: 'json before, ',
            beforeCharacters: '',
            afterCharacters: '',
            afterPrompts: 'json after',
            views: 'city, ',
            characters: 'alice, ',
            characterNegative: 'extra arms',
            exclude: 'city',
            slotLora: '<lora:style:0.8>',
            seed: 42,
        },
        resolveComponent: async (value, seed) => value.replace('{day|night}', seed === 42 ? 'night' : 'day'),
    });

    assert.doesNotMatch(result.positive, /city/);
    assert.match(result.positive, /json before/);
    assert.match(result.positive, /masterpiece/);
    assert.match(result.positive, /alice/);
    assert.match(result.positive, /portrait, night/);
    assert.match(result.positive, /json after/);
    assert.equal(result.positive.match(/<lora:style:0\.8>/g)?.length, 1);
    assert.equal(result.negative, 'worst quality, extra arms');
});

test('planned weights are applied to raw editor fields without baking unrelated image values', () => {
    const result = applyRefinePlanWeights({
        common: 'masterpiece',
        positive: 'portrait, detailed eyes',
        positiveRight: 'full body',
        negative: 'worst quality',
    }, {
        'common/masterpiece#0': 1,
        'positive/detailed eyes#0': 1.2,
        'positive_right/full body#0': 0.9,
    });

    assert.equal(result.common, 'masterpiece');
    assert.equal(result.positive, 'portrait, (detailed eyes:1.20)');
    assert.equal(result.positiveRight, '(full body:0.90)');
    assert.equal(result.negative, 'worst quality');
});

test('regional composition keeps logical left/right, shares common, and adds slot LoRA once', async () => {
    const logical = await composeRegionalRefinePrompt({
        editorFields: {
            common: 'masterpiece',
            positive: 'left portrait',
            positiveRight: 'right full body',
            negative: '',
        },
        fixedContext: {
            left: { beforePrompts: '', beforeCharacters: '', characters: 'alice, ', afterCharacters: '', afterPrompts: '' },
            right: { beforePrompts: '', beforeCharacters: '', characters: 'bob, ', afterCharacters: '', afterPrompts: '' },
            views: 'outdoors, ',
            characterNegative: 'extra fingers',
            exclude: '',
            slotLora: '<lora:regional:1>',
            leftSeed: 10,
            rightSeed: 20,
        },
        resolveComponent: async value => value,
    });

    assert.match(logical.positive, /masterpiece.*alice.*left portrait/);
    assert.match(logical.positiveRight, /masterpiece.*bob.*right full body/);
    assert.match(logical.positive, /<lora:regional:1>/);
    assert.doesNotMatch(logical.positiveRight, /<lora:regional:1>/);
    assert.equal(logical.negative, 'extra fingers');

    assert.deepEqual(mapRegionalBackendPrompts(logical, true), {
        positiveLeft: logical.positiveRight,
        positiveRight: logical.positive,
        negative: logical.negative,
        negativeLeft: logical.negativeRight,
        negativeRight: logical.negativeLeft,
    });
    assert.equal(logical.positive.includes('alice'), true, 'logical left remains unswapped');
});

const REGIONAL_NEGATIVE_CONTEXT = Object.freeze({
    left: { characters: 'alice, ' },
    right: { characters: 'bob, ' },
    negative: {
        chains: {
            both: ['negative', 'neg_both'],
            left: ['negative', 'neg_both', 'negative_left', 'neg_left'],
            right: ['negative', 'neg_both', 'negative_right'],
        },
        texts: {
            negative: 'generated shared',
            neg_both: 'jpeg artifacts',
            negative_left: 'generated left',
            neg_left: 'left custom',
            negative_right: 'generated right',
        },
    },
    characterNegativeLeft: 'alice negative',
    characterNegativeRight: 'bob negative',
});

test('regional negatives are rebuilt per side around the units generation assembled', async () => {
    const logical = await composeRegionalRefinePrompt({
        editorFields: {
            common: '',
            positive: 'left',
            positiveRight: 'right',
            negative: 'worst quality',
            negativeLeft: 'harsh shadow',
            negativeRight: 'lens flare',
        },
        fixedContext: REGIONAL_NEGATIVE_CONTEXT,
        resolveComponent: async value => value,
    });

    assert.equal(logical.negativeLeft, 'worst quality, jpeg artifacts, harsh shadow, left custom, alice negative');
    assert.equal(logical.negativeRight, 'worst quality, jpeg artifacts, lens flare, bob negative');
    assert.equal(logical.negative, 'worst quality, jpeg artifacts, harsh shadow, left custom, lens flare, alice negative, bob negative');
});

test('a schema 2 answer leaves the generated side negatives in place', async () => {
    const logical = await composeRegionalRefinePrompt({
        editorFields: {
            common: '',
            positive: 'left',
            positiveRight: 'right',
            negative: 'worst quality',
            negativeLeft: null,
            negativeRight: null,
        },
        fixedContext: REGIONAL_NEGATIVE_CONTEXT,
        resolveComponent: async value => value,
    });

    assert.equal(logical.negativeLeft, 'worst quality, jpeg artifacts, generated left, left custom, alice negative');
    assert.equal(logical.negativeRight, 'worst quality, jpeg artifacts, generated right, bob negative');
});

test('without a negative chain every regional side falls back to one merged negative', async () => {
    const logical = await composeRegionalRefinePrompt({
        editorFields: { common: '', positive: 'left', positiveRight: 'right', negative: 'worst quality' },
        fixedContext: { left: {}, right: {}, characterNegative: 'extra fingers' },
        resolveComponent: async value => value,
    });

    assert.equal(logical.negative, 'worst quality, extra fingers');
    assert.equal(logical.negativeLeft, logical.negative);
    assert.equal(logical.negativeRight, logical.negative);
});

test('normal negative keeps the custom negative units around the edited Negative field', async () => {
    const result = await composeNormalRefinePrompt({
        editorFields: { common: '', positive: 'portrait', positiveRight: '', negative: 'worst quality' },
        fixedContext: {
            characters: 'alice, ',
            characterNegative: 'extra arms',
            negative: {
                chain: ['negative', 'neg_custom'],
                texts: { negative: 'generated shared', neg_custom: 'jpeg artifacts' },
            },
        },
        resolveComponent: async value => value,
    });

    assert.equal(result.negative, 'worst quality, jpeg artifacts, extra arms');
});
