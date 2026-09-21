// The model type and Fast mode, end to end: Checkpoint (Illustrious) to Diffusion
// (Anima) and back through the header dropdown, and Fast on a checkpoint through the run
// bar's Fast pill - judged by what ComfyUI was asked to run and what the run bar shows.
// The Diffusion Fast set restarts the local ComfyUI with launch flags; that is not run
// here (it would restart the developer's ComfyUI). Run with `npm run test:e2e`.
import assert from 'node:assert/strict';
import test from 'node:test';

import { freshSeed, launchApp, workflow } from './harness.mjs';

let app = null;

test.before(async () => {
    app = await launchApp({
        settings: {
            // the two types keep their own steps, so the switch shows which set is in force
            model_type_generation: {
                Checkpoint: { api_model_sampler: 'euler_ancestral', api_model_scheduler: 'normal', step: 4, cfg: 5, width: 512, height: 512, api_hf_enable: false, api_image_landscape: false, regional_condition: false },
                Diffusion: { api_model_sampler: 'er_sde', api_model_scheduler: 'simple', step: 6, cfg: 3, width: 512, height: 512, api_hf_enable: false, api_image_landscape: false, regional_condition: false },
            },
        },
    });
});
test.after(async () => { await app?.close(); });

test('switching to Diffusion runs the Anima model with its own steps and sampler, and the prompt typed after the switch', async () => {
    assert.equal(await app.setting('api_model_type'), 'Checkpoint');
    await app.openSettingsPage('model');
    await app.pickDropdown('model-type', 'Diffusion');
    await app.closeSettings();
    assert.equal(await app.setting('api_model_type'), 'Diffusion');
    assert.equal(await app.setting('step'), 6, 'the steps remembered for Diffusion');
    assert.equal(await app.setting('api_model_sampler'), 'er_sde');

    // the switch empties the prompts (a Checkpoint's tags are not an Anima prompt)
    await app.typePositive('1girl, solo, white background, red eyes');
    const run = await app.generate({ expectImages: 1 });
    assert.equal(run.error, '', `no error overlay; log ${app.logFile}`);
    assert.equal(run.history.length, 1);
    const { workflow: wf, outputs } = run.history[0];
    assert.equal(workflow.unet(wf, outputs), app.settings.api_model_file_diffusion_select, 'the diffusion model of the settings');
    assert.equal(workflow.checkpoint(wf, outputs), null, 'no checkpoint in the chain that ran');
    const sampler = workflow.sampler(wf, outputs);
    assert.equal(sampler.inputs.steps, 6);
    assert.equal(sampler.inputs.sampler_name, 'er_sde');
    assert.match(workflow.positive(wf, outputs) ?? '', /red eyes/, 'the prompt typed after the switch');
});

test('switching back to Checkpoint brings the checkpoint, its steps and its sampler back', async () => {
    await app.openSettingsPage('model');
    await app.pickDropdown('model-type', 'Checkpoint');
    await app.closeSettings();
    assert.equal(await app.setting('api_model_type'), 'Checkpoint');
    assert.equal(await app.setting('step'), 4, 'the steps remembered for Checkpoint');
    assert.equal(await app.setting('api_model_sampler'), 'euler_ancestral');

    await app.typePositive('1girl, solo, white background, blue eyes');
    const run = await app.generate({ expectImages: 1 });
    assert.equal(run.error, '');
    const { workflow: wf, outputs } = run.history[0];
    assert.equal(workflow.checkpoint(wf, outputs), app.settings.api_model_file_select);
    assert.equal(workflow.unet(wf, outputs), null);
    assert.equal(workflow.sampler(wf, outputs).inputs.steps, 4);
    assert.match(workflow.positive(wf, outputs) ?? '', /blue eyes/);
});

test('Fast on a checkpoint: the run bar pill turns it on, and the run carries the distillation LoRA with the fast steps and sampler', async () => {
    assert.equal(await app.setting('api_fast_enable'), false);
    await app.page.click('#fast-mode-toggle');
    await app.page.waitFor(`globalThis.globalSettings.api_fast_enable === true`, { label: 'Fast to switch on' });
    assert.match(await app.page.evaluate(`document.getElementById('fast-mode-toggle').textContent`), /On/);

    const run = await app.generate({ expectImages: 1 });
    assert.equal(run.error, '', `no error overlay; log ${app.logFile}`);
    const { workflow: wf, outputs } = run.history[0];
    const fastLora = String(app.settings.api_fast_lora).replace(/\.safetensors$/, '');
    assert.ok(workflow.loras(wf, outputs).some(name => name.includes(fastLora)), `the fast LoRA among ${workflow.loras(wf, outputs)}`);
    const sampler = workflow.sampler(wf, outputs);
    assert.equal(sampler.inputs.steps, app.settings.api_fast_steps);
    assert.equal(sampler.inputs.sampler_name, app.settings.api_fast_sampler);

    // off again: the next run is a plain one (on a seed of its own, or ComfyUI would
    // answer the earlier plain run of this prompt from its cache)
    await app.page.click('#fast-mode-toggle');
    await app.page.waitFor(`globalThis.globalSettings.api_fast_enable === false`, { label: 'Fast to switch off' });
    await app.setSeed(freshSeed() + 200);
    const plain = await app.generate({ expectImages: 1 });
    assert.equal(plain.error, '');
    assert.equal(workflow.loras(plain.history[0].workflow, plain.history[0].outputs).some(name => name.includes(fastLora)), false);
    assert.equal(workflow.sampler(plain.history[0].workflow, plain.history[0].outputs).inputs.steps, 4);
});
