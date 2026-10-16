// The viewer's Info tab: what imageSummary.js makes of an image's records, what
// viewerInfo.js draws from that, and the store that keeps the stars of saved images.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { buildRecipe } from '../scripts/shared/recipe.js';
import { detailerLabel, modelLabel, summarizeImage } from '../scripts/shared/imageSummary.js';
import { createLibraryStore } from '../scripts/main/libraryStore.js';
import { withFakeDom } from './helpers/fakeDom.mjs';

const recipe = buildRecipe({
    sections: {
        prompt: {},
        generation: { step: 30, cfg: 4, api_model_sampler: 'er_sde', api_model_scheduler: 'simple', api_model_file_diffusion_select: 'waiANIMA_v10Base10.safetensors', width: 832, height: 1216 },
        lora: { lora_slot: [['styles\\CharTurnIL.safetensors', '0.8', '0.8', 'ALL'], ['off.safetensors', '1', '1', 'OFF']] },
        adetailer: { api_adetailer_enable: true, ad_slot: [['bbox/face_yolov8m.pt', '0.3', '0', 'center-1']] },
    },
    settings: { api_model_type: 'Diffusion' },
    run: {
        seed: 1830551274, width: 832, height: 1216, names: 'rice shower (umamusume)',
        sent: { steps: 8, cfg: 1.5, sampler: 'euler', scheduler: 'simple', fast: { lora: 'anima-turbo-lora-v0.2.safetensors', strength: 0.8 } },
        prose: { applied: true, paragraph: 'Rice Shower stands under the cherry trees.', writer: 'student' },
    },
});
const timing = { v: 1, total: 10200, segments: [{ id: 'prose', ms: 900 }, { id: 'queue', ms: 100 }, { id: 'base', ms: 5800 }, { id: 'detailer', ms: 3400 }] };

test('names lose their folders and extensions; a detailer is called by what it finds', () => {
    assert.equal(modelLabel('styles\\anima-turbo-lora-v0.2.safetensors'), 'anima-turbo-lora-v0.2');
    assert.equal(detailerLabel('bbox/face_yolov8m.pt'), 'face');
    assert.equal(detailerLabel('bbox/hand_yolov8n.pt'), 'hand');
});

test('a recipe: what was sent, what the editor asked for, the LoRA rows that ran and Fast\'s own', () => {
    const summary = summarizeImage({ recipe, timing, path: 'C:\\out\\a.png' });
    assert.equal(summary.state, 'full');
    assert.deepEqual([summary.model, summary.type], ['waiANIMA_v10Base10', 'Diffusion']);
    assert.deepEqual([summary.sampler, summary.scheduler, summary.steps, summary.cfg], ['euler', 'simple', 8, 1.5]);
    assert.deepEqual(summary.asked, { steps: 30, cfg: 4 });
    assert.deepEqual(summary.fast, { lora: 'anima-turbo-lora-v0.2', strength: 0.8 });
    assert.deepEqual(summary.loras.map(row => [row.name, row.weight, row.fast]), [['CharTurnIL', 0.8, false], ['anima-turbo-lora-v0.2', 0.8, true]], 'the OFF row did not run');
    assert.deepEqual(summary.detailers, ['face']);
    assert.equal(summary.time.total, 10200);
    assert.deepEqual(summary.characters, ['rice shower (umamusume)']);
});

test('only the parameters text: a partial summary; nothing at all: just the seed', () => {
    const partial = summarizeImage({ parameters: '1girl\n<lora:x.safetensors:0.6>\nNegative prompt: bad\nSteps: 28, Sampler: Euler a, CFG scale: 6, Seed: 5, Size: 512x768, Model: waiIllustriousSDXL_v160' });
    assert.equal(partial.state, 'partial');
    assert.deepEqual([partial.model, partial.steps, partial.seed, partial.width], ['waiIllustriousSDXL_v160', 28, 5, 512]);
    assert.deepEqual(partial.loras.map(row => row.name), ['x']);
    const none = summarizeImage({ seed: '77' });
    assert.deepEqual([none.state, none.seed, none.time], ['none', 77, null]);
});

test('the Info tab draws the time and the recipe, and the seed button fills the Seed field', async () => {
    await withFakeDom(async document => {
        globalThis.globalSettings = { language: 'en-US' };
        globalThis.cachedFiles = { language: { 'en-US': {} } };
        globalThis.inBrowser = false;
        const seeds = [];
        globalThis.generate = { seed: { setValue: value => seeds.push(value) } };
        const { renderViewerInfo } = await import('../scripts/renderer/viewerInfo.js');
        const panel = document.createElement('div');
        const badge = document.createElement('span');
        document.body.append(panel, badge);

        const actions = renderViewerInfo(panel, summarizeImage({ recipe, timing, path: 'C:\\out\\a.png' }), { badge, writer: 'student' });
        assert.ok(actions, 'a box for the buttons under the recipe');
        assert.equal(panel.querySelector('.viewer-time-total').textContent, '10.2 s');
        assert.deepEqual(panel.querySelectorAll('.viewer-time-row').map(row => [row.querySelector('.viewer-time-name').textContent, row.querySelector('.viewer-time-sec').textContent]),
            [['Prose (Student)', '0.9 s'], ['Queue wait', '0.1 s'], ['Base pass', '5.8 s'], ['Detailer', '3.4 s']]);
        assert.equal(panel.querySelector('.viewer-time-note').textContent, 'Fast · anima-turbo-lora-v0.2 0.8');
        const rows = Object.fromEntries(panel.querySelectorAll('.viewer-recipe-list dt').map(dt => [dt.textContent, dt.nextElementSibling.textContent]));
        assert.equal(rows.Model, 'waiANIMA_v10Base10 · Diffusion');
        assert.equal(rows['Steps · CFG'], '8 · 1.5Fastyou set 30 · 4');
        assert.equal(rows.Size, '832 × 1216 · Hires off · Detailer face');
        assert.equal(rows.Seed, '1830551274');
        assert.equal(badge.textContent, '● SAA recipe v1');
        assert.equal(badge.hidden, false);
        panel.querySelector('.viewer-seed-button').click();
        assert.deepEqual(seeds, [1830551274]);

        renderViewerInfo(panel, summarizeImage({ seed: 3 }), { badge });
        assert.equal(badge.hidden, true, 'no records, no badge');
        assert.equal(panel.querySelector('.viewer-time-total').textContent, '—');
    });
});

test('the stars of saved images survive a reload, without case on Windows', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'saa-library-'));
    try {
        const store = createLibraryStore({ rootDir: dir, platform: 'win32', log: null });
        assert.deepEqual(store.list(), []);
        store.setFavorite('C:\\out\\2026-10-16\\a.png', true);
        store.setFavorite('relative.png', true);   // not a path to anything: ignored
        assert.equal(store.isFavorite('c:\\OUT\\2026-10-16\\A.png'), true);
        const again = createLibraryStore({ rootDir: dir, platform: 'win32', log: null });
        assert.deepEqual(again.list(), ['C:\\out\\2026-10-16\\a.png']);
        again.setFavorite('C:\\OUT\\2026-10-16\\a.png', false);
        assert.deepEqual(createLibraryStore({ rootDir: dir, platform: 'win32', log: null }).list(), []);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
