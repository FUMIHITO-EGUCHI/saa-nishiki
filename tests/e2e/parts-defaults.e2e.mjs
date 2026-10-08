// The starter set, end to end: a settings folder with no parts.json yet starts with the
// bundled parts (data/parts_defaults.json), they show as tiles on the Positive row's
// Parts tab, and the file they were seeded into is the ordinary parts.json; a parts.json
// from before the set gains the names it lacks at launch, the user's own part kept.
// Real app; no image is generated. Run with `npm run test:e2e`.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { launchApp } from './harness.mjs';

let app = null;

test.before(async () => { app = await launchApp({ starterParts: true }); });
test.after(async () => { await app?.close(); });

const OPEN_MODAL = '.selection-modal:not([hidden])';

test('a fresh install has the 295 starter parts, stored as its parts.json and offered on the Parts tab', async () => {
    const { page } = app;
    await page.waitFor(`globalThis.partsUi?.list?.().length === 295`, { label: 'the starter parts in the renderer' });
    const entry = JSON.parse(await page.evaluate(`JSON.stringify(globalThis.partsUi.get('sailor uniform'))`));
    assert.equal(entry.name, 'sailor uniform');
    assert.equal(entry.category, 'outfit');
    assert.match(entry.tags, /^serafuku, /);
    assert.equal(entry.samples.length, 0, 'no sample ships with the set');
    const categories = JSON.parse(await page.evaluate(`JSON.stringify(globalThis.partsUi.list().reduce((acc, part) => ({ ...acc, [part.category]: (acc[part.category] ?? 0) + 1 }), {}))`));
    assert.deepEqual(categories, { outfit: 50, hair: 28, body: 12, background: 33, camera: 35, composition: 17, tone: 48, pose: 26, expression: 23, other: 23 });

    const file = path.join(app.settingsDir, 'parts.json');
    assert.ok(fs.existsSync(file), `${file} was written at first launch`);
    const envelope = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(envelope.section, 'parts');
    assert.equal(Object.keys(envelope.data.parts).length, 295);

    // the row's "parts" button opens the row's tag modal on its Parts tab with every starter part a tile
    await page.click('.prompt-positive .scene-parts-button');
    await page.waitFor(`document.querySelectorAll('${OPEN_MODAL} .selection-modal-tile').length === 295`, { label: 'the row modal on its Parts tab with the starter tiles' });
    const names = JSON.parse(await page.evaluate(`JSON.stringify([...document.querySelectorAll('${OPEN_MODAL} .parts-tile-name')].map(node => node.textContent))`));
    assert.ok(names.includes('parts:sailor uniform'), 'the sailor uniform is among the tiles');
    assert.ok(names.includes('parts:classroom') || names.some(name => name.startsWith('parts:')), 'tiles are named as parts');
    await page.key('Escape');
    await page.waitFor(`!document.querySelector('${OPEN_MODAL}')`, { label: 'the modal to close' });
});

test('a parts.json from before the starter set gains the whole set at launch, its own part kept as it was', async () => {
    const older = await launchApp({ partsDoc: { parts: { 'sailor uniform': { name: 'Sailor Uniform', category: 'outfit', tags: 'serafuku, ~loafers' } } } });
    try {
        const { page } = older;
        await page.waitFor(`globalThis.partsUi?.list?.().length === 295`, { label: 'the starter parts merged into the older store' });
        const mine = JSON.parse(await page.evaluate(`JSON.stringify(globalThis.partsUi.get('sailor uniform'))`));
        assert.equal(mine.name, 'Sailor Uniform', 'the user\'s part keeps its name');
        assert.equal(mine.tags, 'serafuku, ~loafers', 'and its tags');
        const envelope = JSON.parse(fs.readFileSync(path.join(older.settingsDir, 'parts.json'), 'utf8'));
        assert.equal(Object.keys(envelope.data.parts).length, 295, 'the merge is saved');
        assert.ok(envelope.data.starterVersion >= 3, 'and the set version with it, so the next launch merges nothing');
    } finally {
        await older.close();
    }
});
