// The run bar's Size ratio chip, end to end: an old Landscape setting is folded into the
// boxes, the chip turns the size, a ratio picked keeps the pixels and reaches ComfyUI as
// the latent size, the chain makes one box follow the other and lets go of it.
// Real app, real local ComfyUI (`npm run test:e2e`).
import assert from 'node:assert/strict';
import test from 'node:test';

import { launchApp, workflow } from './harness.mjs';

let app = null;

// settings from before the chip: a portrait size with the Landscape switch on
test.before(async () => { app = await launchApp({ settings: { width: 512, height: 640, api_image_landscape: true } }); });
test.after(async () => { await app?.close(); });

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const size = () => app.page.evaluate(`[globalThis.generate.width.getValue(), globalThis.generate.height.getValue()]`);
const chipLabel = () => app.page.evaluate(`document.querySelector('#run-ratio .run-ratio-label').textContent`);

// a Size box typed into as a person types, left with Tab
async function typeSize(axis, value) {
    const { page } = app;
    const input = `.generate-${axis} input[type="number"]`;
    await page.click(input);
    await page.evaluate(`document.querySelector(${JSON.stringify(input)}).select()`);
    await page.type(String(value));
    await page.evaluate(`document.querySelector(${JSON.stringify(input)}).blur()`);
    await sleep(100);
}

test('the chip turns the size, a ratio keeps the pixels and is what ComfyUI samples, the chain follows and lets go', async () => {
    const { page } = app;
    await page.waitFor(`document.querySelector('#run-ratio .run-ratio-label')?.textContent === '4:5'`, { label: 'the chip read from the size' });
    assert.deepEqual(await size(), [640, 512], 'the old Landscape switch is folded into the boxes');
    assert.equal(await app.setting('api_image_landscape'), false, 'and stays off');

    await page.click('#run-ratio-turn');
    assert.deepEqual(await size(), [512, 640], 'the left half of the chip turns the size');

    await page.click('#run-ratio-pick');
    await page.waitFor(`!document.getElementById('run-ratio-popover').hidden`, { label: 'the ratio tiles' });
    const tiles = await page.evaluate(`[...document.querySelectorAll('.run-ratio-tile-label')].map(node => node.textContent)`);
    assert.deepEqual(tiles, ['1:1', '4:5', '3:4', 'A4', '2:3', 'Golden', '9:16', 'Free']);
    await page.evaluate(`[...document.querySelectorAll('.run-ratio-tile')].find(tile => tile.textContent.includes('A4')).click()`);
    assert.equal(await page.evaluate(`document.getElementById('run-ratio-popover').hidden`), true, 'a tile picked closes the tiles');
    // 512 × 640 has 327,680 px; A4 at that count would be 481 wide, under the 512 floor,
    // so the short side stops at 512 and the long side keeps 1:√2
    assert.deepEqual(await size(), [512, 728]);
    assert.equal(await chipLabel(), 'A4');
    assert.equal(await app.setting('api_image_ratio'), 'a4');

    const run = await app.generate({ expectImages: 1 });
    assert.equal(run.error, '');
    assert.equal(run.history.length, 1);
    const { workflow: wf, outputs } = run.history[0];
    assert.deepEqual(workflow.latentSize(wf, outputs), { width: 512, height: 728, batch: 1 }, 'ComfyUI samples the size the chip set');

    await typeSize('height', 768);
    assert.deepEqual(await size(), [544, 768], 'linked: the width follows the height at 1:√2');

    await page.click('#run-ratio-chain');
    assert.equal(await chipLabel(), 'Free');
    assert.equal(await app.setting('api_image_ratio_linked'), false);
    await typeSize('width', 600);
    assert.deepEqual(await size(), [600, 768], 'Free: the height stays where it was');

    await page.click('#run-ratio-chain');
    assert.deepEqual(await size(), [600, 848], 'linked again: the height follows the width at the last ratio');
    assert.equal(await chipLabel(), 'A4');

    await page.evaluate(`globalThis.editHistory.undo()`);
    await sleep(200);
    assert.deepEqual(await size(), [600, 768], 'one undo takes back the relink, size and chain together');
    assert.equal(await chipLabel(), 'Free');
});
