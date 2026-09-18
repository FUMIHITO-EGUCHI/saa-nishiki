// The chip weight popover (weightPopover.js) driven on the in-memory DOM: what Apply hands
// back on each tab, what the Fixed and Plan panels draw, where the box is put, and the
// guards that close it (Cancel / Apply, a pointer outside, a scroll behind it, a resize).
import assert from 'node:assert/strict';
import test from 'node:test';

import { withFakeDom } from './helpers/fakeDom.mjs';
import { createWeightPopover } from '../scripts/renderer/components/weightPopover.js';

const tick = () => new Promise(resolve => { setTimeout(resolve, 0); });

// Every label the popover draws is «key», so an unwritten one is visible as ''.
const text = key => `«${key}»`;

const FIXED_CAPSULE = { id: 'long hair#0', value: 'long hair', weightPlan: { mode: 'fixed', min: 1, max: 1, step: 0.05, seed: 0 } };
const PLAN_CAPSULE = { id: 'smile#0', value: 'smile', weightPlan: { mode: 'increment', min: 1, max: 1.3, step: 0.05, seed: 0 } };

function fakeWindow() {
    const listeners = [];
    return {
        listeners,
        innerWidth: 1280,
        innerHeight: 800,
        addEventListener(type, listener) { listeners.push({ type, listener }); },
        removeEventListener(type, listener) {
            const at = listeners.findIndex(entry => entry.type === type && entry.listener === listener);
            if (at >= 0) listeners.splice(at, 1);
        },
    };
}

function globalsFor(window) {
    return { window, globalSettings: { language: 'en-US', tag_chip_alias: false }, cachedFiles: { language: {} } };
}

// A popover on a chip, with a layout box for the anchor and for the box itself (there is
// no layout engine behind the fake DOM, so position() is given the numbers it reads).
async function mountPopover(document, {
    capsule = FIXED_CAPSULE,
    tab = 'fixed',
    anchorBox = { left: 10, top: 10, width: 60, height: 20 },
    popoverHeight = 200,
    ...openOptions
} = {}) {
    const popover = createWeightPopover({ text });
    const anchor = document.createElement('button');
    anchor.className = 'tag-capsule-chip';
    document.body.appendChild(anchor);
    anchor.setLayoutBox(anchorBox);
    popover.element.setLayoutBox({ width: 336, height: popoverHeight });
    const fallback = document.createElement('button');
    document.body.appendChild(fallback);

    const applied = [];
    const closed = [];
    popover.open({
        anchor,
        capsule,
        fallbackFocus: fallback,
        tab,
        onApply: plan => applied.push(plan),
        onClose: event => closed.push(event),
        ...openOptions,
    });
    await tick();
    const root = popover.element;
    return {
        popover, anchor, fallback, root, applied, closed,
        q: selector => root.querySelector(selector),
        all: selector => root.querySelectorAll(selector),
        // the Plan panel's own boxes: Min, Max, Step, Seed (the Fixed panel has a
        // .tag-weight-number pair of its own)
        planNumbers: () => root.querySelectorAll('.tag-weight-popover-body')[1].querySelectorAll('.tag-weight-number'),
    };
}

// The popover reads the keys off the document, in the capture phase, before the page does.
function keydown(document, target, key, modifiers = {}) {
    let prevented = false;
    document.dispatchEvent({
        type: 'keydown',
        key,
        target,
        ...modifiers,
        preventDefault() { prevented = true; },
        stopPropagation() {},
    });
    return prevented;
}

function press(element, type, extra = {}) {
    let prevented = false;
    element.dispatchEvent({
        type,
        bubbles: type !== 'scroll',
        ...extra,
        preventDefault() { prevented = true; },
        stopPropagation() {},
    });
    return prevented;
}

// ------------------------------------------------------------------ what Apply writes

test('Apply hands back the Fixed tab\'s weight and the Plan tab\'s plan, never the other one', async () => {
    const window = fakeWindow();
    await withFakeDom(async document => {
        const fixed = await mountPopover(document, { capsule: FIXED_CAPSULE, tab: 'fixed' });
        fixed.all('.tag-weight-preset').find(button => button.dataset.value === '1.2').click();
        fixed.q('.tag-weight-button-primary').click();
        assert.deepEqual(fixed.applied, [{ mode: 'fixed', min: 1.2, max: 1.2, step: 0.05, seed: 0 }],
            'the Fixed tab applies the weight it shows, not the plan draft behind it');
        assert.deepEqual(fixed.closed, [{ apply: true }]);

        const plan = await mountPopover(document, { capsule: PLAN_CAPSULE, tab: 'plan' });
        plan.q('.tag-weight-button-primary').click();
        assert.deepEqual(plan.applied, [{ mode: 'increment', min: 1, max: 1.3, step: 0.05, seed: 0, autoStep: false }],
            'the Plan tab applies the plan, not a fixed weight');
    }, globalsFor(window));
});

