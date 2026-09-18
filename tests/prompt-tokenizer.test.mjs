// One tokenizer for prompt text: a weighted group "(red hair, blue eyes:1.2)" is one tag
// for the chips, and for everything downstream of them (Exclude filter, plan weights, AI
// Refine, the Scene counts). These are behaviour tests: they run the functions.
import assert from 'node:assert/strict';
import test from 'node:test';

import {
    appendTagsToText,
    mapPromptTokens,
    migratePlanIds,
    parsePromptToCapsules,
    removeTagsFromText,
    serializeCapsules,
    splitGroupToken,
    splitPromptTokens,
    stripDisabledTags,
} from '../scripts/renderer/components/tagCapsuleLogic.js';
import { applyPlanWeights, createPlanWeigher, planWeightEntries, reapplyPlanWeights } from '../scripts/renderer/tools/promptBatchExpansion.js';
import { applyRefineEditorPatch } from '../scripts/renderer/tools/refineEditorApplication.js';
import { splitLegacyRegionalNegative } from '../scripts/renderer/tools/refinePromptComposition.js';
import { filterPrompts } from '../scripts/renderer/tools/promptFilter.js';

test('splitPromptTokens keeps a closed group together and splits everything else', () => {
    assert.deepEqual(splitPromptTokens('1girl, (red hair, blue eyes:1.2), smile'), ['1girl', '(red hair, blue eyes:1.2)', 'smile']);
    assert.deepEqual(splitPromptTokens('[a, b], {red hair, blue eyes|green hair}, c'), ['[a, b]', '{red hair, blue eyes|green hair}', 'c']);
    assert.deepEqual(splitPromptTokens('a, ((b, c)), d'), ['a', '((b, c))', 'd']);
    assert.deepEqual(splitPromptTokens('a, b\nc, (d, e)'), ['a', 'b', 'c', '(d, e)'], 'lines are split as well');
    assert.deepEqual(splitPromptTokens(''), []);
    assert.deepEqual(splitPromptTokens('a, , b'), ['a', 'b'], 'blank tags are dropped');
    // escapes and emoticon tags open nothing
    assert.deepEqual(splitPromptTokens('hatsune miku \\(cosplay\\), smile'), ['hatsune miku \\(cosplay\\)', 'smile']);
    assert.deepEqual(splitPromptTokens('\\(escaped, comma\\), c'), ['\\(escaped', 'comma\\)', 'c']);
    assert.deepEqual(splitPromptTokens(':(, sad, :), >:(, ;)'), [':(', 'sad', ':)', '>:(', ';)']);
    // a "(" in the middle of a word is text, so "foo(a, b)" is not a group
    assert.deepEqual(splitPromptTokens('foo(a, b), c'), ['foo(a', 'b)', 'c']);
    // one group after another, no space between
    assert.deepEqual(splitPromptTokens('(a, b)(c, d), e'), ['(a, b)(c, d)', 'e']);
});

test('an opener that never closes only costs its own token, not the whole line', () => {
    // the old tokenizer fell back to splitting every comma of the line, which cut the
    // healthy group behind it in half
    assert.deepEqual(splitPromptTokens('(unclosed, (a, b:1.2), c'), ['(unclosed', '(a, b:1.2)', 'c']);
    assert.deepEqual(splitPromptTokens('(:3, (a, b:1.2)'), ['(:3', '(a, b:1.2)']);
    assert.deepEqual(splitPromptTokens('a, (b, c'), ['a', '(b', 'c']);
    // a stray closer is text too
    assert.deepEqual(splitPromptTokens('a), (b, c:1.1)'), ['a)', '(b, c:1.1)']);
});

test('mapPromptTokens rewrites tags and leaves the commas, line breaks and spacing alone', () => {
    const text = 'a,  (x, y:1.2) , b\nc';
    assert.equal(mapPromptTokens(text, () => null), text, 'null changes nothing');
    assert.equal(mapPromptTokens(text, token => (token.startsWith('(') ? 'GROUP' : null)), 'a,  GROUP , b\nc');
    assert.equal(mapPromptTokens(text, token => (token === 'b' ? '' : null)), 'a,  (x, y:1.2) ,\nc', 'a dropped tag leaves its comma');
    const seen = [];
    mapPromptTokens(text, (token, index) => { seen.push([index, token]); return null; });
    assert.deepEqual(seen, [[0, 'a'], [1, '(x, y:1.2)'], [2, 'b'], [3, 'c']], 'one running index over the whole text');
});

