import assert from 'node:assert/strict';
import test from 'node:test';

import { checkNumberInRange, convertToMultipleOfNFloor } from '../scripts/renderer/tools/numbers.js';

// Every ADetailer / post-process number generate.js puts into a workflow passes one of these
// two first, so the range ends and the rounding direction are the contract, not a detail.

test('checkNumberInRange answers the value inside [min, max] and the default outside', () => {
    assert.equal(checkNumberInRange(0.4, 0, 1, 0.3), 0.4);
    assert.equal(checkNumberInRange(1.5, 0, 1, 0.3), 0.3, 'above the maximum');
    assert.equal(checkNumberInRange(-0.5, 0, 1, 0.3), 0.3, 'below the minimum');
    // both ends belong to the range: denoise 0 and denoise 1 are settings a user can pick
    assert.equal(checkNumberInRange(1, 0, 1, 0.3), 1, 'the maximum itself is in range');
    assert.equal(checkNumberInRange(0, 0, 1, 0.3), 0, 'the minimum itself is in range');
    // out of range on one end only is out of range
    assert.equal(checkNumberInRange(512, -512, 512, 4, true), 512);
    assert.equal(checkNumberInRange(513, -512, 512, 4, true), 4);
    assert.equal(checkNumberInRange(-513, -512, 512, 4, true), 4);
});

test('checkNumberInRange rounds only when it is asked to, and rounds down', () => {
    assert.equal(checkNumberInRange(4.7, 0, 64, 4), 4.7, 'by default the value comes back as typed');
    assert.equal(checkNumberInRange(4.7, 0, 64, 4, false), 4.7);
    assert.equal(checkNumberInRange(4.7, 0, 64, 4, true), 4, 'mask_blur is an integer');
    assert.equal(checkNumberInRange(-3.2, -512, 512, 4, true), -4, 'down, not towards zero');
    // the default is answered as it stands: rounding it is not this helper's job
    assert.equal(checkNumberInRange(99.5, 0, 64, 4.5, true), 4.5);
});

test('convertToMultipleOfNFloor floors onto the grid and never leaves ±128', () => {
    assert.equal(convertToMultipleOfNFloor(4, 4), 4, 'a value already on the grid stays');
    assert.equal(convertToMultipleOfNFloor(10, 4), 8, 'down to the next multiple');
    assert.equal(convertToMultipleOfNFloor(-10, 4), -12, 'down, not towards zero');
    assert.equal(convertToMultipleOfNFloor(127, 4), 124);
    // dilate / erode is clamped before the grid, so a huge number lands on the edge of it
    assert.equal(convertToMultipleOfNFloor(5000, 8), 128);
    assert.equal(convertToMultipleOfNFloor(-5000, 8), -128);
    assert.equal(convertToMultipleOfNFloor(1000, 7), 126, 'clamped first, then floored: not 994 capped to 128');
    // ... and clamped again after it, or flooring the edge onto a grid it is not on leaves the range
    assert.equal(convertToMultipleOfNFloor(-128, 3), -128, 'floor(-128 / 3) * 3 is -129');
    assert.equal(convertToMultipleOfNFloor(128, 3), 126);
});
