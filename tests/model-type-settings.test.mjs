import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ANIMA_DEFAULTS, GENERATION_KEYS, generationFor, rememberGeneration, snapshotGeneration } from '../scripts/shared/modelTypeSettings.js';
import { SECTION_KEYS, normalizeSection } from '../scripts/shared/settingsSections.js';

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

test('generationFor returns the stored entry, else Anima defaults for Diffusion, else nothing', () => {
    const store = { Checkpoint: snapshotGeneration(checkpoint), Diffusion: { step: 30, cfg: 4.5, junk: 1 } };
    assert.deepEqual(generationFor(store, 'Checkpoint', {}), snapshotGeneration(checkpoint));
    assert.deepEqual(generationFor(store, 'Diffusion', {}), { step: 30, cfg: 4.5 });
    // first time on Diffusion: Anima defaults, orientation kept
    assert.deepEqual(generationFor({}, 'Diffusion', { width: 832, height: 1216 }), { ...ANIMA_DEFAULTS, width: 832, height: 1216 });
    assert.deepEqual(generationFor({}, 'Diffusion', { width: 1024, height: 768 }), { ...ANIMA_DEFAULTS, width: 1216, height: 832 });
    // first time on Checkpoint: the current values stay
    assert.deepEqual(generationFor({}, 'Checkpoint', checkpoint), {});
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
