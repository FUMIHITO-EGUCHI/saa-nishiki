// The renderer's side of the image recipe (scripts/renderer/imageRecipe.js): the editor
// is collected once per click, each image adds its own run, the queue adds what it
// decided before the backend, and the gallery gets one record per image.
import assert from 'node:assert/strict';
import test from 'node:test';

import { captureRecipeSections, imageRecord, noteJobSteps, queuedRecipe, startJobClock } from '../scripts/renderer/imageRecipe.js';

function withEditor(body) {
    const collected = [];
    globalThis.settingsPersistence = {
        collectSection: section => {
            collected.push(section);
            return section === 'prompt' ? { api_prompt: '1girl', prompt_field_presets: {} } : { section };
        },
    };
    globalThis.globalSettings = { version: '2.8.9', api_model_type: 'Diffusion', ai_prose_writer: 'student' };
    try {
        return body(collected);
    } finally {
        delete globalThis.settingsPersistence;
        delete globalThis.globalSettings;
    }
}

test('the click collects the sections once; each image adds its own run', () => {
    withEditor(collected => {
        const sections = captureRecipeSections();
        assert.deepEqual(collected, ['prompt', 'generation', 'lora', 'adetailer']);
        const first = queuedRecipe(sections, { seed: 10, characters: ['a'] });
        const second = queuedRecipe(sections, { seed: 11, characters: ['b'] });
        assert.deepEqual([first.run.seed, second.run.seed], [10, 11]);
        assert.equal(first.app.api_model_type, 'Diffusion');
        assert.equal(first.saa, '2.8.9');
        assert.equal('prompt_field_presets' in first.sections.prompt, false);
    });
    assert.equal(captureRecipeSections(), null, 'nothing to collect before persistence is up');
    assert.equal(queuedRecipe(null, {}), null);
});

test('the queue writes what it decided into the job before the backend', () => {
    withEditor(() => {
        const generateData = { recipe: queuedRecipe(captureRecipeSections(), { seed: 3 }) };
        noteJobSteps(generateData, {
            positive: 'Rice Shower stands under the cherry trees.',
            negative: 'lowres',
            ai: { mode: 'off', text: '' },
            prose: { applied: true, prompt: 'Rice Shower stands under the cherry trees.', fields: { characters: [] } },
            timing: { jobStart: 100, ai: 0, prose: 900 },
        });
        assert.deepEqual(generateData.timing, { jobStart: 100, ai: 0, prose: 900 });
        assert.equal(generateData.recipe.run.positive, 'Rice Shower stands under the cherry trees.');
        assert.equal(generateData.recipe.run.ai, null, 'no AI request, no AI step');
        assert.deepEqual(generateData.recipe.run.prose, {
            applied: true, paragraph: 'Rice Shower stands under the cherry trees.', writer: 'student', fields: { characters: [] },
        });

        // Prose that kept the tags: no paragraph to reuse
        noteJobSteps(generateData, { prose: { applied: false, prompt: '', reason: 'empty' }, timing: { jobStart: 100 } });
        assert.equal(generateData.recipe.run.prose.paragraph, '');
    });
});

test('the record: the backend\'s copy of the recipe, its timing and file; WebUI times itself', () => {
    const generateData = { recipe: { v: 1, run: {} }, timing: { jobStart: Date.now() - 5000, ai: 0, prose: 0 }, queueManager: { apiInterface: 'WebUI' } };
    const sent = { v: 1, run: { sent: { steps: 8 } } };
    assert.deepEqual(imageRecord(generateData, { path: 'C:\\out\\a.png', timing: { total: 1, segments: [] }, recipe: sent }),
        { recipe: sent, timing: { total: 1, segments: [] }, path: 'C:\\out\\a.png', interface: 'WebUI' });
    const own = imageRecord(generateData, null, { posted: Date.now() - 4000 });
    assert.equal(own.recipe, generateData.recipe);
    assert.ok(own.timing.total >= 5000);
    assert.equal(own.timing.segments.find(segment => segment.id === 'backend').ms >= 4000, true);
    assert.equal(imageRecord({}, null).timing, null);
});

test('the job clock laps', () => {
    const times = [1000, 1600, 2500];
    const clock = startJobClock(() => times.shift());
    assert.equal(clock.start, 1000);
    assert.equal(clock.lap(), 600);
    assert.equal(clock.lap(), 900);
});
