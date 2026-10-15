// Everyday generation, end to end: the real app against the real local ComfyUI. What a
// person does at the run bar and the Positive field, judged by what ComfyUI was asked
// to run and by what the gallery received. Run with `npm run test:e2e`.
import assert from 'node:assert/strict';
import test from 'node:test';

import { freshSeed, launchApp, workflow } from './harness.mjs';

let app = null;

test.before(async () => { app = await launchApp(); });
test.after(async () => { await app?.close(); });

test('one image: the prompt, the seed, the size and the steps of the run bar reach ComfyUI, and the image lands in the gallery', async () => {
    const seed = app.settings.random_seed;
    const run = await app.generate({ expectImages: 1 });
    assert.equal(run.error, '', 'no error overlay');
    assert.equal(run.images.length, 1);
    assert.equal(run.images[0].seed, String(seed), 'the seed of the run bar');
    assert.ok(run.images[0].bytes > 1000, 'an image, not a placeholder');

    assert.equal(run.history.length, 1, 'ComfyUI ran exactly one prompt');
    const { workflow: wf, outputs } = run.history[0];
    assert.equal(workflow.checkpoint(wf, outputs), app.settings.api_model_file_select, 'the checkpoint of the settings');
    const sampler = workflow.sampler(wf, outputs);
    assert.ok(sampler, `a sampler among ${workflow.classTypes(wf).join(', ')}`);
    assert.equal(workflow.seedOf(sampler), seed);
    assert.equal(sampler.inputs.steps, 4);
    assert.deepEqual(workflow.latentSize(wf, outputs), { width: 512, height: 512, batch: 1 });
    assert.match(workflow.positive(wf, outputs) ?? '', /1girl/, 'the Common field is in the positive prompt');
    assert.match(workflow.negative(wf, outputs) ?? '', /worst quality/, 'the Negative field is in the negative prompt');
});

test('a weighted tag is sent as written and a tag switched off with ~ is not sent', async () => {
    await app.typePositive('(long hair:1.2), ~smile, red eyes');
    const run = await app.generate({ expectImages: 1 });
    assert.equal(run.error, '');
    assert.equal(run.history.length, 1);
    const { workflow: wf, outputs } = run.history[0];
    const positive = workflow.positive(wf, outputs) ?? '';
    assert.match(positive, /\(long hair:1\.2\)/, 'the weight is in the prompt');
    assert.match(positive, /red eyes/);
    assert.doesNotMatch(positive, /smile/, 'the switched-off tag stays out');
    assert.match(run.images[0].tags, /long hair/, 'the gallery keeps the prompt of the image');
});

test('a batch of three on a random seed: three images with three seeds, one prompt run each, the same prompt text', async () => {
    // a fixed seed would repeat the image (the app says so and asks); a batch is run on -1
    await app.setSeed(-1);
    await app.setBatch(3);
    const run = await app.generate({ button: 'batch', expectImages: 3 });
    await app.setBatch(1);
    await app.setSeed(freshSeed() + 100);
    assert.equal(run.error, '');
    assert.equal(run.images.length, 3);
    const seeds = run.images.map(image => Number(image.seed));
    assert.equal(new Set(seeds).size, 3, `three different seeds, not ${seeds}`);
    assert.ok(seeds.every(seed => seed >= 0), 'real seeds, not the -1 of the slider');
    assert.equal(run.history.length, 3, 'one ComfyUI run per image');
    assert.deepEqual(
        run.history.map(entry => workflow.seedOf(workflow.sampler(entry.workflow, entry.outputs))).sort((a, b) => a - b),
        [...seeds].sort((a, b) => a - b),
        'the gallery names the seed ComfyUI sampled with',
    );
    const prompts = new Set(run.history.map(entry => workflow.positive(entry.workflow, entry.outputs)));
    assert.equal(prompts.size, 1, 'the same prompt for every image of the batch');
});
