import test from 'node:test';
import assert from 'node:assert/strict';

import { appendPromptEnd, forgeCoupleMapping, forgeCouplePrompt, regionalRatio, singleLinePrompt } from '../scripts/shared/regionalGeneration.js';
import { migrateSlotSides, regionalSlots } from '../scripts/shared/characterSides.js';
import { rememberPrompts } from '../scripts/shared/modelTypePrompts.js';
import { jsonSlotFragment } from '../scripts/shared/jsonSlotPrompt.js';
import { expandAll, parsePromptToCapsules } from '../scripts/renderer/components/tagCapsuleLogic.js';
import { chainFromSettings } from '../scripts/renderer/components/tagCapsuleField.js';
import { beginImageOverride, endImageOverride, planBatchExpansion } from '../scripts/renderer/tools/promptBatchExpansion.js';
import { resolveQueuedAiPrompt } from '../scripts/renderer/tools/refineGenerationResult.js';
import { createPrompt, createRegional, getPrompts } from '../scripts/renderer/generate_regional.js';
import { adoptRegionalCharacters, applyPromptsForModelType, callback_myCharacterList_updateThumb, syncRegionalCharacters } from '../scripts/renderer/callbacks.js';

// ---------------------------------------------------------------- stubs

const PROMPT_KEYS = ['common', 'positive', 'positive_right', 'negative', 'negative_left', 'negative_right', 'background', 'style', 'exclude'];

// the renderer globals getPrompts reads: prompt fields, JSON slots, LoRA slots
function stubPromptCard({ fields = {}, jsonRows = [], settings = {} } = {}) {
    globalThis.globalSettings = { css_style: 'dark', api_model_type: 'Checkpoint', regional_condition: true, prompt_custom_fields: [], ...settings };
    globalThis.prompt = Object.fromEntries(PROMPT_KEYS.map(key => [key, { getValue: () => fields[key] ?? '' }]));
    globalThis.jsonlist = { getValues: () => jsonRows };
    globalThis.lora = { getValues: () => [] };
}

// the hidden regional Left / Right list (myRegionalCharacterList) as generate_regional.js reads it
function stubRegionalList() {
    const keys = ['None', 'None'];
    const weights = [1, 1];
    return {
        updateDefaults(left, right) { keys[0] = left || 'None'; keys[1] = right || 'None'; },
        getKey: () => [...keys],
        setTextValue(index, value) { weights[index] = Number.parseFloat(value) || 1; },
        getTextValue: index => weights[index],
    };
}

// the Characters card (myVariableCharacterList) holding its own copy of the slots
function stubCharacterList(settings) {
    let slots = structuredClone(settings.character_slots);
    return {
        setSlots(next) { slots = structuredClone(next); },
        getSlots: () => structuredClone(slots),
        // a pick in the card: callback_myCharacterList_updateThumb's settings part
        edit(next) { slots = structuredClone(next); settings.character_slots = structuredClone(slots); syncRegionalCharacters(); },
    };
}

// Mira's CreateTillingPNGMask reading of Layout "a,b,c": three strips in that proportion;
// PngRectanglesToMask takes strips 0 + 1 for the first region and 1 + 2 for the second
function comfyRegions(layout) {
    const [a, b, c] = layout.split(',').map(Number);
    const total = a + b + c;
    return [[0, (a + b) / total], [a / total, 1]];
}

// ---------------------------------------------------------------- prompt text

test('a newline in a regional prompt separates tags instead of gluing them', () => {
    assert.equal(singleLinePrompt('1girl\nsmile'), '1girl, smile');
    assert.equal(singleLinePrompt('a,\n\n , b'), 'a, b', 'separators around the newline collapse into one');
    assert.equal(singleLinePrompt('\n a, b \n'), 'a, b', 'newlines at either end go away');
    assert.equal(singleLinePrompt('x\r\ny'), 'x, y');
    assert.equal(singleLinePrompt('[color=red]a\nb[/color]'), '[color=red]a, b[/color]');
    assert.equal(singleLinePrompt('a, b, '), 'a, b, ', 'a prompt without a newline is left exactly as it was');
    assert.equal(singleLinePrompt(undefined), '');
});

test('an end-of-prompt fragment follows the side text with one separator', () => {
    assert.equal(appendPromptEnd('smile, outdoors', 'red dress, '), 'smile, outdoors, red dress, ');
    assert.equal(appendPromptEnd('', 'red dress, '), 'red dress, ');
    assert.equal(appendPromptEnd('smile', ''), 'smile');
    assert.equal(appendPromptEnd('smile,', 'red dress'), 'smile, red dress');
    assert.equal(appendPromptEnd('[color=red]smile[/color]', 'red dress, '), '[color=red]smile[/color], red dress, ');
});

