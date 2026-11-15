// The locks on the random sources (scripts/shared/promptLocks.js, scripts/renderer/promptLocks.js):
// a locked row keeps what it drew; a source it holds nothing for draws once and is held.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
    createDrawRecord, describeDraws, drawsEachImage, hasRandomSource, heldFieldDraws, holdFieldDraws, isFieldLocked,
    pruneCharacterLocks, pruneFieldLocks, recipeLocks, setCharacterLock, setFieldLock, heldCharacter, holdCharacter,
    cleanRunDraws,
} from '../scripts/shared/promptLocks.js';
import { processRandomString } from '../scripts/renderer/tools/nestedBraceParsing.js';
import { mergeRecipePrompt } from '../scripts/shared/recipeApply.js';
import { buildRecipe, parseRecipe } from '../scripts/shared/recipe.js';

// replaceWildcardsAsync with its loader stubbed: a wildcard's value is "<name>-<seed>"
async function wildcards(text, seed, materials) {
    let out = text;
    for (const [, name] of [...text.matchAll(/__([a-zA-Z0-9_-]+)__/g)]) {
        let value = materials?.wildcard?.(name);
        if (value === undefined) {
            value = `${name}-${seed}`;
            materials?.rememberWildcard?.(name, value);
        }
        out = out.replaceAll(`__${name}__`, value);
    }
    return out;
}

const settings = () => ({});
const install = values => {
    globalThis.globalSettings = values;
    globalThis.editHistory = undefined;
    return values;
};

test('what counts as a random source in a row', () => {
    assert.equal(hasRandomSource('1girl, smile'), false);
    assert.equal(hasRandomSource('__hair__, smile'), true);
    assert.equal(hasRandomSource('{red|blue} dress'), true);
    assert.equal(hasRandomSource('{a|{b|c}}'), true);
    assert.equal(hasRandomSource('{just braces}'), false);
    assert.equal(hasRandomSource('random'), false, 'only a view-list row knows "random"');
    assert.equal(hasRandomSource(' Random ', { list: true }), true);
    assert.equal(hasRandomSource('random sky', { list: true }), false);
    // with the seed fixed only a choice (and a wildcard under Wildcard seed) differs per image
    assert.equal(drawsEachImage('__hair__'), false);
    assert.equal(drawsEachImage('__hair__', { freshWildcards: true }), true);
    assert.equal(drawsEachImage('{a|b}'), true);
});

test('a draw record replays what it holds and draws the rest, recording both', async () => {
    const record = createDrawRecord({ wildcards: { hair: 'red hair' }, choices: { 'cat|dog': ['dog'] } });
    const text = processRandomString(await wildcards('__hair__, __eyes__, {cat|dog}, {cat|dog}', 7, record), record);
    assert.match(text, /^red hair, eyes-7, dog, (cat|dog)$/);
    const draws = record.result();
    assert.deepEqual(draws.wildcards, { hair: 'red hair', eyes: 'eyes-7' });
    assert.equal(draws.choices['cat|dog'].length, 2, 'the second identical choice is a draw of its own');
    assert.equal(draws.choices['cat|dog'][0], 'dog');
    // a source no longer in the row is not carried along
    const again = createDrawRecord(draws);
    await wildcards('__eyes__', 9, again);
    assert.deepEqual(again.result(), { wildcards: { eyes: 'eyes-7' } });
    assert.deepEqual(describeDraws(draws).slice(0, 3), ['red hair', 'eyes-7', 'dog']);
    // the view list's pick
    const list = createDrawRecord({ list: 'beach' });
    assert.equal(list.list(() => 'forest'), 'beach');
    assert.equal(createDrawRecord(null).list(() => 'forest'), 'forest');
});

