import test from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_SIZE_LIMITS, SIZE_HARD_MAX, SIZE_MIN, formatSizeRange, isOutOfRange, sizeRangeFor } from '../scripts/shared/sizeLimits.js';
import { resolveSliderValue } from '../scripts/shared/sliderValue.js';
import { DEFAULT_SETTINGS, SECTION_KEYS } from '../scripts/shared/settingsSections.js';

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

test('a limit setting is snapped to the step and kept inside the hard bounds', () => {
    assert.equal(sizeRangeFor({ size_limit_checkpoint: 1500 }).max, 1504);
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

test('the limit settings ship as defaults in the api section', () => {
    assert.equal(DEFAULT_SETTINGS.size_limit_checkpoint, 1536);
    assert.equal(DEFAULT_SETTINGS.size_limit_diffusion, 2048);
    assert.ok(SECTION_KEYS.app.includes('size_limit_checkpoint'));
    assert.ok(SECTION_KEYS.app.includes('size_limit_diffusion'));
});