test('the regional generator separates JSON slots and newlines like the standard path', () => {
    stubPromptCard({
        fields: { common: 'masterpiece', positive: '1girl\nsmile, outdoors', positive_right: 'sad' },
        jsonRows: [
            ['best quality', '1.0', 'Both', 'BOP'],
            ['red dress', '1', 'Left', 'EOP'],
            ['', '1', 'Right', 'EOP'],          // a blank slot adds nothing
            ['blue coat', '0.8', 'Right', 'EOP'],
            [null, '1', 'Both', 'BOC'],          // an entry the JSON does not carry
            [],                                  // a row whose controls are not built yet
            ['glasses', '1', 'Both', 'Off'],
        ],
    });
    const { posL, posR, posLc } = getPrompts('(hatsune miku:1.2), ', 'kagamine rin, ', '', '', 'ComfyUI', -1, 1);
    assert.equal(posL, 'best quality, masterpiece, (hatsune miku:1.2), 1girl, smile, outdoors, red dress, ');
    assert.equal(posR, 'best quality, masterpiece, kagamine rin, sad, (blue coat:0.8), ');
    assert.doesNotMatch(posLc, /outdoors(\[\/color\])?red dress/, 'the info panel copy is separated too');
    assert.doesNotMatch(posLc, /\n/);
});

test('without characters, JSON slots or views the regional prompt is what the Final preview shows', () => {
    const fields = { common: 'masterpiece\nbest quality', positive: '1girl\nsmile', positive_right: 'sad,\nrain' };
    const settings = { regional_condition: true, api_model_type: 'Checkpoint', prompt_custom_fields: [] };
    stubPromptCard({ fields, settings });
    const { posL, posR } = getPrompts('', '', '', '', 'ComfyUI', -1, 1);
    const [preview] = expandAll(
        Object.entries(fields).map(([key, text]) => ({ key, capsules: parsePromptToCapsules(text) })),
        1, 1, { chain: chainFromSettings(settings) },
    );
    assert.equal(posL, preview.positive);
    assert.equal(posR, preview.positiveRight);
});

test('a JSON slot fragment is the same text on both paths', () => {
    // generate.js and generate_regional.js build their fragments with this one function
    assert.equal(jsonSlotFragment('red dress', '1.0'), 'red dress, ');
    assert.equal(jsonSlotFragment('  ', '0.8'), '');
});

// ---------------------------------------------------------------- "same settings" seed

test('Regional "same settings" sends the fixed slider seed, not -1', async () => {
    stubPromptCard();
    const last = { lastPos: 'l', lastPosColored: 'lc', lastPosR: 'r', lastPosRColored: 'rc', lastNeg: 'n', lastNegL: 'nl', lastNegR: 'nr', lastCharacter: 'A', lastImagePrefix: 'A' };
    globalThis.generate = { seed: { getValue: () => 12345 }, ...last };
    const fixed = await createPrompt(true, '', 'ComfyUI');
    assert.equal(fixed.randomSeed, 12345);
    assert.equal(fixed.positivePromptLeft, 'l');
    assert.equal(fixed.negativePromptRight, 'nr');

    globalThis.generate = { seed: { getValue: () => -1 }, ...last };
    const random = await createPrompt(true, '', 'ComfyUI');
    assert.ok(Number.isInteger(random.randomSeed) && random.randomSeed >= 0, `a random seed, got ${random.randomSeed}`);
});

// ---------------------------------------------------------------- regions

test('WebUI (Forge Couple) is sent the regions ComfyUI masks, for every slider position', () => {
    for (let image = 10; image <= 90; image += 5) {
        for (let overlap = 0; overlap <= 200; overlap += 10) {
            const comfy = comfyRegions(regionalRatio(image, overlap, 'ComfyUI'));
            const mapping = forgeCoupleMapping({ ratio: regionalRatio(image, overlap, 'WebUI'), split: 'left-right', str_left: 1, str_right: 1 });
            const webui = mapping.map(([x1, x2]) => [x1, x2]);
            for (const [region, bounds] of webui.entries()) {
                for (const [edge, value] of bounds.entries()) {
                    assert.ok(Math.abs(value - comfy[region][edge]) < 1e-9, `image ${image} overlap ${overlap}: region ${region} edge ${edge} ${value} vs ${comfy[region][edge]}`);
                }
            }
        }
    }
    // the ComfyUI layout itself is unchanged
    assert.equal(regionalRatio(50, 20, 'ComfyUI'), '1,0.2,1');
    assert.equal(regionalRatio(30, 0, 'ComfyUI'), '0.6,0.01,1.4');
    // the old WebUI ratio left the middle of the image to no region at an image ratio of 30
    const [oldEnd, oldStart] = [(0.6 + 0.1) / 2, (1.4 - 0.1) / 2];
    assert.ok(oldStart - oldEnd > 0.29);
    const [[, end], [start]] = forgeCoupleMapping({ ratio: regionalRatio(30, 10, 'WebUI') });
    assert.ok(start < end, 'the regions overlap as the Overlap slider asks');
});

