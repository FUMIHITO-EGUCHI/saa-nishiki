// mySlider.js on the in-memory DOM: what counts as inside the range while a value is being
// typed, the red mark an out-of-range one leaves on the box, and the clamp that writes the
// bound back when the box is left (the run bar's size / steps / CFG boxes have no visible
// bar, so this is the only thing that stops a "4096" sitting there unused).
import assert from 'node:assert/strict';
import test from 'node:test';

import { withFakeDom } from './helpers/fakeDom.mjs';
import { SLIDER_RANGE_EVENT, setupSlider } from '../scripts/renderer/components/mySlider.js';

const RANGE = { min: 512, max: 2048, step: 8 };

function mountSlider(document, className, options = RANGE) {
    const container = document.createElement('div');
    container.className = className;
    document.body.appendChild(container);
    const written = [];
    const announced = [];
    const control = setupSlider(className, className, { ...options, defaultValue: options.defaultValue ?? 1024 },
        value => written.push(value));
    container.addEventListener(SLIDER_RANGE_EVENT, event => announced.push(event.detail));
    return {
        control, container, written, announced,
        bar: container.querySelector(`.mySlider-${className}-bar`),
        box: container.querySelector(`.mySlider-${className}-value`),
    };
}

function type(box, value, eventType = 'input') {
    box.value = String(value);
    box.dispatchEvent({ type: eventType, bubbles: true, preventDefault() {}, stopPropagation() {} });
}

test('a value typed inside the range applies live, the bounds included', async () => {
    await withFakeDom(document => {
        const { bar, box, written, announced } = mountSlider(document, 'generate-steps');
        type(box, 1536);
        assert.deepEqual(written, [1536], 'the setting follows every keystroke inside the range');
        assert.equal(bar.value, '1536');
        assert.equal(box.classList.contains('is-over'), false);
        assert.equal(announced.at(-1).over, false);

        // the bounds themselves are inside the range
        type(box, 512);
        assert.deepEqual(written, [1536, 512], 'the minimum is a value the box can hold');
        assert.equal(bar.value, '512');
        assert.equal(box.classList.contains('is-over'), false);
        type(box, 2048);
        assert.deepEqual(written, [1536, 512, 2048], 'and so is the maximum');
        assert.equal(bar.value, '2048');
        assert.equal(box.classList.contains('is-over'), false);
    });
});

test('a value typed outside the range only marks the box red; nothing else moves yet', async () => {
    await withFakeDom(document => {
        const { bar, box, written, announced } = mountSlider(document, 'generate-width');
        assert.equal(bar.value, '1024');

        type(box, 4096);
        assert.deepEqual(written, [], 'the generation keeps the value in effect');
        assert.equal(bar.value, '1024', 'the bar does not follow it either');
        assert.equal(box.classList.contains('is-over'), true, 'the box is marked');
        assert.deepEqual(announced.at(-1), { over: true, clamped: false, min: 512, max: 2048 });

        type(box, 100);
        assert.deepEqual(written, [], 'below the minimum is just as far out');
        assert.equal(box.classList.contains('is-over'), true);

        // and typing on until it is back inside clears the mark
        type(box, 1000);
        assert.equal(box.classList.contains('is-over'), false);
        assert.deepEqual(written, [1000]);

        // a half-typed number is neither in range nor a value to mark
        type(box, '-');
        assert.equal(box.classList.contains('is-over'), false, 'nothing has been typed yet');
        assert.deepEqual(announced.at(-1), { over: false, clamped: false, min: 512, max: 2048 });
    });
});

test('leaving the box pulls an out-of-range value to the bound and flashes it', async () => {
    await withFakeDom(document => {
        const { bar, box, written, announced } = mountSlider(document, 'generate-height');
        type(box, 4096);
        assert.equal(box.classList.contains('is-over'), true);

        type(box, 4096, 'change');
        assert.equal(box.value, '2048', 'the box shows the size that is in effect');
        assert.equal(bar.value, '2048');
        assert.deepEqual(written, [2048], 'the setting is the clamped one');
        assert.equal(box.classList.contains('is-over'), false, 'the red mark is gone');
        assert.equal(box.classList.contains('is-clamped'), true, 'and the box flashes once');
        assert.deepEqual(announced.at(-1), { over: false, clamped: true, min: 512, max: 2048 });

        // the flash is one animation long
        box.dispatchEvent({ type: 'animationend' });
        assert.equal(box.classList.contains('is-clamped'), false);

        type(box, 100, 'change');
        assert.equal(box.value, '512', 'below the minimum comes up to it');
        assert.deepEqual(written, [2048, 512]);
        assert.equal(box.classList.contains('is-clamped'), true);
    });
});

