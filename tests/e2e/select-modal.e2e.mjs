// The row's Choose tags modal sized by the window (design: Select Modal Resize): the
// dialog follows the window, the corner drags it smaller and the size is remembered per
// tab, the Selected row stays one line high, and the Parts tab has its category rail,
// its click-previews grid and its panel. Real app; no image is generated.
// Run with `npm run test:e2e`.
import assert from 'node:assert/strict';
import test from 'node:test';

import { launchApp } from './harness.mjs';

let app = null;

test.before(async () => { app = await launchApp({ starterParts: true }); });
test.after(async () => { await app?.close(); });

const OPEN = '.selection-modal:not([hidden])';
const DIALOG = `${OPEN} .selection-modal-dialog`;
// the camera parts of the starter set (data/parts_defaults.json)
const CAMERA = 35;

async function openPositiveModal(page) {
    await page.click('.prompt-positive .tag-capsule-add');
    await page.waitFor(`Boolean(document.querySelector('${OPEN}'))`, { label: 'the tag modal' });
}

async function dialogBox(page) {
    return JSON.parse(await page.evaluate(`(() => { const r = document.querySelector('${DIALOG}').getBoundingClientRect(); return JSON.stringify({ width: Math.round(r.width), height: Math.round(r.height), right: Math.round(r.right), bottom: Math.round(r.bottom) }); })()`));
}

test('the dialog fills the window less 24px a side, the corner drags it smaller, and the Parts tab remembers its own size', async () => {
    const { page } = app;
    await app.typePositive('1girl, smile');
    await page.evaluate(`(() => {
        const wrapper = document.querySelector('.myTextbox-prompt-positive-textarea').closest('.myTextbox-wrapper');
        const [, chipsButton] = wrapper.querySelectorAll('.tag-view-button');
        chipsButton?.click();
    })()`);
    await page.waitFor(`document.querySelectorAll('.prompt-positive .tag-capsule-chip').length === 2`, { label: 'the row as chips' });
    await openPositiveModal(page);
    const viewport = JSON.parse(await page.evaluate(`JSON.stringify({ width: window.innerWidth, height: window.innerHeight })`));
    const box = await dialogBox(page);
    assert.equal(box.width, Math.max(640, Math.min(1800, viewport.width - 48)), 'the width follows the window');
    assert.equal(box.height, Math.max(480, Math.min(1200, viewport.height - 48)), 'the height follows the window');
    assert.equal(await page.evaluate(`document.querySelector('${DIALOG}').classList.contains('is-window-sized')`), true);

    // the corner: a real pointer drag of 300 by 200 shrinks the dialog by that much
    const handle = await page.rect(`${OPEN} .selection-modal-resize`);
    await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: handle.x, y: handle.y });
    await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: handle.x, y: handle.y, button: 'left', clickCount: 1 });
    await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: handle.x - 300, y: handle.y - 200, button: 'left' });
    await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: handle.x - 300, y: handle.y - 200, button: 'left', clickCount: 1 });
    const dragged = await dialogBox(page);
    assert.equal(dragged.width, box.width - 300, 'the drag took 300px off the width');
    assert.equal(dragged.height, box.height - 200, 'and 200px off the height');
    assert.equal(await page.evaluate(`localStorage.getItem('selection-modal-size:main')`), JSON.stringify({ width: dragged.width, height: dragged.height }), 'the tag list remembers it');

    // the Parts tab has no size of its own yet: back to the rule; the fit button forgets the tag list's
    await page.click(`${OPEN} .selection-modal-tab:nth-child(2)`);
    await page.waitFor(`document.querySelector('${OPEN} .selection-modal-tab.is-active')?.textContent === 'Parts'`, { label: 'the Parts tab' });
    const parts = await dialogBox(page);
    assert.deepEqual([parts.width, parts.height], [box.width, box.height], 'the Parts tab is not shrunk by the Tags drag');
    await page.click(`${OPEN} .selection-modal-tab:nth-child(1)`);
    await page.waitFor(`document.querySelector('${OPEN} .selection-modal-tab.is-active')?.textContent === 'Tags'`, { label: 'the Tags tab' });
    assert.equal((await dialogBox(page)).width, dragged.width, 'the Tags tab is still the dragged size');
    await page.click(`${OPEN} .selection-modal-fit`);
    assert.equal((await dialogBox(page)).width, box.width, 'fit the window puts the rule back');
    assert.equal(await page.evaluate(`localStorage.getItem('selection-modal-size:main')`), null);
    await page.key('Escape');
    await page.waitFor(`!document.querySelector('${OPEN}')`, { label: 'the modal closed' });
});

