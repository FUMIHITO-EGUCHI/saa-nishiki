// Parts, end to end: a part made in the editor, its chip in the Positive row, the
// expanded tags reaching ComfyUI, and a sample generated on the mannequin and stored
// beside the settings. Real app, real local ComfyUI (`npm run test:e2e`).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { freshSeed, launchApp, workflow } from './harness.mjs';

let app = null;

test.before(async () => { app = await launchApp(); });
test.after(async () => { await app?.close(); });

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const OPEN_MODAL = '.selection-modal:not([hidden])';

test('the editor makes a part; it is stored as settings/parts.json and the Positive row offers the picker', async () => {
    const { page } = app;
    await page.evaluate(`globalThis.partsUi.openEditor()`);
    await page.waitFor(`Boolean(document.querySelector('.parts-editor-dialog'))`, { label: 'the part editor' });
    await page.evaluate(`(() => {
        const dialog = document.querySelector('.parts-editor-dialog');
        const set = (selector, value) => { const input = dialog.querySelector(selector); input.value = value; input.dispatchEvent(new Event('input', { bubbles: true })); };
        set('.parts-name-input', 'Sailor Uniform');
        dialog.querySelector('.parts-category-select').value = 'outfit';
        set('.parts-tags-input', 'serafuku, (pleated skirt:1.1), ~loafers');
        const generate = dialog.querySelector('.parts-check input');
        if (generate.checked) generate.click();
        dialog.querySelector('.selection-modal-apply').click();
    })()`);
    await page.waitFor(`Boolean(globalThis.partsUi.get('sailor uniform'))`, { label: 'the part in the store' });
    const entry = JSON.parse(await page.evaluate(`JSON.stringify(globalThis.partsUi.get('sailor uniform'))`));
    assert.equal(entry.name, 'Sailor Uniform');
    assert.equal(entry.category, 'outfit');
    assert.equal(entry.tags, 'serafuku, (pleated skirt:1.1), ~loafers');
    assert.equal(entry.samples.length, 0, 'no sample was asked for');
    const file = path.join(app.settingsDir, 'parts.json');
    assert.ok(fs.existsSync(file), `${file} exists`);
    assert.match(fs.readFileSync(file, 'utf8'), /"sailor uniform"/);
    assert.equal(await page.evaluate(`Boolean(document.querySelector('.parts-editor-dialog'))`), false, 'the editor closed');

    // the row's "parts" button opens the row's tag modal on its Parts tab, the new part a tile
    await page.click('.prompt-positive .scene-parts-button');
    await page.waitFor(`document.querySelectorAll('${OPEN_MODAL} .selection-modal-tile').length === 1`, { label: 'the row modal on its Parts tab with one tile' });
    assert.equal(await page.evaluate(`document.querySelector('${OPEN_MODAL} .selection-modal-tab.is-active')?.textContent`), 'Parts');
    assert.equal(await page.evaluate(`document.querySelector('${OPEN_MODAL} .parts-tile-name')?.textContent`), 'parts:Sailor Uniform');
    await page.key('Escape');
    await page.waitFor(`!document.querySelector('${OPEN_MODAL}')`, { label: 'the modal to close' });
});

test('a parts: chip in the Positive row is sent to ComfyUI as the part\'s tags, weights applied, disabled members left out', async () => {
    const { page } = app;
    await app.typePositive('parts:sailor uniform, red eyes');
    await page.evaluate(`(() => {
        const wrapper = document.querySelector('.myTextbox-prompt-positive-textarea').closest('.myTextbox-wrapper');
        const [, chipsButton] = wrapper.querySelectorAll('.tag-view-button');
        chipsButton?.click();
    })()`);
    await page.waitFor(`document.querySelectorAll('.prompt-positive .tag-capsule-chip.is-part').length === 1`, { label: 'the part chip' });
    const chip = JSON.parse(await page.evaluate(`(() => {
        const chip = document.querySelector('.prompt-positive .tag-capsule-chip.is-part');
        return JSON.stringify({ name: chip.querySelector('.tag-capsule-chip-name').textContent, count: chip.querySelector('.tag-capsule-chip-weight').textContent, missing: chip.classList.contains('is-part-missing') });
    })()`));
    assert.equal(chip.name, 'parts:sailor uniform');
    assert.equal(chip.count, '3', 'the segment counts the member tags');
    assert.equal(chip.missing, false);

    await app.setSeed(freshSeed() + 7);
    const run = await app.generate({ expectImages: 1 });
    assert.equal(run.error, '');
    assert.equal(run.history.length, 1);
    const positive = workflow.positive(run.history[0].workflow, run.history[0].outputs) ?? '';
    assert.match(positive, /serafuku, \(pleated skirt:1\.1\), red eyes/, 'the part expanded in place');
    assert.doesNotMatch(positive, /parts:/, 'no token reaches the model');
    assert.doesNotMatch(positive, /loafers/, 'a disabled member stays out');
});