test('row locks: on with the last draws or the next draw, held per part, pruned with their row', () => {
    let s = {};
    s = { ...s, ...setFieldLock(s, 'background', true, { left: { wildcards: { place: 'cafe' } } }) };
    assert.equal(isFieldLocked(s, 'background'), true);
    assert.deepEqual(heldFieldDraws(s, 'background', 'left'), { wildcards: { place: 'cafe' } });
    assert.equal(heldFieldDraws(s, 'background', 'right'), null, 'the other side holds nothing yet');
    assert.equal(holdFieldDraws(s, 'background', 'left', { wildcards: { place: 'cafe' } }), null, 'nothing changed');
    s = { ...s, ...holdFieldDraws(s, 'background', 'right', { wildcards: { place: 'park' } }) };
    assert.deepEqual(heldFieldDraws(s, 'background', 'right'), { wildcards: { place: 'park' } });
    assert.equal(holdFieldDraws(s, 'style', 'left', { list: 'x' }), null, 'an unlocked row holds nothing');
    s = { ...s, ...setFieldLock(s, 'style', true) };
    assert.equal(isFieldLocked(s, 'style'), true);
    assert.equal(heldFieldDraws(s, 'style'), null, 'next draw');
    assert.deepEqual(Object.keys(pruneFieldLocks(s, ['background']).prompt_locks), ['background']);
    assert.equal(pruneFieldLocks(s, ['background', 'style']), null);
    s = { ...s, ...setFieldLock(s, 'style', false) };
    assert.equal(isFieldLocked(s, 'style'), false);
});

test('character locks: per slot, removed with the slot', () => {
    let s = {};
    s = { ...s, ...setCharacterLock(s, 2, true) };
    assert.equal(heldCharacter(s, 2), null, 'next draw');
    s = { ...s, ...holdCharacter(s, 2, 'oc:Rob Roy') };
    assert.equal(heldCharacter(s, 2), 'oc:Rob Roy');
    assert.equal(holdCharacter(s, 0, 'x'), null, 'an unlocked slot holds nothing');
    assert.deepEqual(pruneCharacterLocks(s, 2).character_locks, {});
    assert.equal(pruneCharacterLocks(s, 3), null);
});

test('drawField: unlocked draws as before; locked holds, keeps fixed-tag edits, draws a new source once', async () => {
    const { drawField, toggleFieldLock, fieldState, beginImageDraws } = await import('../scripts/renderer/promptLocks.js');
    const s = install({});
    const draw = (text, seed, image = null, part = 'left') => drawField('positive', text, { seed, image, part, wildcards, choices: processRandomString });

    const image = beginImageDraws();
    assert.equal(await draw('smile, __hair__', 1, image), 'smile, hair-1');
    assert.deepEqual(image.fields.positive, { left: { wildcards: { hair: 'hair-1' } } }, 'the image keeps what it drew');
    assert.equal(await draw('smile, __hair__', 2), 'smile, hair-2', 'unlocked: the seed decides');
    assert.equal(await drawField('common', 'no source here', { seed: 3, wildcards, choices: processRandomString }), 'no source here');

    toggleFieldLock('positive');   // locks on the last draw
    assert.deepEqual(fieldState('positive'), { locked: true, values: ['hair-2'] });
    assert.equal(await draw('smile, __hair__', 5), 'smile, hair-2', 'locked: what it holds');
    assert.equal(await draw('grin, blush, __hair__', 6), 'grin, blush, hair-2', 'editing the fixed tags keeps it');
    assert.equal(await draw('grin, __hair__, __eyes__', 7), 'grin, hair-2, eyes-7', 'a new source draws');
    assert.equal(await draw('grin, __hair__, __eyes__', 8), 'grin, hair-2, eyes-7', 'and is held from then on');
    assert.deepEqual(s.prompt_locks.positive.draws.left.wildcards, { hair: 'hair-2', eyes: 'eyes-7' });
    assert.equal(await draw('__hair__', 9, null, 'right'), 'hair-9', 'the right side holds its own');
    assert.equal(await draw('__hair__', 10, null, 'right'), 'hair-9');

    // its sources taken out: it holds nothing, but stays locked
    assert.equal(await draw('grin', 10), 'grin');
    assert.deepEqual(s.prompt_locks.positive.draws, { right: { wildcards: { hair: 'hair-9' } } });
    assert.deepEqual(fieldState('positive'), { locked: true, values: ['hair-9'] });

    toggleFieldLock('positive');
    assert.equal(s.prompt_locks.positive, undefined);
    assert.equal(await draw('__hair__', 11), 'hair-11', 'unlocked again: drawn anew');
});