test('the renderer builds that ratio for each backend and the Forge Couple prompt stays one line per region', () => {
    globalThis.globalSettings = { regional_split: 'left-right', css_style: 'light' };
    globalThis.regional = {
        overlap_ratio: { getValue: () => 10 }, image_ratio: { getValue: () => 30 },
        str_left: { getFloat: () => 1.2 }, str_right: { getFloat: () => 0.8 },
        option_left: { getValue: () => 'default' }, option_right: { getValue: () => 'default' },
    };
    assert.equal(createRegional('ComfyUI').ratio, regionalRatio(30, 10, 'ComfyUI'));
    const webui = createRegional('WebUI');
    assert.deepEqual(forgeCoupleMapping(webui).map(([x1, x2, , , weight]) => [x1, x2, weight]),
        comfyRegions(createRegional('ComfyUI').ratio).map(([x1, x2], index) => [x1, x2, [1.2, 0.8][index]]));
    // what the renderer sends: the left prompt carries the LoRA on its own line, the right a trailing newline
    assert.equal(forgeCouplePrompt('1girl, smile\n<lora:a:1>\n<lora:b:0.5>', 'sad, \n'), '1girl, smile, <lora:a:1>, <lora:b:0.5>\nsad');
    assert.equal(forgeCouplePrompt('a\nb', 'c'), 'a, b\nc');
});

// ---------------------------------------------------------------- characters and the model type

function stubCharacters(settings) {
    globalThis.globalSettings = settings;
    globalThis.characterListRegional = stubRegionalList();
    globalThis.characterList = stubCharacterList(settings);
    delete globalThis.settingsPersistence;
    delete globalThis.prompt;
    syncRegionalCharacters();
}

// callbacks.js applyModelType: remember the card being left, then bring back the other one
function switchModelType(settings, from, to) {
    settings.model_type_prompts = rememberPrompts(settings.model_type_prompts, from, settings);
    settings.api_model_type = to;
    settings.regional_condition = to === 'Checkpoint' ? settings.regional_condition_checkpoint : false;
    applyPromptsForModelType(to);
}

// language.js updateSettings (restart, preset, undo): migrate, push the slots, sync
function reloadSettings(settings) {
    settings.character_slots = migrateSlotSides(settings.character_slots, settings.character_left, settings.character_right,
        { weights: [1, 1], regional: Boolean(settings.regional_condition) });
    globalThis.characterList.setSlots(settings.character_slots);
    syncRegionalCharacters();
}

test('switching the model type brings the regional list along with the restored side column', () => {
    const settings = {
        api_model_type: 'Checkpoint', regional_condition: true, regional_condition_checkpoint: true,
        character_slots: [{ key: 'A', weight: 1, side: 'left' }, { key: 'B', weight: 1.1, side: 'right' }],
        character_left: 'None', character_right: 'None',
        model_type_prompts: { Diffusion: { character_slots: [{ key: 'C', weight: 1 }, { key: 'D', weight: 1 }] } },
    };
    stubCharacters(settings);
    assert.deepEqual(globalThis.characterListRegional.getKey(), ['A', 'B']);

    switchModelType(settings, 'Checkpoint', 'Diffusion');
    assert.deepEqual(settings.character_slots.map(slot => slot.side ?? 'both'), ['both', 'both'], 'the Diffusion cast carries no side');
    // Regional is off here, so the Checkpoint pair waits in the settings (it is the Checkpoint
    // card's, and the Diffusion cast is not given those characters)
    assert.deepEqual([settings.character_left, settings.character_right], ['A', 'B']);
    globalThis.characterList.edit([{ key: 'E', weight: 1 }, { key: 'D', weight: 1 }]); // the cast is edited

    switchModelType(settings, 'Diffusion', 'Checkpoint');
    // what the Regional box names and what generate_regional.js draws are the same characters again
    assert.equal(regionalSlots(settings.character_slots).left.key, 'A');
    assert.deepEqual(globalThis.characterListRegional.getKey(), ['A', 'B']);
    assert.equal(globalThis.characterListRegional.getTextValue(1), 1.1);
});