test('the Plan tab applies the mode, range and seed as they were edited', async () => {
    const window = fakeWindow();
    await withFakeDom(async document => {
        const { q, all, planNumbers, applied } = await mountPopover(document, { capsule: PLAN_CAPSULE, tab: 'plan', generationSeed: 4242 });
        all('.tag-weight-mode').find(button => button.dataset.mode === 'random').click();
        const [minInput, maxInput] = planNumbers();
        maxInput.value = '1.60';
        press(maxInput, 'change');
        assert.equal(minInput.value, '1.00');
        // the seed follows the run until the switch is turned off
        const follow = q('.tag-weight-seed .tag-weight-switch');
        assert.equal(follow.checked, true);
        assert.equal(q('.tag-weight-number-seed').value, '4242', 'the run seed is shown while it is followed');
        follow.checked = false;
        press(follow, 'change');
        const seedInput = q('.tag-weight-number-seed');
        seedInput.value = '77';
        press(seedInput, 'change');

        q('.tag-weight-button-primary').click();
        assert.deepEqual(applied, [{ mode: 'random', min: 1, max: 1.6, step: 0.05, seed: 77, autoStep: false }]);
    }, globalsFor(window));
});

// ------------------------------------------------------------------ the labels

test('every label, aria-label and mode name in the popover comes from the text resolver', async () => {
    const window = fakeWindow();
    await withFakeDom(async document => {
        const { q, all, root } = await mountPopover(document);
        assert.deepEqual(all('.tag-weight-popover-tab').map(button => button.textContent),
            [text('tag_ui_tab_fixed'), text('tag_ui_tab_plan'), text('tag_ui_tab_related')]);
        assert.deepEqual(all('.tag-weight-label').map(label => label.textContent), [
            text('tag_ui_weight'), text('tag_ui_step'), text('tag_ui_presets'), text('tag_ui_output'),
            text('tag_ui_min'), text('tag_ui_max'), text('tag_ui_step'), text('tag_ui_seed'),
        ]);
        assert.equal(q('.tag-weight-note').textContent, text('tag_ui_weight_note'));
        assert.deepEqual(all('.tag-weight-mode-name').map(node => node.textContent),
            [text('tag_ui_mode_increment'), text('tag_ui_mode_decrement'), text('tag_ui_mode_random')]);
        assert.deepEqual(all('.tag-weight-toggle-text').map(node => node.textContent),
            [text('tag_ui_step_auto'), text('tag_ui_follow_seed')]);
        assert.equal(q('.tag-weight-popover-close').getAttribute('aria-label'), text('tag_ui_close'));
        assert.equal(q('.tag-weight-number-main').getAttribute('aria-label'), text('tag_ui_weight'));
        assert.equal(q('.tag-weight-number-step').getAttribute('aria-label'), text('tag_ui_step'));
        assert.equal(q('.tag-weight-modes').getAttribute('aria-label'), text('tag_ui_mode'));
        assert.deepEqual(all('.tag-weight-stepbtn').map(button => button.getAttribute('aria-label')),
            [text('tag_ui_decrease'), text('tag_ui_increase')]);
        assert.deepEqual(all('.tag-weight-button').map(button => button.textContent),
            [text('tag_ui_cancel'), text('tag_ui_apply')]);
        // the six presets carry the weights they set
        assert.deepEqual(all('.tag-weight-preset').map(button => button.textContent),
            ['0.80', '0.90', '1.00', '1.10', '1.20', '1.30']);
        assert.equal(root.getAttribute('aria-label'), 'long hair');
    }, globalsFor(window));
});

// ------------------------------------------------------------------ the Fixed panel

