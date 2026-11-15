// The sequence batch, end to end: the real app against the real local ComfyUI. Each scene
// owns its prompts, its LoRA rows and its generation settings: two scenes that differ in
// Positive, a custom field, the width and a LoRA, two favorite characters and two candidates
// make eight runs, each with its scene's settings, and the screen keeps its own. Sequence
// mode is the edit mode (D34): it puts a scene on the screen, edits go into the scene, Sample
// (a trial run) lands in the scene's own viewer history, "Save to <scene>" adopts it, Run
// makes the whole sequence, and Single gives the screen its own again.
// Run with `npm run test:e2e`.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import { launchApp, workflow } from './harness.mjs';

// Two characters whose images are easy to tell apart. Rob Roy is in no character list: she
// joins as an original character of this run, named by her Danbooru tag.
const CAFE = '曼城茶座（赛马娘）';
const ROB_ROY = 'oc:Rob Roy';
const ROB_ROY_TAGS = String.raw`zenno rob roy \(umamusume\), brown hair, long hair, braid, glasses, horse ears, horse tail`;
// Good enough to see what an image shows, and still quick: the machine's Fast set (a few
// distilled steps) at full SDXL size, portrait or landscape per scene.
const PORTRAIT = { width: 832, height: 1216 };
const LANDSCAPE = { width: 1216, height: 832 };
const LORA = '8.0-sprite pixel art style by skormino.safetensors';

let app = null;

test.before(async () => {
    app = await launchApp({
        settings: {
            fav_characters: [CAFE, ROB_ROY],
            custom_prompt: '1girl, solo, masterpiece, best quality',
            api_fast_enable: true,
            ...PORTRAIT,
            prompt_custom_fields: [{ id: 'cf_scene', name: 'Scene', polarity: 'positive', text: 'standing' }],
            prompt_positive_order: ['common', 'views', 'cf_scene', 'background', 'style', 'ai', 'characters', 'positive', 'artist'],
            sequence_confirm_threshold: 0,
            api_prompt: 'my own positive tags',
            lora_slot: [],
        },
    });
    // two scenes made from the screen, each changed in its prompts, its width and its LoRA rows
    await app.page.evaluate(`(() => {
        const files = globalThis.cachedFiles;
        files.ocList['Rob Roy'] = ${JSON.stringify(ROB_ROY_TAGS)};
        files.ocListArray = Object.entries(files.ocList);
        return true;
    })()`);
    await app.page.evaluate(`(() => {
        const base = globalThis.sequenceBatch.captureScene();
        const scene = (id, name, positive, action, size, loras) => {
            const settings = JSON.parse(JSON.stringify(base));
            settings.prompt.api_prompt = positive;
            settings.prompt.prompt_custom_fields = settings.prompt.prompt_custom_fields.map(field => field.id === 'cf_scene' ? { ...field, text: action } : field);
            settings.generation.width = size.width;
            settings.generation.height = size.height;
            settings.lora.lora_slot = loras;
            return { id, name, settings, thumb: '', image: '', history: [] };
        };
        globalThis.sequenceBatch.update(current => {
            current.name = '';
            current.scenes = [
                scene('a', 'Morning', 'bedroom, morning light', 'waking up', ${JSON.stringify(PORTRAIT)}, []),
                scene('b', 'Street', 'city street, day', 'walking', ${JSON.stringify(LANDSCAPE)}, [[${JSON.stringify(LORA)}, '0.6', '0.6', 'ALL']]),
            ];
        });
        return true;
    })()`);
});
test.after(async () => { await app?.close(); });

async function waitImages(count, before) {
    await app.page.waitFor(
        `globalThis.__e2e.images.length >= ${before + count} && globalThis.inGenerating !== true && !globalThis.mainGallery.isLoading`,
        { timeoutMs: 300_000, intervalMs: 250, label: `${count} image(s) from the sequence` },
    );
}

function savedImages(outputs) {
    return Object.values(outputs ?? {}).flatMap(output => output?.images ?? []);
}

