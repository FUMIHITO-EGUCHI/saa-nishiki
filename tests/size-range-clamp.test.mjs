import test from 'node:test';
import assert from 'node:assert/strict';

import { withFakeDom } from './helpers/fakeDom.mjs';
import { SLIDER_RANGE_EVENT, setupSlider } from '../scripts/renderer/components/mySlider.js';
import { applySizeRange } from '../scripts/renderer/callbacks.js';
import { SIZE_HARD_MAX, SIZE_MIN, SIZE_STEP } from '../scripts/shared/sizeLimits.js';

function mountSlider(document, className, value, onValue) {
    const container = document.createElement('div');
    container.className = className;
    document.body.appendChild(container);
    const control = setupSlider(className, className, { min: SIZE_MIN, max: SIZE_HARD_MAX, step: SIZE_STEP, defaultValue: value }, onValue);
    return {
        control,
        container,
        bar: container.querySelector(`.mySlider-${className}-bar`),
        box: container.querySelector(`.mySlider-${className}-value`),
    };
}

test('the fake range input keeps the sanitized value, as Chromium does: widening the range does not undo a clamp', async () => {
    await withFakeDom(document => {
        const input = document.createElement('input');
        input.type = 'range';
        input.min = '512'; input.max = '4096'; input.step = '8';
        input.value = '2048';
        input.max = '1536';
        assert.equal(input.value, '1536', 'the narrower max clamps the value the element holds');
        input.max = '4096';
        assert.equal(input.value, '1536', 'and the element keeps it (measured in headless Chromium)');
        // off-grid input snaps to the step grid measured from min, ties towards +Infinity
        const stepped = document.createElement('input');
        stepped.type = 'range';
        stepped.min = '512'; stepped.max = '4096'; stepped.step = '64';
        stepped.value = '1500';
        assert.equal(stepped.value, '1472');
        stepped.value = '1504';
        assert.equal(stepped.value, '1536');
        // the default range is 0-100, and a max below the min counts as the min
        const bare = document.createElement('input');
        bare.type = 'range';
        bare.value = '2048';
        assert.equal(bare.value, '100');
        bare.min = '512';
        assert.equal(bare.value, '512');
    });
});

test('the fake range input sanitizes like Chromium: a narrower max clamps the value it reads back', async () => {
    await withFakeDom(document => {
        const input = document.createElement('input');
        input.type = 'range';
        input.min = '512'; input.max = '4096'; input.step = '8';
        input.value = '2048';
        input.max = '1536';
        assert.equal(input.value, '1536');
    });
});

test('narrowing the range pulls an out-of-range value to the bound through the callback', async () => {
    await withFakeDom(document => {
        const written = [];
        const events = [];
        const { control, container, bar, box } = mountSlider(document, 'generate-width', 2048, value => written.push(value));
        container.addEventListener(SLIDER_RANGE_EVENT, event => events.push(event.detail));
        control.setRange({ min: SIZE_MIN, max: 1536, step: SIZE_STEP });
        // the setting (callback), the bar the generation reads and the visible box agree
        assert.deepEqual(written, [1536]);
        assert.equal(control.getValue(), 1536);
        assert.equal(bar.value, '1536');
        assert.equal(String(box.value), '1536');
        assert.equal(events.at(-1).clamped, true);
        assert.ok(box.classList.contains('is-clamped'), 'the box flashes');
    });
});

test('widening the range, or narrowing it above the value, leaves the value and the callback alone', async () => {
    await withFakeDom(document => {
        const written = [];
        const { control, box } = mountSlider(document, 'generate-height', 1216, value => written.push(value));
        control.setRange({ min: SIZE_MIN, max: 2048, step: SIZE_STEP });
        control.setRange({ min: SIZE_MIN, max: 1536, step: SIZE_STEP });
        control.setRange({ min: SIZE_MIN, max: 4096, step: SIZE_STEP });
        assert.deepEqual(written, []);
        assert.equal(control.getValue(), 1216);
        assert.equal(String(box.value), '1216');
    });
});

