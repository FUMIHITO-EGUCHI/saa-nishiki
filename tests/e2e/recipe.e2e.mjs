// The recipe and the time, end to end: one image from the real app on the real local
// ComfyUI is saved with the "saa_recipe" and "saa_time" text chunks, the viewer's Info
// tab shows the time and the recipe, and Use settings… loads it back.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import zlib from 'node:zlib';

import { freshSeed, launchApp } from './harness.mjs';
import { readTextChunks } from '../../scripts/shared/pngText.js';

let app = null;

test.before(async () => { app = await launchApp(); });
test.after(async () => { await app?.close(); });

test('an image is saved with its recipe and time, and the Info tab shows them', async () => {
    const { page } = app;
    await app.typePositive('1girl, solo, smile, cherry blossoms');
    const seed = freshSeed() + 11;
    await app.setSeed(seed);
    const run = await app.generate({ expectImages: 1 });
    assert.equal(run.error, '');

    const record = JSON.parse(await page.evaluate(`JSON.stringify(globalThis.mainGallery.currentEntry().record)`));
    assert.ok(record.path, 'the saved file is known');
    assert.equal(record.recipe.run.seed, seed);
    assert.ok(record.timing.total > 0);

    const { records } = readTextChunks(fs.readFileSync(record.path), { inflate: zlib.inflateSync });
    const recipe = JSON.parse(records.saa_recipe);
    assert.equal(recipe.run.seed, seed);
    assert.equal(recipe.sections.prompt.api_prompt, '1girl, solo, smile, cherry blossoms');
    assert.ok(JSON.parse(records.saa_time).segments.some(segment => segment.id === 'base'), 'the base pass is timed');
    assert.ok(records.parameters, 'the saver\'s own parameters text is still there');

    await page.evaluate(`document.querySelector('[data-info-tab="info"]').click()`);
    await page.waitFor(`Boolean(document.querySelector('.viewer-time-total'))`, { label: 'the Info tab' });
    assert.match(await page.evaluate(`document.querySelector('.viewer-time-total').textContent`), /\d+(\.\d)? s|min/);
    assert.match(await page.evaluate(`document.getElementById('viewer-recipe-badge').textContent`), /SAA recipe v1/);
    assert.equal(await page.evaluate(`document.querySelector('.viewer-recipe-seed').textContent`), String(seed));
});

test('Use settings… loads the image\'s prompt back into the editor, and its notice undoes it', async () => {
    const { page } = app;
    await app.typePositive('1girl, pink hair, guitar');
    await page.evaluate(`document.querySelector('.viewer-recipe-actions .viewer-primary-button').click()`);
    await page.waitFor(`Boolean(document.querySelector('.use-settings-modal:not([hidden]) .use-settings-row'))`, { label: 'the Use settings dialog' });
    const rows = JSON.parse(await page.evaluate(`JSON.stringify([...document.querySelectorAll('.use-settings-row')].map(row => [row.dataset.row, row.querySelector('input').checked]))`));
    assert.deepEqual(rows.find(([id]) => id === 'tags'), ['tags', true], 'the tags differ, so they start checked');
    assert.deepEqual(rows.find(([id]) => id === 'seed'), ['seed', false], 'the seed starts unchecked');
    await page.click('.use-settings-modal .selection-modal-apply');
    await page.waitFor(`globalThis.globalSettings.api_prompt === '1girl, solo, smile, cherry blossoms'`, { label: 'the prompt loaded' });
    await page.waitFor(`Boolean(document.querySelector('.use-settings-notice-undo'))`, { label: 'the notice' });
    await page.click('.use-settings-notice-undo');
    await page.waitFor(`globalThis.globalSettings.api_prompt === '1girl, pink hair, guitar'`, { label: 'the prompt put back' });
});
