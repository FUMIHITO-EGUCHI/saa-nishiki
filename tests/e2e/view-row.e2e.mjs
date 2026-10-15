// The View row, end to end: a plain tag and a parts: camera chip typed into it reach
// ComfyUI right after the Common tags, expanded, in the "views" place of the chain. Real
// app, real local ComfyUI (`npm run test:e2e`).
import assert from 'node:assert/strict';
import test from 'node:test';

import { launchApp, workflow } from './harness.mjs';

let app = null;

test.before(async () => { app = await launchApp({ settings: { custom_prompt: 'masterpiece, best quality' } }); });
test.after(async () => { await app?.close(); });

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// the View row's textarea, typed into as a person types (the harness does the same for Positive)
async function typeView(text) {
    const { page } = app;
    const textarea = '.myTextbox-prompt-view-textarea';
    await page.evaluate(`(() => {
        const textarea = document.querySelector(${JSON.stringify(textarea)});
        const wrapper = textarea.closest('.myTextbox-wrapper');
        const [textButton] = wrapper.querySelectorAll('.tag-view-button');
        if (textarea.getClientRects().length === 0) textButton.click();
    })()`);
    await page.waitFor(`document.querySelector(${JSON.stringify(textarea)}).getClientRects().length > 0`, { label: 'the View textarea' });
    await page.click(textarea);
    await page.evaluate(`(() => { const t = document.querySelector(${JSON.stringify(textarea)}); t.focus(); t.select(); })()`);
    await page.type(text);
    await page.key('Escape');
    await page.evaluate(`document.querySelector(${JSON.stringify(textarea)}).blur()`);
    await sleep(200);
}

test('a tag and a parts: camera chip in the View row reach ComfyUI after Common, expanded, and Prose sees them as the view', async () => {
    const { page } = app;
    // a camera part made in the editor (the starter set is not relied on here)
    await page.evaluate(`globalThis.partsUi.openEditor()`);
    await page.waitFor(`Boolean(document.querySelector('.parts-editor-dialog'))`, { label: 'the part editor' });
    await page.evaluate(`(() => {
        const dialog = document.querySelector('.parts-editor-dialog');
        const set = (selector, value) => { const input = dialog.querySelector(selector); input.value = value; input.dispatchEvent(new Event('input', { bubbles: true })); };
        set('.parts-name-input', 'Bird View');
        const select = dialog.querySelector('.parts-category-select');
        select.value = [...select.options].some(option => option.value === 'camera') ? 'camera' : 'other';
        set('.parts-tags-input', 'from above, wide shot');
        const generate = dialog.querySelector('.parts-check input');
        if (generate.checked) generate.click();
        dialog.querySelector('.selection-modal-apply').click();
    })()`);
    await page.waitFor(`Boolean(globalThis.partsUi.get('bird view'))`, { label: 'the part in the store' });

    // the row is in the Scene, with its own parts button (the tag modal on its Parts tab)
    assert.equal(await page.evaluate(`Boolean(document.querySelector('.prompt-scene .prompt-view .scene-parts-button'))`), true, 'the View row offers the parts picker');
    assert.equal(await page.evaluate(`Boolean(document.querySelector('.dropdown-view'))`), false, 'the Angle / Camera dropdowns are gone');

    await typeView('dutch angle, parts:bird view');
    assert.equal(await app.setting('view_tags'), 'dutch angle, parts:bird view', 'the row writes view_tags');
    await app.typePositive('1girl, smile');

    const run = await app.generate({ expectImages: 1 });
    assert.equal(run.error, '', `no error overlay; log ${app.logFile}`);
    assert.equal(run.history.length, 1);
    const { workflow: wf, outputs } = run.history[0];
    const positive = workflow.positive(wf, outputs) ?? '';
    assert.match(positive, /^masterpiece, best quality, dutch angle, from above, wide shot, /, 'the View text follows Common, the part expanded');
    assert.match(positive, /1girl, smile/, 'the Positive row comes later');
    assert.doesNotMatch(positive, /parts:/, 'no part token reaches the model');
    assert.ok(positive.indexOf('dutch angle') < positive.indexOf('1girl'), 'views before positive');
});