test('the Selected row keeps its one line however many chips it holds, and the Parts tab picks through its rail, grid and panel', async () => {
    const { page } = app;
    await openPositiveModal(page);
    await page.click(`${OPEN} .selection-modal-tab:nth-child(2)`);
    await page.waitFor(`document.querySelectorAll('${OPEN} .selection-modal-tile').length === 295`, { label: 'the 295 starter tiles' });
    const rail = JSON.parse(await page.evaluate(`JSON.stringify([...document.querySelectorAll('${OPEN} .selection-modal-rail-item')].map(item => item.querySelector('.selection-modal-rail-name').textContent + ':' + item.querySelector('.selection-modal-rail-count').textContent))`));
    assert.equal(rail[0], 'All:295');
    assert.ok(rail.includes(`Camera:${CAMERA}`), `the camera category with its count: ${rail.join(' ')}`);
    assert.equal(await page.evaluate(`document.querySelector('${OPEN} .selection-modal-filter-label').hidden`), true, 'no Category box beside the rail');
    const rowHeight = await page.evaluate(`document.querySelector('${OPEN} .selection-modal-selected').getBoundingClientRect().height`);
    assert.equal(Math.round(rowHeight), 40, 'the Selected row is 40px with two chips');

    // the rail narrows the grid; a click picks the tile and shows it in the panel
    await page.click(`${OPEN} .selection-modal-rail-item[data-category="camera"]`);
    await page.waitFor(`document.querySelectorAll('${OPEN} .selection-modal-tile').length === ${CAMERA}`, { label: 'the camera tiles' });
    await page.click(`${OPEN} .selection-modal-tile`);
    await page.waitFor(`document.querySelectorAll('${OPEN} .selection-modal-chip.is-part').length === 1 && document.querySelector('${OPEN} .parts-picker-token')`, { label: 'the part picked and shown in the panel' });
    const first = await page.evaluate(`document.querySelector('${OPEN} .selection-modal-tile .parts-tile-name').textContent`);
    assert.match(await page.evaluate(`document.querySelector('${OPEN} .parts-picker-token').textContent`), /^parts:/, 'the panel says what the chip sends');
    assert.match(await page.evaluate(`document.querySelector('${OPEN} .parts-panel-sub').textContent`), /starter$/, 'a starter part says so');
    // every other camera tile too: the strip fills but the row does not grow
    for (let i = 1; i < CAMERA; i++) {
        await page.evaluate(`document.querySelectorAll('${OPEN} .selection-modal-tile')[${i}].dispatchEvent(new MouseEvent('click', { bubbles: true }))`);
    }
    await page.waitFor(`document.querySelectorAll('${OPEN} .selection-modal-selected-list .selection-modal-chip').length === ${CAMERA + 2}`, { label: `${CAMERA + 2} chips in the strip` });
    assert.equal(Math.round(await page.evaluate(`document.querySelector('${OPEN} .selection-modal-selected').getBoundingClientRect().height`)), 40, `still 40px with ${CAMERA + 2} chips`);
    assert.equal(await page.evaluate(`(() => { const s = document.querySelector('${OPEN} .selection-modal-selected-list'); return s.scrollWidth > s.clientWidth; })()`), true, 'the strip scrolls sideways');
    assert.equal(await page.evaluate(`document.querySelector('${OPEN} .selection-modal-selected-count').textContent`), String(CAMERA + 2));
    await page.click(`${OPEN} .selection-modal-selected-toggle`);
    await page.waitFor(`!document.querySelector('${OPEN} .selection-modal-selected-popover').hidden`, { label: 'the popover' });
    assert.equal(await page.evaluate(`document.querySelectorAll('${OPEN} .selection-modal-selected-popover .selection-modal-chip').length`), CAMERA + 2);
    await page.key('Escape');
    await page.waitFor(`document.querySelector('${OPEN} .selection-modal-selected-popover').hidden`, { label: 'the popover folded' });
    assert.equal(await page.evaluate(`Boolean(document.querySelector('${OPEN}'))`), true, 'the modal stayed open');

    await page.click(`${OPEN} .selection-modal-apply`);
    await page.waitFor(`!document.querySelector('${OPEN}')`, { label: 'the modal closed' });
    const value = await page.evaluate(`document.querySelector('.myTextbox-prompt-positive-textarea').value`);
    assert.match(value, /^1girl, smile, parts:/, `the chips landed after the tags: ${value.slice(0, 60)}`);
    assert.equal(value.split(',').filter(piece => piece.trim().startsWith('parts:')).length, CAMERA, `every camera part is in the row: ${value.slice(0, 80)}`);
    assert.ok(value.includes(first.replace(/^parts:/, 'parts:').toLowerCase()) || value.toLowerCase().includes(first.toLowerCase()), 'the previewed part is among them');
});
