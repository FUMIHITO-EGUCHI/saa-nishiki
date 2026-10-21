import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { prepareEdit, compositeEdit, readOriginal } from '../scripts/main/imageEditPixels.js';
const png = (bytes, width, height, channels) => sharp(Buffer.from(bytes), { raw: { width, height, channels } }).png().toBuffer();
test('save and decode preserves every locked or unpermitted pixel, including alpha', async () => {
    const original = await png([10,20,30,200, 40,50,60,255, 70,80,90,0, 100,110,120,100], 2, 2, 4);
    const mask = await png([255,255,255,0], 2, 2, 1);
    const lock = await png([0,255,0,0], 2, 2, 1);
    const prepared = await prepareEdit(original, mask, lock, { padding: 0, feather: 0 });
    const candidate = await png(new Array(prepared.crop.width*prepared.crop.height*4).fill(255), prepared.crop.width, prepared.crop.height, 4);
    const result = await compositeEdit(original, candidate, prepared);
    const after = await readOriginal(result.image);
    const before = await readOriginal(original);
    for (const p of [1,3]) assert.deepEqual(after.data.subarray(p*4,p*4+4), before.data.subarray(p*4,p*4+4));
    assert.equal(result.verification.protectedChangedPixels, 0);
    assert.equal(result.verification.protectedMaxDifference, 0);
    assert.ok(result.verification.changedPixels > 0);
});
test('empty and fully locked masks are no-ops, dimensions are checked', async () => {
    const original = await png(new Array(12).fill(40), 2, 2, 3);
    const empty = await png([0,0,0,0], 2, 2, 1);
    const full = await png([255,255,255,255], 2, 2, 1);
    assert.equal((await prepareEdit(original, empty, empty)).empty, true);
    assert.equal((await prepareEdit(original, full, full)).empty, true);
    await assert.rejects(prepareEdit(original, await png([255],1,1,1), empty), /dimensions/);
});
test('edge crop returns at its original coordinates and feather never leaks', async () => {
    const original = await png(new Array(5*4*3).fill(55), 5,4,3);
    const values = new Array(20).fill(0); values[19]=255;
    const prepared = await prepareEdit(original, await png(values,5,4,1), null, { padding: 1, feather: 1 });
    assert.deepEqual(prepared.crop, { x:3,y:2,width:2,height:2 });
    const result = await compositeEdit(original, await png(new Array(12).fill(200),2,2,3), prepared);
    assert.equal(result.verification.changedPixels, 1);
    assert.equal(result.verification.protectedChangedPixels, 0);
});