test('the Fixed panel marks the preset in effect and previews the token it writes', async () => {
    const window = fakeWindow();
    await withFakeDom(async document => {
        const { q, all } = await mountPopover(document);
        const presets = all('.tag-weight-preset');
        const marked = () => presets.filter(button => button.classList.contains('is-on')).map(button => button.dataset.value);
        const pressed = () => presets.filter(button => button.getAttribute('aria-pressed') === 'true').map(button => button.dataset.value);
        assert.deepEqual(marked(), ['1'], 'the capsule sits at 1.00');
        assert.deepEqual(pressed(), ['1']);
        assert.equal(q('.tag-weight-number-main').value, '1.00');
        assert.equal(q('.tag-weight-output').textContent, 'long hair', 'a weight of 1 writes the bare tag');

        presets.find(button => button.dataset.value === '1.2').click();
        assert.deepEqual(marked(), ['1.2']);
        assert.deepEqual(pressed(), ['1.2']);
        assert.equal(q('.tag-weight-number-main').value, '1.20');
        assert.equal(q('.tag-weight-output').textContent, '(long hair:1.20)');
        assert.equal(q('.tag-weight-output-up').textContent, '(long hair:1.20)', 'above 1 is the "up" colour');

        presets.find(button => button.dataset.value === '0.8').click();
        assert.equal(q('.tag-weight-output-down').textContent, '(long hair:0.80)', 'below 1 is the "down" colour');
        assert.equal(q('.tag-weight-output-up'), null);

        // a weight outside 0.50 - 1.50 is marked on the box itself
        const weightInput = q('.tag-weight-number-main');
        assert.equal(weightInput.classList.contains('is-warn'), false);
        weightInput.value = '2';
        press(weightInput, 'change');
        assert.equal(weightInput.value, '2.00', 'the committed weight is written back formatted');
        assert.equal(weightInput.classList.contains('is-warn'), true);
        assert.deepEqual(marked(), [], 'no preset is 2.00');
    }, globalsFor(window));
});

test('the step box drives the weight stepper', async () => {
    const window = fakeWindow();
    await withFakeDom(async document => {
        const { q, all } = await mountPopover(document);
        const [decrease, increase] = all('.tag-weight-stepbtn');
        increase.click();
        assert.equal(q('.tag-weight-number-main').value, '1.05');
        const stepInput = q('.tag-weight-number-step');
        assert.equal(stepInput.value, '0.05');
        stepInput.value = '0.25';
        press(stepInput, 'change');
        assert.equal(stepInput.value, '0.25');
        increase.click();
        assert.equal(q('.tag-weight-number-main').value, '1.30');
        decrease.click();
        assert.equal(q('.tag-weight-number-main').value, '1.05');
    }, globalsFor(window));
});

// ------------------------------------------------------------------ the Plan panel

test('the Plan panel checks one mode at a time and keeps the roving tab stop on it', async () => {
    const window = fakeWindow();
    await withFakeDom(async document => {
        const { q, all, planNumbers } = await mountPopover(document, { capsule: PLAN_CAPSULE, tab: 'plan' });
        const modes = all('.tag-weight-mode');
        const state = () => modes.map(button => [
            button.dataset.mode,
            button.classList.contains('is-on'),
            button.getAttribute('aria-checked'),
            button.tabIndex,
        ]);
        assert.deepEqual(state(), [
            ['increment', true, 'true', 0],
            ['decrement', false, 'false', -1],
            ['random', false, 'false', -1],
        ]);
        assert.equal(q('.tag-weight-autostep-row').hidden, false, 'a stepped mode can divide by the batch count');
        assert.equal(q('.tag-weight-seed').hidden, true, 'only a random draw has a seed');
        assert.equal(q('.tag-weight-hint').textContent, text('tag_ui_hint_plan'));

        modes.find(button => button.dataset.mode === 'random').click();
        assert.deepEqual(state(), [
            ['increment', false, 'false', -1],
            ['decrement', false, 'false', -1],
            ['random', true, 'true', 0],
        ]);
        assert.equal(q('.tag-weight-autostep-row').hidden, true, 'a random draw has no step to derive');
        assert.equal(q('.tag-weight-seed').hidden, false);
        assert.equal(q('.tag-weight-hint').textContent, text('tag_ui_reproducible'));

        const [minInput, maxInput, stepInput] = planNumbers();
        assert.deepEqual([minInput.value, maxInput.value, stepInput.value], ['1.00', '1.30', '0.05']);
    }, globalsFor(window));
});

