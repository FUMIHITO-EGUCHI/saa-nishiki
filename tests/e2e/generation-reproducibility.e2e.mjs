// Real Electron → ComfyUI → PNG → Use settings → process restart → fresh sampling.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import zlib from 'node:zlib';
import sharp from 'sharp';
import { launchApp, REPO_ROOT } from './harness.mjs';
import { readTextChunks } from '../../scripts/shared/pngText.js';

const output = path.join(REPO_ROOT, 'reports', 'generation-reproducibility');
const seed = 4114399038;
const generation = { width: 1024, height: 1024, step: 30, cfg: 7, api_model_sampler: 'euler_ancestral', api_model_scheduler: 'normal', api_image_landscape: true };
const settings = {
    ...generation, model_type_generation: { Checkpoint: generation },
    api_model_file_select: 'waiIllustriousSDXL_v170.safetensors', random_seed: seed,
    custom_prompt: 'embedding:lazypos, simple background, portrait, half-length portrait, minimalist poster design, white outer margin, centered colored rectangular panel, thin black rectangular border, character overlapping the frame, simple graphic background, limited color palette, clean composition, rice shower \\(umamusume\\)',
    api_neg_prompt: 'embedding:lazyneg, bad quality, worst quality, worst detail',
    api_adetailer_enable: true, api_adetailer_prompt_mode: 'inherit', api_adetailer_seed: -1,
    ad_slot: ['hand_yolov8n.pt', 'face_yolov8m.pt'].map((name, index) => [name, index ? '0.3' : '0.5', '0', 'sam_vit_b_01ec64.pth', '', '4', 'center-1', '', '4', '0.5']),
    api_refiner_enable: false, api_hf_enable: false, api_fast_enable: false, ai_interface: 'None',
};

async function state(app) {
    return app.page.evaluate(`({sampler: generate.sampler.getValue(), scheduler: generate.scheduler.getValue(),
        storedSampler: globalSettings.api_model_sampler, storedScheduler: globalSettings.api_model_scheduler,
        mode: document.getElementById('adetailer-prompt-mode').value, adSeed: Number(document.getElementById('adetailer-seed').value),
        seed: generate.seed.getValue()})`);
}

async function detailerControls(app, mode, value) {
    await app.page.evaluate(`(() => {
        const mode = document.getElementById('adetailer-prompt-mode'); mode.value = ${JSON.stringify(mode)}; mode.dispatchEvent(new Event('change', {bubbles:true}));
        const seed = document.getElementById('adetailer-seed'); seed.value = ${value}; seed.dispatchEvent(new Event('change', {bubbles:true}));
    })()`);
}

async function generate(app, name) {
    const result = await app.generate();
    assert.equal(result.error, '');
    const gallery = await app.page.evaluate('mainGallery.currentEntry().record');
    const list = await app.page.evaluate('api.workflowListRuns()');
    const record = await app.page.evaluate(`api.workflowReadRun(${JSON.stringify(list[0].id)})`);
    const history = (await (await fetch(`${app.comfy.base}/history/${record.promptId}`)).json())[record.promptId];
    assert.equal(history.status.status_str, 'success');
    const recipe = JSON.parse(readTextChunks(fs.readFileSync(gallery.path), { inflate: zlib.inflateSync }).records.saa_recipe);
    const image = path.join(output, `${name}.png`);
    fs.copyFileSync(gallery.path, image);
    fs.writeFileSync(path.join(output, `${name}-record.json`), JSON.stringify(record, null, 2));
    fs.writeFileSync(path.join(output, `${name}-recipe.json`), JSON.stringify(recipe, null, 2));
    return { image, recipe, record, graph: history.prompt[2] };
}

function checkGraph(run, { mode, mainSeed, adSeed, sampler, scheduler }) {
    const base = run.graph['36'].inputs;
    assert.equal(base.noise_seed, mainSeed);
    assert.equal(base.sampler_name, sampler);
    assert.equal(base.scheduler, scheduler);
    const detailers = Object.values(run.graph).filter(node => node.class_type === 'FaceDetailer');
    assert.equal(detailers.length, 2);
    for (const { inputs } of detailers) {
        assert.equal(inputs.seed, adSeed);
        if (mode === 'inherit') {
            assert.deepEqual(inputs.positive, base.positive);
            assert.deepEqual(inputs.negative, base.negative);
        } else {
            assert.equal(run.graph[inputs.positive[0]].inputs.text, '');
            assert.equal(run.graph[inputs.negative[0]].inputs.text, '');
        }
    }
    assert.equal(run.recipe.sections.generation.api_model_sampler, sampler);
    assert.equal(run.recipe.sections.generation.api_model_scheduler, scheduler);
    assert.deepEqual(run.recipe.run.sent.adetailer, [{ seed: adSeed, promptMode: mode }, { seed: adSeed, promptMode: mode }]);
}