test('leaving the box on a value that was inside the range is no clamp and no flash', async () => {
    await withFakeDom(document => {
        const { box, written, announced } = mountSlider(document, 'generate-cfg');
        type(box, 1536, 'change');
        assert.equal(box.value, '1536');
        assert.deepEqual(written, [1536]);
        assert.equal(box.classList.contains('is-clamped'), false, 'nothing was taken away');
        assert.deepEqual(announced.at(-1), { over: false, clamped: false, min: 512, max: 2048 });

        // the bounds are inside the range, so landing on one is not a clamp either
        type(box, 512, 'change');
        assert.equal(box.classList.contains('is-clamped'), false, 'the minimum is a value, not a clamp');
        type(box, 2048, 'change');
        assert.equal(box.classList.contains('is-clamped'), false, 'and so is the maximum');
        assert.deepEqual(written, [1536, 512, 2048]);

        // an off-grid value inside the range is snapped, still without the flash
        type(box, 1001, 'change');
        assert.equal(box.value, '1000');
        assert.equal(box.classList.contains('is-clamped'), false);
    });
});

test('text in the box puts back the value in effect instead of clamping it', async () => {
    await withFakeDom(document => {
        const { bar, box, written, announced } = mountSlider(document, 'generate-seed');
        type(box, 1536);
        assert.equal(bar.value, '1536');
        type(box, 'abc', 'change');
        assert.equal(box.value, '1536', 'the box shows what the generation will use');
        assert.deepEqual(written, [1536], 'nothing new was written');
        assert.equal(box.classList.contains('is-over'), false);
        assert.equal(box.classList.contains('is-clamped'), false);
        assert.deepEqual(announced.at(-1), { over: false, clamped: false, min: 512, max: 2048 });
    });
});

test('dragging the bar writes through and clears a mark the box was carrying', async () => {
    await withFakeDom(document => {
        const { bar, box, written } = mountSlider(document, 'generate-denoise');
        type(box, 4096);
        assert.equal(box.classList.contains('is-over'), true);

        bar.value = '1600';
        bar.dispatchEvent({ type: 'input', bubbles: true, preventDefault() {}, stopPropagation() {} });
        assert.equal(box.value, '1600', 'the box follows the bar');
        assert.deepEqual(written, [1600]);
        assert.equal(box.classList.contains('is-over'), false);
    });
});

test('setValue clamps to the range, and a float step keeps the decimals in the callback', async () => {
    await withFakeDom(document => {
        const size = mountSlider(document, 'setvalue-size');
        size.control.setValue(4096);
        assert.deepEqual(size.written, [2048]);
        assert.equal(size.box.classList.contains('is-clamped'), true);
        assert.equal(size.control.getValue(), 2048);

        size.box.dispatchEvent({ type: 'animationend' });
        size.control.setValue(1024);
        assert.deepEqual(size.written, [2048, 1024]);
        assert.equal(size.box.classList.contains('is-clamped'), false, 'an in-range value is no clamp');

        size.control.setValue('not a number');
        assert.deepEqual(size.written, [2048, 1024], 'text is not a value');

        const cfg = mountSlider(document, 'setvalue-cfg', { min: 0, max: 20, step: 0.5, defaultValue: 7 });
        cfg.control.setValue(7.3);
        assert.deepEqual(cfg.written, [7.5], 'snapped to the step grid, not truncated to an integer');
        assert.equal(cfg.control.getFloat(), 7.5);
        cfg.control.setValue(25);
        assert.deepEqual(cfg.written, [7.5, 20]);
    });
});