test('a sample on the mannequin runs through the queue, skips the gallery, and lands in settings/parts/<part>/', async () => {
    const { page, comfy } = app;
    const known = new Set(await comfy.historyIds());
    const galleryBefore = await page.evaluate('globalThis.__e2e.images.length');
    assert.equal(await page.evaluate(`globalThis.partsUi.queueSample('sailor uniform', { base: 'mannequin' })`), true, 'the sample was queued');
    await page.waitFor(`globalThis.partsUi.get('sailor uniform').samples.length === 1 && globalThis.inGenerating !== true`, { timeoutMs: 180_000, intervalMs: 300, label: 'the sample in the store' });
    await sleep(300);
    const entry = JSON.parse(await page.evaluate(`JSON.stringify(globalThis.partsUi.get('sailor uniform'))`));
    const [sample] = entry.samples;
    assert.equal(sample.modelType, 'Checkpoint');
    assert.equal(sample.base, 'mannequin');
    assert.equal(sample.seed, 3);
    assert.deepEqual([sample.width, sample.height], [512, 704]);
    const file = path.join(app.settingsDir, 'parts', 'sailor-uniform', sample.file);
    assert.ok(fs.existsSync(file), `${file} exists`);
    assert.ok(fs.statSync(file).size > 10_000, 'a real PNG');
    assert.equal(await page.evaluate('globalThis.__e2e.images.length'), galleryBefore, 'the gallery did not receive the sample');

    const history = await comfy.historySince(known);
    assert.equal(history.length, 1, 'ComfyUI ran the sample once');
    const { workflow: wf, outputs } = history[0];
    const positive = workflow.positive(wf, outputs) ?? '';
    assert.match(positive, /faceless, bald, white skin/, 'the Checkpoint mannequin base');
    assert.match(positive, /serafuku, \(pleated skirt:1\.1\)$/, 'the part\'s tags at the end');
    assert.match(workflow.negative(wf, outputs) ?? '', /dress form/, 'the sample negative');
    assert.deepEqual(workflow.latentSize(wf, outputs), { width: 512, height: 704, batch: 1 });
    const sampler = workflow.sampler(wf, outputs);
    assert.equal(workflow.seedOf(sampler), 3);
    assert.equal(sampler.inputs.steps, 24, 'the bench steps, not the run bar\'s 4');
    assert.equal(await app.errorText(), '');

    // the tile now shows for this model: the Parts tab's tile carries an image
    await page.click('.prompt-positive .scene-parts-button');
    await page.waitFor(`Boolean(document.querySelector('${OPEN_MODAL} .selection-modal-tile .parts-tile-image img'))`, { label: 'the tile image' });
    assert.equal(await page.evaluate(`Boolean(document.querySelector('${OPEN_MODAL} .selection-modal-tile .parts-tile-image.is-missing'))`), false, 'the tile no longer says "No sample yet"');
    assert.match(await page.evaluate(`document.querySelector('${OPEN_MODAL} .parts-tile-meta')?.textContent`), /serafuku/, 'the tile line is the tags of the part');
    // the panel names the model the sample is for
    await page.click(`${OPEN_MODAL} .selection-modal-tile`);
    await page.waitFor(`Boolean(document.querySelector('${OPEN_MODAL} .parts-picker-sample .parts-card-meta'))`, { label: 'the panel about the tile' });
    assert.match(await page.evaluate(`document.querySelector('${OPEN_MODAL} .parts-picker-sample .parts-card-meta').textContent`), /Illustrious · v\d+/, 'the model and the prompt version of the sample');
    await page.key('Escape');
    await page.waitFor(`!document.querySelector('${OPEN_MODAL}')`, { label: 'the modal to close' });
});