test('lowering the size limit in Settings rewrites the size the generation uses, the setting and the box together', async () => {
    const saved = { globalSettings: globalThis.globalSettings, generate: globalThis.generate };
    try {
        await withFakeDom(document => {
            const label = document.createElement('span');
            label.id = 'run-size-range';
            document.body.appendChild(label);
            const settings = { api_model_type: 'Diffusion', size_limit_checkpoint: 1536, size_limit_diffusion: 2048, width: 1216, height: 832 };
            globalThis.globalSettings = settings;
            const width = mountSlider(document, 'generate-width', settings.width, value => { settings.width = value; });
            const height = mountSlider(document, 'generate-height', settings.height, value => { settings.height = value; });
            globalThis.generate = { width: width.control, height: height.control };

            applySizeRange();
            assert.equal(label.textContent, '512–2048');
            assert.equal(settings.width, 1216);

            settings.size_limit_diffusion = 1024; // what the Settings box callback writes before applySizeRange
            applySizeRange();
            assert.equal(label.textContent, '512–1024');
            assert.equal(width.control.getValue(), 1024, 'the generation reads the bar');
            assert.equal(settings.width, 1024, 'the stored size follows');
            assert.equal(String(width.box.value), '1024', 'the box shows it');
            assert.equal(settings.height, 832, 'an in-range side is untouched');

            // raising the limit again puts back what the limit took away (session memory)
            settings.size_limit_diffusion = 2048;
            applySizeRange();
            assert.equal(width.control.getValue(), 1216, 'the trim is recoverable');
            assert.equal(settings.width, 1216, 'the setting follows');
            assert.equal(String(width.box.value), '1216', 'and the box');
            assert.equal(settings.height, 832, 'the side that was never trimmed stays put');
        });
    } finally {
        Object.assign(globalThis, saved);
    }
});

test('a size chosen after the trim is the user\'s own: raising the limit leaves it alone', async () => {
    const saved = { globalSettings: globalThis.globalSettings, generate: globalThis.generate };
    try {
        await withFakeDom(document => {
            const settings = { api_model_type: 'Checkpoint', size_limit_checkpoint: 1536, width: 1536, height: 1024 };
            globalThis.globalSettings = settings;
            const width = mountSlider(document, 'generate-width', settings.width, value => { settings.width = value; });
            const height = mountSlider(document, 'generate-height', settings.height, value => { settings.height = value; });
            globalThis.generate = { width: width.control, height: height.control };

            settings.size_limit_checkpoint = 1024;
            applySizeRange();
            assert.equal(settings.width, 1024, 'trimmed to the new limit');

            // the user picks a size of their own inside the narrow range
            width.control.setValue(768);
            assert.equal(settings.width, 768);

            settings.size_limit_checkpoint = 1536;
            applySizeRange();
            assert.equal(settings.width, 768, 'the remembered 1536 does not overwrite it');
        });
    } finally {
        Object.assign(globalThis, saved);
    }
});

test('the clamp is not an edit: it runs with the edit history suspended', async () => {
    const saved = { globalSettings: globalThis.globalSettings, generate: globalThis.generate, editHistory: globalThis.editHistory };
    try {
        await withFakeDom(document => {
            const history = {
                depth: 0,
                isRecordingSuspended() { return this.depth > 0; },
                async suspendRecording(mutation) {
                    this.depth += 1;
                    try { return mutation(); } finally { this.depth -= 1; }
                },
            };
            globalThis.editHistory = history;
            const suspendedWhenWritten = [];
            const settings = { api_model_type: 'Diffusion', size_limit_diffusion: 2048, width: 1600, height: 900 };
            globalThis.globalSettings = settings;
            const width = mountSlider(document, 'generate-width', settings.width, value => {
                settings.width = value;
                suspendedWhenWritten.push(history.isRecordingSuspended());
            });
            const height = mountSlider(document, 'generate-height', settings.height, value => { settings.height = value; });
            globalThis.generate = { width: width.control, height: height.control };

            settings.size_limit_diffusion = 1024;
            applySizeRange();
            assert.equal(settings.width, 1024);
            assert.deepEqual(suspendedWhenWritten, [true], 'the clamp wrote inside suspendRecording, so no undo entry');
        });
    } finally {
        Object.assign(globalThis, saved);
    }
});
