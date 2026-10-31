import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeSection } from '../scripts/shared/settingsSections.js';
import { buildRecipe, parseRecipe } from '../scripts/shared/recipe.js';
import { planRecipeLoad } from '../scripts/shared/recipeApply.js';

test('single-choice sampler values from older settings are recovered without falling back', () => {
    const saved=normalizeSection('generation',{api_model_sampler:['euler_cfg_pp'],api_model_scheduler:['karras']});
    assert.equal(saved.api_model_sampler,'euler_cfg_pp');
    assert.equal(saved.api_model_scheduler,'karras');
});
test('ADetailer prompt mode and zero seed survive settings, PNG recipe and Use settings', () => {
    const adetailer=normalizeSection('adetailer',{api_adetailer_enable:true,api_adetailer_prompt_mode:'empty',api_adetailer_seed:0});
    assert.equal(adetailer.api_adetailer_prompt_mode,'empty');
    assert.equal(adetailer.api_adetailer_seed,0);
    const recipe=parseRecipe(JSON.stringify(buildRecipe({sections:{adetailer},run:{seed:42}})));
    const applied=planRecipeLoad(recipe,{sections:{}},['size']);
    assert.equal(applied.sections.adetailer.api_adetailer_prompt_mode,'empty');
    assert.equal(applied.sections.adetailer.api_adetailer_seed,0);
});
test('ADetailer defaults inherit, while invalid modes and seeds are normalized', () => {
    const defaults=normalizeSection('adetailer',{});
    assert.equal(defaults.api_adetailer_prompt_mode,'inherit');
    assert.equal(defaults.api_adetailer_seed,-1);
    for(const seed of [-2,1.5,4294967296])assert.equal(normalizeSection('adetailer',{api_adetailer_seed:seed}).api_adetailer_seed,-1);
    assert.equal(normalizeSection('adetailer',{api_adetailer_prompt_mode:'unknown'}).api_adetailer_prompt_mode,'inherit');
});
test('old non-Fast PNGs restore the actually sent sampler without mutating the source', () => {
    const source={v:1,sections:{generation:{api_model_sampler:'euler_ancestral',api_model_scheduler:'normal'}},app:{api_fast_enable:false},run:{sent:{sampler:'euler_cfg_pp',scheduler:'karras'}}};
    const parsed=parseRecipe(source);
    assert.equal(parsed.sections.generation.api_model_sampler,'euler_cfg_pp');
    assert.equal(parsed.sections.generation.api_model_scheduler,'karras');
    assert.equal(source.sections.generation.api_model_sampler,'euler_ancestral');
    assert.equal(parseRecipe({...source,app:{api_fast_enable:true}}).sections.generation.api_model_sampler,'euler_ancestral');
});
test('older image recipes explicitly retain empty ADetailer conditioning when loaded', () => {
    const parsed=parseRecipe({v:1,sections:{adetailer:{api_adetailer_enable:true}},run:{seed:42}});
    assert.equal(parsed.sections.adetailer.api_adetailer_prompt_mode,'empty');
    assert.equal(parsed.sections.adetailer.api_adetailer_seed,-1);
});
