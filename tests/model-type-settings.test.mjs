import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ANIMA_DEFAULTS, CHECKPOINT_DEFAULTS, GENERATION_KEYS, WEBUI_SAMPLER_NAMES, WEBUI_SCHEDULER_NAMES, generationFor, rememberGeneration, snapshotGeneration } from '../scripts/shared/modelTypeSettings.js';
import { DEFAULT_SETTINGS, SECTION_KEYS, normalizeSection } from '../scripts/shared/settingsSections.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

const checkpoint = { api_model_sampler: 'euler_ancestral', api_model_scheduler: 'karras', step: 28, cfg: 5, width: 832, height: 1216, api_image_landscape: false, api_hf_enable: true, api_hf_scale: 1.5, api_hf_denoise: 0.4, api_hf_steps: 20, api_hf_upscaler_selected: '4x-UltraSharp', regional_condition: true, random_seed: 3 };

test('snapshotGeneration keeps only the generation keys', () => {
    const snapshot = snapshotGeneration(checkpoint);
    assert.deepEqual(Object.keys(snapshot).sort(), [...GENERATION_KEYS].sort());
    assert.equal(snapshot.random_seed, undefined);
    assert.deepEqual(snapshotGeneration({ step: 12 }), { step: 12 });
});

test('rememberGeneration stores a snapshot under the type and leaves the other type alone', () => {
    const store = rememberGeneration({ Diffusion: { step: 30 } }, 'Checkpoint', checkpoint);
    assert.deepEqual(store.Diffusion, { step: 30 });
    assert.equal(store.Checkpoint.step, 28);
    assert.equal(store.Checkpoint.random_seed, undefined);
    // unknown types and broken stores
    assert.deepEqual(rememberGeneration('nope', 'Other', checkpoint), {});
});

test('generationFor returns the stored entry, else the type\'s own defaults with Hires off', () => {
    const store = { Checkpoint: snapshotGeneration(checkpoint), Diffusion: { step: 30, cfg: 4.5, junk: 1 } };
    assert.deepEqual(generationFor(store, 'Checkpoint', {}), snapshotGeneration(checkpoint));
    assert.deepEqual(generationFor(store, 'Diffusion', {}), { step: 30, cfg: 4.5 });
    // first time on Diffusion: Anima defaults, orientation kept, the checkpoint's Hires not carried over
    assert.deepEqual(generationFor({}, 'Diffusion', { width: 832, height: 1216 }), { ...ANIMA_DEFAULTS, width: 832, height: 1216, api_hf_enable: false });
    assert.deepEqual(generationFor({}, 'Diffusion', { width: 1024, height: 768 }), { ...ANIMA_DEFAULTS, width: 1216, height: 832, api_hf_enable: false });
    // first time on Checkpoint: the checkpoint defaults, not the diffusion model's sampler / CFG / Hires;
    // the current size stays (the Size range clamps it)
    const fromDiffusion = generationFor({ Diffusion: { step: 30 } }, 'Checkpoint', { api_model_sampler: 'er_sde', cfg: 4.5, width: 1216, height: 832, api_hf_enable: true });
    assert.deepEqual(fromDiffusion, { ...CHECKPOINT_DEFAULTS, api_hf_enable: false });
    for (const key of Object.keys(CHECKPOINT_DEFAULTS)) assert.equal(CHECKPOINT_DEFAULTS[key], DEFAULT_SETTINGS[key], `${key} matches the app default`);
    assert.equal(DEFAULT_SETTINGS.api_hf_enable, false);
    // every value handed out is a generation key (applyGenerationSettings pushes only those)
    for (const values of [fromDiffusion, generationFor({}, 'Diffusion', {})]) {
        for (const key of Object.keys(values)) assert.ok(GENERATION_KEYS.includes(key), key);
    }
});

test('the defaults come out in the selected backend\'s sampler names', () => {
    // ComfyUI (and anything else) keeps the names as written
    assert.equal(generationFor({}, 'Checkpoint', { api_interface: 'ComfyUI' }).api_model_sampler, CHECKPOINT_DEFAULTS.api_model_sampler);
    assert.equal(generationFor({}, 'Diffusion', { api_interface: 'ComfyUI' }).api_model_scheduler, ANIMA_DEFAULTS.api_model_scheduler);
    // WebUI spells them differently, and a name its dropdown cannot find would leave the box
    // on its first entry while the setting said something else (language.js SAMPLER_WEBUI)
    const checkpoint = generationFor({}, 'Checkpoint', { api_interface: 'WebUI' });
    assert.equal(checkpoint.api_model_sampler, 'Euler a');
    assert.equal(checkpoint.api_model_scheduler, 'Normal');
    const diffusion = generationFor({}, 'Diffusion', { api_interface: 'WebUI', width: 1024, height: 768 });
    assert.equal(diffusion.api_model_sampler, 'ER SDE');
    assert.equal(diffusion.api_model_scheduler, 'Simple');
    assert.equal(diffusion.width, 1216, 'the rest of the defaults is unchanged');
    // every translated name exists in the WebUI lists the dropdown is filled with
    const language = read('scripts/renderer/language.js');
    for (const name of [...Object.values(WEBUI_SAMPLER_NAMES), ...Object.values(WEBUI_SCHEDULER_NAMES)]) {
        assert.ok(language.includes(`"${name}"`), `${name} is in language.js`);
    }
    // a stored entry is handed back as it is: it was written under the backend it belongs to
    const stored = { Checkpoint: { api_model_sampler: 'euler_ancestral' } };
    assert.equal(generationFor(stored, 'Checkpoint', { api_interface: 'WebUI' }).api_model_sampler, 'euler_ancestral');
});

test('the store is an app-section setting (beside the type, outside undo) that survives normalisation', () => {
    assert.ok(SECTION_KEYS.app.includes('model_type_generation'));
    assert.ok(!SECTION_KEYS.generation.includes('model_type_generation'));
    const kept = normalizeSection('app', { model_type_generation: { Checkpoint: { step: 28 } } });
    assert.deepEqual(kept.model_type_generation, { Checkpoint: { step: 28 } });
    assert.deepEqual(normalizeSection('app', { model_type_generation: 'nope' }).model_type_generation, {});
});

test('a model type switch stores the values being left and applies the ones for the type entered', () => {
    const callbacks = read('scripts/renderer/callbacks.js');
    assert.match(callbacks, /SETTINGS\.model_type_generation = rememberGeneration\(SETTINGS\.model_type_generation, previous, SETTINGS\);/);
    assert.match(callbacks, /applyGenerationSettings\(generationFor\(SETTINGS\.model_type_generation, value, SETTINGS\)\);/);
    assert.match(callbacks, /export function applyGenerationSettings\(values = \{\}\)/);
    for (const key of GENERATION_KEYS) assert.match(callbacks, new RegExp(`'${key}' in values`), `${key} is pushed to its control`);
});
