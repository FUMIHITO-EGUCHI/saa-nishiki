import test from 'node:test';
import assert from 'node:assert/strict';

import {
    applyRefinePlanWeights,
    composeNormalRefinePrompt,
    composeRegionalRefinePrompt,
    mapRegionalBackendPrompts,
    ownedRefineEditorFields,
    splitLegacyRegionalNegative,
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

test('a field Refine does not own keeps what generation made of it', async () => {
    const owned = ownedRefineEditorFields({
        common: 'masterpiece, ~signature',
        positive: 'portrait',
        positiveRight: '',
        negative: 'worst quality, ~bad hands',
        negativeLeft: 'muted text',
        negativeRight: null,
    }, ['common', 'negativeLeft']);
    assert.deepEqual(owned, {
        common: null,
        positive: 'portrait',
        positiveRight: '',
        negative: 'worst quality',
        negativeLeft: null,
        negativeRight: null,
    });
    assert.deepEqual(applyRefinePlanWeights(owned, { 'negative/worst quality#0': 1.2 }), {
        common: null,
        positive: 'portrait',
        positiveRight: '',
        negative: '(worst quality:1.20)',
        negativeLeft: null,
        negativeRight: null,
    });

    // muted Common and Negative: generation sent nothing for them, and Refine sends nothing either
    const normal = await composeNormalRefinePrompt({
        editorFields: ownedRefineEditorFields({ common: 'muted common', positive: 'portrait', negative: 'muted negative' }, ['common', 'negative']),
        fixedContext: {
            chain: [{ id: 'common', text: '' }, { id: 'characters', text: 'alice, ' }, { id: 'positive', text: 'old' }],
            characterNegative: 'extra arms',
            negative: { chain: ['negative', 'neg_custom'], texts: { negative: '', neg_custom: 'jpeg artifacts' } },
        },
    });
    assert.equal(normal.positive, 'alice, portrait');
    assert.equal(normal.negative, 'jpeg artifacts, extra arms');

    // a muted Negative (left): the left side keeps generation's empty unit
    const regional = await composeRegionalRefinePrompt({
        editorFields: ownedRefineEditorFields({
            common: '', positive: 'left', positiveRight: 'right', negative: 'worst quality', negativeLeft: 'muted left', negativeRight: 'lens flare',
        }, ['negativeLeft']),
        fixedContext: {
            ...REGIONAL_NEGATIVE_CONTEXT,
            negative: { ...REGIONAL_NEGATIVE_CONTEXT.negative, texts: { ...REGIONAL_NEGATIVE_CONTEXT.negative.texts, negative_left: '' } },
        },
    });
    assert.equal(regional.negativeLeft, 'worst quality, jpeg artifacts, left custom, alice negative');
    assert.equal(regional.negativeRight, 'worst quality, jpeg artifacts, lens flare, bob negative');
});

test('the normal negative keeps the Artist signature guard generation added', async () => {
    const result = await composeNormalRefinePrompt({
        editorFields: { common: '', positive: 'portrait', negative: 'worst quality' },
        fixedContext: {
            chain: [{ id: 'positive', text: 'portrait' }],
            characterNegative: 'extra arms',
            negative: { chain: ['negative'], texts: { negative: 'old' }, extra: 'artist name, signature, watermark' },
        },
    });
    assert.equal(result.negative, 'worst quality, extra arms, artist name, signature, watermark');
});

test('a legacy negative reaches each Regional side without the other side\'s own tags', () => {
    const context = {
        negative: {
            chains: { both: ['negative'], left: ['negative', 'negative_left'], right: ['negative', 'negative_right'] },
            texts: { negative: 'lowres', negative_left: 'hat', negative_right: 'glasses' },
        },
        characterNegativeLeft: 'ponytail',
        characterNegativeRight: 'beard',
    };
    assert.deepEqual(splitLegacyRegionalNegative('lowres, (hat:1.2), glasses, ponytail, beard, bad hands', context), {
        left: 'lowres, (hat:1.2), ponytail, bad hands',
        right: 'lowres, glasses, beard, bad hands',
    });
    // a tag generation gave both sides stays on both
    assert.deepEqual(splitLegacyRegionalNegative('lowres, Hat', {
        ...context,
        negative: { ...context.negative, texts: { ...context.negative.texts, negative_right: 'hat' } },
    }), { left: 'lowres, Hat', right: 'lowres, Hat' });
    // without the generated units both sides take it whole
    assert.deepEqual(splitLegacyRegionalNegative('lowres, hat', {}), { left: 'lowres, hat', right: 'lowres, hat' });
    assert.deepEqual(splitLegacyRegionalNegative('lowres, hat', null), { left: 'lowres, hat', right: 'lowres, hat' });
});
test('a Regional side is recomposed as one line, exactly as generation sends it', async () => {
    // a unit may hold a newline (a JSON slot, an original character, a custom field);
    // generation flattens each region through singleLinePrompt before Exclude runs
    const logical = await composeRegionalRefinePrompt({
        editorFields: { common: 'masterpiece', positive: 'left portrait', positiveRight: 'right full body', negative: '' },
        fixedContext: {
            left: {
                chain: [
                    { id: 'common', text: 'old common, ' },
                    { id: 'characters', text: 'alice,\nblue dress' },
                    { id: 'positive', text: 'old left' },
                ],
            },
            right: { chain: [{ id: 'positive_right', text: 'old right' }] },
            exclude: 'blue dress',
            slotLora: '<lora:regional:1>',
        },
        resolveComponent: async value => value,
    });

    const [sideText, loraLine] = logical.positive.split('\n');
    assert.equal(sideText, 'masterpiece, alice, left portrait', 'the newline separates tags, and Exclude still sees them');
    assert.equal(loraLine, '<lora:regional:1>', 'the slot LoRA keeps its own line, as in generation');
    assert.equal(logical.positiveRight, 'right full body');
});
