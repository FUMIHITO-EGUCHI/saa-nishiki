// The LoRA slots (slots/myLoRASlot.js) on the in-memory DOM: a row per LoRA with its
// switch, weight slider and field, the fold with the pass and the CLIP strength, the tag
// every mode composes for each backend (generate.js getLoRAs), and the parse that turns
// "<lora:...>" back into rows.
import assert from 'node:assert/strict';
import test from 'node:test';

import { getLoRAs } from '../scripts/renderer/generate.js';
import { generateGUID, rowsFromLoraTags } from '../scripts/renderer/slots/myLoRASlot.js';
import { withFakeDom } from './helpers/fakeDom.mjs';

const LORA_LIST = ['style/anime.safetensors', 'detail.safetensors', 'plain-name'];

// setupLoRA keeps one manager per module, so every test gets its own copy of the module
let moduleCase = 0;

async function withLoRASlot(body, { apiInterface = 'ComfyUI', loraUi = null } = {}) {
    moduleCase += 1;
    return withFakeDom(async document => {
        globalThis.globalSettings = { language: 'en-US', css_style: 'dark' };
        globalThis.cachedFiles = { loraList: LORA_LIST, language: { 'en-US': {} } };
        globalThis.generate = { api_interface: { getValue: () => apiInterface } };
        globalThis.loraUi = loraUi;
        const container = document.createElement('div');
        container.className = 'add-lora-main';
        document.body.appendChild(container);
        const { setupLoRA } = await import(`../scripts/renderer/slots/myLoRASlot.js?case=${moduleCase}`);
        const manager = setupLoRA('add-lora-main');
        globalThis.lora = manager;
        try {
            return await body({ document, container, manager });
        } finally {
            delete globalThis.loraUi;
        }
    });
}

const rowOf = (container, index = 0) => container.querySelectorAll('.lora-slot')[index];
const input = (node, value, type = 'input') => {
    node.value = value;
    node.dispatchEvent({ type, bubbles: true });
};

test('every id a row is looked up by is a complete v4 GUID', () => {
    const ids = new Set();
    for (let attempt = 0; attempt < 200; attempt++) {
        const id = generateGUID();
        assert.match(id, /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/, id);
        ids.add(id);
    }
    assert.equal(ids.size, 200, 'and no two rows share one');
});

test('a saved row: the name without its folder or extension, the switch, the slider and the field', async () => {
    await withLoRASlot(async ({ container, manager }) => {
        globalThis.globalSettings.lora_slot = [['style/anime.safetensors', '0.8', '0.8', 'ALL']];
        manager.flush();
        const row = rowOf(container);
        assert.equal(row.querySelector('.lora-slot-name').textContent, 'anime');
        assert.equal(row.querySelector('.lora-slot-name').title, 'style/anime.safetensors');
        assert.equal(row.querySelector('.lora-slot-switch').getAttribute('aria-checked'), 'true');
        assert.equal(row.querySelector('.lora-slot-slider').value, '0.8');
        assert.equal(row.querySelector('.lora-slot-value').value, '0.8');
        assert.ok(container.querySelector('.lora-slot-add'), 'the + LoRA button under the rows');
        assert.deepEqual(manager.getValues(), [['style/anime.safetensors', '0.8', '0.8', 'ALL']]);
    });
});

test('the slider and the field are one weight, and CLIP follows it until it is given its own', async () => {
    await withLoRASlot(async ({ container, manager }) => {
        manager.setRows([['detail.safetensors', '0.8', '0.8', 'ALL']]);
        const row = rowOf(container);
        input(row.querySelector('.lora-slot-slider'), '0.55');
        assert.equal(row.querySelector('.lora-slot-value').value, '0.55');
        assert.deepEqual(manager.getValues(), [['detail.safetensors', '0.55', '0.55', 'ALL']]);
        input(row.querySelector('.lora-slot-value'), '1.2');
        assert.equal(row.querySelector('.lora-slot-slider').max, '1.2', 'the slider widens to a weight past its range');
        assert.deepEqual(manager.getValues(), [['detail.safetensors', '1.2', '1.2', 'ALL']]);

        row.querySelector('.lora-slot-fold').click();
        const clip = rowOf(container).querySelector('.lora-slot-clip');
        assert.equal(clip.value, '1.2', 'CLIP shows the weight it follows');
        assert.equal(clip.classList.contains('is-own'), false);
        input(clip, '0.4');
        assert.equal(clip.classList.contains('is-own'), true, 'a value of its own');
        assert.ok(rowOf(container).querySelector('.lora-slot-relink'), 'and the way back');
        input(rowOf(container).querySelector('.lora-slot-slider'), '0.9');
        assert.deepEqual(manager.getValues(), [['detail.safetensors', '0.9', '0.4', 'ALL']], 'the weight moves alone now');
        rowOf(container).querySelector('.lora-slot-relink').click();
        assert.deepEqual(manager.getValues(), [['detail.safetensors', '0.9', '0.9', 'ALL']], '↺ follows the weight again');
    });
});

