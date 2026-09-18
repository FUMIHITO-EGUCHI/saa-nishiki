// The ControlNet slot (slots/myControlNetSlot.js) on the in-memory DOM: the twelve
// entries a row reports, what survives a settings reload, and what generate.js
// (createControlNet) hands the backend. controlnet-union.test.mjs covers the control
// type itself; this drives a real row carrying one.
import assert from 'node:assert/strict';
import test from 'node:test';

import { createControlNet } from '../scripts/renderer/generate.js';
import { withFakeDom } from './helpers/fakeDom.mjs';

// the textbox measures itself on a timer that outlives the fake document
globalThis.getComputedStyle = () => ({ lineHeight: '20px' });

const flush = () => new Promise(resolve => setTimeout(resolve, 0));
const MODELS = ['controlnet-union-sdxl-1.0-promax.safetensors', 'control-lora-openposeXL2-rank256.safetensors', 'CV->CLIP-ViT-H'];

// [pre, resolution, enable, post, strength, start, end, image, imageAfter, b64, b64After, controlType]
const row = (overrides = {}) => {
    const fields = {
        pre: 'DWPreprocessor', resolution: '1024', enable: 'On',
        post: MODELS[0], strength: '0.8', start: '0', end: '1',
        image: null, imageAfter: null, controlType: 'auto',
        ...overrides,
    };
    return [
        fields.pre, fields.resolution, fields.enable, fields.post,
        fields.strength, fields.start, fields.end,
        fields.image, fields.imageAfter, null, null, fields.controlType,
    ];
};

let moduleCase = 0;

async function withControlNetSlot(body) {
    moduleCase += 1;
    const warnings = [];
    const realWarn = console.warn;
    console.warn = (...args) => warnings.push(args.join(' '));
    try {
        return await withFakeDom(async document => {
            globalThis.globalSettings = {
                language: 'en-US', css_style: 'dark', api_interface: 'ComfyUI', api_controlnet_enable: true,
            };
            globalThis.cachedFiles = { controlnetList: MODELS, language: { 'en-US': {} } };
            globalThis.generate = { api_interface: { getValue: () => 'ComfyUI' } };
            globalThis.overlay = { custom: { createCustomOverlay() {} } };

            const container = document.createElement('div');
            container.className = 'add-controlnet-main';
            document.body.appendChild(container);

            const { setupControlNet } = await import(`../scripts/renderer/slots/myControlNetSlot.js?case=${moduleCase}`);
            const manager = setupControlNet('add-controlnet-main');
            globalThis.controlnet = manager;
            const add = async (...rows) => { manager.AddControlNetSlot(rows); await flush(); };
            return body({ document, container, manager, add, warnings });
        }, {
            localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
            getComputedStyle: () => ({ lineHeight: '20px' }),
        });
    } finally {
        console.warn = realWarn;
    }
}

test('a row reports its controls, then four image entries, then the control type', async () => {
    await withControlNetSlot(async ({ manager, add }) => {
        await add(row({ image: 'data:image/png;base64,SRC', imageAfter: 'data:image/png;base64,MAP', controlType: 'depth' }));

        assert.deepEqual(manager.getValues(true), [[
            'DWPreprocessor', '1024', 'On', MODELS[0], '0.8', '0', '1',
            'data:image/png;base64,SRC', 'data:image/png;base64,MAP', null, null, 'depth',
        ]]);
        assert.deepEqual(manager.getValues().at(-1).slice(7, 11), [null, null, null, null],
            'the images are left out of what settings keep');
        assert.equal(manager.getValues().at(-1)[11], 'depth', 'the control type is kept either way');
    });
});

test('a row is only built for models this installation has', async () => {
    await withControlNetSlot(async ({ manager, add, warnings }) => {
        await add(
            row({ pre: 'NoSuchPreprocessor' }),
            row({ post: 'gone.safetensors' }),
            row(),
        );
        assert.equal(manager.getSlots().length, 1);
        assert.equal(manager.getValues()[0][0], 'DWPreprocessor');
        assert.equal(warnings.filter(line => line.includes('not found, skipping')).length, 2);
    });
});

