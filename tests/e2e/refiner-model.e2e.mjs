// The refiner's "Default", end to end: the refiner pass runs on the base checkpoint, and a
// reload of the model lists keeps the refiner choice. Until 2026-10-15 the refiner list
// held only the model files, so "Default" (and any choice, after a reload) showed and ran
// the first file of the list: a second checkpoint each image, read from disk again every
// time. Run with `npm run test:e2e`.
import assert from 'node:assert/strict';
import test from 'node:test';

import { FAST_GENERATION, launchApp, workflow } from './harness.mjs';

const CHECKPOINT = {
    api_model_sampler: 'euler_ancestral', api_model_scheduler: 'normal', ...FAST_GENERATION, regional_condition: false,
    api_refiner_enable: true, api_refiner_model: 'Default', api_refiner_ratio: 0.5,
};

let app = null;

test.before(async () => {
    // the model type's own generation set is what the app puts back on start
    app = await launchApp({ settings: { ...CHECKPOINT, model_type_generation: { Checkpoint: CHECKPOINT } } });
});
test.after(async () => { await app?.close(); });

const shownRefiner = () => app.page.evaluate(`document.querySelector('.refiner-model .mydropdown-input')?.value ?? ''`);
// what the model refresh button runs (#model-refresh-toggle), awaited
const reloadModelLists = () => app.page.evaluate(`import('./scripts/renderer/components/myCollapsed.js').then(module => module.reloadModelLists()).then(() => true)`);

test('"Default" refines with the base checkpoint: one checkpoint for the whole run', async () => {
    assert.equal(await shownRefiner(), 'Default', 'the list has "Default", not its first file in its place');
    const run = await app.generate({ expectImages: 1 });
    assert.equal(run.error, '', `no error overlay; log ${app.logFile}`);
    const { workflow: wf, outputs } = run.history[0];
    const chain = workflow.executedChain(wf, outputs);
    const checkpoints = new Set(chain.filter(node => node.class_type === 'CheckpointLoaderSimple').map(node => node.inputs.ckpt_name));
    assert.deepEqual([...checkpoints], [app.settings.api_model_file_select]);
    // the builders skip a refiner on the run's own checkpoint: the base pass runs every step
    const samplers = chain.filter(node => node.class_type === 'KSamplerAdvanced');
    assert.equal(samplers.length, 1, 'no second pass on the same weights');
    assert.ok(samplers[0].inputs.end_at_step >= samplers[0].inputs.steps);
});

test('a reload of the model lists keeps the refiner choice', async () => {
    await reloadModelLists();
    assert.equal(await shownRefiner(), 'Default', 'was the first file of the list');

    const last = await app.page.evaluate(`globalThis.cachedFiles.modelListAll.at(-1)`);
    await app.page.evaluate(`(() => {
        globalThis.globalSettings.api_refiner_model = ${JSON.stringify(last)};
        globalThis.refiner.model.updateDefaults(${JSON.stringify(last)});
    })()`);
    await reloadModelLists();
    assert.equal(await shownRefiner(), last);
    await app.page.evaluate(`(() => {
        globalThis.globalSettings.api_refiner_model = 'Default';
        globalThis.refiner.model.updateDefaults('Default');
    })()`);
});