const screenState = `JSON.stringify({ positive: globalThis.prompt.positive.getValue(), action: globalThis.prompt.cf_scene.getValue(), width: Number(globalThis.generate.width.getValue()), loras: globalThis.lora.getValues().length })`;

test('2 scenes x 2 characters x 2 candidates: eight runs, each with the prompts, width and LoRA of its scene, its character and seed B + c', async () => {
    const seed = app.settings.random_seed;
    const screenBefore = await app.page.evaluate(screenState);
    const known = new Set(await app.comfy.historyIds());
    const before = await app.page.evaluate('globalThis.__e2e.images.length');
    // the run bar's Sequence mode is the edit mode: the first scene goes on the screen, the
    // count is the patterns, Generate is Sample | Run, and with no characters picked Run is
    // off and says why while Sample is not
    const generateButton = '.myButton-generate-button-single';
    const runButton = '#run-sequence-go';
    const generateBox = `(() => { const box = document.getElementById('run-generate').getBoundingClientRect(); return JSON.stringify([box.x, box.y, box.width, box.height].map(Math.round)); })()`;
    const singleBox = await app.page.evaluate(generateBox);
    await app.page.click('.run-mode[data-mode="sequence"]');
    await app.page.waitFor(`globalThis.sequenceEdit.sceneId() === 'a' && Boolean(document.getElementById('sequence-strip')) && document.querySelector('.run-param-batch .run-param-label').textContent === 'Pattern'`, { timeoutMs: 5000, label: 'Sequence mode: scene 1 on the screen' });
    assert.equal(await app.page.evaluate(`globalThis.prompt.positive.getValue()`), 'bedroom, morning light');
    assert.equal(await app.page.evaluate(generateBox), singleBox, 'Generate keeps its place and its width');
    await app.setBatch(2);
    const buttons = await app.page.evaluate(`JSON.stringify({
        sample: [document.querySelector('${generateButton}').textContent.trim(), document.querySelector('${generateButton}').disabled],
        run: [document.querySelector('${runButton}').textContent.trim(), document.querySelector('${runButton}').disabled, document.querySelector('${runButton}').title],
    })`);
    assert.equal(buttons, JSON.stringify({ sample: ['Sample', false], run: ['Run 0', true, 'No characters'] }));
    assert.equal(await app.page.evaluate('globalThis.globalSettings.sequence_run.candidates'), 2, 'the count went to the patterns');
    const split = await app.page.evaluate(`(() => { const a = document.querySelector('.run-generate .generate-button-single').getBoundingClientRect().width; const b = document.querySelector('${runButton}').getBoundingClientRect().width; return Math.round(a / (a + b) * 100); })()`);
    assert.ok(split >= 58 && split <= 62, `Sample takes 60 % (${split} %)`);
    // the strip's scene opens the dialog; its tabs carry the counts, and Done closes it
    await app.page.click('.sequence-strip-current');
    await app.page.waitFor(`Boolean(document.querySelector('.sequence-dialog:not([hidden])'))`, { timeoutMs: 5000, label: 'the dialog' });
    const tabs = await app.page.evaluate(`JSON.stringify([...document.querySelectorAll('.sequence-tab')].map(tab => [tab.dataset.page, tab.querySelector('.sequence-tab-count').textContent]))`);
    assert.equal(tabs, JSON.stringify([['scenes', '2'], ['run', '0']]));
    assert.equal(await app.page.evaluate(`Boolean(document.querySelector('.sequence-dialog .sequence-generate, .sequence-dialog #sequence-candidates'))`), false, 'no Generate and no count in the dialog');
    await app.page.click('.sequence-tab[data-page="run"]');
    await app.page.waitFor(`Boolean(document.querySelector('.sequence-dialog:not([hidden]) .sequence-page-run:not([hidden])'))`, { timeoutMs: 5000, label: 'the Characters tab' });
    await app.page.evaluate(`(() => { document.querySelector('.sequence-dialog .sequence-page-run .sequence-column-foot .sequence-button').click(); return true; })()`);   // Add all
    assert.equal(await app.page.evaluate(`document.querySelector('.sequence-formula').textContent`), '2 × 2 × 2');
    assert.equal(await app.page.evaluate(`Boolean(document.querySelector('.sequence-dialog .selection-modal-cancel'))`), false, 'no Back in the dialog');
    await app.page.click('.sequence-dialog .sequence-done');
    await app.page.waitFor(`document.querySelector('.sequence-dialog')?.hidden !== false && document.querySelector('${runButton}').disabled === false`, { timeoutMs: 5000, label: 'the dialog closed and Run on' });
    assert.equal(await app.page.evaluate(`document.querySelector('${runButton}').textContent.trim()`), 'Run 8');
    assert.equal(await app.page.evaluate(`globalThis.sequenceEdit.sceneId()`), 'a', 'still on scene 1');
    await app.page.click(runButton);
    await waitImages(8, before);
    assert.equal(await app.page.evaluate(`globalThis.prompt.positive.getValue()`), 'bedroom, morning light', 'after the run scene 1 is on the screen again');

    const history = await app.comfy.historySince(known);
    assert.equal(history.length, 8, 'one ComfyUI run per row');
    assert.equal(await app.errorText(), '');
    const runs = history.map(entry => ({
        seed: workflow.seedOf(workflow.sampler(entry.workflow, entry.outputs)),
        positive: workflow.positive(entry.workflow, entry.outputs) ?? '',
        width: workflow.latentSize(entry.workflow, entry.outputs)?.width,
        loras: workflow.loras(entry.workflow, entry.outputs),
        files: savedImages(entry.outputs),
    }));
    assert.deepEqual(runs.map(run => run.seed).sort((a, b) => a - b), [seed, seed, seed, seed, seed + 1, seed + 1, seed + 1, seed + 1], 'candidate c runs on B + c for every character and scene');
    for (const run of runs) {
        assert.doesNotMatch(run.positive, /my own positive tags|standing/, 'the prompts of the scene, not of the screen');
        assert.match(run.positive, /manhattan cafe|zenno rob roy/, 'a character is in the prompt');
        const street = /city street/.test(run.positive);
        assert.match(run.positive, street ? /walking/ : /waking up/, 'the fields of one scene together');
        assert.equal(run.width, street ? LANDSCAPE.width : PORTRAIT.width, 'the width of the scene');
        assert.equal(run.loras.some(name => name.includes('sprite pixel art')), street, 'the LoRA rows of the scene');
    }
    assert.equal(runs.filter(run => /city street/.test(run.positive)).length, 4, 'each scene for two characters x two candidates');
    const files = runs.flatMap(run => run.files);
    if (files.length) {
        assert.ok(files.every(file => /^seq-\d{8}-\d{6}$/.test(file.subfolder)), `one run folder: ${files.map(file => `${file.subfolder} | ${file.filename}`).join(', ')}`);
        assert.ok(files.some(file => /_p02_s02-Street/.test(file.filename)), files.map(file => file.filename).join(', '));
        // the Library shows the run's folder character by character, pattern by pattern, scene by scene
        const runFolder = files[0].subfolder;
        await app.page.click('#viewer-library-open');
        await app.page.waitFor(`[...document.querySelectorAll('.library-rail-item')].some(node => node.querySelector('.library-rail-label')?.textContent === ${JSON.stringify(runFolder)})`, { timeoutMs: 10_000, label: 'the run folder in the Library' });
        await app.page.evaluate(`(() => { [...document.querySelectorAll('.library-rail-item')].find(node => node.querySelector('.library-rail-label')?.textContent === ${JSON.stringify(runFolder)}).click(); return true; })()`);
        await app.page.waitFor(`document.querySelectorAll('.library-tile').length === 8`, { timeoutMs: 10_000, label: 'the eight images in the Library' });
        const paths = await app.page.evaluate(`[...document.querySelectorAll('.library-tile')].map(tile => tile.querySelector('img').dataset.path)`);
        const order = paths.map(file => file.split(/[\\/]/).pop().replace(/\.png$/, '').replace(/^.*?_p/, 'p'));
        assert.deepEqual(order.slice(0, 4), ['p01_s01-Morning', 'p01_s02-Street', 'p02_s01-Morning', 'p02_s02-Street'], 'one character: pattern 1 scenes 1-2, then pattern 2');
        assert.deepEqual(order.slice(4), order.slice(0, 4), 'then the next character the same way');
        await app.page.evaluate(`(() => { document.querySelector('.library-modal .selection-modal-close')?.click(); return true; })()`);
        await app.page.waitFor(`!document.querySelector('.library-modal') || document.querySelector('.library-modal').closest('[hidden]') !== null || document.querySelector('.library-modal').hidden || !document.querySelector('.library-modal').getClientRects().length`, { timeoutMs: 3000, label: 'the Library closed' });
    }
    // Single ends the edit mode: the screen's own settings and the viewer's own images, the run's with them
    await app.page.click('.run-mode[data-mode="single"]');
    await app.page.waitFor(`!globalThis.sequenceEdit.isActive() && !document.getElementById('sequence-strip') && document.getElementById('run-sequence-go').hidden`, { timeoutMs: 5000, label: 'Single: the edit mode ends' });
    assert.equal(await app.page.evaluate(`document.querySelector('${generateButton}').textContent.trim()`), 'Generate');
    assert.equal(await app.page.evaluate(screenState), screenBefore, 'the screen keeps its own settings');
});

