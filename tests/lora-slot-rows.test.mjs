// The LoRA slot (slots/myLoRASlot.js) on the in-memory DOM: the row a "+" builds, the
// tag every enable mode composes for each backend (generate.js getLoRAs), the parse that
// turns "<lora:...>" back into rows, and the metadata the "?" button shows.
import assert from 'node:assert/strict';
import test from 'node:test';

import { getLoRAs } from '../scripts/renderer/generate.js';
import { generateGUID } from '../scripts/renderer/slots/myLoRASlot.js';
import { withFakeDom } from './helpers/fakeDom.mjs';

// the textbox measures itself on a timer that outlives the fake document
globalThis.getComputedStyle = () => ({ lineHeight: '20px' });

const flush = () => new Promise(resolve => setTimeout(resolve, 0));
const LORA_LIST = ['style/anime.safetensors', 'detail.safetensors', 'plain-name'];

// setupLoRA keeps one manager per module, so every test gets its own copy of the module
let moduleCase = 0;

async function withLoRASlot(body, { apiInterface = 'ComfyUI' } = {}) {
    moduleCase += 1;
    return withFakeDom(async document => {
        const overlays = [];
        globalThis.globalSettings = {
            language: 'en-US', css_style: 'dark',
            model_path_comfyui: 'C:/comfy/models', model_path_webui: 'C:/webui/models',
        };
        globalThis.cachedFiles = {
            loraList: LORA_LIST,
            language: { 'en-US': { lora_model_strength: 'Model', lora_clip_strength: 'Clip', lora_enable_title: 'Enable', lora_trigger_words: 'Trigger: ', lora_metadata: 'Metadata:', lora_no_metadata: 'No metadata' } },
        };
        globalThis.generate = { api_interface: { getValue: () => apiInterface } };
        globalThis.overlay = { custom: { createCustomOverlay: (...args) => overlays.push(args) } };
        globalThis.inBrowser = false;

        const container = document.createElement('div');
        container.className = 'add-lora-main';
        document.body.appendChild(container);

        const { setupLoRA } = await import(`../scripts/renderer/slots/myLoRASlot.js?case=${moduleCase}`);
        const manager = setupLoRA('add-lora-main');
        globalThis.lora = manager;
        return body({ document, container, manager, overlays });
    }, {
        localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
        getComputedStyle: () => ({ lineHeight: '20px' }),
    });
}

const click = (container, target) =>
    container.dispatchEvent({ type: 'click', target, bubbles: false, preventDefault() {}, stopPropagation() {} });

// The "+" of the waiting row builds a slot; its four controls are reached the way the
// manager's own getValues does.
async function addRow(container, manager) {
    click(container, container.querySelector('.slot-action-add'));
    await flush();
    const className = manager.getSlots().at(-1);
    const slot = manager.slotIndex.get(className);
    const component = field => manager.componentInstances.get(`${className}-${slot.itemClasses[field]}`);
    return {
        className,
        set(field, value) {
            const control = component(field);
            if (control.updateDefaults) control.updateDefaults(value); else control.setValue(value);
            return this;
        },
    };
}

test('every id a row is looked up by is a complete v4 GUID', () => {
    const ids = new Set();
    for (let attempt = 0; attempt < 200; attempt++) {
        const id = generateGUID();
        assert.match(id, /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/, id);
        ids.add(id);
    }
    assert.equal(ids.size, 200, 'and no two rows share one');
});

test('the "+" builds a row of LoRA, model strength, clip strength and an enable mode', async () => {
    await withLoRASlot(async ({ container, manager }) => {
        const row = await addRow(container, manager);

        assert.equal(container.querySelectorAll('.content-row').length, 1);
        assert.equal(container.querySelectorAll('.add-row').length, 1, 'a fresh + row waits under it');
        assert.deepEqual(manager.getValues(), [[LORA_LIST[0], '1.0', '1.0', 'ALL']]);

        row.set('select1', 'detail.safetensors').set('text1', '0.6').set('text2', '0.4').set('select2', 'HiFix');
        assert.deepEqual(manager.getValues(), [['detail.safetensors', '0.6', '0.4', 'HiFix']]);
    });
});

