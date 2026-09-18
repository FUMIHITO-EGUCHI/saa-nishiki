import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { DEFAULT_SIZE_LIMITS, SIZE_HARD_MAX, SIZE_LIMIT_STEP, SIZE_MIN, formatSizeRange, isOutOfRange, sizeRangeFor } from '../scripts/shared/sizeLimits.js';
import { resolveSliderValue } from '../scripts/shared/sliderValue.js';
import { DEFAULT_SETTINGS, SECTION_KEYS } from '../scripts/shared/settingsSections.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('a checkpoint samples 512–1536 by default, a diffusion model 512–2048', () => {
    assert.deepEqual(sizeRangeFor({ api_model_type: 'Checkpoint' }), { min: 512, max: 1536, step: 8 });
    assert.deepEqual(sizeRangeFor({ api_model_type: 'Diffusion' }), { min: 512, max: 2048, step: 8 });
    assert.equal(sizeRangeFor({}).max, DEFAULT_SIZE_LIMITS.Checkpoint, 'no type reads as a checkpoint');
});

test('the per-type limit setting raises or lowers the upper bound', () => {
    assert.equal(sizeRangeFor({ api_model_type: 'Checkpoint', size_limit_checkpoint: 2048 }).max, 2048);
    assert.equal(sizeRangeFor({ api_model_type: 'Diffusion', size_limit_diffusion: 1536 }).max, 1536);
    // the other type's limit does not leak across
    assert.equal(sizeRangeFor({ api_model_type: 'Checkpoint', size_limit_diffusion: 4096 }).max, 1536);
});

test('a limit setting is snapped to the limit grid and kept inside the hard bounds', () => {
    // the Settings box snaps the same way (step SIZE_LIMIT_STEP from SIZE_MIN), so both land on 1472
    assert.equal(sizeRangeFor({ size_limit_checkpoint: 1500 }).max, 1472);
    assert.equal(resolveSliderValue(1500, { min: SIZE_MIN, max: SIZE_HARD_MAX, step: SIZE_LIMIT_STEP }), 1472);
    assert.equal(sizeRangeFor({ size_limit_diffusion: 2048, api_model_type: 'Diffusion' }).max, 2048, 'the defaults sit on the grid');
    assert.match(fs.readFileSync(path.join(root, 'scripts/renderer.js'), 'utf8'), /step:SIZE_LIMIT_STEP, defaultValue:SETTINGS\.size_limit_checkpoint[\s\S]*step:SIZE_LIMIT_STEP, defaultValue:SETTINGS\.size_limit_diffusion/);
    assert.equal(sizeRangeFor({ size_limit_checkpoint: 99999 }).max, SIZE_HARD_MAX);
    assert.equal(sizeRangeFor({ size_limit_checkpoint: 100 }).max, SIZE_MIN);
    assert.equal(sizeRangeFor({ size_limit_checkpoint: 'abc' }).max, 1536, 'garbage falls back to the default');
});

test('the label reads min–max', () => {
    assert.equal(formatSizeRange(sizeRangeFor({ api_model_type: 'Checkpoint' })), '512–1536');
});

test('typed values outside the range are flagged; blanks and mid-edits are not', () => {
    const range = sizeRangeFor({ api_model_type: 'Checkpoint' });
    assert.equal(isOutOfRange('2048', range), true);
    assert.equal(isOutOfRange(500, range), true);
    assert.equal(isOutOfRange('1024', range), false);
    assert.equal(isOutOfRange('', range), false);
    assert.equal(isOutOfRange('abc', range), false);
});

test('confirming an over-limit size lands on the limit itself', () => {
    const range = sizeRangeFor({ api_model_type: 'Checkpoint' });
    assert.equal(resolveSliderValue('2048', range), 1536);
    assert.equal(resolveSliderValue('500', range), 512);
});

test('the limit settings ship as defaults in the app section', () => {
    assert.equal(DEFAULT_SETTINGS.size_limit_checkpoint, 1536);
    assert.equal(DEFAULT_SETTINGS.size_limit_diffusion, 2048);
    assert.ok(SECTION_KEYS.app.includes('size_limit_checkpoint'));
    assert.ok(SECTION_KEYS.app.includes('size_limit_diffusion'));
});

test('4096 a side is the ceiling of the limit setting itself', () => {
    assert.equal(sizeRangeFor({ size_limit_checkpoint: 4096 }).max, 4096, 'the ceiling itself is allowed');
    assert.equal(sizeRangeFor({ size_limit_checkpoint: 4160 }).max, 4096, 'one grid step past it comes back to the ceiling');
    assert.equal(sizeRangeFor({ api_model_type: 'Diffusion', size_limit_diffusion: 6000 }).max, 4096);
    assert.equal(resolveSliderValue(6000, { min: SIZE_MIN, max: SIZE_HARD_MAX, step: SIZE_LIMIT_STEP }), 4096, 'the Settings box stops there too');
    assert.equal(isOutOfRange(4097, sizeRangeFor({ size_limit_checkpoint: 4096 })), true);
});
