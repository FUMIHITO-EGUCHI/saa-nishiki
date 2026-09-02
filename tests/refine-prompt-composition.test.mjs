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
    });
    assert.equal(logical.positive.includes('alice'), true, 'logical left remains unswapped');
});
