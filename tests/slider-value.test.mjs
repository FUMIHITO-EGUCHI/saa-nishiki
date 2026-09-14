import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveSliderValue } from '../scripts/shared/sliderValue.js';

const SIZE = { min: 512, max: 2048, step: 8 };

test('a size typed below the minimum is lifted to it instead of being dropped', () => {
    assert.equal(resolveSliderValue('500', SIZE), 512);
    assert.equal(resolveSliderValue(5, SIZE), 512);
});

test('a size above the maximum is capped', () => {
    assert.equal(resolveSliderValue('4096', SIZE), 2048);
});

test('in-range sizes snap to the step grid', () => {
    assert.equal(resolveSliderValue('1000', SIZE), 1000);
    assert.equal(resolveSliderValue('1001', SIZE), 1000);
    assert.equal(resolveSliderValue('1005', SIZE), 1008);
    assert.equal(resolveSliderValue(2047, SIZE), 2048);
});

test('float steps keep the step precision', () => {
    const CFG = { min: 0, max: 20, step: 0.01 };
    assert.equal(resolveSliderValue('7.123', CFG), 7.12);
    assert.equal(resolveSliderValue('25', CFG), 20);
    assert.equal(resolveSliderValue(-1, CFG), 0);
});

test('non-numeric input resolves to null', () => {
    assert.equal(resolveSliderValue('', SIZE), null);
    assert.equal(resolveSliderValue('abc', SIZE), null);
    assert.equal(resolveSliderValue(undefined, SIZE), null);
});

test('the seed range (-1 .. 2^32) passes through unchanged', () => {
    const SEED = { min: -1, max: 4294967295, step: 1 };
    assert.equal(resolveSliderValue('-1', SEED), -1);
    assert.equal(resolveSliderValue('331659210', SEED), 331659210);
});
