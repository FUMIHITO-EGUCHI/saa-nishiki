// The Library: the index of the folders SAA saves to (libraryIndex.js) - folders by day,
// what each PNG's text says, the cache that spares a second read - and the grid's search,
// sorting and grouping (libraryWindow.js).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import zlib from 'node:zlib';

import { createLibraryIndex, dayOf, readImageHeader } from '../scripts/main/libraryIndex.js';
import { asciiJson, crc32, insertTextChunks } from '../scripts/shared/pngText.js';
import { buildRecipe } from '../scripts/shared/recipe.js';
import { withFakeDom } from './helpers/fakeDom.mjs';

function png(records = []) {
    const chunk = (type, data) => {
        const head = Buffer.alloc(8);
        head.writeUInt32BE(data.length, 0);
        head.write(type, 4, 'latin1');
        const crc = Buffer.alloc(4);
        crc.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, 'latin1'), data])), 0);
        return Buffer.concat([head, data, crc]);
    };
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(832, 0);
    ihdr.writeUInt32BE(1216, 4);
    ihdr[8] = 8; ihdr[9] = 6;
    const base = Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
        chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(Buffer.alloc(9))), chunk('IEND', Buffer.alloc(0)),
    ]);
    return insertTextChunks(base, records);
}

function recipeOf({ seed, names, click }) {
    return buildRecipe({
        sections: { prompt: { api_prompt: '1girl, cherry blossoms' }, generation: { step: 30, cfg: 4, api_model_file_select: 'waiIllustriousSDXL_v170.safetensors' }, lora: { lora_slot: [['dmd2.safetensors', '1', '1', 'ALL']] }, adetailer: {} },
        settings: { api_model_type: 'Checkpoint' },
        run: { seed, names, click, positive: 'rice shower, 1girl, cherry blossoms' },
        now: Date.UTC(2026, 9, 16, 5, 32),
    });
}