test('splitGroupToken takes a group apart, with whatever stands around it', () => {
    assert.deepEqual(splitGroupToken('(red hair, blue eyes:1.2)'), { before: '', open: '(', body: 'red hair, blue eyes', close: ':1.2)', after: '' });
    assert.deepEqual(splitGroupToken('((a, b))'), { before: '', open: '(', body: '(a, b)', close: ')', after: '' });
    assert.deepEqual(splitGroupToken('[a, b]'), { before: '', open: '[', body: 'a, b', close: ']', after: '' });
    // the colored prompt copy wraps tags in [color=..], so a group can sit inside a token
    assert.deepEqual(splitGroupToken('(a, b:1.2)[/color]'), { before: '', open: '(', body: 'a, b', close: ':1.2)', after: '[/color]' });
    assert.deepEqual(splitGroupToken('(a, b)(c, d)').after, '(c, d)', 'the first group, the rest stays for the caller');
    assert.equal(splitGroupToken('1girl'), null);
    assert.equal(splitGroupToken('(unclosed'), null);
});

test('the chips and the prompt text agree on a group, a bracket group and a random group', () => {
    const capsules = parsePromptToCapsules('1girl, (red hair, blue eyes:1.2), [a, b], {red, blue|green}, ~(off, tags)');
    assert.deepEqual(capsules.map(capsule => capsule.value), ['1girl', 'red hair, blue eyes', '[a, b]', '{red, blue|green}', '(off, tags)']);
    assert.equal(capsules[1].weightPlan.min, 1.2);
    assert.equal(capsules[4].disabled, true);
    assert.equal(serializeCapsules(capsules), '1girl, (red hair, blue eyes:1.20), [a, b], {red, blue|green}, ~(off, tags)');
    assert.equal(stripDisabledTags('1girl, (red hair, blue eyes:1.2), ~(off, tags), solo'), '1girl, (red hair, blue eyes:1.2), solo');
    // the Scene row count is the number of chips (promptFieldManager tagCount shares this)
    const text = '1girl, (red hair, blue eyes:1.2), [a, b]\nsolo';
    assert.equal(splitPromptTokens(text).length, parsePromptToCapsules(text).length);
});

test('a text selection moved to another field carries a whole group', () => {
    // myRightClickMenu takes the selected text apart with splitPromptTokens
    const selection = '(red hair, blue eyes:1.2), smile';
    const tokens = splitPromptTokens(selection);
    assert.deepEqual(tokens, ['(red hair, blue eyes:1.2)', 'smile']);
    assert.equal(appendTagsToText('1girl', tokens), '1girl, (red hair, blue eyes:1.2), smile');
    assert.equal(removeTagsFromText('1girl, (red hair, blue eyes:1.2), smile, hat', tokens), '1girl, hat');
    assert.equal(removeTagsFromText('(a, b), (a, b)', ['(a, b)']), '(a, b)', 'one occurrence per named tag');
});

test('AI Refine keeps a switched-off group whole', () => {
    const before = '1girl, ~(red hair, blue eyes:1.2), smile';
    const values = { api_prompt: before };
    const controls = {
        common: { getValue: () => '', setValue: () => {} },
        positive: { getValue: () => values.api_prompt, setValue: value => { values.api_prompt = value; } },
        negative: { getValue: () => 'lowres', setValue: () => {} },
    };
    const snapshot = { revision: 1, mode: 'normal', muted: [], fields: { common: '', positive: before, negative: 'lowres' } };
    const candidate = {
        format: 'v3',
        validForEditorApply: true,
        editorFields: { common: '', positive: '1girl, smile, looking at viewer', negative: 'lowres' },
    };
    const result = applyRefineEditorPatch({ candidate, snapshot, currentSnapshot: snapshot, controls, settings: {}, tagCapsuleFields: null });
    assert.equal(result.status, 'applied');
    // whole, and back between the tags it sat between (refineEditorApplication.js)
    assert.equal(values.api_prompt, '1girl, ~(red hair, blue eyes:1.2), smile, looking at viewer');
    assert.deepEqual(parsePromptToCapsules(values.api_prompt).map(capsule => capsule.value),
        ['1girl', 'red hair, blue eyes', 'smile', 'looking at viewer']);
    assert.equal(stripDisabledTags(values.api_prompt), '1girl, smile, looking at viewer');
});

test('planned weights land on the group, not on a tag inside it', () => {
    const entries = planWeightEntries({ 'positive/smile#0': 1.3, 'positive/red hair, blue eyes#0': 1.4 }).positive;
    // "(a, smile, b:1.2)" is one tag: the outer smile is smile#0, the one inside the group is not counted
    assert.equal(applyPlanWeights('(a, smile, b:1.2), smile', entries), '(a, smile, b:1.2), (smile:1.30)');
    assert.equal(applyPlanWeights('(red hair, blue eyes:1.10), smile', entries), '(red hair, blue eyes:1.40), (smile:1.30)');
    // a weight of 1 drops the markup, the spacing around a tag survives
    assert.equal(applyPlanWeights('a,  smile , b', planWeightEntries({ 'positive/smile#0': 1 }).positive), 'a,  smile , b');
    assert.equal(applyPlanWeights('a, b', []), 'a, b');
});