test('a restart, preset or undo after a model type switch adds no characters to the cast', () => {
    const settings = {
        api_model_type: 'Checkpoint', regional_condition: true, regional_condition_checkpoint: true,
        character_slots: [{ key: 'A', weight: 1, side: 'left' }, { key: 'B', weight: 1, side: 'right' }],
        character_left: 'None', character_right: 'None',
        model_type_prompts: { Diffusion: { character_slots: [{ key: 'C', weight: 1 }, { key: 'D', weight: 1 }] } },
    };
    stubCharacters(settings);
    switchModelType(settings, 'Checkpoint', 'Diffusion');
    reloadSettings(settings);
    assert.deepEqual(settings.character_slots.map(slot => slot.key), ['C', 'D']);
    assert.deepEqual(globalThis.characterList.getSlots().map(slot => slot.key), ['C', 'D']);

    // settings saved by the old build (the switch left character_left / right behind) are not
    // migrated into the cast either; with Regional off they wait where they are instead of
    // being overwritten with None, so a later Regional switch can still use them
    Object.assign(settings, { character_left: 'A', character_right: 'B' });
    reloadSettings(settings);
    assert.deepEqual(settings.character_slots.map(slot => slot.key), ['C', 'D']);
    assert.deepEqual([settings.character_left, settings.character_right], ['A', 'B']);
});

// ---------------------------------------------------------------- "same settings" weight plans

// the tag-capsule field set as planBatchExpansion / beginImageOverride read it: two plans
// that step per image, one on Positive and one on Negative (left)
function stubPlanFieldSet() {
    return {
        getBatchExpansion: () => ({ enabled: false, count: 1, variable: 2 }),
        getPromptOverrides: imageIndex => ({
            positive: '1girl, smile',
            negative_left: 'blurry',
            weights: { 'positive/smile#0': 1 + 0.1 * imageIndex, 'negative_left/blurry#0': 1 + 0.2 * imageIndex },
            terminal: [],
        }),
    };
}

test('Regional "same settings" walks the weight plans instead of sending one prompt N times', async () => {
    stubPromptCard();
    globalThis.generate = {
        seed: { getValue: () => 7 },
        lastPos: '1girl, smile', lastPosColored: '', lastPosR: 'sad, smile', lastPosRColored: '',
        lastNeg: 'lowres, blurry', lastNegL: 'lowres, blurry', lastNegR: 'lowres, bad hands',
        lastCharacter: 'A', lastImagePrefix: 'A',
    };
    const fieldSet = stubPlanFieldSet();
    const expansion = planBatchExpansion({ loops: 3 }, { fieldSet, sliderSeed: 7 });
    const runs = [];
    for (let loop = 0; loop < expansion.loops; loop++) {
        beginImageOverride(expansion, loop, { fieldSet });
        try { runs.push(await createPrompt(true, '', 'ComfyUI', loop)); } finally { endImageOverride(); }
    }
    assert.deepEqual(runs.map(run => run.positivePromptLeft),
        ['1girl, smile', '1girl, (smile:1.10)', '1girl, (smile:1.20)'], 'the left prompt follows the plan');
    assert.deepEqual(runs.map(run => run.negativePromptLeft),
        ['lowres, blurry', 'lowres, (blurry:1.20)', 'lowres, (blurry:1.40)'], 'so does the left negative');
    // the right side has no plan of its own: the Positive plan does not reach it
    assert.deepEqual([...new Set(runs.map(run => run.positivePromptRight))], ['sad, smile']);
    assert.deepEqual([...new Set(runs.map(run => run.negativePromptRight))], ['lowres, bad hands']);
    // a fixed slider seed still pins the seed; only the weights move
    assert.deepEqual(runs.map(run => run.randomSeed), [7, 7, 7]);
});

test('Regional "same settings" without a plan is the previous prompt, untouched', async () => {
    stubPromptCard();
    globalThis.generate = {
        seed: { getValue: () => 12345 },
        lastPos: '1girl, smile', lastPosColored: 'c', lastPosR: 'sad', lastPosRColored: 'cr',
        lastNeg: 'lowres', lastNegL: 'lowres', lastNegR: 'lowres', lastCharacter: 'A', lastImagePrefix: 'A',
    };
    const expansion = planBatchExpansion({ loops: 2 }, { fieldSet: { getBatchExpansion: () => ({ enabled: false, count: 1, variable: 0 }) } });
    beginImageOverride(expansion, 0);
    try {
        const run = await createPrompt(true, '', 'ComfyUI', 0);
        assert.equal(run.positivePromptLeft, '1girl, smile');
        assert.equal(run.negativePromptLeft, 'lowres');
        assert.equal(run.randomSeed, 12345);
    } finally { endImageOverride(); }
});