test('"divide by the batch count" takes the step box over, and the range warns at its own end', async () => {
    const window = fakeWindow();
    await withFakeDom(async document => {
        const { q, planNumbers, applied } = await mountPopover(document, { capsule: PLAN_CAPSULE, tab: 'plan' });
        const [minInput, maxInput, stepInput] = planNumbers();
        const autoStep = q('.tag-weight-autostep .tag-weight-switch');
        assert.equal(stepInput.disabled, false);
        autoStep.checked = true;
        press(autoStep, 'change');
        assert.equal(stepInput.disabled, true, 'the step comes from the batch count now');

        // the warning is drawn on the end that is out of range, not on both boxes
        maxInput.value = '1.90';
        press(maxInput, 'change');
        assert.equal(maxInput.classList.contains('is-warn'), true, 'above 1.50 is marked');
        assert.equal(minInput.classList.contains('is-warn'), false, 'the low end is still inside the range');
        minInput.value = '0.20';
        press(minInput, 'change');
        assert.equal(minInput.classList.contains('is-warn'), true, 'below 0.50 is marked too');
        assert.equal(maxInput.classList.contains('is-warn'), true);
        maxInput.value = '1.30';
        press(maxInput, 'change');
        assert.equal(maxInput.classList.contains('is-warn'), false, 'the high end came back inside');
        assert.equal(minInput.classList.contains('is-warn'), true, 'the low end is still out');
        maxInput.value = '1.90';
        press(maxInput, 'change');

        q('.tag-weight-button-primary').click();
        assert.deepEqual(applied, [{ mode: 'increment', min: 0.2, max: 1.9, step: 0.05, seed: 0, autoStep: true }]);
    }, globalsFor(window));
});

// ------------------------------------------------------------------ where the box is put

test('the popover is anchored under the chip, and flips above / right when it would leave the viewport', async () => {
    const window = fakeWindow();
    await withFakeDom(async document => {
        const near = await mountPopover(document, { anchorBox: { left: 10, top: 10, width: 60, height: 20 } });
        assert.equal(near.root.style.width, '336px');
        assert.equal(near.root.style.left, '10px', 'left-aligned with the chip');
        assert.equal(near.root.style.top, '34px', 'four pixels under it');
        near.popover.close();

        const corner = await mountPopover(document, { anchorBox: { left: 1000, top: 700, width: 60, height: 20 } });
        assert.equal(corner.root.style.left, '724px', 'right-aligned with the chip: 1060 - 336');
        assert.equal(corner.root.style.top, '496px', 'flipped above it: 700 - 200 - 4');
        corner.popover.close();

        // a chip at the very edge is still kept eight pixels off the viewport
        const edge = await mountPopover(document, { anchorBox: { left: -400, top: -40, width: 20, height: 20 } });
        assert.equal(edge.root.style.left, '8px');
        assert.equal(edge.root.style.top, '8px');
    }, globalsFor(window));
});

// ------------------------------------------------------------------ closing

test('Cancel closes without applying, gives the focus back to the chip and unhooks every guard', async () => {
    const window = fakeWindow();
    await withFakeDom(async document => {
        const { popover, anchor, root, applied, closed, q } = await mountPopover(document);
        assert.equal(popover.isOpen(), true);
        assert.equal(root.hidden, false);
        assert.equal(document.activeElement, q('.tag-weight-number-main'), 'the weight box takes the focus');
        assert.equal(window.listeners.some(entry => entry.type === 'resize'), true);

        q('.tag-weight-button').click();   // Cancel
        assert.deepEqual(applied, [], 'Cancel writes nothing');
        assert.deepEqual(closed, [{ apply: false }]);
        assert.equal(popover.isOpen(), false);
        assert.equal(root.hidden, true);
        assert.equal(document.activeElement, anchor, 'the focus is back on the chip');
        assert.equal(window.listeners.some(entry => entry.type === 'resize'), false, 'the resize guard is gone');

        // closing twice is not two closes, and the guards no longer reach a dead session
        popover.close();
        assert.deepEqual(closed, [{ apply: false }]);
        press(document.body, 'pointerdown');
        press(document.body, 'scroll');
        assert.deepEqual(closed, [{ apply: false }]);
    }, globalsFor(window));
});