test('applyPlanWeights can keep counting across the units of a chain', () => {
    const entries = planWeightEntries({ 'positive/smile#1': 1.2 }).positive;
    const counter = new Map();
    assert.equal(applyPlanWeights('smile, hat', entries, counter), 'smile, hat', 'the first unit holds smile#0');
    assert.equal(applyPlanWeights('smile, cat', entries, counter), '(smile:1.20), cat', 'the second unit continues at smile#1');
    // without a shared counter every call starts over, which is what the per-unit calls did
    assert.equal(applyPlanWeights('smile, cat', entries), 'smile, cat');
});

test('createPlanWeigher: one ordinal counter per field, units weighted one by one', () => {
    const weigh = createPlanWeigher({ 'positive/smile#1': 1.2, 'common/smile#0': 0.9, 'negative/blurry#0': 1.4 });
    assert.equal(weigh('smile, hat', 'positive'), 'smile, hat');
    assert.equal(weigh('smile, cat', 'positive'), '(smile:1.20), cat', 'the positive counter kept running');
    assert.equal(weigh('smile', 'common'), '(smile:0.90)', 'common counts on its own');
    assert.equal(weigh('smile, smile', 'characters'), 'smile, smile', 'a unit of a field with no plans is untouched');
    assert.equal(weigh('blurry', 'negative'), '(blurry:1.40)');
    weigh.reset();
    assert.equal(weigh('smile, hat', 'positive'), 'smile, hat', 'reset starts the next chain at #0');
});

test('planWeightEntries drops token ids it cannot read', () => {
    assert.deepEqual(planWeightEntries(), {});
    assert.deepEqual(planWeightEntries(null), {});
    assert.deepEqual(planWeightEntries({
        'nofield#0': 1.2,              // no field in front of the name
        'positive/no ordinal': 1.2,    // no "#"
        'positive#0/smile': 1.2,       // the "#" stands before the "/"
        'positive/#0': 1.2,            // no name
        'positive/smile#x': 1.2,       // the ordinal is not a number
        'positive/smile#0': 'heavy',   // the weight is not a number
    }), {}, 'a plan that cannot be read weighs nothing, it does not weigh something else');
    assert.deepEqual(
        planWeightEntries({ 'positive/  Detailed   Eyes  #2': '1.25' }).positive,
        [{ name: 'detailed eyes', ordinal: 2, weight: 1.25 }],
        'the name is normalized the way the capsule ids were built and the weight parsed',
    );
});

test('a side negative repeating the shared negative keeps the shared weight', () => {
    // the Regional left negative is the shared negative plus the left field, so both name
    // blurry#0 - and the shared tag is the one standing first in the text
    const prompts = reapplyPlanWeights(
        { negative: 'blurry', negativeLeft: 'blurry' },
        { 'negative/blurry#0': 1.3, 'negative_left/blurry#0': 0.5 },
    );
    assert.equal(prompts.negativeLeft, '(blurry:1.30)');
    assert.equal(prompts.negative, '(blurry:1.30)');
    assert.equal(
        applyPlanWeights('blurry', [{ name: 'blurry', ordinal: 0, weight: 1.3 }, { name: 'blurry', ordinal: 0, weight: 0.5 }]),
        '(blurry:1.30)',
        'the first entry of a name#ordinal wins',
    );
    // a prompt trio the caller left empty is answered empty, never "undefined"
    assert.deepEqual(reapplyPlanWeights({}, { 'positive/smile#0': 1.2 }), { positive: '', positiveRight: '', negative: '' });
});

test('createPlanWeigher: a chain unit built from several fields counts them together', () => {
    const weigh = createPlanWeigher({ 'common/smile#0': 0.9, 'positive/smile#1': 1.2 });
    assert.equal(weigh('smile, smile', 'common', 'positive'), '(smile:0.90), (smile:1.20)', 'both field plans on one unit');
    assert.equal(weigh('smile', 'common', 'positive'), 'smile', 'that field pair kept counting past #1');
    assert.equal(weigh('smile', 'common'), '(smile:0.90)', 'a different field list counts on its own');
    assert.equal(createPlanWeigher()('smile', 'positive'), 'smile', 'no plans at all, nothing to weigh');
});

