// "Use settings…": how an image's recipe lines up with the editor (recipeApply.js) and
// what loading writes - fields matched by key / id / name, an image-only field made
// again, an editor-only field muted, Random slots resolved, rows chosen one by one.
import assert from 'node:assert/strict';
import test from 'node:test';

import { buildRecipe, recipeFromParameters } from '../scripts/shared/recipe.js';
import { compareRecipeFields, mergeRecipePrompt, planRecipeLoad, recipeLoraRows, resolveRandomSlots, rowDiffers } from '../scripts/shared/recipeApply.js';

const imagePrompt = {
    api_prompt: '1girl, solo, long hair, (smile:1.2)',
    view_tags: 'parts:from above',
    prompt_background: 'cherry blossoms, outdoors',
    api_neg_prompt: 'lowres',
    character_slots: [{ key: 'Random', weight: 1 }, { key: 'None', weight: 1 }],
    artist_slots: [{ key: 'ciloranko', weight: 1 }],
    prompt_custom_fields: [
        { id: 'cf_outfit', name: 'Outfit', polarity: 'positive', text: 'parts:blazer uniform, white gloves' },
        { id: 'cf_img2', name: 'Hands', polarity: 'positive', text: 'holding umbrella' },
    ],
    prompt_positive_order: ['common', 'views', 'background', 'style', 'artist', 'ai', 'characters', 'cf_outfit', 'cf_img2', 'positive'],
    prompt_negative_order: ['negative'],
    positive_weight_plans: { 'smile#0': { mode: 'fixed', min: 1.2, max: 1.2, step: 0.05 } },
};
const nowPrompt = {
    api_prompt: '1girl, solo, pink hair',
    view_tags: 'parts:from above',
    prompt_background: '',
    api_neg_prompt: 'lowres',
    character_slots: [{ key: 'gotoh hitori', weight: 1 }, { key: 'kita ikuyo', weight: 1 }, { key: 'None', weight: 1 }],
    artist_slots: [{ key: '', weight: 1 }],
    prompt_custom_fields: [
        { id: 'cf_mine', name: 'hands', polarity: 'positive', text: 'peace sign' },
        { id: 'cf_mood', name: 'Mood', polarity: 'positive', text: 'melancholy, soft lighting' },
        { id: 'cf_neg', name: 'Neg extra', polarity: 'negative', text: '' },
    ],
    prompt_positive_order: ['common', 'views', 'cf_mine', 'cf_mood', 'positive'],
    prompt_negative_order: ['negative', 'cf_neg'],
    prompt_field_presets: { positive: [{ name: 'x', text: 'y' }] },
    ai_interface: 'Local',
};
const picked = ['rice shower (umamusume)', 'None'];

test('a Random slot takes the character the run picked; the rest stay', () => {
    assert.deepEqual(resolveRandomSlots(imagePrompt.character_slots, picked).map(slot => slot.key), ['rice shower (umamusume)', 'None']);
    assert.deepEqual(resolveRandomSlots([{ key: 'oc:Random' }], ['oc:Alice']).map(slot => slot.key), ['oc:Alice']);
    assert.deepEqual(resolveRandomSlots([{ key: 'Random' }], []).map(slot => slot.key), ['Random'], 'nothing picked: stays Random');
});

test('the fields side by side: same, differs, a new field and a muted one', () => {
    const rows = compareRecipeFields(imagePrompt, nowPrompt, { picked });
    const byName = Object.fromEntries(rows.map(row => [row.name, row]));
    assert.deepEqual(byName.Characters.image, ['rice shower (umamusume)']);
    assert.deepEqual(byName.Characters.now, ['gotoh hitori', 'kita ikuyo']);
    assert.equal(byName.View.status, 'same');
    assert.equal(byName.Positive.status, 'differs');
    assert.equal(byName.Background.status, 'differs');
    assert.equal(byName.Outfit.status, 'new field');
    assert.equal(byName.Hands.status, 'differs', 'matched by name, without regard to case');
    assert.equal(byName.Hands.now, 'peace sign');
    assert.equal(byName.Mood.status, 'muted');
    assert.equal(byName.Mood.image, null);
    assert.equal('Neg extra' in byName, false, 'empty on both sides: left out');
    assert.equal(byName.Artist.image[0], 'ciloranko');
});

test('loading the tags: the image\'s fields, the editor\'s own muted, nothing deleted', () => {
    const next = mergeRecipePrompt(nowPrompt, imagePrompt, { picked });
    assert.equal(next.api_prompt, imagePrompt.api_prompt);
    assert.equal(next.prompt_background, 'cherry blossoms, outdoors');
    assert.equal(next.prompt_style, '', 'a field the image left empty is emptied');
    assert.deepEqual(next.positive_weight_plans, imagePrompt.positive_weight_plans);
    assert.deepEqual(next.character_slots.map(slot => slot.key), ['rice shower (umamusume)', 'None', 'None'], 'the editor\'s third slot stays, emptied');
    assert.deepEqual(next.artist_slots, imagePrompt.artist_slots);
    assert.deepEqual(next.prompt_custom_fields.map(field => [field.id, field.muted === true]), [
        ['cf_outfit', false], ['cf_img2', false], ['cf_mood', true], ['cf_neg', true],
    ], 'Hands replaced the editor\'s "hands"; Mood and Neg extra kept, muted');
    assert.deepEqual(next.prompt_positive_order, [...imagePrompt.prompt_positive_order, 'cf_mood']);
    assert.deepEqual(next.prompt_negative_order, ['negative', 'cf_neg']);
    assert.deepEqual(next.prompt_field_presets, nowPrompt.prompt_field_presets, 'the editor\'s furniture stays');
    assert.equal(next.ai_interface, 'Local', 'the AI card is not the picture');
});