test('ComfyUI gets both strengths, and where they sit says which pass the LoRA runs in', async () => {
    await withLoRASlot(async ({ container, manager }) => {
        const row = await addRow(container, manager);
        row.set('select1', 'detail.safetensors').set('text1', '0.6').set('text2', '0.4');

        row.set('select2', 'ALL');
        assert.equal(getLoRAs('ComfyUI'), '<lora:detail.safetensors:0.6:0.4>');
        assert.equal(getLoRAs('None'), '', 'with no backend chosen there is nothing to send it to');
        row.set('select2', 'Base');
        assert.equal(getLoRAs('ComfyUI'), '<lora:detail.safetensors:0.6:0.4:0:0>', 'base pass only');
        row.set('select2', 'HiFix');
        assert.equal(getLoRAs('ComfyUI'), '<lora:detail.safetensors:0:0:0.6:0.4>', 'hires pass only');
        row.set('select2', 'OFF');
        assert.equal(getLoRAs('ComfyUI'), '', 'an off row sends nothing');
        assert.equal(getLoRAs('WebUI'), '', 'to either backend');
    });
});

test('WebUI gets the bare file name and one strength, and a name it cannot parse is dropped', async () => {
    await withLoRASlot(async ({ container, manager }) => {
        const first = await addRow(container, manager);
        first.set('select1', 'style/anime.safetensors').set('text1', '0.7').set('text2', '0.2');
        assert.equal(getLoRAs('WebUI'), '<lora:anime:0.7>', 'the folder and the extension are the file system\'s, not the prompt\'s');

        const second = await addRow(container, manager);
        second.set('select1', 'plain-name').set('text1', '1.0');
        assert.equal(getLoRAs('WebUI'), '<lora:anime:0.7>', 'a name that is not a .safetensors has nothing to send');

        second.set('select1', 'detail.safetensors');
        assert.equal(getLoRAs('WebUI'), '<lora:anime:0.7>\n<lora:detail:1.0>', 'one per line');
    });
});

test('a prompt\'s LoRA tags are parsed back into rows, one mode per pair', async () => {
    await withLoRASlot(async ({ manager }) => {
        manager.flushSlot('<lora:detail.safetensors:0.6:0.4>');
        await flush();
        assert.deepEqual(manager.getValues(), [['detail.safetensors', '0.6', '0.4', 'ALL']]);

        manager.flushSlot('<lora:detail.safetensors:0.6:0.4:0:0>');
        await flush();
        assert.deepEqual(manager.getValues(), [['detail.safetensors', '0.6', '0.4', 'Base']]);

        manager.flushSlot('<lora:detail.safetensors:0:0:0.6:0.4>');
        await flush();
        assert.deepEqual(manager.getValues(), [['detail.safetensors', '0.6', '0.4', 'HiFix']],
            'the row carries the pass\'s own strengths, not the zeros of the pass it skips');

        // the same pair twice is the one mode that covers both passes
        manager.flushSlot('<lora:detail.safetensors:0.6:0.4:0.6:0.4>');
        await flush();
        assert.deepEqual(manager.getValues(), [['detail.safetensors', '0.6', '0.4', 'ALL']]);

        // different pairs need a row each
        manager.flushSlot('<lora:detail.safetensors:0.6:0.4:0.2:0.1>');
        await flush();
        assert.deepEqual(manager.getValues(), [
            ['detail.safetensors', '0.6', '0.4', 'Base'],
            ['detail.safetensors', '0.2', '0.1', 'HiFix'],
        ]);

        manager.flushSlot('<lora:detail.safetensors:0:0>');
        await flush();
        assert.deepEqual(manager.getValues(), [['detail.safetensors', '0', '0', 'OFF']]);
    });
});

test('a LoRA the installation does not have still gets a row, switched off', async () => {
    const warnings = [];
    const realWarn = console.warn;
    console.warn = (...args) => warnings.push(args.join(' '));
    try {
        await withLoRASlot(async ({ manager }) => {
            manager.flushSlot('<lora:gone.safetensors:0.8:0.8><lora:detail.safetensors:0.5:0.5>');
            await flush();
            const rows = manager.getValues();
            assert.deepEqual(rows[0].slice(1), ['0', '0', 'OFF'], 'no strength, no pass');
            assert.deepEqual(rows[1], ['detail.safetensors', '0.5', '0.5', 'ALL'], 'the one that is installed is untouched');
            assert.equal(getLoRAs('ComfyUI'), '<lora:detail.safetensors:0.5:0.5>', 'so the missing one cannot reach a backend');
            assert.ok(warnings.some(line => line.includes('gone.safetensors')), 'and it is reported');
            // the dropdown has no entry for a model that is not installed, so the row shows
            // the first installed one instead of the name the prompt carried
            assert.equal(rows[0][0], LORA_LIST[0]);
        });
    } finally {
        console.warn = realWarn;
    }
});