test('the row\'s Choose tags modal: the Tags tab links the same search to the Parts tab, a tile joins the selection, Apply puts the chip in the row', async () => {
    const { page } = app;
    await app.typePositive('1girl, smile');
    // the row as chips: its "+ Add tag" button is the way into the modal
    await page.evaluate(`(() => {
        const wrapper = document.querySelector('.myTextbox-prompt-positive-textarea').closest('.myTextbox-wrapper');
        const [, chipsButton] = wrapper.querySelectorAll('.tag-view-button');
        chipsButton?.click();
    })()`);
    await page.waitFor(`document.querySelectorAll('.prompt-positive .tag-capsule-chip').length === 2`, { label: 'the row as chips' });
    await page.click('.prompt-positive .tag-capsule-add');
    await page.waitFor(`Boolean(document.querySelector('${OPEN_MODAL}'))`, { label: 'the tag modal' });
    const tabs = JSON.parse(await page.evaluate(`JSON.stringify([...document.querySelectorAll('${OPEN_MODAL} .selection-modal-tab')].map(tab => [tab.textContent, tab.getAttribute('aria-selected')]))`));
    assert.deepEqual(tabs, [['Tags', 'true'], ['Parts', 'false'], ['LoRA', 'false']], 'the tag list first, the parts and the LoRAs beside it');
    // the toolbar's ends: the search box first, the star last, on both tabs
    const toolbarEnds = `(() => { const shown = [...document.querySelectorAll('${OPEN_MODAL} .selection-modal-toolbar > *')].filter(node => !node.hidden); return [shown[0]?.className, shown.at(-1)?.className].join(' | '); })()`;
    assert.equal(await page.evaluate(toolbarEnds), 'selection-modal-search-label | selection-modal-favonly');

    // the search is shared: typed on the Tags tab, it also counts the parts it matches
    await page.waitFor(`document.activeElement?.classList.contains('selection-modal-search')`, { label: 'the search box focused' });
    await page.type('serafuku');
    await page.waitFor(`!document.querySelector('${OPEN_MODAL} .selection-modal-crosslink').hidden`, { label: 'the link to the Parts tab' });
    assert.match(await page.evaluate(`document.querySelector('${OPEN_MODAL} .selection-modal-crosslink').textContent`), /^1 parts match/);
    await page.click(`${OPEN_MODAL} .selection-modal-crosslink`);
    await page.waitFor(`document.querySelector('${OPEN_MODAL} .selection-modal-tab.is-active')?.textContent === 'Parts' && document.querySelectorAll('${OPEN_MODAL} .selection-modal-tile').length === 1`, { label: 'the Parts tab narrowed to the match' });
    assert.equal(await page.evaluate(`document.querySelector('${OPEN_MODAL} .selection-modal-search').value`), 'serafuku');
    assert.equal(await page.evaluate(toolbarEnds), 'selection-modal-search-label | selection-modal-favonly', 'the toolbar kept its places');
    // the Parts tab has the category rail instead of the Category box, and no Sample box
    assert.equal(await page.evaluate(`document.querySelector('${OPEN_MODAL} .selection-modal-rail').hidden`), false, 'the category rail');
    assert.deepEqual(JSON.parse(await page.evaluate(`JSON.stringify([...document.querySelectorAll('${OPEN_MODAL} .selection-modal-filter-label')].map(node => node.hidden))`)), [true, true], 'no Category or Sample box beside the rail');

    // a tile joins the selection as a part chip; Apply writes the token into the row
    // a click previews the tile in the panel; the panel's button (or a double click) picks it
    await page.click(`${OPEN_MODAL} .selection-modal-tile`);
    await page.waitFor(`Boolean(document.querySelector('${OPEN_MODAL} .selection-modal-tile.is-previewed'))`, { label: 'the tile previewed' });
    assert.equal(await page.evaluate(`document.querySelectorAll('${OPEN_MODAL} .selection-modal-chip.is-part').length`), 0, 'a click alone does not pick');
    assert.match(await page.evaluate(`document.querySelector('${OPEN_MODAL} .selection-modal-panel').textContent`), /serafuku/, 'the panel shows the previewed part\'s tags');
    await page.click(`${OPEN_MODAL} .parts-picker-add`);
    await page.waitFor(`Boolean(document.querySelector('${OPEN_MODAL} .selection-modal-chip.is-part'))`, { label: 'the part among the selected chips' });
    assert.equal(await page.evaluate(`document.querySelector('${OPEN_MODAL} .selection-modal-chip.is-part .selection-modal-chip-label').textContent`), 'parts:Sailor Uniform');
    await page.click(`${OPEN_MODAL} .selection-modal-apply`);
    await page.waitFor(`!document.querySelector('${OPEN_MODAL}')`, { label: 'the modal to close' });
    assert.equal(await page.evaluate(`document.querySelector('.myTextbox-prompt-positive-textarea').value`), '1girl, smile, parts:sailor uniform');
    await page.waitFor(`document.querySelectorAll('.prompt-positive .tag-capsule-chip.is-part').length === 1`, { label: 'the part chip in the row' });
    assert.equal(await app.errorText(), '');
});
