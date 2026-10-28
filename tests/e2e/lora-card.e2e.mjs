// The LoRA card, end to end on the real app and the real local ComfyUI: "+ LoRA" opens the
// tag modal's LoRA tab on its own, a click on a tile picks the LoRA, Add puts its row in
// the card at its default weight and its trigger word in the Positive row; the row's
// slider, switch and fold change what a run sends; Retake takes the six samples with the
// prompt written in its dialog, and the sample viewer opens on all six and shows one large;
// Batch (Last) keeps the last prompt but sends the LoRA card, and the trigger words the
// row's switch took out or put back, as they are now.
// Run with `npm run test:e2e`.
import assert from 'node:assert/strict';
import test from 'node:test';

import { launchApp, workflow } from './harness.mjs';

const OPEN = '.selection-modal:not([hidden])';
let app = null;
let lora = '';

test.before(async () => { app = await launchApp(); });
test.after(async () => { await app?.close(); });

const values = () => app.page.evaluate('JSON.stringify(globalThis.lora.getValues())').then(JSON.parse);
const inView = selector => app.page.evaluate(`document.querySelector(${JSON.stringify(selector)})?.scrollIntoView({ block: 'center' })`);

async function openPicker() {
    const { page } = app;
    await inView('.lora-slot-add');
    await page.click('.lora-slot-add');
    await page.waitFor(`Boolean(document.querySelector('${OPEN} .lora-tile-body'))`, { label: 'the LoRA picker' });
    await page.waitFor(`document.activeElement?.classList.contains('selection-modal-search')`, { label: 'the search box focused' });
    await page.type('charturn');
    await page.waitFor(`document.querySelectorAll('${OPEN} .selection-modal-tile').length === 1`, { label: 'the one LoRA the search finds' });
}

test('"+ LoRA": the LoRA tab alone, a click on a tile picks it, Add puts the row and its trigger word', async () => {
    const { page } = app;
    await app.typePositive('1girl, solo');
    await page.evaluate(`(() => { globalThis.globalSettings.lora_slot = []; globalThis.lora.flush(); globalThis.collapsedTabs?.lora?.setCollapsed?.(false); })()`);
    lora = await page.evaluate(`(globalThis.cachedFiles.loraList || []).find(name => /charturn/i.test(name)) || ''`);
    assert.ok(lora, 'the E2E machine has the CharTurnIL LoRA');

    await openPicker();
    assert.equal(await page.evaluate(`document.querySelector('${OPEN} .selection-modal-title').textContent`), 'LoRA');
    assert.equal(await page.evaluate(`document.querySelector('${OPEN} .selection-modal-tabs').hidden`), true, 'no Tags or Parts tab');
    await page.click(`${OPEN} .selection-modal-tile`);
    await page.waitFor(`document.querySelectorAll('${OPEN} .selection-modal-chip.is-lora').length === 1`, { label: 'picked by the click' });
    assert.match(await page.evaluate(`document.querySelector('${OPEN} .lora-panel-name').textContent`), /CharTurnIL/, 'and shown in the panel');
    assert.equal(await page.evaluate(`Boolean(document.querySelector('${OPEN} .lora-add'))`), false, 'no second button to pick with');
    assert.equal(await page.evaluate(`document.querySelector('${OPEN} .selection-modal-apply').textContent`), 'Add (1)');
    await page.click(`${OPEN} .selection-modal-apply`);
    await page.waitFor(`!document.querySelector('${OPEN}')`, { label: 'the picker closed' });

    await page.waitFor('globalThis.lora.getValues().length === 1', { label: 'the row' });
    assert.deepEqual(await values(), [[lora, '0.8', '0.8', 'ALL']], 'at its default weight');
    await page.waitFor(`/charturn/.test(document.querySelector('.myTextbox-prompt-positive-textarea').value)`, { label: 'its trigger word in the Positive row' });
    await page.waitFor(`document.querySelector('.lora-slot-trigger.is-on')?.textContent === 'charturn ✓'`, { label: 'the row shows the word in the prompt' });
    assert.equal(await page.evaluate(`document.querySelector('.lora-slot-name').textContent`), lora.split(/[\\\\/]/).pop().replace(/\.safetensors$/i, ''), 'the name without the extension');
    assert.equal(await app.errorText(), '');
});