test('flush rebuilds the rows saved in the settings, including an enable value it does not know', async () => {
    await withLoRASlot(async ({ manager }) => {
        globalThis.globalSettings.lora_slot = [
            ['detail.safetensors', '0.6', '0.4', 'ALL'],
            // a row saved before its controls were built has no enable value; this used to
            // throw a ReferenceError and take the whole settings load down with it
            ['style/anime.safetensors', '1.0', '1.0', ''],
        ];
        manager.flush();
        await flush();
        assert.deepEqual(manager.getValues(), [
            ['detail.safetensors', '0.6', '0.4', 'ALL'],
            ['style/anime.safetensors', '0', '0', 'OFF'],
        ]);
    });
});

// --------------------------------------------------------------- the "?" metadata panel

const METADATA = {
    'modelspec.title': 'Detail Tweaker',
    'modelspec.architecture': 'stable-diffusion-xl-v1-base/lora',
    ss_network_dim: '32',
    ss_tag_frequency: JSON.stringify({ '10_detail': { blurry: 5, '1girl': 120, smile: 60 } }),
    ss_something_else: 'not shown',
};

test('the "?" shows the model card, the trigger words by frequency, and the raw metadata', async () => {
    await withLoRASlot(async ({ container, manager, overlays }) => {
        const asked = [];
        globalThis.api = {
            readSafetensors: async (...args) => { asked.push(args); return METADATA; },
            readFile: async (...args) => { asked.push(args); return 'data:image/png;base64,preview'; },
        };
        const row = await addRow(container, manager);
        row.set('select1', 'detail.safetensors');

        click(container, container.querySelector('.slot-action-info'));
        await flush();

        assert.deepEqual(asked, [
            ['C:/comfy/models', 'loras', 'detail.safetensors'],
            ['C:/comfy/models', 'loras', 'detail.png'],
        ], 'the sample image sits next to the model');

        const [image, message] = overlays.at(-1);
        assert.equal(image, 'data:image/png;base64,preview');
        assert.match(message, /^\n\nModel Title: Detail Tweaker\nArchitecture: stable-diffusion-xl-v1-base\/lora\nNetwork Dim: 32\n/,
            'only the keys the card names, in the card\'s order');
        assert.match(message, /Trigger: \[color=Chartreuse]1girl \(120\), smile \(60\), blurry \(5\)\[\/color]/,
            'the most used tag first');
        assert.match(message, /\n\nMetadata:\n\{\n {2}"modelspec.title": "Detail Tweaker"/, 'the raw file follows');
        assert.match(message, /"ss_something_else": "not shown"/, 'in full, card or not');
    });
});

test('the trigger words are the ten most used, and unreadable frequencies cost nothing else', async () => {
    await withLoRASlot(async ({ container, manager, overlays }) => {
        const many = Object.fromEntries(Array.from({ length: 12 }, (_, index) => [`tag${index}`, index + 1]));
        globalThis.api = {
            readSafetensors: async () => ({ ss_network_dim: '8', ss_tag_frequency: JSON.stringify({ '10_x': many }) }),
            readFile: async () => 'data:image/png;base64,preview',
        };
        const row = await addRow(container, manager);
        row.set('select1', 'detail.safetensors');
        click(container, container.querySelector('.slot-action-info'));
        await flush();

        const tags = /\[color=Chartreuse]([^[]*)\[\/color]/.exec(overlays.at(-1)[1])[1];
        assert.deepEqual(tags.split(', ').slice(0, 3), ['tag11 (12)', 'tag10 (11)', 'tag9 (10)']);
        assert.equal(tags.split(', ').length, 10, 'ten at most');

        globalThis.api.readSafetensors = async () => ({ ss_network_dim: '8', ss_tag_frequency: 'not json' });
        const realError = console.error;
        console.error = () => {};
        try {
            click(container, container.querySelector('.slot-action-info'));
            await flush();
        } finally {
            console.error = realError;
        }
        assert.match(overlays.at(-1)[1], /Trigger: \[color=Chartreuse]\[\/color]/, 'the rest of the card still shows');
    });
});

test('a model with no metadata, and one that could not be read, say so instead', async () => {
    await withLoRASlot(async ({ container, manager, overlays }) => {
        globalThis.api = { readSafetensors: async () => 'None', readFile: async () => '' };
        const row = await addRow(container, manager);
        row.set('select1', 'detail.safetensors');

        click(container, container.querySelector('.slot-action-info'));
        await flush();
        assert.deepEqual(overlays.at(-1).slice(0, 2), ['none', '\n\nNo metadata']);

        globalThis.api.readSafetensors = async () => 'Error: file is locked';
        click(container, container.querySelector('.slot-action-info'));
        await flush();
        assert.deepEqual(overlays.at(-1).slice(0, 2), ['none', '\n\nError: file is locked']);
    });
});
