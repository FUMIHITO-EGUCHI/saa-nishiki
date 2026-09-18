// Picking a tag in the chip popover's Related tab disables the button that was clicked.
// A disabled button hands its focus to <body>, and the popover then saw none of the keys:
// Ctrl+R reached the window menu's Reload and closing gave the focus back to nothing.
// These run the popover against the in-memory DOM.
import assert from 'node:assert/strict';
import test from 'node:test';

import { withFakeDom } from './helpers/fakeDom.mjs';

const GLOBALS = {
    window: { addEventListener() {}, removeEventListener() {}, innerWidth: 1280, innerHeight: 800 },
    globalSettings: { language: 'en-US', tag_chip_alias: false },
    cachedFiles: { language: {} },
};

const tick = () => new Promise(resolve => { setTimeout(resolve, 0); });

// Chromium's focus fixup rule: an element that is disabled while it has the focus loses
// it to <body>. The in-memory DOM does not do that on its own, and the whole point of the
// fix is what happens then.
function disableLikeChromium(document, element) {
    let disabled = false;
    Object.defineProperty(element, 'disabled', {
        configurable: true,
        get: () => disabled,
        set(value) {
            disabled = Boolean(value);
            if (disabled && document.activeElement === element) document.activeElement = document.body;
        },
    });
}

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

async function openRelatedPopover(document) {
    const { createWeightPopover } = await import('../scripts/renderer/components/weightPopover.js');
    const popover = createWeightPopover({ text: (key, ...rest) => [key, ...rest].join(' ') });
    const anchor = document.createElement('button');
    document.body.appendChild(anchor);
    const picked = [];
    popover.open({
        anchor,
        capsule: { id: 'long hair#0', value: 'long hair', weightPlan: { mode: 'fixed', min: 1, max: 1, step: 0.05, seed: 0 } },
        fallbackFocus: document.createElement('button'),
        tab: 'related',
        fetchRelated: async () => ({ related: [{ tag: 'blue_eyes', score: 900 }, { tag: 'smile', score: 800 }], family: [], familyWord: 'hair' }),
        presentTags: () => new Set(),
        onPick: (tag, options) => picked.push([tag, options]),
    });
    await tick();
    await tick();
    const chips = popover.element.querySelectorAll('.tag-weight-related-chip');
    assert.equal(chips.length, 2, 'the Related tab lists the two answers');
    for (const chip of chips) disableLikeChromium(document, chip);
    return { popover, anchor, chips, picked };
}

test('picking a Related tag keeps the focus inside the popover', async () => {
    await withFakeDom(async document => {
        const { popover, anchor, chips, picked } = await openRelatedPopover(document);
        chips[0].focus();
        assert.equal(document.activeElement, chips[0]);
        chips[0].dispatchEvent({ type: 'click', bubbles: true, target: chips[0], shiftKey: false, preventDefault() {}, stopPropagation() {} });
        assert.deepEqual(picked, [['blue eyes', { replace: false }]], 'the tag went into the field');
        assert.equal(chips[0].disabled, true, 'the picked tag cannot be picked twice');
        assert.equal(document.activeElement, chips[1], 'the focus moved on to the next tag, not to <body>');
        assert.equal(popover.element.contains(document.activeElement), true);

        // and the focus comes back to the chip the popover belongs to
        assert.equal(keydown(document, document.activeElement, 'Escape'), true);
        assert.equal(popover.isOpen(), false);
        assert.equal(document.activeElement, anchor);
    }, GLOBALS);
});

test('Ctrl+R while the popover is open never reaches the window menu, wherever the focus sits', async () => {
    await withFakeDom(async document => {
        const { popover, chips } = await openRelatedPopover(document);
        assert.equal(keydown(document, chips[0], 'r', { ctrlKey: true }), true, 'inside the popover');
        // the focus can sit outside it (a picked tag disables its button in a page without
        // another one to take it): the popover is open, so the key is still consumed
        assert.equal(keydown(document, document.body, 'R', { ctrlKey: true }), true);
        assert.equal(keydown(document, document.body, 'r', { metaKey: true }), true);
        assert.equal(keydown(document, document.body, 'r', { ctrlKey: true, altKey: true }), false, 'Ctrl+Alt+R is not Reload');
        assert.equal(keydown(document, document.body, 'r'), false, 'a plain "r" is typing');
        popover.close();
        assert.equal(keydown(document, document.body, 'r', { ctrlKey: true }), false, 'a closed popover consumes nothing');
    }, GLOBALS);
});

test('the Related tab writes as it goes: it has no Apply, and its Cancel reads "close"', async () => {
    await withFakeDom(async document => {
        const { popover } = await openRelatedPopover(document);
        const apply = popover.element.querySelector('.tag-weight-button-primary');
        const cancel = popover.element.querySelector('.tag-weight-button:not(.tag-weight-button-primary)');
        assert.equal(apply.hidden, true, 'a picked tag is already in the field');
        assert.equal(cancel.textContent, 'tag_ui_close');
        // a weight tab brings Apply back, and the same button is Cancel again
        popover.element.querySelectorAll('.tag-weight-popover-tab')[0].click();
        assert.equal(apply.hidden, false);
        assert.equal(cancel.textContent, 'tag_ui_cancel');
    }, GLOBALS);
});

test('with Apply out of the way the focus ring ends at Cancel, not at a button nobody can see', async () => {
    await withFakeDom(async document => {
        const { popover } = await openRelatedPopover(document);
        const root = popover.element;
        const closeButton = root.querySelector('.tag-weight-popover-close');
        const cancel = root.querySelector('.tag-weight-button:not(.tag-weight-button-primary)');
        assert.equal(root.querySelector('.tag-weight-button-primary').hidden, true);
        cancel.focus();
        assert.equal(keydown(document, cancel, 'Tab'), true, 'Cancel is the last control the ring has here');
        assert.equal(document.activeElement, closeButton);
    }, GLOBALS);
});

test('the last Related tag picked leaves the focus on the tab strip, still inside the popover', async () => {
    await withFakeDom(async document => {
        const { popover, chips } = await openRelatedPopover(document);
        for (const chip of chips) {
            chip.focus();
            chip.dispatchEvent({ type: 'click', bubbles: true, target: chip, shiftKey: false, preventDefault() {}, stopPropagation() {} });
        }
        assert.equal(chips.every(chip => chip.disabled), true);
        assert.equal(popover.element.contains(document.activeElement), true, 'not <body>');
        assert.equal(keydown(document, document.activeElement, 'r', { ctrlKey: true }), true);
    }, GLOBALS);
});
