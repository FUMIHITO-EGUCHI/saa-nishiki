// The image recipe (scripts/shared/recipe.js): what a queued image keeps of the editor
// and of its own run, what comes back out of a text chunk, and what the A1111
// "parameters" text of an image without a recipe still says.
import assert from 'node:assert/strict';
import test from 'node:test';

import { buildRecipe, parseParameters, parseRecipe, recipeLoras, recipeModel, recipeSize } from '../scripts/shared/recipe.js';

const sections = {
    prompt: {
        api_prompt: '1girl, smile',
        prompt_custom_fields: [{ id: 'cf_outfit', name: 'Outfit', polarity: 'positive', text: 'parts:blazer uniform' }],
        prompt_field_presets: { positive: [{ name: 'big', text: '…' }] },
        prompt_field_collapsed: ['negative'],
        character_slots: [{ key: 'Random', weight: 1 }],
    },
    generation: {
        step: 30, cfg: 4, api_model_sampler: 'euler', api_model_scheduler: 'simple', width: 832, height: 1216,
        api_model_file_select: 'waiIllustriousSDXL_v160.safetensors', api_model_file_diffusion_select: 'waiANIMA_v10Base10.safetensors',
        api_hf_enable: true, api_hf_scale: 1.5, api_hf_denoise: 0.4, api_hf_upscaler_selected: '4x-AnimeSharp.pth', api_hf_steps: 12,
    },
    lora: { lora_slot: [['CharTurnIL.safetensors', '0.8', '0.8', 'ALL'], ['None', '1', '1', 'ALL'], ['old.safetensors', '0.6', '0.5', 'Base']] },
    adetailer: { api_adetailer_enable: true, ad_slot: [['bbox/face_yolov8m.pt', '0.3', '0', 'center-1'], ['bbox/hand.pt', '0.3', '0', 'Off']] },
};

test('a recipe keeps the sections and the model keys, not the editor furniture', () => {
    const recipe = buildRecipe({
        sections,
        settings: { api_model_type: 'Diffusion', api_fast_enable: true, api_addr: '127.0.0.1:8189' },
        run: { seed: 1830551274, width: 832, height: 1216, characters: ['rice_shower_(umamusume)'], interface: 'ComfyUI' },
        saaVersion: '2.8.9',
        now: Date.UTC(2026, 9, 16, 5, 32),
    });
    assert.equal(recipe.v, 1);
    assert.equal(recipe.created, '2026-10-16T05:32:00.000Z');
    assert.equal(recipe.sections.prompt.api_prompt, '1girl, smile');
    assert.equal('prompt_field_presets' in recipe.sections.prompt, false);
    assert.equal('prompt_field_collapsed' in recipe.sections.prompt, false);
    assert.deepEqual(recipe.app, { api_model_type: 'Diffusion', api_fast_enable: true }, 'only the model keys of the app section');
    assert.deepEqual(recipe.run.characters, ['rice_shower_(umamusume)']);
    assert.equal(recipe.run.prose, null);
    // a copy: editing the editor afterwards does not touch the queued recipe
    sections.prompt.api_prompt = 'changed';
    assert.equal(recipe.sections.prompt.api_prompt, '1girl, smile');
    sections.prompt.api_prompt = '1girl, smile';
});

test('a text chunk parses back to the recipe; anything else is no recipe', () => {
    const recipe = buildRecipe({ sections, settings: { api_model_type: 'Checkpoint' }, run: { seed: 7 } });
    const parsed = parseRecipe(JSON.stringify(recipe));
    assert.deepEqual(parsed.sections.lora, recipe.sections.lora);
    assert.equal(parsed.run.seed, 7);
    assert.equal(parseRecipe('{"v":"1"}'), null);
    assert.equal(parseRecipe('not json'), null);
    assert.equal(parseRecipe({ v: 1 }), null, 'a recipe has sections');
    assert.deepEqual(parseRecipe({ v: 2, sections: {} }).sections.prompt, {}, 'missing sections read as empty');
});

test('the LoRA rows, model and size a recipe describes', () => {
    const recipe = buildRecipe({
        sections,
        settings: { api_model_type: 'Diffusion' },
        run: { width: 832, height: 1216, sent: { steps: 8, cfg: 1.5, sampler: 'euler', scheduler: 'simple', fast: { lora: 'anima-turbo-lora-v0.2.safetensors', strength: 0.8 } } },
    });
    assert.deepEqual(recipeLoras(recipe), [
        { name: 'CharTurnIL.safetensors', model: 0.8, clip: 0.8, stage: 'ALL' },
        { name: 'old.safetensors', model: 0.6, clip: 0.5, stage: 'Base' },
    ]);
    const model = recipeModel(recipe);
    assert.equal(model.type, 'Diffusion');
    assert.equal(model.model, 'waiANIMA_v10Base10.safetensors');
    assert.deepEqual([model.steps, model.cfg, model.sent.steps, model.sent.fast.strength], [30, 4, 8, 0.8]);
    const size = recipeSize(recipe);
    assert.deepEqual([size.width, size.height, size.hires.scale], [832, 1216, 1.5]);
    assert.deepEqual(size.detailers, ['bbox/face_yolov8m.pt'], 'a row switched Off does not run');
});

test('the parameters text of an image without a recipe', () => {
    const text = [
        '1girl, solo, smile,',
        'cherry blossoms',
        '<lora:CharTurnIL.safetensors:0.8:0.7>',
        'Negative prompt: lowres, bad hands',
        'Steps: 30, Sampler: Euler a, Schedule type: Normal, CFG scale: 5.0, Seed: 1830551274, Size: 832x1216, Clip skip: 2, Model hash: abc, Model: waiIllustriousSDXL_v160, Hashes: {"model":"abc","lora:x":"def"}, Version: ComfyUI',
    ].join('\n');
    const parsed = parseParameters(text);
    assert.equal(parsed.positive, '1girl, solo, smile,\ncherry blossoms');
    assert.equal(parsed.negative, 'lowres, bad hands');
    assert.deepEqual([parsed.steps, parsed.cfg, parsed.seed, parsed.width, parsed.height], [30, 5, 1830551274, 832, 1216]);
    assert.deepEqual([parsed.sampler, parsed.scheduler, parsed.model], ['Euler a', 'Normal', 'waiIllustriousSDXL_v160']);
    assert.deepEqual(parsed.loras, [{ name: 'CharTurnIL.safetensors', model: 0.8, clip: 0.7 }]);

    // the pod's shorter line: Scheduler instead of Schedule type, no size
    const pod = parseParameters('a cat\nNegative prompt: \nSteps: 8, Sampler: euler, Scheduler: simple, CFG scale: 1.5, Seed: 3, Model: waiANIMA_v10Base10');
    assert.deepEqual([pod.positive, pod.negative, pod.scheduler, pod.width], ['a cat', '', 'simple', null]);
    assert.equal(parseParameters(''), null);
});
