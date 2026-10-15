// Regional on a diffusion model (Anima), end to end: the Regional switch shows in cast
// mode, a top / bottom split with the Panels preset runs the UNET regional workflow, the
// two regions are masked, and both region prompts open with the panel tags after Common.
// Run with `npm run test:e2e`.
import assert from 'node:assert/strict';
import test from 'node:test';

import { launchApp, workflow } from './harness.mjs';

const PANEL_TAGS = 'split screen, 2koma, two panels';

let app = null;

test.before(async () => {
    app = await launchApp({
        settings: {
            api_model_type: 'Diffusion',
            api_model_sampler: 'er_sde', api_model_scheduler: 'simple', step: 6, cfg: 3,
            regional_condition: true,
            regional_split: 'top-bottom',
            regional_panels: true,
            regional_image_ratio: 50, regional_overlap_ratio: 20,
            custom_prompt: 'masterpiece, best quality',
            model_type_generation: {
                Diffusion: { api_model_sampler: 'er_sde', api_model_scheduler: 'simple', step: 6, cfg: 3, width: 512, height: 512, api_hf_enable: false, api_image_landscape: false, regional_condition: true },
            },
        },
    });
});
test.after(async () => { await app?.close(); });

test('a diffusion model runs Regional: the switch shows, the UNET regional workflow masks two regions, and the panel tags open both region prompts', async () => {
    assert.equal(await app.setting('api_model_type'), 'Diffusion');
    assert.equal(await app.setting('regional_condition'), true, 'the switch was not forced off by the model type');
    const visible = await app.page.evaluate(`(() => { const el = document.querySelector('.regional-condition-trigger-dummy'); return Boolean(el && el.offsetParent !== null); })()`);
    assert.equal(visible, true, 'the Regional switch shows in cast mode');

    await app.typePositive('1girl, solo, red eyes, smile');
    const run = await app.generate({ expectImages: 1 });
    assert.equal(run.error, '', `no error overlay; log ${app.logFile}`);
    assert.equal(run.history.length, 1);
    const { workflow: wf, outputs } = run.history[0];
    assert.equal(workflow.unet(wf, outputs), app.settings.api_model_file_diffusion_select, 'the diffusion model of the settings');
    assert.equal(workflow.checkpoint(wf, outputs), null, 'no checkpoint in the chain that ran');

    const masks = workflow.nodes(wf, 'ConditioningSetMask');
    assert.ok(masks.length >= 2, `two masked regions, found ${masks.length}`);
    // the encoders read their text from SAA's text nodes (a link, not a string): follow it
    const texts = workflow.nodes(wf, 'CLIPTextEncode').map(node => String(workflow.text(wf, node.inputs?.text) ?? ''));
    const regionPrompts = texts.filter(text => text.includes(PANEL_TAGS));
    assert.ok(regionPrompts.length >= 2, `both region prompts carry the panel tags: ${JSON.stringify(texts)}`);
    for (const text of regionPrompts) assert.match(text, /^masterpiece, best quality, split screen, 2koma, two panels/, 'the panel tags follow Common');
    assert.ok(texts.some(text => /red eyes/.test(text)), 'the typed prompt reached a region');
    // the top / bottom split: Mira's mask layout is rows, not columns
    const layout = Object.values(wf).find(node => node?.inputs && Object.hasOwn(node.inputs, 'Colum_first'));
    assert.ok(layout, 'the tiling mask node');
    assert.equal(layout.inputs.Colum_first, false, 'top / bottom means rows');
});