test('a lock switched on before anything drew takes the next draw', async () => {
    const { drawField, toggleFieldLock, fieldState } = await import('../scripts/renderer/promptLocks.js');
    install({});
    toggleFieldLock('cf_new');
    assert.deepEqual(fieldState('cf_new'), { locked: true, values: [] });
    const draw = seed => drawField('cf_new', '{a|b|c|d|e|f|g|h}', { seed, wildcards, choices: processRandomString });
    const first = await draw(1);
    for (let i = 0; i < 6; i++) assert.equal(await draw(i), first);
});

test('the AI answer: a lock that holds one answers with it, a lock with none keeps the next', async () => {
    const { drawAi, toggleAiLock, aiState } = await import('../scripts/renderer/promptLocks.js');
    const s = install({});
    let calls = 0;
    const request = async () => ({ content: `answer ${++calls}`, fresh: true, source: 'request' });
    const options = { role: 2, aiInterface: 'Local' };
    assert.equal((await drawAi(request, options)).content, 'answer 1');
    toggleAiLock();
    assert.deepEqual(aiState(), { locked: true, text: 'answer 1' });
    const held = await drawAi(request, options);
    assert.deepEqual([held.content, held.source, calls], ['answer 1', 'locked', 1]);
    assert.equal((await drawAi(request, { role: 0, aiInterface: 'Local' })).content, 'answer 2', 'AI off: the request decides (it answers nothing)');
    toggleAiLock();
    assert.equal(s.ai_prompt_lock, null);
});

test('somethingVaries: an unlocked choice or an AI answer per image makes a fixed-seed batch differ', async () => {
    const { somethingVaries, toggleFieldLock } = await import('../scripts/renderer/promptLocks.js');
    install({});
    const rows = [{ id: 'positive', text: 'smile, {a|b}' }, { id: 'background', text: '__place__' }];
    assert.equal(somethingVaries(rows), true);
    toggleFieldLock('positive');
    assert.equal(somethingVaries(rows), false, 'locked, and the wildcard follows the fixed seed');
    assert.equal(somethingVaries(rows, { freshWildcards: true }), true, 'Wildcard seed draws it per image');
    assert.equal(somethingVaries([], { aiRole: 2, aiInterface: 'Local' }), true);
    assert.equal(somethingVaries([], { aiRole: 1, aiInterface: 'Local' }), false, 'Once asks once');
});

test('the recipe keeps the draws; "Use settings…" locks the rows on them and the AI on its answer', () => {
    const draws = { fields: { background: { left: { wildcards: { place: 'cafe' } } }, empty: { left: {} } } };
    assert.deepEqual(cleanRunDraws(draws), { fields: { background: { left: { wildcards: { place: 'cafe' } } } } });
    const recipe = parseRecipe(JSON.stringify(buildRecipe({ run: { seed: 1, draws, ai: { mode: 'Expand', text: 'a smile' } } })));
    assert.deepEqual(recipe.run.draws, { fields: { background: { left: { wildcards: { place: 'cafe' } } } } });
    assert.deepEqual(recipeLocks(recipe.run), {
        prompt_locks: { background: { draws: { left: { wildcards: { place: 'cafe' } } } } },
        ai_prompt_lock: { text: 'a smile' },
    });
    const merged = mergeRecipePrompt({ prompt_locks: { style: { draws: {} } }, ai_prompt_lock: null }, { prompt_background: '__place__' }, { run: recipe.run });
    assert.deepEqual(merged.prompt_locks, { background: { draws: { left: { wildcards: { place: 'cafe' } } } } });
    assert.deepEqual(merged.ai_prompt_lock, { text: 'a smile' });
    // an image from before the draws: the rows draw anew, the editor's AI lock stays
    const old = mergeRecipePrompt({ prompt_locks: { style: { draws: {} } }, ai_prompt_lock: { text: 'mine' } }, {}, { run: { seed: 1 } });
    assert.deepEqual(old.prompt_locks, {});
    assert.deepEqual(old.ai_prompt_lock, { text: 'mine' });
    assert.equal(settings().prompt_locks, undefined);
});