test('saved settings and PNG restore reproduce identical pixels after restart, including ADetailer', { timeout: 600_000 }, async () => {
    fs.mkdirSync(output, { recursive: true });
    // Preserve the first launch's isolated folder until the restarted process exits.
    const previousKeep = process.env.SAA_E2E_KEEP;
    process.env.SAA_E2E_KEEP = '1';
    let app;
    try {
        app = await launchApp({ settings });
        console.log(`isolated app: ${app.runDir}`);
        const queue = await (await fetch(`${app.comfy.base}/queue`)).json();
        assert.equal(queue.queue_running.length + queue.queue_pending.length, 0, 'ComfyUI must be idle');
        await app.pickDropdown('generate-sampler', 'euler_cfg_pp');
        await app.pickDropdown('generate-scheduler', 'karras');
        await app.page.evaluate('api.workflowPreferences({captureStages:true})');
        const expected = { sampler: 'euler_cfg_pp', scheduler: 'karras', storedSampler: 'euler_cfg_pp', storedScheduler: 'karras', mode: 'inherit', adSeed: -1, seed };
        assert.deepEqual(await state(app), expected);
        console.log('Generating original with inherited prompts and seed');
        const original = await generate(app, 'original');
        checkGraph(original, { mode: 'inherit', mainSeed: seed, adSeed: seed, sampler: 'euler_cfg_pp', scheduler: 'karras' });

        // An intervening, different run forces the final comparison to sample again.
        await app.setSeed(seed + 1);
        await app.pickDropdown('generate-sampler', 'euler_ancestral');
        await app.pickDropdown('generate-scheduler', 'normal');
        await detailerControls(app, 'empty', 0);
        console.log('Generating intervening run with explicit empty prompts and fixed seed 0');
        const control = await generate(app, 'control');
        checkGraph(control, { mode: 'empty', mainSeed: seed + 1, adSeed: 0, sampler: 'euler_ancestral', scheduler: 'normal' });

        await app.page.evaluate(`document.querySelector('.cg-preview-image[data-dom-index="1"]').click()`);
        await app.page.waitFor(`mainGallery.currentEntry().record?.recipe?.run?.seed === ${seed}`);
        await app.page.evaluate(`document.querySelector('[data-info-tab="info"]').click()`);
        await app.page.waitFor(`Boolean(document.querySelector('.viewer-recipe-actions .viewer-primary-button'))`);
        await app.page.evaluate(`document.querySelector('.viewer-recipe-actions .viewer-primary-button').click()`);
        await app.page.waitFor(`Boolean(document.querySelector('.use-settings-modal:not([hidden]) .use-settings-row'))`);
        await app.page.evaluate(`document.querySelectorAll('.use-settings-row input[type="checkbox"]').forEach(input => { if (!input.checked) input.click(); })`);
        await app.page.click('.use-settings-modal .selection-modal-apply');
        await app.page.waitFor(`globalSettings.random_seed === ${seed} && globalSettings.api_adetailer_seed === -1`);
        assert.deepEqual(await state(app), expected, 'Use settings restores widgets and settings');
        await app.page.evaluate('settingsPersistence.flush()');
        const settingsDir = app.settingsDir;
        const persisted = JSON.parse(fs.readFileSync(path.join(settingsDir, 'state.json'), 'utf8')).data;
        assert.equal(persisted.generation.api_model_sampler, 'euler_cfg_pp');
        assert.equal(persisted.generation.api_model_scheduler, 'karras');
        assert.equal(persisted.adetailer.api_adetailer_prompt_mode, 'inherit');
        assert.equal(persisted.adetailer.api_adetailer_seed, -1);
        await app.close(); app = null;
        app = await launchApp({ settings, reuseSettingsDir: settingsDir });
        assert.deepEqual(await state(app), expected, 'full restart reads persisted values');
        console.log('Regenerating after full restart');
        const repeated = await generate(app, 'repeated');
        checkGraph(repeated, { mode: 'inherit', mainSeed: seed, adSeed: seed, sampler: 'euler_cfg_pp', scheduler: 'karras' });
        assert.match(repeated.record.provenance.nodes['36'].state, /execution-observed|observed-completed/, 'the base sampler actually executed');
        const pixels = await Promise.all([original.image, repeated.image, control.image].map(file => sharp(file).ensureAlpha().raw().toBuffer()));
        let changedPixels = 0;
        for (let index = 0; index < pixels[0].length; index += 4) {
            if (!pixels[0].subarray(index, index + 4).equals(pixels[1].subarray(index, index + 4))) changedPixels++;
        }
        assert.equal(changedPixels, 0);
        assert.ok(!pixels[0].equals(pixels[2]), 'the intervening run was a different image');
        await app.page.evaluate('collapsedTabs.aDetailer.setCollapsed(false); document.getElementById("adetailer-settings").scrollIntoView()');
        const screenshot = await app.page.send('Page.captureScreenshot', { format: 'png' });
        fs.writeFileSync(path.join(output, 'ui.png'), Buffer.from(screenshot.result.data, 'base64'));
        const evidence = { verifiedAt: new Date().toISOString(), settingsDir, expected, changedPixels, dimensions: [1024, 1024], samplerExecuted: repeated.record.provenance.nodes['36'].state,
            runs: [original, control, repeated].map(run => ({ id: run.record.id, promptId: run.record.promptId, image: run.image, sent: run.recipe.run.sent })) };
        fs.writeFileSync(path.join(output, 'evidence.json'), JSON.stringify(evidence, null, 2));
        console.log(JSON.stringify(evidence));
    } finally {
        await app?.close();
        if (previousKeep === undefined) delete process.env.SAA_E2E_KEEP;
        else process.env.SAA_E2E_KEEP = previousKeep;
    }
});