test('the row\'s slider, switch and fold change what a run sends, and the settings keep it', async () => {
    const { page } = app;
    await page.evaluate(`(() => { const slider = document.querySelector('.lora-slot-slider'); slider.value = '0.6'; slider.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    assert.equal(await page.evaluate(`document.querySelector('.lora-slot-line .lora-slot-value').value`), '0.6', 'the field follows the slider');
    assert.deepEqual(await values(), [[lora, '0.6', '0.6', 'ALL']], 'CLIP follows the weight');

    await inView('.lora-slot-fold');
    await page.click('.lora-slot-fold');
    await page.waitFor(`Boolean(document.querySelector('.lora-slot-more'))`, { label: 'the fold' });
    await page.evaluate(`[...document.querySelectorAll('.lora-slot-more .lora-segment button')].find(node => node.textContent === 'Hires').click()`);
    assert.deepEqual(await values(), [[lora, '0.6', '0.6', 'HiFix']]);
    assert.equal(await page.evaluate(`document.querySelector('.lora-slot-stage').textContent`), 'Hires only');

    await page.evaluate(`document.querySelector('.lora-slot-switch').click()`);
    assert.deepEqual(await values(), [[lora, '0.6', '0.6', 'OFF']], 'switched off, strengths kept');
    await page.evaluate(`document.querySelector('.lora-slot-switch').click()`);
    await page.evaluate(`[...document.querySelectorAll('.lora-slot-more .lora-segment button')].find(node => node.textContent === 'All').click()`);
    assert.deepEqual(await values(), [[lora, '0.6', '0.6', 'ALL']], 'back on in its pass');

    await page.evaluate('globalThis.settingsPersistence.flush()');
    await page.waitFor(`JSON.stringify(globalThis.globalSettings.lora_slot) === ${JSON.stringify(JSON.stringify([[lora, '0.6', '0.6', 'ALL']]))}`, { label: 'the settings keep the row' });
});

test('Retake takes the six samples with the dialog\'s prompt; the viewer opens on all six and shows one large', async () => {
    const { page } = app;
    await openPicker();
    await page.click(`${OPEN} .selection-modal-tile`);
    await page.waitFor(`Boolean(document.querySelector('${OPEN} .lora-retake-open'))`, { label: 'the panel' });
    await page.click(`${OPEN} .lora-retake-open`);
    await page.waitFor(`Boolean(document.querySelector('.lora-retake .lora-retake-add'))`, { label: 'the Retake dialog' });
    assert.match(await page.evaluate(`[...document.querySelectorAll('.lora-retake-chip.is-lora')].map(chip => chip.textContent).join()`), /charturn/, 'the trigger word is marked');
    await page.evaluate(`document.querySelector('.lora-retake-add').focus()`);
    await page.type('from behind');
    await page.key('Enter', 'Enter', 13);
    await page.waitFor(`[...document.querySelectorAll('.lora-retake-chip')].some(chip => chip.textContent.startsWith('from behind'))`, { label: 'the new tag' });
    await page.click('.lora-retake-foot .selection-modal-apply');
    await page.waitFor(`!document.querySelector('.lora-retake')`, { label: 'the dialog closed' });

    // the six images come in one by one; the panel's grid fills
    await page.waitFor(`document.querySelectorAll('${OPEN} .lora-panel .lora-cell-image[src]').length === 6`, { label: 'six samples', timeoutMs: 240_000, intervalMs: 500 });
    await page.key('Escape');
    await page.waitFor(`!document.querySelector('${OPEN}')`, { label: 'the picker closed' });
    assert.deepEqual(await values(), [[lora, '0.6', '0.6', 'ALL']], 'picking it again added nothing: it was in the slots');

    await inView('.lora-slot-samples');
    await page.waitFor(`document.querySelector('.lora-slot-samples')?.disabled === false`, { label: 'the row\'s Samples button' });
    await page.click('.lora-slot-samples');
    await page.waitFor(`document.querySelectorAll('.lora-viewer .lora-viewer-big').length === 6`, { label: 'the viewer on all six' });
    await page.waitFor(`document.querySelectorAll('.lora-viewer .lora-viewer-big img[src]').length === 6`, { label: 'their images' });
    assert.equal(await page.evaluate(`Boolean(document.querySelector('.lora-viewer-back'))`), false, 'all six first');
    await page.click('.lora-viewer .lora-viewer-card:nth-child(5) .lora-viewer-big');
    await page.waitFor(`document.querySelector('.lora-viewer-weight-value')?.textContent === '0.8'`, { label: 'the one picked, large' });
    const prompt = await page.evaluate(`document.querySelector('.lora-viewer-info .lora-viewer-prompt').textContent`);
    assert.match(prompt, /from behind/, 'made with the prompt written in the dialog');
    assert.match(prompt, /<lora:[^>]*CharTurnIL[^>]*:0\.8:0\.8>/i);
    await page.key('ArrowRight', 'ArrowRight', 39);
    await page.waitFor(`document.querySelector('.lora-viewer-weight-value')?.textContent === '1'`, { label: 'the next weight' });
    await page.key('Escape');
    await page.waitFor(`document.querySelectorAll('.lora-viewer .lora-viewer-big').length === 6`, { label: 'back to all six' });
    await page.key('Escape');
    await page.waitFor(`!document.querySelector('.lora-viewer')`, { label: 'the viewer closed' });
    assert.equal(await app.errorText(), '');
});

test('Batch (Last) keeps the last prompt but sends the LoRA card as it is now: switched off, not loaded and its trigger word gone; on again at a new weight, both back', async () => {
    const { page } = app;
    // the LoRA text every run handed the LoRA loader
    const loraText = run => run.history.map(entry => workflow.executedChain(entry.workflow, entry.outputs)
        .filter(node => node.class_type === 'LoRAfromText').map(node => workflow.text(entry.workflow, node.inputs?.text)).join('')).join('|');
    const positive = run => workflow.positive(run.history[0].workflow, run.history[0].outputs);
    const tags = run => positive(run).split(/[,\n]/).map(tag => tag.trim()).filter(Boolean).sort();
    const row = () => page.evaluate(`document.querySelector('.myTextbox-prompt-positive-textarea').value`);
    await app.setBatch(1);
    await page.evaluate(`(() => { globalThis.globalSettings.lora_slot = [[${JSON.stringify(lora)}, '0.6', '0.6', 'ALL']]; globalThis.lora.flush(); })()`);
    const first = await app.generate();
    assert.match(loraText(first), /CharTurnIL[^>]*:0\.6:0\.6>/i, 'the first run carries it');
    assert.ok(tags(first).includes('charturn'), 'and its trigger word');

    await page.evaluate(`document.querySelector('.lora-slot-switch').click()`);
    assert.doesNotMatch(await row(), /charturn/, 'switched off, its trigger word leaves the Positive row');
    const off = await app.generate({ button: 'same' });
    assert.equal(off.history.length, 1);
    assert.doesNotMatch(loraText(off), /CharTurnIL/i, 'the last prompt runs without the LoRA');
    assert.deepEqual(tags(off), tags(first).filter(tag => tag !== 'charturn'), 'and without its word, the rest as it was');

    await page.evaluate(`document.querySelector('.lora-slot-switch').click()`);
    assert.match(await row(), /charturn/, 'on again, the word is back in the row');
    await page.evaluate(`(() => { const field = document.querySelector('.lora-slot-line .lora-slot-value'); field.value = '0.9'; field.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    const weighted = await app.generate({ button: 'same' });
    assert.match(loraText(weighted), /CharTurnIL[^>]*:0\.9:0\.9>/i, 'on again at 0.9: that weight');
    assert.deepEqual(tags(weighted), tags(first), 'and the word back in the last prompt');
    assert.equal(await app.errorText(), '');
});