test('flush rebuilds the rows from the settings, images dropped and the type kept', async () => {
    await withControlNetSlot(async ({ manager }) => {
        globalThis.globalSettings.controlnet_slot = [
            [...row({ image: 'data:image/png;base64,SRC', controlType: 'tile' })],
            // a row saved before the control type column existed
            ['CannyEdgePreprocessor', '768', 'Post', MODELS[1], '0.5', '0.2', '0.9', null, null, null, null],
            ['CannyEdgePreprocessor', '768', 'Post', MODELS[1], '0.5', '0.2', '0.9', null, null, null, null, 'nonsense'],
        ];
        manager.flush();
        await flush();

        assert.deepEqual(manager.getValues(true).map(entry => [entry[0], entry[7], entry[11]]), [
            ['DWPreprocessor', null, 'tile'],
            ['CannyEdgePreprocessor', null, 'auto'],
            ['CannyEdgePreprocessor', null, 'auto'],
        ], 'no image survives a reload, and a type the node does not know reads as auto');
    });
});

test('what the backend gets: the models, the checked range and the image the trigger names', async () => {
    await withControlNetSlot(async ({ add }) => {
        await add(row({ image: 'SRC', imageAfter: 'MAP', start: '0.2', end: '0.9', controlType: 'openpose' }));

        assert.deepEqual(createControlNet(), [{
            preModel: 'DWPreprocessor', preRes: '1024',
            postModel: MODELS[0], postStr: '0.8',
            postStart: '0.2', postEnd: '0.9',
            image: 'SRC', imageAfter: null,
            controlType: 'openpose',
        }], 'On sends the source image for the pre-processor to read');
    });
});

test('Post sends the ready-made map instead, and a pre-processor set to none becomes Post', async () => {
    await withControlNetSlot(async ({ add }) => {
        await add(row({ enable: 'Post', image: 'SRC', imageAfter: 'MAP' }));
        const [post] = createControlNet();
        assert.equal(post.image, null);
        assert.equal(post.imageAfter, 'MAP');

        await add(row({ pre: 'none', enable: 'On', image: 'SRC', imageAfter: 'MAP' }));
        const asPost = createControlNet().at(-1);
        assert.equal(asPost.image, null, 'nothing to pre-process: the map is what there is');
        assert.equal(asPost.imageAfter, 'MAP');
    });
});

test('an ip-adapter keeps the square source whatever the trigger says', async () => {
    await withControlNetSlot(async ({ add }) => {
        await add(row({ pre: 'ip-adapter->CLIP-ViT-H', enable: 'Post', image: 'SQUARE', imageAfter: 'MAP' }));
        const [sent] = createControlNet();
        assert.equal(sent.image, 'SQUARE');
        assert.equal(sent.imageAfter, 'MAP');
    });
});

test('a row that cannot do anything is not sent: Off, no model, or a range that is empty', async () => {
    await withControlNetSlot(async ({ add }) => {
        await add(
            row({ enable: 'Off' }),
            row({ start: '0.9', end: '0.4' }),
            row({ start: '0.5', end: '0.5' }),
            row({ enable: 'On', image: 'SRC' }),
        );
        assert.deepEqual(createControlNet().map(sent => sent.image), ['SRC']);

        globalThis.globalSettings.api_controlnet_enable = false;
        assert.deepEqual(createControlNet(), [], 'the card\'s own switch sends none of it');
    });
});

test('a start or end outside 0-1 falls back to the ends of the range', async () => {
    await withControlNetSlot(async ({ add }) => {
        await add(row({ start: '-1', end: '2', image: 'SRC' }));
        const [sent] = createControlNet();
        assert.equal(sent.postStart, 0);
        assert.equal(sent.postEnd, 1);
    });
});
