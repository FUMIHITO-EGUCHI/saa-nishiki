// The sequence batch, end to end: the real app against the real local ComfyUI. A sequence of
// two scenes in a custom field, two favorite characters and two candidates make eight runs;
// the edit mode puts a scene into the field, a trial run sends it, and "Save to <scene>"
// takes the image into the scene. Run with `npm run test:e2e`.
import assert from 'node:assert/strict';
import test from 'node:test';

import { launchApp, workflow } from './harness.mjs';

const FRIEREN = '芙莉莲（葬送的芙莉莲）';
const FERN = '菲伦（葬送的芙莉莲）';
const SCENES = [
    { id: 'a', name: 'Morning', text: 'waking up, bedroom', thumb: '' },
    { id: 'b', name: 'Street', text: 'walking, street', thumb: '' },
];

let app = null;

test.before(async () => {
    app = await launchApp({
        settings: {
            fav_characters: [FRIEREN, FERN],
            prompt_custom_fields: [{ id: 'cf_scene', name: 'Scene', polarity: 'positive', text: 'standing' }],
            prompt_positive_order: ['common', 'views', 'cf_scene', 'background', 'style', 'ai', 'characters', 'positive', 'artist'],
            sequence_confirm_threshold: 0,
        },
    });
    await app.page.evaluate(`(() => {
        globalThis.sequenceBatch.update(current => { current.name = ''; current.field = 'cf_scene'; current.scenes = ${JSON.stringify(SCENES)}; });
        return true;
    })()`);
});
test.after(async () => { await app?.close(); });

async function waitImages(count, before) {
    await app.page.waitFor(
        `globalThis.__e2e.images.length >= ${before + count} && globalThis.inGenerating !== true && !globalThis.mainGallery.isLoading`,
        { timeoutMs: 300_000, intervalMs: 250, label: `${count} image(s) from the sequence` },
    );
}

function savedImages(outputs) {
    return Object.values(outputs ?? {}).flatMap(output => output?.images ?? []);
}

test('2 characters x 2 scenes x 2 candidates: eight runs, each with its character, its scene and seed B + c', async () => {
    const seed = app.settings.random_seed;
    const known = new Set(await app.comfy.historyIds());
    const before = await app.page.evaluate('globalThis.__e2e.images.length');
    await app.page.evaluate(`(() => { globalThis.sequenceBatch.open({ page: 'run' }); return true; })()`);
    await app.page.waitFor(`Boolean(document.querySelector('.sequence-dialog:not([hidden]) .sequence-page-run:not([hidden])'))`, { timeoutMs: 5000, label: 'the Run page' });
    await app.page.evaluate(`(() => {
        const dialog = document.querySelector('.sequence-dialog');
        dialog.querySelector('.sequence-page-run .sequence-column-foot .sequence-button').click();   // Add all
        const candidates = dialog.querySelector('#sequence-candidates');
        candidates.value = '2';
        candidates.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
    })()`);
    const label = await app.page.evaluate(`document.querySelector('.sequence-generate').textContent`);
    assert.equal(label, 'Generate (8)');
    await app.page.click('.sequence-generate');
    await waitImages(8, before);

    const history = await app.comfy.historySince(known);
    assert.equal(history.length, 8, 'one ComfyUI run per row');
    assert.equal(await app.errorText(), '');
    const runs = history.map(entry => ({
        seed: workflow.seedOf(workflow.sampler(entry.workflow, entry.outputs)),
        positive: workflow.positive(entry.workflow, entry.outputs) ?? '',
        files: savedImages(entry.outputs),
    }));
    assert.deepEqual(runs.map(run => run.seed).sort((a, b) => a - b), [seed, seed, seed, seed, seed + 1, seed + 1, seed + 1, seed + 1], 'candidate c runs on B + c for every character and scene');
    for (const run of runs) {
        assert.doesNotMatch(run.positive, /standing/, 'the scene replaces the field text');
        assert.match(run.positive, /waking up, bedroom|walking, street/, 'a scene is in the prompt');
        assert.match(run.positive, /frieren|fern/i, 'a character is in the prompt');
    }
    const byScene = runs.filter(run => /walking, street/.test(run.positive));
    assert.equal(byScene.length, 4, 'each scene for two characters x two candidates');
    const files = runs.flatMap(run => run.files);
    if (files.length) {
        assert.ok(files.every(file => /^seq-\d{8}-\d{6}$/.test(file.subfolder)), `one run folder: ${files.map(file => `${file.subfolder} | ${file.filename}`).join(', ')}`);
        assert.equal(new Set(files.map(file => file.subfolder)).size, 1);
        assert.ok(files.some(file => /_s02-Street_c2/.test(file.filename)), files.map(file => file.filename).join(', '));
    }
    assert.equal(await app.page.evaluate(`globalThis.prompt.cf_scene.getValue()`), 'standing', 'the screen keeps its own text');
});

test('edit mode: the scene goes into the field, a trial run sends it, Save to scene takes the image, Back gives the field back', async () => {
    await app.page.evaluate(`globalThis.sequenceEdit.enter('a')`);
    await app.page.waitFor(`globalThis.sequenceEdit.isActive() && globalThis.prompt.cf_scene.getValue() === 'waking up, bedroom'`, { timeoutMs: 5000, label: 'the scene in the field' });
    assert.ok(await app.page.evaluate(`Boolean(document.getElementById('sequence-strip'))`), 'the strip above Prompts');

    const run = await app.generate({ expectImages: 1 });
    assert.equal(run.error, '');
    const positive = workflow.positive(run.history[0].workflow, run.history[0].outputs) ?? '';
    assert.match(positive, /waking up, bedroom/);

    await app.page.waitFor(`document.getElementById('sequence-save-scene')?.disabled === false`, { timeoutMs: 5000, label: 'Save to scene' });
    // the field changes after the image; the scene takes the image's own text back
    await app.page.evaluate(`(() => { globalThis.prompt.cf_scene.setValue('something else'); document.querySelector('.prompt-fields [data-field-id="cf_scene"]').dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
    await app.page.waitFor(`globalThis.sequenceBatch.current().scenes[0].text === 'something else'`, { timeoutMs: 3000, label: 'the scene follows the field' });
    await app.page.click('#sequence-save-scene');
    await app.page.waitFor(`globalThis.sequenceBatch.current().scenes[0].thumb.startsWith('data:image/jpeg') && globalThis.sequenceBatch.current().scenes[0].text === 'waking up, bedroom'`, { timeoutMs: 5000, label: 'the image in the scene' });
    assert.ok(await app.page.evaluate(`globalThis.sequenceBatch.current().scenes[0].thumb.length < 12000`), 'a small thumbnail');

    await app.page.evaluate(`globalThis.sequenceEdit.exit()`);
    await app.page.waitFor(`!globalThis.sequenceEdit.isActive() && globalThis.prompt.cf_scene.getValue() === 'standing'`, { timeoutMs: 5000, label: 'the field back' });
});
