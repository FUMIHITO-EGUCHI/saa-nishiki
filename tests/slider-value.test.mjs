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

test('the step grid is measured from the minimum, not from zero', () => {
    // 1, 5, 9, 13 ... - the grid of a 1..100 / 4 box, where 8 is not a value it can hold
    assert.equal(resolveSliderValue(10, { min: 1, max: 100, step: 4 }), 9);
    assert.equal(resolveSliderValue(2, { min: 1, max: 100, step: 4 }), 1);
});

test('a grid the maximum does not sit on steps back down instead of overshooting it', () => {
    // 0, 4, 8, 12 ... - 12 is past the maximum, so the top of the box is 8
    assert.equal(resolveSliderValue(10, { min: 0, max: 10, step: 4 }), 8);
    assert.equal(resolveSliderValue(2047, { min: 512, max: 2047, step: 8 }), 2040);
});

test('a step that is no step leaves the value where the clamp put it', () => {
    assert.equal(resolveSliderValue(7.4, { min: 0, max: 10, step: 0 }), 7, 'an integer step still truncates');
    assert.equal(resolveSliderValue(7.4, { min: 0, max: 10, step: Number.NaN }), 7.4);
    assert.equal(resolveSliderValue(7.4, { min: 0, max: 10, step: Number.POSITIVE_INFINITY }), 7.4);
    // a grid can only be walked forwards: a negative step is no grid at all
    assert.equal(resolveSliderValue(10, { min: 0, max: 10, step: -4 }), 10, 'the clamp is all that is left');
});

test('float steps snap onto the grid and keep the precision the step has', () => {
    const QUARTER = { min: 0, max: 1, step: 0.25 };
    assert.equal(resolveSliderValue(0.3, QUARTER), 0.25);
    assert.equal(resolveSliderValue(0.4, QUARTER), 0.5);
    // 3 x 0.1 is 0.30000000000000004 in binary; what the box holds is 0.3
    assert.equal(resolveSliderValue(0.3, { min: 0, max: 1, step: 0.1 }), 0.3);
    assert.equal(resolveSliderValue(0.07, { min: 0, max: 1, step: 0.001 }), 0.07);
});

test('without a range the box behaves like a 0 .. 255 / 1 control', () => {
    assert.equal(resolveSliderValue('300'), 255);
    assert.equal(resolveSliderValue('-5'), 0);
    assert.equal(resolveSliderValue('7.6'), 8);
});

test('anything that is not a finite number is no value at all', () => {
    assert.equal(resolveSliderValue(Number.NaN, SIZE), null);
    assert.equal(resolveSliderValue(Number.POSITIVE_INFINITY, SIZE), null);
    assert.equal(resolveSliderValue(null, SIZE), null);
    assert.equal(resolveSliderValue(true, SIZE), null, 'a boolean is not parsed as a number');
    // what a number box hands over is a string, and a trailing unit is still a size
    assert.equal(resolveSliderValue(' 1024px ', SIZE), 1024);
});