test('a row whose CLIP differs from its weight comes back with CLIP of its own', async () => {
    await withLoRASlot(async ({ container, manager }) => {
        manager.setRows([['detail.safetensors', '0.6', '0.4', 'ALL']]);
        rowOf(container).querySelector('.lora-slot-fold').click();
        assert.equal(rowOf(container).querySelector('.lora-slot-clip').value, '0.4');
        assert.equal(rowOf(container).querySelector('.lora-slot-clip').classList.contains('is-own'), true);
    });
});

test('WebUI takes one strength: the CLIP field is off there', async () => {
    await withLoRASlot(async ({ container, manager }) => {
        manager.setRows([['detail.safetensors', '0.6', '0.6', 'ALL']]);
        rowOf(container).querySelector('.lora-slot-fold').click();
        assert.equal(rowOf(container).querySelector('.lora-slot-clip').disabled, true);
    }, { apiInterface: 'WebUI' });
});

test('the switch turns a row off and back on with its strengths and its pass', async () => {
    await withLoRASlot(async ({ container, manager }) => {
        manager.setRows([['detail.safetensors', '0.6', '0.4', 'Base']]);
        assert.equal(rowOf(container).querySelector('.lora-slot-stage').textContent, 'Base only', 'a pass other than All shows under the name');
        rowOf(container).querySelector('.lora-slot-switch').click();
        assert.deepEqual(manager.getValues(), [['detail.safetensors', '0.6', '0.4', 'OFF']]);
        assert.equal(rowOf(container).classList.contains('is-off'), true);
        assert.equal(getLoRAs('ComfyUI'), '', 'an off row sends nothing');
        rowOf(container).querySelector('.lora-slot-switch').click();
        assert.deepEqual(manager.getValues(), [['detail.safetensors', '0.6', '0.4', 'Base']]);
    });
});

test('the fold picks the pass: All, Base or Hires, each its own tag for ComfyUI', async () => {
    await withLoRASlot(async ({ container, manager }) => {
        manager.setRows([['detail.safetensors', '0.6', '0.4', 'ALL']]);
        rowOf(container).querySelector('.lora-slot-fold').click();
        const pick = label => [...rowOf(container).querySelectorAll('.lora-segment button')].find(node => node.textContent === label).click();
        assert.equal(getLoRAs('ComfyUI'), '<lora:detail.safetensors:0.6:0.4>');
        assert.equal(getLoRAs('None'), '', 'with no backend chosen there is nothing to send it to');
        pick('Base');
        assert.equal(getLoRAs('ComfyUI'), '<lora:detail.safetensors:0.6:0.4:0:0>', 'base pass only');
        pick('Hires');
        assert.equal(getLoRAs('ComfyUI'), '<lora:detail.safetensors:0:0:0.6:0.4>', 'hires pass only');
        assert.equal(rowOf(container).querySelector('.lora-slot-stage').textContent, 'Hires only');
        assert.equal(rowOf(container).classList.contains('is-open'), true, 'the fold stays open');
    });
});

test('WebUI gets the bare file name and one strength, and a name it cannot parse is dropped', async () => {
    await withLoRASlot(async ({ manager }) => {
        manager.setRows([['style/anime.safetensors', '0.7', '0.2', 'ALL'], ['plain-name', '1.0', '1.0', 'ALL']]);
        assert.equal(getLoRAs('WebUI'), '<lora:anime:0.7>', 'the folder and the extension are the file system\'s; a name without .safetensors has nothing to send');
        manager.setRows([['style/anime.safetensors', '0.7', '0.2', 'ALL'], ['detail.safetensors', '1.0', '1.0', 'ALL']]);
        assert.equal(getLoRAs('WebUI'), '<lora:anime:0.7>\n<lora:detail:1.0>', 'one per line');
    });
});

test('the × removes the row', async () => {
    await withLoRASlot(async ({ container, manager }) => {
        manager.setRows([['detail.safetensors', '0.6', '0.6', 'ALL'], ['style/anime.safetensors', '1', '1', 'ALL']]);
        rowOf(container).querySelector('.lora-slot-remove').click();
        assert.deepEqual(manager.getValues(), [['style/anime.safetensors', '1', '1', 'ALL']]);
        assert.equal(manager.getSlots().length, 1);
    });
});