test('a strip longer than the viewer scrolls by itself: picking a thumbnail never slides the viewer', async () => {
    assert.ok(await app.page.evaluate('globalThis.mainGallery.imageCount()') >= 8, 'the eight runs are in the viewer');
    // the eight runs three times over: a strip longer than the viewer
    await app.page.evaluate(`(() => { globalThis.__ownViewer = globalThis.mainGallery.entries(); const e = globalThis.__ownViewer; globalThis.mainGallery.replaceAll([...e, ...e, ...e], 2); return true; })()`);
    const count = await app.page.evaluate('globalThis.mainGallery.imageCount()');
    try {
        await new Promise(resolve => setTimeout(resolve, 400));
        const overflow = await app.page.evaluate(`(() => { const strip = document.querySelector('.cg-preview-container'); return strip.scrollWidth > strip.clientWidth; })()`);
        assert.ok(overflow, 'the strip overflows');
        for (const index of [count - 1, 0, count - 2, Math.floor(count / 2)]) {
            await app.page.evaluate(`(() => { document.querySelectorAll('.cg-preview-image')[${index}].click(); return true; })()`);
            await new Promise(resolve => setTimeout(resolve, 450));
            const shifted = await app.page.evaluate(`(() => { const out = []; let node = document.querySelector('.cg-main-image'); while (node) { if (node.scrollLeft) out.push(String(node.className)); node = node.parentElement; } return out; })()`);
            assert.deepEqual(shifted, [], `nothing around the image scrolled sideways after thumbnail ${index}`);
        }
        const centered = await app.page.evaluate(`(() => {
            const strip = document.querySelector('.cg-preview-container').getBoundingClientRect();
            const tile = document.querySelector('.cg-preview-tile.is-current').getBoundingClientRect();
            return Math.abs((tile.left + tile.width / 2) - (strip.left + strip.width / 2));
        })()`);
        assert.ok(centered < 40, `the picked thumbnail sits in the middle of the strip (${centered}px off)`);
    } finally {
        await app.page.evaluate(`(() => { globalThis.mainGallery.replaceAll(globalThis.__ownViewer); delete globalThis.__ownViewer; return true; })()`);
    }
});