test('reapplyPlanWeights answers the Regional side negatives when it is given them', () => {
    const weights = { 'positive/detailed eyes#0': 1.1, 'negative/blurry#0': 1.3, 'negative_left/extra arms#0': 1.4, 'negative_right/extra arms#0': 0.8 };
    const prompts = reapplyPlanWeights({
        positive: 'detailed eyes, hat',
        positiveRight: 'detailed eyes',
        negative: 'blurry, extra arms, extra arms',
        negativeLeft: 'blurry, extra arms',
        negativeRight: 'blurry, extra arms',
    }, weights);
    assert.equal(prompts.positive, '(detailed eyes:1.10), hat');
    assert.equal(prompts.negative, '(blurry:1.30), extra arms, extra arms');
    assert.equal(prompts.negativeLeft, '(blurry:1.30), (extra arms:1.40)', 'the shared negative first, then the left field');
    assert.equal(prompts.negativeRight, '(blurry:1.30), (extra arms:0.80)');
    // a caller that has no side negatives gets none back
    assert.deepEqual(Object.keys(reapplyPlanWeights({ positive: 'a' }, weights)).sort(), ['negative', 'positive', 'positiveRight']);
});

test('a group negative stays whole when a legacy answer is split over the sides', () => {
    const fixedContext = {
        negative: {
            chains: { both: ['negative'], left: ['negative', 'negative_left'], right: ['negative', 'negative_right'] },
            texts: { negative: 'lowres', negative_left: '(extra arms, extra legs:1.2)', negative_right: 'blurry' },
        },
    };
    const { left, right } = splitLegacyRegionalNegative('lowres, (extra arms, extra legs:1.2), blurry, watermark', fixedContext);
    assert.equal(left, 'lowres, (extra arms, extra legs:1.2), watermark');
    assert.equal(right, 'lowres, blurry, watermark');
});

test('Exclude takes a tag out of a group instead of cutting the group in half', () => {
    const text = '1girl, (red hair, blue eyes:1.2), smile';
    assert.equal(filterPrompts(text, text, 'red hair').positivePrompt, '1girl, (blue eyes:1.2), smile');
    assert.equal(filterPrompts(text, text, 'red hair, blue eyes').positivePrompt, '1girl, smile', 'an emptied group goes away');
    assert.equal(filterPrompts(text, text, 'smile').positivePrompt, '1girl, (red hair, blue eyes:1.2),', 'the line-end comma is kept, as it always was');
    assert.equal(filterPrompts(text, text, 'nothing here').positivePrompt, text, 'nothing excluded, nothing changed');
    // a group chip in the Exclude field names every tag inside it
    assert.equal(filterPrompts(text, text, '(red hair, smile:1.2)').positivePrompt, '1girl, (blue eyes:1.2),');
    // replacements reach into a group as well
    assert.equal(filterPrompts(text, text, 'red hair:blue hair').positivePrompt, '1girl, (blue hair, blue eyes:1.2), smile');
    // line breaks and the colored copy survive
    const lines = '1girl, (red hair, blue eyes:1.2)\nsmile';
    assert.equal(filterPrompts(lines, lines, 'red hair').positivePrompt, '1girl, (blue eyes:1.2)\nsmile');
    const colored = '[color=#123456]1girl, (red hair, blue eyes:1.2)[/color], smile';
    assert.equal(filterPrompts(colored, colored, 'red hair').positivePromptColored, '[color=#123456]1girl, (blue eyes:1.2)[/color], smile');
});

test('stored weight plans move with the chips when a group stops being two tags', () => {
    const text = '(a, smile, b:1.2), smile';
    const plan = { mode: 'increment', min: 1.1, max: 1.3, step: 0.05, seed: 0 };
    const other = { mode: 'random', min: 0.9, max: 1.1, step: 0.05, seed: 3 };
    // written by the build that split every comma: "smile#0" is the one inside the group,
    // "smile#1" the tag behind it - which is "smile#0" now
    const legacy = migratePlanIds({ 'smile#0': other, 'smile#1': plan }, text);
    assert.equal(legacy.changed, true);
    assert.deepEqual(legacy.plans, { 'smile#0': plan }, 'the plan of a group fragment has no chip left');
    assert.equal(parsePromptToCapsules(text)[1].id, 'smile#0');

    // a sidecar this build wrote names chips that exist: nothing moves
    assert.deepEqual(migratePlanIds({ 'smile#0': plan }, text), { plans: { 'smile#0': plan }, changed: false });
    // no group in the text: both tokenizers agree, nothing to migrate
    assert.deepEqual(migratePlanIds({ 'smile#1': plan }, 'hat, smile, smile'), { plans: { 'smile#1': plan }, changed: false });
    assert.deepEqual(migratePlanIds({}, text), { plans: {}, changed: false });
    // an id neither tokenizer gives out is left for reconcilePlans to report
    const gone = migratePlanIds({ 'smile#1': plan, 'hat#0': other }, text);
    assert.deepEqual(gone.plans, { 'smile#0': plan, 'hat#0': other });
});