async function withFolders(body) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'saa-lib-'));
    try {
        return await body(dir);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

test('folders: days newest first, then the others; SAA\'s own samples and empty folders left out', () => withFolders(async dir => {
    for (const [folder, count] of [['2026-10-15', 2], ['2026-10-16', 1], ['regional', 1], ['parts-samples', 3], ['empty', 0]]) {
        fs.mkdirSync(path.join(dir, folder));
        for (let index = 0; index < count; index++) fs.writeFileSync(path.join(dir, folder, `${index}.png`), png());
    }
    fs.writeFileSync(path.join(dir, 'loose.png'), png());
    const index = createLibraryIndex({ log: null });
    assert.deepEqual(await index.folders(dir), [
        { id: '2026-10-16', label: '2026-10-16', count: 1 },
        { id: '2026-10-15', label: '2026-10-15', count: 2 },
        { id: 'regional', label: 'regional', count: 1 },
        { id: '.', label: path.basename(dir), count: 1 },
    ]);
}));

test('a flat folder of pod saves is split into days by the stamp in each name', () => withFolders(async dir => {
    for (const name of ['SAA_2026-09-03T05-57-52_1.png', 'SAA_2026-09-03T06-23-46_2.png', 'SAA_2026-09-30T01-00-00_3.png']) fs.writeFileSync(path.join(dir, name), png());
    const index = createLibraryIndex({ log: null });
    assert.deepEqual(await index.folders(dir, { flat: true }), [{ id: 'day:2026-09-30', label: '2026-09-30', count: 1 }, { id: 'day:2026-09-03', label: '2026-09-03', count: 2 }]);
    assert.deepEqual((await index.images(dir, 'day:2026-09-03')).map(entry => entry.name).sort(), ['SAA_2026-09-03T05-57-52_1.png', 'SAA_2026-09-03T06-23-46_2.png']);
    assert.equal(dayOf({ name: 'SAA_2026-09-03T05-57-52_1.png' }), '2026-09-03');
}));

test('an entry says what the PNG text says: recipe, time, or only parameters', () => withFolders(async dir => {
    const day = path.join(dir, '2026-10-16');
    fs.mkdirSync(day);
    fs.writeFileSync(path.join(day, 'a.png'), png([
        ['saa_recipe', asciiJson(recipeOf({ seed: 1830551274, names: 'ライスシャワー', click: 'c1' }))],
        ['saa_time', asciiJson({ v: 1, total: 10200, segments: [{ id: 'base', ms: 5800 }] })],
    ]));
    fs.writeFileSync(path.join(day, 'b.png'), png([['parameters', 'maid, 1girl\nNegative prompt: lowres\nSteps: 28, Sampler: Euler a, CFG scale: 6, Seed: 77, Size: 832x1216, Model: waiIllustriousSDXL_v160']]));
    fs.writeFileSync(path.join(day, 'c.png'), png());
    const index = createLibraryIndex({ log: null });
    const entries = Object.fromEntries((await index.images(dir, '2026-10-16')).map(entry => [entry.name, entry]));
    assert.equal(entries['a.png'].state, 'full');
    assert.deepEqual([entries['a.png'].seed, entries['a.png'].time, entries['a.png'].click, entries['a.png'].width], [1830551274, 10200, 'c1', 832]);
    assert.deepEqual(entries['a.png'].characters, ['ライスシャワー']);
    assert.deepEqual(entries['a.png'].loras, ['dmd2']);
    assert.match(entries['a.png'].text, /cherry blossoms/);
    assert.equal(entries['b.png'].state, 'partial');
    assert.equal(entries['b.png'].model, 'waiIllustriousSDXL_v160');
    assert.match(entries['b.png'].text, /maid/);
    assert.equal(entries['c.png'].state, 'none');
}));

test('the cache spares the second read and notices a changed file', () => withFolders(async dir => {
    const file = path.join(dir, 'a.png');
    fs.writeFileSync(file, png([['parameters', 'one\nSteps: 1, Seed: 1']]));
    let reads = 0;
    const cacheFile = path.join(dir, 'cache', 'index.json');
    const counting = target => { reads += 1; return readImageHeader(target); };
    const first = createLibraryIndex({ cacheFile, readHeader: counting, log: null });
    await first.images(dir, '.');
    await first.images(dir, '.');
    assert.equal(reads, 1);
    await new Promise(resolve => setTimeout(resolve, 2300));   // the cache is written a moment later
    const second = createLibraryIndex({ cacheFile, readHeader: counting, log: null });
    second.load();
    assert.equal((await second.images(dir, '.'))[0].seed, 1);
    assert.equal(reads, 1, 'read from the cache file');
    fs.writeFileSync(file, png([['parameters', 'two, longer\nSteps: 1, Seed: 2']]));
    assert.equal((await second.images(dir, '.'))[0].seed, 2);
    assert.equal(reads, 2);
}));

test('the grid: search and filters, sorting, and runs grouped by their click', async () => {
    await withFakeDom(async () => {
        globalThis.globalSettings = { language: 'en-US' };
        globalThis.cachedFiles = { language: { 'en-US': {} } };
        const { filterEntries, groupEntries, groupSummary, sortEntries, filterOptions } = await import('../scripts/renderer/libraryWindow.js');
        const entry = (name, minute, extra = {}) => ({ name, path: `C:\\out\\${name}`, created: `2026-10-16T05:${String(minute).padStart(2, '0')}:00.000Z`, mtime: 0, model: 'v170', characters: ['rice'], loras: [], state: 'full', text: '', click: '', time: null, type: 'Checkpoint', fast: false, ...extra });
        const entries = [
            entry('a.png', 1, { click: 'k1', time: 9000, text: 'cherry blossoms rice' }),
            entry('b.png', 2, { click: 'k1', time: 8000 }),
            entry('c.png', 5, { click: 'k2', loras: ['charturn'] }),
            entry('d.png', 30, { state: 'partial', model: 'v160' }),
            entry('e.png', 33, { state: 'partial', model: 'v160' }),
        ];
        assert.deepEqual(filterEntries(entries, { search: 'cherry rice' }).map(item => item.name), ['a.png']);
        assert.deepEqual(filterEntries(entries, { search: 'D.PNG' }).map(item => item.name), ['d.png'], 'the file name is searched too');
        assert.deepEqual(filterEntries(entries, { lora: 'charturn' }).map(item => item.name), ['c.png']);
        assert.deepEqual(filterEntries(entries, { recipe: 'partial', model: 'v160' }).map(item => item.name), ['d.png', 'e.png']);
        assert.deepEqual(sortEntries(entries, 'newest').map(item => item.name), ['e.png', 'd.png', 'c.png', 'b.png', 'a.png']);
        assert.deepEqual(sortEntries(entries, 'fastest').map(item => item.name).slice(0, 2), ['b.png', 'a.png']);
        const runs = groupEntries(sortEntries(entries, 'newest'), 'run');
        assert.deepEqual(runs.map(group => group.entries.map(item => item.name)), [['e.png', 'd.png'], ['c.png'], ['b.png', 'a.png']],
            'one click, one run; images without a click join when close in time with the same model and characters');
        assert.equal(groupSummary(runs[2].entries), '2 images · rice · Checkpoint');
        assert.deepEqual(groupEntries(entries, 'day').map(group => group.entries.length), [5]);
        assert.deepEqual(filterOptions(entries, item => [item.model]), [{ value: 'v170', count: 3 }, { value: 'v160', count: 2 }]);
    });
});