// ---------------------------------------------------------------- queued Refine and the side negatives

test('a legacy Refine answer reused for image 2 still carries image 2 side-negative weights', async () => {
    // image #2 of a Regional batch: Negative (left) "blurry" is planned at 1.50 here, and the
    // cached answer of image #1 ("Once" role) wrote it at 1.30
    const fixedContext = {
        negative: {
            chains: { both: ['negative'], left: ['negative_left'], right: ['negative_right'] },
            texts: { negative: 'lowres', negative_left: '(blurry:1.50)', negative_right: 'bad hands' },
        },
        characterNegativeLeft: '', characterNegativeRight: '',
    };
    const planWeights = { 'negative_left/blurry#0': 1.5, 'positive/smile#0': 1.2 };
    const content = JSON.stringify({
        positive: '1girl, (smile:1.10)', positive_right: 'sad',
        negative: 'lowres, (blurry:1.30), bad hands',
    });
    const result = await resolveQueuedAiPrompt({
        mode: 'Refine', content, marker: '_|REPLACE_AI_PROMPT|_', regional: true, fixedContext, planWeights,
        originalPrompts: { positive: '1girl, smile', positiveRight: 'sad', negative: 'lowres, (blurry:1.50), bad hands' },
    });
    assert.equal(result.ok, true);
    assert.equal(result.positive, '1girl, (smile:1.20)', 'the positive plan was already put back');
    assert.equal(result.negativeLeft, 'lowres, (blurry:1.50)', 'and now the side negative is this image weight');
    assert.equal(result.negativeRight, 'lowres, bad hands', 'the other side keeps the answer as it is');
});

// ---------------------------------------------------------------- the regional pair while Regional is off

test('with Regional off an old character_left / right waits instead of being overwritten with None', () => {
    const settings = {
        api_model_type: 'Checkpoint', regional_condition: false,
        character_slots: [{ key: 'Random', weight: 1 }, { key: 'None', weight: 1 }],
        character_left: 'hatsune_miku', character_right: 'kagamine_rin',
    };
    stubCharacters(settings);
    assert.deepEqual([settings.character_left, settings.character_right], ['hatsune_miku', 'kagamine_rin'],
        'the sync no longer writes None over them');
    // a restart / preset load / undo adds nothing to the ordinary cast, and keeps them
    reloadSettings(settings);
    assert.deepEqual(settings.character_slots.map(slot => slot.key), ['Random', 'None']);
    assert.deepEqual([settings.character_left, settings.character_right], ['hatsune_miku', 'kagamine_rin']);

    // Regional switched on (callback_regional_condition): now they become slot sides
    settings.regional_condition = true;
    adoptRegionalCharacters();
    assert.deepEqual(settings.character_slots.map(slot => [slot.key, slot.side ?? 'both']),
        [['Random', 'both'], ['None', 'both'], ['hatsune_miku', 'left'], ['kagamine_rin', 'right']]);
    assert.deepEqual(globalThis.characterList.getSlots().map(slot => slot.key),
        ['Random', 'None', 'hatsune_miku', 'kagamine_rin'], 'the card holds the same list');
    assert.deepEqual(globalThis.characterListRegional.getKey(), ['hatsune_miku', 'kagamine_rin']);
    // switching Regional off and on again changes nothing: the slots carry the sides now
    adoptRegionalCharacters();
    assert.equal(settings.character_slots.length, 4);
});

test('taking the last side off the cast forgets the stored pair', async () => {
    const settings = {
        api_model_type: 'Checkpoint', regional_condition: false,
        character_slots: [{ key: 'A', weight: 1, side: 'left' }, { key: 'B', weight: 1, side: 'right' }],
        character_left: 'A', character_right: 'B',
    };
    stubCharacters(settings);
    globalThis.cachedFiles = { characterList: {}, characterThumb: {}, characterNames: {}, tagAssist: {} };
    globalThis.thumbGallery = { update: () => {} };
    assert.deepEqual([settings.character_left, settings.character_right], ['A', 'B']);
    // the user drops both sided characters in the card while Regional is off
    globalThis.characterList.setSlots([{ key: 'C', weight: 1 }, { key: 'D', weight: 1 }]);
    await callback_myCharacterList_updateThumb();
    assert.deepEqual([settings.character_left, settings.character_right], ['None', 'None'],
        'the pair is gone with the sides, so switching Regional on does not bring it back');
    settings.regional_condition = true;
    adoptRegionalCharacters();
    assert.deepEqual(settings.character_slots.map(slot => slot.key), ['C', 'D']);
});
