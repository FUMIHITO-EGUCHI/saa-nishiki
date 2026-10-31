import test from 'node:test';
import assert from 'node:assert/strict';

import { RATIOS, findRatio, fitsRatio, followSize, nearestRatio, ratioById, settleRatio, sizeAtArea } from '../scripts/shared/sizeRatio.js';

const range = { min: 512, max: 1536, step: 8 };
const a4 = ratioById('a4');

test('the picker offers 1:1, 4:5, 3:4, A4, 2:3, Golden and 9:16, A4 being 1:√2', () => {
    assert.deepEqual(RATIOS.map(ratio => ratio.label), ['1:1', '4:5', '3:4', 'A4', '2:3', 'Golden', '9:16']);
    assert.equal(a4.long, Math.SQRT2);
    assert.equal(ratioById('golden').long, (1 + Math.sqrt(5)) / 2);
});

test('a ratio picked keeps the pixels the size has, on the 8 px grid, in the orientation asked', () => {
    assert.deepEqual(sizeAtArea(a4, 1024 * 1024, false, range), { width: 856, height: 1216 });
    assert.deepEqual(sizeAtArea(a4, 1024 * 1024, true, range), { width: 1216, height: 856 });
    assert.deepEqual(sizeAtArea(ratioById('1-1'), 856 * 1216, false, range), { width: 1024, height: 1024 });
    for (const ratio of RATIOS) {
        const size = sizeAtArea(ratio, 1024 * 1024, false, range);
        assert.equal(size.width % 8, 0);
        assert.equal(size.height % 8, 0);
        assert.ok(fitsRatio(ratio, size.width, size.height), `${ratio.label} fits its own size`);
    }
});

test('a ratio whose long side would pass the range stops at the bound with the ratio kept', () => {
    const size = sizeAtArea(ratioById('9-16'), 1400 * 1400, false, range);
    assert.equal(size.height, 1536);
    assert.equal(size.width, 864);
    assert.ok(fitsRatio(ratioById('9-16'), size.width, size.height));
});

test('typing one side moves the other along the ratio; at the range the typed side is pulled back', () => {
    assert.deepEqual(followSize(a4, false, 'width', 800, range), { width: 800, height: 1128 });
    assert.deepEqual(followSize(a4, false, 'height', 1024, range), { width: 728, height: 1024 });
    assert.deepEqual(followSize(a4, true, 'width', 1216, range), { width: 1216, height: 856 });
    // 1200 wide in A4 portrait would be 1697 tall: the height stops at 1536, the width comes back to match
    assert.deepEqual(followSize(a4, false, 'width', 1200, range), { width: 1088, height: 1536 });
    // too small: the follower stops at 512 and the typed side grows to keep the ratio
    assert.deepEqual(followSize(a4, true, 'width', 600, range), { width: 728, height: 512 });
});

test('a size fits a ratio when it is what the grid gives for it, in either orientation', () => {
    assert.ok(fitsRatio(a4, 864, 1216));
    assert.ok(fitsRatio(a4, 1216, 864));
    assert.ok(fitsRatio(a4, 728, 1024), 'a hand-made 728×1024 reads as A4');
    assert.equal(findRatio(1024, 1360)?.id, '3-4', 'the default size is 3:4');
    assert.equal(findRatio(832, 1216), null, 'the SDXL 832×1216 bucket is none of them');
    assert.equal(findRatio(1024, 1024)?.id, '1-1');
    assert.equal(nearestRatio(832, 1216).id, '2-3');
});

test('the shown ratio follows the size: kept while it fits, else the one that fits, else Free', () => {
    assert.deepEqual(settleRatio({ width: 864, height: 1216, ratioId: 'a4', linked: true }), { ratioId: 'a4', linked: true });
    assert.deepEqual(settleRatio({ width: 1024, height: 1024, ratioId: 'a4', linked: true }), { ratioId: '1-1', linked: true });
    assert.deepEqual(settleRatio({ width: 832, height: 1216, ratioId: 'a4', linked: true }), { ratioId: 'a4', linked: false }, 'Free keeps A4 to link back to');
    assert.deepEqual(settleRatio({ width: 1024, height: 1024, ratioId: 'a4', linked: false }), { ratioId: 'a4', linked: false }, 'Free stays Free');
    assert.deepEqual(settleRatio({ width: 1024, height: 1360, ratioId: '', linked: true }), { ratioId: '3-4', linked: true }, 'nothing chosen yet: taken from the size');
    assert.deepEqual(settleRatio({ width: 832, height: 1216, ratioId: '', linked: true }), { ratioId: '', linked: false });
});
