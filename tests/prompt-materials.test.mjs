import assert from 'node:assert/strict';
import test from 'node:test';

import { createPromptMaterials } from '../scripts/renderer/tools/promptMaterials.js';
import { processRandomString } from '../scripts/renderer/tools/nestedBraceParsing.js';

// One image draws its "{a|b}" choices and wildcards once; everything that has to describe
// the same picture (the coloured copy in the Info panel, the Prose units) replays them.

test('a replayed pass takes the options the recording pass took', () => {
    const material = '{red|blue|green} dress, {short|long} hair, {red|blue|green} ribbon';
    const materials = createPromptMaterials();
    const recorded = processRandomString(material, materials);
    for (let repeat = 0; repeat < 5; repeat++) {
        assert.equal(processRandomString(material, materials.replay()), recorded, 'the same material, the same picture');
    }
    // and unit by unit, in the order the prompt put them in
    const units = ['{red|blue|green} dress', '{short|long} hair', '{red|blue|green} ribbon'];
    materials.replay();
    assert.equal(units.map(unit => processRandomString(unit, materials)).join(', '), recorded);
});

test('without a record the choices are drawn as they always were', () => {
    const options = new Set();
    for (let draw = 0; draw < 200; draw++) options.add(processRandomString('{a|b|c}'));
    assert.deepEqual([...options].sort(), ['a', 'b', 'c'], 'every option can come up');
});

test('a replay that runs past the record falls back instead of drawing something new', () => {
    const materials = createPromptMaterials();
    const recorded = processRandomString('{a|b|c|d|e}', materials);
    materials.replay();
    processRandomString('{a|b|c|d|e}', materials);
    // the second replay of a content drawn once: the recorded option, not a fresh roll
    for (let repeat = 0; repeat < 20; repeat++) {
        assert.equal(processRandomString('{a|b|c|d|e}', materials), recorded);
    }
    // material that was never recorded still resolves (to one of its options)
    assert.ok(['x', 'y'].includes(processRandomString('{x|y}', materials)));
});

test('two identical choices stay as independent as they were drawn', () => {
    const materials = createPromptMaterials();
    // recorded: two draws of one content, in order
    const recorded = processRandomString('{a|b} one, {a|b} two', materials);
    const [first, second] = [...recorded.matchAll(/([ab]) (?:one|two)/g)].map(match => match[1]);
    materials.replay();
    assert.equal(processRandomString('{a|b} one', materials), `${first} one`);
    assert.equal(processRandomString('{a|b} two', materials), `${second} two`);
});

test('a wildcard is loaded once and reused for the same image', () => {
    const materials = createPromptMaterials();
    assert.equal(materials.wildcard('hair'), undefined, 'nothing loaded yet');
    materials.rememberWildcard('hair', 'long pink hair');
    materials.rememberWildcard('hair', 'short black hair');
    assert.equal(materials.wildcard('hair'), 'long pink hair', 'the first load is what the prompt used');
    assert.equal(materials.replay().wildcard('hair'), 'long pink hair');
});