test('Tab is trapped inside the popover and skips the panel that is not on screen', async () => {
    const window = fakeWindow();
    await withFakeDom(async document => {
        const { q, all, root } = await mountPopover(document);
        const close = q('.tag-weight-popover-close');
        const apply = q('.tag-weight-button-primary');

        close.focus();
        assert.equal(keydown(document, close, 'Tab', { shiftKey: true }), true);
        assert.equal(document.activeElement, apply, 'Shift+Tab off the first control wraps to the last');

        apply.focus();
        assert.equal(keydown(document, apply, 'Tab'), true);
        assert.equal(document.activeElement, close, 'and Tab off the last wraps to the first');

        // in the middle the browser moves the focus itself
        q('.tag-weight-number-main').focus();
        assert.equal(keydown(document, q('.tag-weight-number-main'), 'Tab'), false);

        // the Plan panel is hidden behind the Fixed tab, so none of its boxes are in the ring
        all('.tag-weight-popover-tab')[1].click();
        const modes = all('.tag-weight-mode');
        modes[0].focus();
        assert.equal(keydown(document, modes[0], 'Tab', { shiftKey: true }), false,
            'a mode button is not the first control: the tabs and the × come before it');
        close.focus();
        keydown(document, close, 'Tab', { shiftKey: true });
        assert.equal(document.activeElement, apply);
        assert.equal(root.contains(document.activeElement), true);

        // and a key aimed at the page behind the popover is left to the page
        const outside = document.createElement('input');
        document.body.appendChild(outside);
        assert.equal(keydown(document, outside, 'Tab'), false, 'the page keeps its own Tab');
        assert.equal(keydown(document, outside, 'Enter'), false, 'and its own Enter');
        assert.equal(document.activeElement, apply, 'the trap did not move the focus');
    }, globalsFor(window));
});

test('Enter in a number box applies; Escape drops the edit', async () => {
    const window = fakeWindow();
    await withFakeDom(async document => {
        const typed = await mountPopover(document);
        const weightInput = typed.q('.tag-weight-number-main');
        typed.all('.tag-weight-preset').find(button => button.dataset.value === '1.1').click();
        assert.equal(keydown(document, weightInput, 'Enter'), true);
        assert.deepEqual(typed.applied, [{ mode: 'fixed', min: 1.1, max: 1.1, step: 0.05, seed: 0 }]);

        // Enter on a button is that button's own click, not an Apply
        const other = await mountPopover(document);
        assert.equal(keydown(document, other.q('.tag-weight-preset'), 'Enter'), false);
        assert.equal(other.popover.isOpen(), true);
        assert.deepEqual(other.applied, []);

        // Escape closes without applying, and an Escape the IME is holding does nothing
        const dropped = await mountPopover(document);
        dropped.all('.tag-weight-preset').find(button => button.dataset.value === '1.3').click();
        assert.equal(keydown(document, dropped.root, 'Escape', { isComposing: true }), false);
        assert.equal(dropped.popover.isOpen(), true);
        assert.equal(keydown(document, dropped.root, 'Escape'), true);
        assert.deepEqual(dropped.applied, []);
        assert.deepEqual(dropped.closed, [{ apply: false }]);
    }, globalsFor(window));
});

test('the × in the header closes it the same way Cancel does', async () => {
    const window = fakeWindow();
    await withFakeDom(async document => {
        const { popover, applied, closed, q } = await mountPopover(document);
        q('.tag-weight-popover-close').click();
        assert.equal(popover.isOpen(), false);
        assert.deepEqual(applied, []);
        assert.deepEqual(closed, [{ apply: false }]);
    }, globalsFor(window));
});

test('a pointer outside closes the popover; one inside it does not', async () => {
    const window = fakeWindow();
    await withFakeDom(async document => {
        const { popover, closed, q } = await mountPopover(document);
        press(q('.tag-weight-preset'), 'pointerdown');
        assert.equal(popover.isOpen(), true, 'a press on a preset is not "outside"');
        press(q('.tag-weight-number-main'), 'pointerdown');
        assert.equal(popover.isOpen(), true);

        const elsewhere = document.createElement('div');
        document.body.appendChild(elsewhere);
        press(elsewhere, 'pointerdown');
        assert.equal(popover.isOpen(), false);
        assert.deepEqual(closed, [{ apply: false }], 'a click away drops the edit, it does not apply it');
    }, globalsFor(window));
});

test('the page scrolling out from under the popover closes it; scrolling inside it does not', async () => {
    const window = fakeWindow();
    await withFakeDom(async document => {
        const inside = await mountPopover(document);
        press(inside.q('.tag-weight-popover-body'), 'scroll');
        assert.equal(inside.popover.isOpen(), true, 'the popover has its own scrollable body');
        inside.popover.close();

        const behind = await mountPopover(document);
        press(document.body, 'scroll');
        assert.equal(behind.popover.isOpen(), false);
        assert.deepEqual(behind.closed, [{ apply: false }]);

        // a window resize carries no target at all, and moves the anchor: the popover goes
        const resized = await mountPopover(document);
        const resize = window.listeners.find(entry => entry.type === 'resize');
        assert.ok(resize, 'the popover listens for a resize');
        resize.listener(new Event('resize'));
        assert.equal(resized.popover.isOpen(), false);
    }, globalsFor(window));
});