test('edit mode: the scene goes on the screen, edits go into it, Sample is its history, Save to adopts it, Single gives the screen back', async () => {
    const screenBefore = await app.page.evaluate(screenState);
    const viewerBefore = await app.page.evaluate('globalThis.mainGallery.imageCount()');
    assert.ok(viewerBefore > 0, 'the eight runs are in the viewer');
    await app.page.click('.run-mode[data-mode="sequence"]');
    await app.page.waitFor(`globalThis.sequenceEdit.isActive() && globalThis.prompt.positive.getValue() === 'bedroom, morning light' && globalThis.prompt.cf_scene.getValue() === 'waking up'`, { timeoutMs: 5000, label: 'scene 1 on the screen' });
    assert.ok(await app.page.evaluate(`Boolean(document.getElementById('sequence-strip'))`), 'the strip above Prompts');
    await app.page.waitFor(`globalThis.mainGallery.imageCount() === 0`, { timeoutMs: 5000, label: 'the viewer shows the scene\'s images only (none yet)' });

    // an edit on the screen goes into the scene
    await app.page.evaluate(`(() => { globalThis.prompt.positive.setValue('bedroom, morning light, curtains'); document.querySelector('.prompt-positive textarea').dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
    await app.page.waitFor(`globalThis.sequenceBatch.current().scenes[0].settings.prompt.api_prompt === 'bedroom, morning light, curtains'`, { timeoutMs: 3000, label: 'the scene follows the screen' });

    const run = await app.generate({ mode: 'sequence', expectImages: 1 });
    assert.equal(run.error, '');
    assert.match(workflow.positive(run.history[0].workflow, run.history[0].outputs) ?? '', /curtains/);
    await app.page.waitFor(`globalThis.sequenceBatch.current().scenes[0].history.length === 1 && globalThis.mainGallery.imageCount() === 1`, { timeoutMs: 5000, label: 'the trial run in the scene\'s history and on show' });
    const trialPath = await app.page.evaluate(`globalThis.sequenceBatch.current().scenes[0].history[0]`);
    await app.page.waitFor(`document.getElementById('sequence-save-scene')?.disabled === false`, { timeoutMs: 5000, label: 'Save to scene' });

    // the screen changes after the image; Save to brings the image's settings back
    await app.page.evaluate(`(() => { globalThis.prompt.positive.setValue('something else'); document.querySelector('.prompt-positive textarea').dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
    await app.page.waitFor(`globalThis.sequenceBatch.current().scenes[0].settings.prompt.api_prompt === 'something else'`, { timeoutMs: 3000, label: 'the scene follows the screen again' });
    await app.page.click('#sequence-save-scene');
    await app.page.waitFor(`globalThis.sequenceBatch.current().scenes[0].image === ${JSON.stringify(trialPath)} && globalThis.sequenceBatch.current().scenes[0].settings.prompt.api_prompt === 'bedroom, morning light, curtains'`, { timeoutMs: 5000, label: 'the image adopted' });
    assert.equal(await app.page.evaluate(`globalThis.prompt.positive.getValue()`), 'bedroom, morning light, curtains', 'the screen holds the adopted image\'s prompts');
    assert.match(await app.page.evaluate(`document.getElementById('sequence-save-scene').textContent`), /Done/, 'Save to answers with Done');
    assert.ok(await app.page.evaluate(`document.querySelector('.cg-preview-tile.is-marked') !== null`), 'the adopted image is marked in the strip');
    assert.ok(await app.page.evaluate(`globalThis.sequenceBatch.current().scenes[0].thumb.startsWith('data:image/jpeg')`));

    // scene 2: its own prompts, width and LoRA row, and no images yet; back to scene 1: its adopted image
    await app.page.click('.sequence-strip-next');
    await app.page.waitFor(`globalThis.sequenceEdit.sceneId() === 'b' && globalThis.prompt.positive.getValue() === 'city street, day' && Number(globalThis.generate.width.getValue()) === ${LANDSCAPE.width} && globalThis.lora.getValues().length === 1 && globalThis.mainGallery.imageCount() === 0`, { timeoutMs: 5000, label: 'scene 2 on the screen' });
    assert.equal(await app.page.evaluate(`globalThis.sequenceBatch.current().scenes[0].settings.prompt.api_prompt`), 'bedroom, morning light, curtains', 'switching does not carry one scene into another');
    await app.page.click('.sequence-strip-prev');
    await app.page.waitFor(`globalThis.sequenceEdit.sceneId() === 'a' && Number(globalThis.generate.width.getValue()) === ${PORTRAIT.width} && globalThis.lora.getValues().length === 0 && globalThis.mainGallery.currentEntry()?.record?.path === ${JSON.stringify(trialPath)}`, { timeoutMs: 5000, label: 'scene 1 with its adopted image on show' });
    assert.equal(await app.page.evaluate(`globalThis.sequenceBatch.current().scenes[1].settings.generation.width`), LANDSCAPE.width);

    // the scene touched last is where Sequence opens next time
    await app.page.click('.run-mode[data-mode="batch"]');
    await app.page.waitFor(`!globalThis.sequenceEdit.isActive() && ${screenState} === ${JSON.stringify(screenBefore)}`, { timeoutMs: 5000, label: 'the screen\'s own settings back' });
    assert.equal(await app.page.evaluate(`globalThis.globalSettings.sequence_run.scene`), 'a');
    assert.equal(await app.page.evaluate('globalThis.mainGallery.imageCount()'), viewerBefore + 1, 'the viewer\'s own images come back with the trial run');
    assert.equal(await app.page.evaluate('globalThis.sequenceBatch.doc().editBackup'), null);
});

test('+ Scene starts as the screen is now', async () => {
    await app.page.evaluate(`(() => { globalThis.sequenceBatch.open({ page: 'scenes' }); return true; })()`);
    await app.page.click('.sequence-tile-add');
    await app.page.waitFor(`globalThis.sequenceBatch.current().scenes.length === 3`, { timeoutMs: 3000, label: 'a third scene' });
    const added = await app.page.evaluate(`JSON.stringify(globalThis.sequenceBatch.current().scenes[2].settings)`);
    assert.equal(added, await app.page.evaluate(`JSON.stringify(globalThis.sequenceBatch.captureScene())`));
    assert.match(added, /my own positive tags/);
    await app.page.evaluate(`(() => { document.querySelector('.sequence-dialog .selection-modal-close').click(); return true; })()`);
    await app.page.waitFor(`document.querySelector('.sequence-dialog')?.hidden !== false`, { timeoutMs: 3000, label: 'the dialog closed' });
});

// Ctrl + a key on the focused chip (CDP: modifiers 2 = Ctrl)
async function ctrlKey(letter) {
    const upper = letter.toUpperCase();
    for (const type of ['keyDown', 'keyUp']) {
        await app.page.send('Input.dispatchKeyEvent', { type, key: letter, code: `Key${upper}`, windowsVirtualKeyCode: upper.charCodeAt(0), modifiers: 2 });
    }
}

async function focusChip(fieldSelector, name) {
    const found = await app.page.evaluate(`(() => {
        const chip = [...document.querySelectorAll(${JSON.stringify(fieldSelector)} + ' .tag-capsule-chip')].find(node => node.querySelector('.tag-capsule-chip-name')?.textContent.trim() === ${JSON.stringify(name)});
        chip?.focus();
        return Boolean(chip) && document.activeElement === chip;
    })()`);
    assert.ok(found, `the chip ${name} in ${fieldSelector}`);
}

test('Ctrl+X / Ctrl+C / Ctrl+V move and copy chips between scenes and between fields', async () => {
    await app.page.evaluate(`(() => { globalThis.sequenceBatch.update(current => { current.scenes = current.scenes.slice(0, 2); }); globalThis.prompt.tagCapsuleFields.setMode('capsule'); return true; })()`);
    await app.page.evaluate(`globalThis.runModes.editScene('a')`);
    await app.page.waitFor(`globalThis.sequenceEdit.sceneId() === 'a' && globalThis.prompt.positive.getValue() === 'bedroom, morning light, curtains'`, { timeoutMs: 5000, label: 'scene 1 on the screen' });
    await app.page.waitFor(`document.querySelectorAll('.tag-capsule-chips[data-field-key="positive"] .tag-capsule-chip').length === 3`, { timeoutMs: 5000, label: 'the Positive chips' });

    // cut in scene 1
    await focusChip('.tag-capsule-chips[data-field-key="positive"]', 'curtains');
    await ctrlKey('x');
    await app.page.waitFor(`globalThis.prompt.positive.getValue() === 'bedroom, morning light' && globalThis.sequenceBatch.current().scenes[0].settings.prompt.api_prompt === 'bedroom, morning light'`, { timeoutMs: 3000, label: 'the chip cut out of scene 1' });

    // paste in scene 2, at the end of its Positive
    await app.page.click('.sequence-strip-next');
    await app.page.waitFor(`globalThis.sequenceEdit.sceneId() === 'b' && globalThis.prompt.positive.getValue() === 'city street, day'`, { timeoutMs: 5000, label: 'scene 2 on the screen' });
    await app.page.evaluate(`(() => { document.querySelector('.tag-capsule-chips[data-field-key="positive"] .tag-capsule-add').focus(); return true; })()`);
    await ctrlKey('v');
    await app.page.waitFor(`globalThis.prompt.positive.getValue() === 'city street, day, curtains' && globalThis.sequenceBatch.current().scenes[1].settings.prompt.api_prompt === 'city street, day, curtains'`, { timeoutMs: 3000, label: 'the chip pasted into scene 2' });

    // copy from Positive to the custom field, after its chip; a second paste adds nothing
    await focusChip('.tag-capsule-chips[data-field-key="positive"]', 'day');
    await ctrlKey('c');
    await focusChip('.tag-capsule-chips[data-field-key="cf_scene"]', 'walking');
    await ctrlKey('v');
    await app.page.waitFor(`globalThis.prompt.cf_scene.getValue() === 'walking, day' && globalThis.prompt.positive.getValue() === 'city street, day, curtains'`, { timeoutMs: 3000, label: 'the chip copied into the other field' });
    await focusChip('.tag-capsule-chips[data-field-key="cf_scene"]', 'walking');
    await ctrlKey('v');
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.equal(await app.page.evaluate('globalThis.prompt.cf_scene.getValue()'), 'walking, day', 'no doubled tag');

    await app.page.evaluate(`globalThis.runModes.set('single')`);
    await app.page.waitFor(`!globalThis.sequenceEdit.isActive()`, { timeoutMs: 5000, label: 'the mode ends' });
    assert.equal(await app.page.evaluate(`globalThis.sequenceBatch.current().scenes[0].settings.prompt.api_prompt`), 'bedroom, morning light');
});

test('the scene on the screen deleted: the mode moves to its neighbour; with no scene Sequence opens the dialog', async () => {
    const screenBefore = await app.page.evaluate(screenState);
    await app.page.evaluate(`globalThis.runModes.editScene('b')`);
    await app.page.waitFor(`globalThis.sequenceEdit.sceneId() === 'b' && globalThis.prompt.positive.getValue() === 'city street, day, curtains'`, { timeoutMs: 5000, label: 'scene 2 on the screen' });
    await app.page.evaluate(`(() => { globalThis.__sceneB = JSON.parse(JSON.stringify(globalThis.sequenceBatch.current().scenes[1])); globalThis.sequenceBatch.update(current => { current.scenes = current.scenes.filter(scene => scene.id !== 'b'); }); return true; })()`);
    await app.page.waitFor(`globalThis.sequenceEdit.sceneId() === 'a' && globalThis.prompt.positive.getValue() === 'bedroom, morning light'`, { timeoutMs: 5000, label: 'scene 1 on the screen' });
    assert.equal(await app.page.evaluate(`document.querySelector('.sequence-strip-count').textContent`), '01 / 1');
    // the last scene gone: the mode ends, the screen gets its own, Sample has nothing to make
    await app.page.evaluate(`(() => { globalThis.__sceneA = JSON.parse(JSON.stringify(globalThis.sequenceBatch.current().scenes[0])); globalThis.sequenceBatch.update(current => { current.scenes = []; }); return true; })()`);
    await app.page.waitFor(`!globalThis.sequenceEdit.isActive() && ${screenState} === ${JSON.stringify(screenBefore)}`, { timeoutMs: 5000, label: 'no scene: the edit mode ends' });
    await app.page.waitFor(`globalThis.runModes.current() === 'sequence' && document.querySelector('.myButton-generate-button-single').disabled === true`, { timeoutMs: 3000, label: 'Sequence with Sample off' });
    // Sequence again with no scene: the dialog, and no strip
    await app.page.click('.run-mode[data-mode="sequence"]');
    await app.page.waitFor(`Boolean(document.querySelector('.sequence-dialog:not([hidden])')) && !document.getElementById('sequence-strip')`, { timeoutMs: 5000, label: 'the dialog' });
    // the scenes back while it is open; Done puts the scene touched last on the screen
    await app.page.evaluate(`(() => { globalThis.sequenceBatch.update(current => { current.scenes = [globalThis.__sceneA, globalThis.__sceneB]; }); delete globalThis.__sceneA; delete globalThis.__sceneB; return true; })()`);
    assert.equal(await app.page.evaluate(`globalThis.sequenceEdit.isActive()`), false, 'not while the dialog is open');
    await app.page.click('.sequence-dialog .sequence-done');
    await app.page.waitFor(`globalThis.sequenceEdit.sceneId() === 'a' && globalThis.prompt.positive.getValue() === 'bedroom, morning light'`, { timeoutMs: 5000, label: 'scene 1 on the screen after Done' });
    // a tile: that scene
    await app.page.click('.sequence-strip-current');
    await app.page.waitFor(`Boolean(document.querySelector('.sequence-dialog:not([hidden]) .sequence-tile[data-scene-id="b"]'))`, { timeoutMs: 5000, label: 'the dialog with the tiles' });
    await app.page.click('.sequence-tile[data-scene-id="b"] .sequence-tile-image');
    await app.page.waitFor(`document.querySelector('.sequence-dialog')?.hidden !== false && globalThis.sequenceEdit.sceneId() === 'b' && globalThis.prompt.positive.getValue() === 'city street, day, curtains'`, { timeoutMs: 5000, label: 'scene 2 from its tile' });
    await app.page.click('.run-mode[data-mode="single"]');
    await app.page.waitFor(`!globalThis.sequenceEdit.isActive() && ${screenState} === ${JSON.stringify(screenBefore)}`, { timeoutMs: 5000, label: 'Single: the screen\'s own' });
});

test('closing the app in edit mode: on start the mode is back on that scene, with the last edit', async () => {
    await app.page.click('.run-mode[data-mode="sequence"]');
    await app.page.waitFor(`globalThis.sequenceEdit.sceneId() === 'b' && globalThis.prompt.positive.getValue() === 'city street, day, curtains'`, { timeoutMs: 5000, label: 'Sequence opens on scene 2, touched last' });
    // an edit just before closing (sooner than the scene's own save)
    await app.page.evaluate(`(() => { globalThis.prompt.positive.setValue('city street, day, curtains, rain'); document.querySelector('.prompt-positive textarea').dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
    const { settingsDir, runDir } = app;
    process.env.SAA_E2E_KEEP = '1';
    try { await app.close(); } finally { delete process.env.SAA_E2E_KEEP; }
    app = null;
    try {
        app = await launchApp({ reuseSettingsDir: settingsDir });
        await app.page.waitFor(`globalThis.sequenceEdit?.isActive?.() === true && globalThis.sequenceEdit.sceneId() === 'b' && globalThis.runModes?.current?.() === 'sequence'`, { timeoutMs: 10_000, label: 'Sequence mode back on scene 2' });
        assert.ok(await app.page.evaluate(`Boolean(document.getElementById('sequence-strip'))`), 'the strip is back');
        assert.equal(await app.page.evaluate(`globalThis.prompt.positive.getValue()`), 'city street, day, curtains, rain', 'the screen as it was closed');
        await app.page.waitFor(`globalThis.sequenceBatch.current().scenes[1].settings.prompt.api_prompt === 'city street, day, curtains, rain'`, { timeoutMs: 3000, label: 'the last edit in the scene' });
        await app.page.click('.run-mode[data-mode="single"]');
        await app.page.waitFor(`!globalThis.sequenceEdit.isActive() && globalThis.prompt.positive.getValue() === 'my own positive tags'`, { timeoutMs: 5000, label: 'Single gives the screen its own again' });
        assert.equal(await app.page.evaluate('globalThis.sequenceBatch.doc().editBackup'), null);
    } finally {
        await app?.close();
        app = null;
        fs.rmSync(runDir, { recursive: true, force: true });
    }
});