const recipe = buildRecipe({
    sections: {
        prompt: imagePrompt,
        generation: { step: 30, cfg: 4, api_model_sampler: 'euler', api_model_scheduler: 'simple', width: 832, height: 1216, api_image_landscape: false, api_hf_enable: false, regional_condition: false, random_seed: -1, api_model_file_diffusion_select: 'waiANIMA_v10Base10.safetensors' },
        lora: { lora_slot: [['anima-style.safetensors', '0.8', '0.8', 'ALL'], ['gone.safetensors', '0.6', '0.6', 'Base']] },
        adetailer: { api_adetailer_enable: true, ad_slot: [['bbox/face_yolov8m.pt', '0.3', '0', 'center-1']] },
    },
    settings: { api_model_type: 'Diffusion', api_fast_enable: true },
    run: { seed: 1830551274, characters: picked, prose: { applied: true, paragraph: 'Rice Shower stands under the cherry trees.', fields: { characters: [] }, writer: 'student' } },
});
const current = {
    sections: {
        prompt: nowPrompt,
        generation: { step: 30, cfg: 4, api_model_sampler: 'euler', api_model_scheduler: 'simple', width: 1216, height: 832, api_image_landscape: false, api_hf_enable: true, api_hf_scale: 1.5, regional_condition: false, random_seed: -1, api_model_file_diffusion_select: 'waiANIMA_v10Base10.safetensors' },
        lora: { lora_slot: [['anima-style.safetensors', '0.8', '0.8', 'ALL']] },
        adetailer: { api_adetailer_enable: false, ad_slot: [] },
    },
    app: { api_model_type: 'Diffusion', api_fast_enable: true },
};

test('which rows differ', () => {
    assert.equal(rowDiffers('model', recipe, current), false);
    assert.equal(rowDiffers('size', recipe, current), true);
    assert.equal(rowDiffers('regional', recipe, current), false);
    assert.equal(rowDiffers('lora', recipe, current), true);
    assert.equal(rowDiffers('seed', recipe, current), true);
});

test('a LoRA the editor does not have is marked; an unknown list blocks nothing', () => {
    assert.deepEqual(recipeLoraRows(recipe, ['anima-style.safetensors', 'dmd2.safetensors']).map(row => [row.name, row.found]),
        [['anima-style.safetensors', true], ['gone.safetensors', false]]);
    assert.ok(recipeLoraRows(recipe, []).every(row => row.found));
});

test('loading writes only the checked rows', () => {
    const plan = planRecipeLoad(recipe, current, ['size', 'seed']);
    assert.deepEqual(Object.keys(plan.sections).sort(), ['adetailer', 'generation']);
    assert.equal(plan.sections.generation.width, 832);
    assert.equal(plan.sections.generation.api_hf_enable, false);
    assert.equal(plan.sections.generation.random_seed, 1830551274);
    assert.equal(plan.sections.generation.step, 30, 'the rest of the section as the editor has it');
    assert.deepEqual(plan.app, {});
    assert.equal(plan.prose, null);

    const all = planRecipeLoad(recipe, current, ['tags', 'prose', 'lora', 'model', 'size', 'regional', 'seed']);
    assert.deepEqual(all.app, { api_model_type: 'Diffusion', api_fast_enable: true });
    assert.deepEqual(all.sections.lora.lora_slot, recipe.sections.lora.lora_slot);
    assert.equal(all.sections.prompt.ai_prose_enable, true, 'the paragraph needs Prose on');
    assert.deepEqual(all.prose, { paragraph: 'Rice Shower stands under the cherry trees.', fields: { characters: [] } });
    assert.equal(all.sections.prompt.api_prompt, imagePrompt.api_prompt);
});

test('an image with only its parameters text still loads: the prompt, sampler, size, seed and LoRA', () => {
    const partial = recipeFromParameters([
        'rice shower \\(umamusume\\), 1girl, smile',
        '<lora:anima-style.safetensors:0.7:0.7>',
        'Negative prompt: lowres',
        'Steps: 28, Sampler: Euler a, Schedule type: Karras, CFG scale: 6, Seed: 77, Size: 832x1216, Model: waiIllustriousSDXL_v160',
    ].join('\n'), { checkpoints: ['waiIllustriousSDXL_v160.safetensors'] });
    assert.equal(partial.partial, true);
    assert.equal(partial.sections.prompt.api_prompt, 'rice shower \\(umamusume\\), 1girl, smile');
    assert.deepEqual(partial.sections.prompt.character_slots, [{ key: 'None', weight: 1 }], 'the characters are in the positive already');
    assert.deepEqual([partial.sections.generation.api_model_sampler, partial.sections.generation.api_model_scheduler], ['euler_ancestral', 'karras']);
    assert.equal(partial.sections.generation.api_model_file_select, 'waiIllustriousSDXL_v160.safetensors');
    assert.equal(partial.app.api_model_type, 'Checkpoint');
    assert.deepEqual(partial.sections.lora.lora_slot, [['anima-style.safetensors', '0.7', '0.7', 'ALL']]);
    assert.equal(partial.run.seed, 77);
    const plan = planRecipeLoad(partial, current, ['tags', 'seed']);
    assert.deepEqual(plan.sections.prompt.character_slots.map(slot => slot.key), ['None', 'None', 'None']);
    assert.equal(plan.sections.generation.random_seed, 77);
});