test('a prompt\'s LoRA tags are parsed back into rows, one mode per pair', () => {
    globalThis.cachedFiles = { loraList: LORA_LIST };
    assert.deepEqual(rowsFromLoraTags('<lora:detail.safetensors:0.6:0.4>'), [['detail.safetensors', '0.6', '0.4', 'ALL']]);
    assert.deepEqual(rowsFromLoraTags('<lora:detail.safetensors:0.6:0.4:0:0>'), [['detail.safetensors', '0.6', '0.4', 'Base']]);
    assert.deepEqual(rowsFromLoraTags('<lora:detail.safetensors:0:0:0.6:0.4>'), [['detail.safetensors', '0.6', '0.4', 'HiFix']],
        'the row carries the pass\'s own strengths, not the zeros of the pass it skips');
    assert.deepEqual(rowsFromLoraTags('<lora:detail.safetensors:0.6:0.4:0.6:0.4>'), [['detail.safetensors', '0.6', '0.4', 'ALL']], 'the same pair twice covers both passes');
    assert.deepEqual(rowsFromLoraTags('<lora:detail.safetensors:0.6:0.4:0.2:0.1>'), [
        ['detail.safetensors', '0.6', '0.4', 'Base'],
        ['detail.safetensors', '0.2', '0.1', 'HiFix'],
    ], 'different pairs need a row each');
    assert.deepEqual(rowsFromLoraTags('<lora:detail.safetensors:0:0>'), [['detail.safetensors', '0', '0', 'OFF']]);
    delete globalThis.cachedFiles;
});

test('a LoRA the installation does not have keeps its name, switched off, never another file', async () => {
    const warnings = [];
    const realWarn = console.warn;
    console.warn = (...args) => warnings.push(args.join(' '));
    try {
        await withLoRASlot(async ({ container, manager }) => {
            globalThis.globalSettings.lora_slot = [['moved-away.safetensors', '0.8', '0.8', 'ALL'], ['detail.safetensors', '0.5', '0.5', 'ALL']];
            manager.flush();
            assert.deepEqual(manager.getValues(), [
                ['moved-away.safetensors', '0.8', '0.8', 'OFF'],
                ['detail.safetensors', '0.5', '0.5', 'ALL'],
            ], 'the missing one is named and off, its strengths kept; the installed one runs');
            assert.equal(rowOf(container).querySelector('.lora-slot-switch').disabled, true, 'and it cannot be switched on');
            assert.equal(rowOf(container).classList.contains('is-missing'), true);
            assert.equal(getLoRAs('ComfyUI'), '<lora:detail.safetensors:0.5:0.5>', 'no substitute reaches the backend');
            assert.ok(warnings.some(line => line.includes('moved-away.safetensors') && line.includes('switched off')), 'and it is reported');

            manager.flushSlot('<lora:gone.safetensors:0.8:0.8><lora:detail.safetensors:0.5:0.5>');
            assert.deepEqual(manager.getValues()[0], ['gone.safetensors', '0', '0', 'OFF'], 'from a prompt too');
        });
    } finally {
        console.warn = realWarn;
    }
});

test('an empty LoRA list (not read yet) switches nothing off, and an unknown mode is off', async () => {
    await withLoRASlot(async ({ manager }) => {
        globalThis.cachedFiles.loraList = [];
        globalThis.globalSettings.lora_slot = [['detail.safetensors', '0.5', '0.5', 'ALL'], ['style/anime.safetensors', '1.0', '1.0', '']];
        manager.flush();
        assert.deepEqual(manager.getValues(), [
            ['detail.safetensors', '0.5', '0.5', 'ALL'],
            // a row saved before its controls were built has no mode; it used to take the
            // whole settings load down with it
            ['style/anime.safetensors', '1.0', '1.0', 'OFF'],
        ]);
    });
});

test('the LoRA\'s trigger words and range come from loraUi: chips that switch, ticks at the sample weights', async () => {
    const switched = [];
    const loraUi = {
        slotWords: name => (name === 'detail.safetensors' ? { origin: 'multiple views', words: [{ word: 'charturn', on: true }, { word: 'back', on: false }] } : { words: [] }),
        slotRange: () => ({ min: 0.2, max: 1, def: 0.8, ticks: [0, 0.2, 0.4, 0.6, 0.8, 1] }),
        switchWord: (word, on) => switched.push([word, on]),
        hasSamples: () => true,
        openSamples: name => switched.push(['samples', name]),
    };
    await withLoRASlot(async ({ container, manager }) => {
        manager.setRows([['detail.safetensors', '0.8', '0.8', 'ALL']]);
        const chips = [...rowOf(container).querySelectorAll('.lora-slot-trigger')];
        assert.deepEqual(chips.map(chip => chip.textContent), ['charturn ✓', '+ back']);
        assert.equal(rowOf(container).querySelector('.lora-slot-origin').textContent, 'tag: multiple views');
        chips[0].click();
        chips[1].click();
        assert.deepEqual(switched, [['charturn', false], ['back', true]]);
        assert.equal(rowOf(container).querySelectorAll('.lora-slot-tick').length, 6, 'a tick per sample weight');
        assert.equal(rowOf(container).querySelector('.lora-slot-slider').min, '0', 'the slider starts at off');
        rowOf(container).querySelector('.lora-slot-fold').click();
        assert.equal(rowOf(container).querySelector('.lora-slot-range').textContent, '0.2 – 1');
        rowOf(container).querySelector('.lora-slot-samples').click();
        assert.deepEqual(switched.at(-1), ['samples', 'detail.safetensors'], 'Samples opens the viewer');
    }, { loraUi });
});
