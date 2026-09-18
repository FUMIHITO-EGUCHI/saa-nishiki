// The selection modal (selectionModal.js) driven on the in-memory DOM: the dialog it
// builds, the 120 ms debounce in front of a dynamic search and the answers it drops, the
// keyboard, the favourites, and what Apply hands back. The timers are a clock this file
// turns by hand, so "not yet" and "now" are separate assertions.
import assert from 'node:assert/strict';
import test from 'node:test';

import { withFakeDom } from './helpers/fakeDom.mjs';
import { createSelectionModal } from '../scripts/renderer/components/selectionModal.js';

const OPTIONS = [
    { key: 'blue_hair', value: 'blue hair', label: 'blue hair', category: 'appearance', attributes: ['color'] },
    { key: 'holding_halo', value: 'holding halo', label: 'holding halo', category: 'pose_action', attributes: ['pose'] },
    { key: 'school_uniform', value: 'school uniform', label: 'school uniform', category: 'clothing', attributes: ['outfit'] },
];

const settle = () => new Promise(resolve => { setImmediate(resolve); });

// A clock the test turns: setTimeout hands back a token, and nothing runs until tick().
function fakeClock() {
    let now = 0;
    let sequence = 0;
    const timers = new Map();
    return {
        setTimeout(callback, delay = 0, ...args) {
            const id = ++sequence;
            timers.set(id, { at: now + (Number(delay) || 0), callback, args });
            return id;
        },
        clearTimeout(id) { timers.delete(id); },
        pending: () => timers.size,
        async tick(ms = 0) {
            const until = now + (Number(ms) || 0);
            for (;;) {
                const due = [...timers.entries()]
                    .filter(([, timer]) => timer.at <= until)
                    .sort((left, right) => left[1].at - right[1].at || left[0] - right[0]);
                if (due.length === 0) break;
                for (const [id, timer] of due) {
                    if (!timers.has(id)) continue;
                    timers.delete(id);
                    now = Math.max(now, timer.at);
                    timer.callback(...timer.args);
                    await settle();
                }
            }
            now = until;
            await settle();
        },
    };
}

function parts(modal) {
    const root = modal.element;
    const filters = root.querySelectorAll('.selection-modal-filter');
    return {
        root,
        dialog: root.querySelector('.selection-modal-dialog'),
        heading: root.querySelector('.selection-modal-title'),
        closeButton: root.querySelector('.selection-modal-close'),
        search: root.querySelector('.selection-modal-search'),
        categorySelect: filters[0],
        attributeSelect: filters[1],
        favOnly: root.querySelector('.selection-modal-favonly'),
        selectedList: root.querySelector('.selection-modal-selected-list'),
        status: root.querySelector('.selection-modal-status'),
        listbox: root.querySelector('.selection-modal-list'),
        note: root.querySelector('.selection-modal-footer-note'),
        cancelButton: root.querySelector('.selection-modal-cancel'),
        applyButton: root.querySelector('.selection-modal-apply'),
        keys: () => root.querySelectorAll('.selection-modal-option').map(item => item.dataset.key),
        rows: () => root.querySelectorAll('.selection-modal-option'),
        chips: () => root.querySelectorAll('.selection-modal-chip-label').map(node => node.textContent),
    };
}

// A modal on a fake document, with the clock in place of the real timers.
async function withModal(factoryOptions, body) {
    const clock = fakeClock();
    return withFakeDom(async document => {
        const modal = createSelectionModal(factoryOptions);
        const trigger = document.createElement('button');
        document.body.appendChild(trigger);
        return body({ document, modal, clock, trigger, ui: parts(modal) });
    }, { setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout });
}

function fire(target, type, extra = {}) {
    let prevented = false;
    target.dispatchEvent({
        type,
        bubbles: true,
        ...extra,
        preventDefault() { prevented = true; },
        stopPropagation() {},
    });
    return prevented;
}

const typeSearch = (search, value) => { search.value = value; fire(search, 'input'); };

// ------------------------------------------------------------------ the dialog

test('open builds a labelled dialog, lists the options and puts the focus in the search box', async () => {
    await withModal({ mode: 'multiple', title: 'Choose tags' }, async ({ document, modal, clock, trigger, ui }) => {
        assert.equal(modal.isOpen(), false);
        assert.equal(ui.root.hidden, true);
        assert.equal(ui.root.getAttribute('aria-hidden'), 'true');

        modal.open({ trigger, options: OPTIONS });
        assert.equal(modal.isOpen(), true);
        assert.equal(ui.root.hidden, false);
        assert.equal(ui.root.getAttribute('aria-hidden'), 'false');
        assert.equal(ui.heading.textContent, 'Choose tags');
        assert.equal(ui.dialog.getAttribute('role'), 'dialog');
        assert.equal(ui.dialog.getAttribute('aria-modal'), 'true');
        assert.equal(ui.dialog.getAttribute('aria-labelledby'), ui.heading.id);
        assert.equal(ui.listbox.getAttribute('role'), 'listbox');
        assert.equal(ui.listbox.getAttribute('aria-multiselectable'), 'true');
        assert.equal(ui.status.getAttribute('aria-live'), 'polite');
        assert.deepEqual(ui.keys(), ['blue hair', 'holding halo', 'school uniform']);
        assert.deepEqual(ui.rows().map(item => item.getAttribute('role')), ['option', 'option', 'option']);
        assert.deepEqual(ui.rows().map(item => item.getAttribute('aria-selected')), ['false', 'false', 'false']);
        assert.equal(ui.status.textContent, '3 results · ↑↓ move · Space select · Enter apply');
        assert.equal(ui.note.hidden, false);
        assert.equal(ui.note.textContent, 'Weights and batch are not set here');
        assert.equal(ui.applyButton.textContent, 'Apply');
        assert.equal(ui.cancelButton.textContent, 'Cancel');
        assert.deepEqual(ui.chips(), []);
        assert.equal(ui.selectedList.textContent, 'None');

        assert.notEqual(document.activeElement, ui.search, 'the focus is taken in the next frame');
        await clock.tick(0);
        assert.equal(document.activeElement, ui.search);
    });
});

test('the modal opens on the row that is already selected and says which rows those are', async () => {
    await withModal({ mode: 'multiple' }, async ({ modal, clock, ui }) => {
        modal.open({ options: OPTIONS, selection: [OPTIONS[2]] });
        await clock.tick(0);
        assert.deepEqual(ui.rows().map(item => item.getAttribute('aria-selected')), ['false', 'false', 'true']);
        assert.equal(ui.listbox.getAttribute('aria-activedescendant'), ui.rows()[2].id);
        assert.deepEqual(ui.chips(), ['school uniform']);
        assert.equal(ui.applyButton.textContent, 'Apply (1)');
    });
});

test('a single-choice modal has no multi-select affordances', async () => {
    await withModal({ mode: 'single' }, async ({ modal, clock, ui }) => {
        modal.open({ options: OPTIONS });
        await clock.tick(0);
        assert.equal(ui.listbox.getAttribute('aria-multiselectable'), null);
        assert.equal(ui.note.hidden, true, 'the weights note belongs to the multi-select modal');
        assert.equal(ui.status.textContent, '3 results', 'and so does the keyboard hint');
        ui.rows()[1].click();
        assert.equal(ui.applyButton.textContent, 'Apply', 'no count on a single choice');
        ui.rows()[2].click();
        assert.deepEqual(ui.chips(), ['school uniform'], 'the second choice replaces the first');
    });
});

// ------------------------------------------------------------------ what Apply hands back

test('Apply hands back the selection; Cancel, Escape and the × hand back nothing', async () => {
    await withModal({ mode: 'multiple' }, async ({ document, modal, clock, trigger, ui }) => {
        const applied = [];
        const closed = [];
        const control = createSelectionModal({
            mode: 'multiple',
            onApply: selection => applied.push(selection.map(option => option.key)),
            onClose: event => closed.push(event),
        });
        const own = parts(control);

        control.open({ trigger, options: OPTIONS });
        await clock.tick(0);
        own.rows()[0].click();
        own.rows()[2].click();
        assert.deepEqual(own.chips(), ['blue hair', 'school uniform']);
        assert.equal(own.applyButton.textContent, 'Apply (2)');
        assert.deepEqual(own.rows().map(item => item.getAttribute('aria-selected')), ['true', 'false', 'true']);
        own.applyButton.click();
        assert.deepEqual(applied, [['blue_hair', 'school_uniform']]);
        assert.deepEqual(closed, [{ apply: true }]);
        assert.equal(control.isOpen(), false);
        assert.equal(own.root.hidden, true);
        assert.equal(document.activeElement, trigger, 'the focus is back where the modal was opened from');

        control.open({ trigger, options: OPTIONS });
        await clock.tick(0);
        own.rows()[1].click();
        own.cancelButton.click();
        assert.deepEqual(applied, [['blue_hair', 'school_uniform']], 'Cancel writes nothing');
        assert.deepEqual(closed.at(-1), { apply: false });

        control.open({ trigger, options: OPTIONS });
        await clock.tick(0);
        own.rows()[1].click();
        assert.equal(fire(document.body, 'keydown', { key: 'Escape' }), true);
        assert.equal(control.isOpen(), false);
        assert.deepEqual(applied.length, 1);

        control.open({ trigger, options: OPTIONS });
        await clock.tick(0);
        own.closeButton.click();
        assert.equal(control.isOpen(), false);
        assert.deepEqual(applied.length, 1);

        // an Escape that is really the IME closing its candidate window is not a Cancel
        control.open({ trigger, options: OPTIONS });
        await clock.tick(0);
        assert.equal(fire(document.body, 'keydown', { key: 'Escape', isComposing: true }), false);
        assert.equal(control.isOpen(), true);
        assert.equal(fire(document.body, 'keydown', { key: 'Escape', keyCode: 229 }), false);
        assert.equal(control.isOpen(), true);
        control.close();
        assert.equal(modal.isOpen(), false);
    });
});

test('a closed modal is deaf: its keys and its timers are unhooked', async () => {
    await withModal({ mode: 'multiple' }, async ({ document, modal, clock, ui }) => {
        modal.open({ options: OPTIONS, dynamicLoadOptions: async () => OPTIONS });
        await clock.tick(0);
        assert.ok(clock.pending() > 0, 'the search the open scheduled');
        modal.close();
        assert.equal(clock.pending(), 0, 'and it was dropped with the modal');
        assert.equal(fire(document.body, 'keydown', { key: 'Escape' }), false, 'Escape belongs to the page again');
        assert.equal(modal.isOpen(), false);
        modal.close();
        assert.equal(modal.isOpen(), false, 'closing a closed modal is not an event');
    });
});

test('the focus goes to the fallback when the trigger left the page, and to the body when there is neither', async () => {
    await withModal({}, async ({ document, modal, clock, trigger, ui }) => {
        const fallback = document.createElement('button');
        document.body.appendChild(fallback);
        modal.open({ trigger, fallback, options: OPTIONS });
        await clock.tick(0);
        modal.close();
        assert.equal(document.activeElement, trigger, 'the button it was opened from comes first');

        modal.open({ trigger, fallback, options: OPTIONS });
        await clock.tick(0);
        trigger.remove();   // e.g. the row the button sat in was deleted while the modal was open
        modal.close();
        assert.equal(document.activeElement, fallback);

        modal.open({ options: OPTIONS });
        await clock.tick(0);
        modal.close();
        assert.equal(document.activeElement, document.body, 'the page keeps the focus rather than losing it');
        assert.equal(document.body.tabIndex, -1);
    });
});

// ------------------------------------------------------------------ the debounce

test('a dynamic search waits 120 ms after the last keystroke and then asks once', async () => {
    await withModal({}, async ({ modal, clock, ui }) => {
        const asked = [];
        modal.open({
            options: [],
            dynamicLoadOptions: async config => { asked.push(config.query); return OPTIONS; },
        });
        await clock.tick(0);
        assert.deepEqual(asked, [], 'the frame that takes the focus is not the search');

        typeSearch(ui.search, 'b');
        typeSearch(ui.search, 'bl');
        typeSearch(ui.search, 'blu');
        await clock.tick(119);
        assert.deepEqual(asked, [], 'still typing');
        await clock.tick(1);
        assert.deepEqual(asked, ['blu'], 'one request, for the last thing that was typed');
        assert.deepEqual(ui.keys(), ['blue hair'], 'the answer is narrowed by the box it was asked for');

        // and the wait starts again from the next keystroke
        typeSearch(ui.search, 'blue');
        await clock.tick(119);
        assert.deepEqual(asked, ['blu']);
        await clock.tick(1);
        assert.deepEqual(asked, ['blu', 'blue']);

        // the filters go through the same wait
        ui.categorySelect.value = 'appearance';
        fire(ui.categorySelect, 'change');
        await clock.tick(119);
        assert.deepEqual(asked, ['blu', 'blue']);
        await clock.tick(1);
        assert.equal(asked.length, 3);
    });
});

test('an answer to a search that has been superseded, or to a closed modal, is dropped', async () => {
    await withModal({}, async ({ modal, clock, ui }) => {
        const requests = [];
        const loader = config => new Promise(resolve => { requests.push({ query: config.query, resolve }); });
        modal.open({ options: [], dynamicLoadOptions: loader });
        await clock.tick(200);
        assert.equal(requests.length, 1, 'the search the open started');

        typeSearch(ui.search, 'b');
        await clock.tick(120);
        typeSearch(ui.search, 'bl');
        await clock.tick(120);
        assert.deepEqual(requests.map(request => request.query), ['', 'b', 'bl']);

        // the answers come back in the wrong order: the newest first
        requests[2].resolve([OPTIONS[0]]);
        await settle();
        assert.deepEqual(ui.keys(), ['blue hair']);
        requests[1].resolve([OPTIONS[1]]);
        await settle();
        assert.deepEqual(ui.keys(), ['blue hair'], 'the superseded answer never reaches the list');
        requests[0].resolve([OPTIONS[2]]);
        await settle();
        assert.deepEqual(ui.keys(), ['blue hair'], 'nor the one from before the first keystroke');

        // and an answer that arrives after the modal was closed is dropped too
        typeSearch(ui.search, 'blu');
        await clock.tick(120);
        modal.close();
        requests[3].resolve([OPTIONS[1]]);
        await settle();
        assert.deepEqual(ui.keys(), ['blue hair'], 'the list was not repainted behind a closed modal');
    });
});

test('a search that fails empties the list instead of leaving the last answer standing', async () => {
    await withModal({ emptyMessage: 'No matching items.' }, async ({ modal, clock, ui }) => {
        let fail = false;
        modal.open({
            options: [],
            dynamicLoadOptions: async () => {
                if (fail) throw new Error('backend is down');
                return OPTIONS;
            },
        });
        await clock.tick(200);
        assert.deepEqual(ui.keys(), ['blue hair', 'holding halo', 'school uniform']);

        fail = true;
        typeSearch(ui.search, 'blue');
        await clock.tick(120);
        assert.deepEqual(ui.keys(), []);
        assert.equal(ui.status.textContent, 'No matching items.');
        assert.equal(modal.isOpen(), true, 'a failed search is not a reason to close');
    });
});

// ------------------------------------------------------------------ filtering and status

test('the status line counts what was found, and says so when the list was cut short', async () => {
    await withModal({ mode: 'single', optionLimit: 2, emptyMessage: 'No matching items.', searchPrompt: 'Type to search.' },
        async ({ modal, clock, ui }) => {
            modal.open({ options: [] });
            await clock.tick(0);
            assert.equal(ui.status.textContent, 'Type to search.', 'an empty box asks for a search term');

            modal.close();
            modal.open({ options: OPTIONS });
            await clock.tick(0);
            // the count is what the search found; the list itself stops at the limit
            assert.equal(ui.status.textContent, '3 results shown. Refine your search to see more.');
            assert.deepEqual(ui.keys(), ['blue hair', 'holding halo'], 'the list stops at the limit');

            typeSearch(ui.search, 'halo');
            await clock.tick(120);
            assert.equal(ui.status.textContent, '1 result');
            assert.deepEqual(ui.keys(), ['holding halo']);

            typeSearch(ui.search, 'zzz');
            await clock.tick(120);
            assert.equal(ui.status.textContent, 'No matching items.', 'a search that found nothing');
            assert.deepEqual(ui.keys(), []);
            assert.equal(ui.listbox.getAttribute('aria-activedescendant'), null, 'nothing to point at');
        });
});

test('the category and attribute boxes narrow the list, and stay out of sight when empty', async () => {
    await withModal({ mode: 'multiple' }, async ({ modal, clock, ui }) => {
        modal.open({ options: OPTIONS });
        await clock.tick(0);
        assert.equal(ui.categorySelect.parentElement.hidden, true, 'no categories were given');
        assert.equal(ui.attributeSelect.parentElement.hidden, true);

        modal.close();
        modal.open({
            options: OPTIONS,
            categories: ['appearance', 'clothing'],
            attributes: [{ value: 'outfit', label: 'Outfit' }],
        });
        await clock.tick(0);
        assert.equal(ui.categorySelect.parentElement.hidden, false);
        assert.deepEqual(ui.categorySelect.options.map(option => option.textContent),
            ['All categories', 'appearance', 'clothing']);
        assert.deepEqual(ui.attributeSelect.options.map(option => option.textContent), ['All attributes', 'Outfit']);

        ui.categorySelect.value = 'clothing';
        fire(ui.categorySelect, 'change');
        assert.deepEqual(ui.keys(), ['blue hair', 'holding halo', 'school uniform'],
            'a change waits for the debounce, like every other search');
        await clock.tick(120);
        assert.deepEqual(ui.keys(), ['school uniform']);

        ui.categorySelect.value = '';
        ui.attributeSelect.value = 'pose';
        fire(ui.attributeSelect, 'change');
        await clock.tick(120);
        assert.deepEqual(ui.keys(), ['holding halo']);
    });
});

// ------------------------------------------------------------------ the keyboard

test('the list moves with the arrows, wraps at both ends and selects with Enter or Space', async () => {
    await withModal({ mode: 'multiple' }, async ({ modal, clock, ui }) => {
        const active = [];
        const control = createSelectionModal({ mode: 'multiple', onActiveOption: option => active.push(option?.key ?? null) });
        const own = parts(control);
        control.open({ options: OPTIONS });
        await clock.tick(0);
        const at = () => own.rows().findIndex(item => item.id === own.listbox.getAttribute('aria-activedescendant'));
        assert.equal(at(), 0);
        assert.deepEqual(active.at(-1), 'blue_hair');

        assert.equal(fire(own.listbox, 'keydown', { key: 'ArrowDown' }), true);
        assert.equal(at(), 1);
        fire(own.listbox, 'keydown', { key: 'ArrowDown' });
        assert.equal(at(), 2);
        fire(own.listbox, 'keydown', { key: 'ArrowDown' });
        assert.equal(at(), 0, 'past the end it wraps to the top');
        fire(own.listbox, 'keydown', { key: 'ArrowUp' });
        assert.equal(at(), 2, 'and back off the top to the bottom');
        fire(own.listbox, 'keydown', { key: 'Home' });
        assert.equal(at(), 0);
        fire(own.listbox, 'keydown', { key: 'End' });
        assert.equal(at(), 2);

        assert.equal(fire(own.listbox, 'keydown', { key: ' ' }), true, 'Space is a selection, not a page scroll');
        assert.deepEqual(own.chips(), ['school uniform']);
        fire(own.listbox, 'keydown', { key: 'Home' });
        fire(own.listbox, 'keydown', { key: 'Enter' });
        assert.deepEqual(own.chips(), ['school uniform', 'blue hair']);
        fire(own.listbox, 'keydown', { key: 'Enter' });
        assert.deepEqual(own.chips(), ['school uniform'], 'Enter on a selected row takes it back out');
        assert.equal(fire(own.listbox, 'keydown', { key: 'a' }), false, 'every other key is left alone');
    });
});

test('Arrow Down out of the search box hands the list over; Enter there picks the one obvious row', async () => {
    await withModal({ mode: 'multiple', allowFreeInput: true }, async ({ document, modal, clock, ui }) => {
        modal.open({ options: OPTIONS });
        await clock.tick(0);
        assert.equal(document.activeElement, ui.search);
        assert.equal(fire(ui.search, 'keydown', { key: 'ArrowDown' }), true);
        assert.equal(document.activeElement, ui.listbox);

        // an exact match is taken whatever else is on the list
        ui.search.focus();
        typeSearch(ui.search, 'holding halo');
        await clock.tick(120);
        fire(ui.search, 'keydown', { key: 'Enter' });
        assert.deepEqual(ui.chips(), ['holding halo']);

        // so is the single row a search narrowed down to
        typeSearch(ui.search, 'uniform');
        await clock.tick(120);
        fire(ui.search, 'keydown', { key: 'Enter' });
        assert.deepEqual(ui.chips(), ['holding halo', 'school uniform']);

        // and text that matches nothing becomes a tag of its own
        typeSearch(ui.search, 'my own tag');
        await clock.tick(120);
        fire(ui.search, 'keydown', { key: 'Enter' });
        assert.deepEqual(ui.chips(), ['holding halo', 'school uniform', 'my own tag']);
        assert.equal(ui.search.value, '', 'the box is ready for the next one');

        // but only where the caller allows it
        modal.close();
        const strict = createSelectionModal({ mode: 'multiple' });
        const own = parts(strict);
        strict.open({ options: OPTIONS });
        await clock.tick(0);
        typeSearch(own.search, 'not a tag');
        await clock.tick(120);
        fire(own.search, 'keydown', { key: 'Enter' });
        assert.deepEqual(own.chips(), []);
        // an Enter the IME is still holding is not an Enter
        typeSearch(own.search, 'holding halo');
        await clock.tick(120);
        assert.equal(fire(own.search, 'keydown', { key: 'Enter', isComposing: true }), false);
        assert.deepEqual(own.chips(), []);
    });
});

test('Tab is trapped inside the dialog and skips the controls that are out of sight', async () => {
    await withModal({ mode: 'multiple' }, async ({ document, modal, clock, ui }) => {
        modal.open({ options: OPTIONS });
        await clock.tick(0);
        assert.equal(ui.favOnly.hidden, true, 'no favourites were configured');
        assert.equal(ui.categorySelect.parentElement.hidden, true);

        ui.closeButton.focus();
        assert.equal(fire(document.body, 'keydown', { key: 'Tab', shiftKey: true }), true);
        assert.equal(document.activeElement, ui.applyButton, 'Shift+Tab off the first control wraps to the last');

        assert.equal(fire(document.body, 'keydown', { key: 'Tab' }), true);
        assert.equal(document.activeElement, ui.closeButton, 'and Tab off the last wraps to the first');

        ui.search.focus();
        assert.equal(fire(document.body, 'keydown', { key: 'Tab' }), false, 'in the middle Tab is the browser\'s');
        assert.equal(document.activeElement, ui.search);
    });
});

// ------------------------------------------------------------------ selected chips

test('a selected chip can be taken back out from the Selected row', async () => {
    await withModal({ mode: 'multiple' }, async ({ modal, clock, ui }) => {
        modal.open({ options: OPTIONS, selection: [OPTIONS[0], OPTIONS[1]] });
        await clock.tick(0);
        assert.deepEqual(ui.chips(), ['blue hair', 'holding halo']);
        const remove = ui.root.querySelectorAll('.selection-modal-chip-remove');
        assert.equal(remove[0].getAttribute('aria-label'), 'Remove blue hair');
        remove[0].click();
        assert.deepEqual(ui.chips(), ['holding halo']);
        assert.deepEqual(ui.rows().map(item => item.getAttribute('aria-selected')), ['false', 'true', 'false']);
        assert.equal(ui.applyButton.textContent, 'Apply (1)');
        ui.root.querySelector('.selection-modal-chip-remove').click();
        assert.deepEqual(ui.chips(), []);
        assert.equal(ui.selectedList.textContent, 'None');
        assert.equal(ui.applyButton.textContent, 'Apply');
    });
});

// ------------------------------------------------------------------ favourites

test('favourites sort to the top, the Fav-only button narrows to them, and the star toggles', async () => {
    await withModal({}, async ({ modal, clock, ui }) => {
        const stored = new Set(['school uniform']);
        const toggled = [];
        const favorites = {
            isFavorite: key => stored.has(key),
            toggle: option => {
                toggled.push(option.key);
                if (stored.has(option.value)) stored.delete(option.value); else stored.add(option.value);
            },
        };
        modal.open({ options: OPTIONS, favorites });
        await clock.tick(0);
        assert.equal(ui.favOnly.hidden, false);
        assert.equal(ui.favOnly.getAttribute('aria-pressed'), 'false');
        assert.equal(ui.favOnly.title, 'Favorites only');
        assert.deepEqual(ui.keys(), ['school uniform', 'blue hair', 'holding halo'], 'the favourite first, the rest in order');
        assert.deepEqual(ui.root.querySelectorAll('.selection-modal-option-fav').map(button => button.textContent),
            ['★', '☆', '☆']);

        ui.favOnly.click();
        assert.equal(ui.favOnly.getAttribute('aria-pressed'), 'true');
        assert.equal(ui.favOnly.classList.contains('is-on'), true);
        assert.deepEqual(ui.keys(), ['school uniform']);

        ui.favOnly.click();
        assert.deepEqual(ui.keys(), ['school uniform', 'blue hair', 'holding halo']);

        // the star adds a favourite without selecting the row it sits on
        const star = ui.rows()[1].querySelector('.selection-modal-option-fav');
        assert.equal(star.title, 'Add blue hair to favorites');
        star.click();
        assert.deepEqual(toggled, ['blue_hair']);
        assert.deepEqual(ui.chips(), [], 'the star is not the row');
        assert.deepEqual(ui.keys(), ['blue hair', 'school uniform', 'holding halo'],
            'two favourites now, in the order the source had them');
        assert.equal(ui.rows()[0].classList.contains('is-fav'), true);
        assert.equal(ui.rows()[0].querySelector('.selection-modal-option-fav').title, 'Remove blue hair from favorites');

        // and a modal opened without a favourites config has no Fav-only button at all
        modal.close();
        modal.open({ options: OPTIONS });
        await clock.tick(0);
        assert.equal(ui.favOnly.hidden, true);
        assert.deepEqual(ui.root.querySelectorAll('.selection-modal-option-fav'), []);
        assert.deepEqual(ui.keys(), ['blue hair', 'holding halo', 'school uniform']);
    });
});

test('reopening the modal drops the search, the filters and the Fav-only narrowing of the last visit', async () => {
    await withModal({}, async ({ modal, clock, ui }) => {
        const favorites = { isFavorite: key => key === 'school uniform' };
        modal.open({ options: OPTIONS, favorites, categories: ['appearance', 'clothing'] });
        await clock.tick(0);
        ui.favOnly.click();
        assert.deepEqual(ui.keys(), ['school uniform']);
        ui.search.value = 'halo';
        ui.categorySelect.value = 'clothing';
        modal.close();

        modal.open({ options: OPTIONS, favorites, categories: ['appearance', 'clothing'] });
        await clock.tick(0);
        assert.equal(ui.search.value, '', 'the box starts empty');
        assert.equal(ui.categorySelect.value, '', 'and on "All categories"');
        assert.equal(ui.favOnly.getAttribute('aria-pressed'), 'false');
        assert.deepEqual(ui.keys(), ['school uniform', 'blue hair', 'holding halo']);
    });
});

// ------------------------------------------------------------------ the caller's hooks

test('the caller is told which row is under the pointer, which row is active, and when the modal opens', async () => {
    await withModal({}, async ({ modal, clock, ui }) => {
        const events = [];
        const control = createSelectionModal({
            mode: 'multiple',
            onOpen: () => events.push('open'),
            onOptionHover: option => events.push(`hover ${option.key}`),
            onOptionLeave: option => events.push(`leave ${option?.key ?? 'all'}`),
            onActiveOption: option => events.push(`active ${option?.key ?? 'none'}`),
        });
        const own = parts(control);
        control.open({ options: OPTIONS });
        await clock.tick(0);
        assert.deepEqual(events, ['open', 'active blue_hair']);

        events.length = 0;
        fire(own.rows()[1], 'mouseenter');
        fire(own.rows()[1], 'mouseleave');
        assert.deepEqual(events, ['hover holding_halo', 'leave holding_halo']);

        events.length = 0;
        fire(own.listbox, 'keydown', { key: 'End' });
        assert.deepEqual(events, ['active school_uniform']);

        events.length = 0;
        control.close();
        assert.deepEqual(events, ['leave all'], 'the preview the hover put up is taken down with the modal');
    });
});

// ------------------------------------------------------------------ the API surface

test('the modal hands back exactly the handles the callers use, and destroy takes it off the page', async () => {
    await withModal({ mode: 'multiple' }, async ({ document, modal, clock, ui }) => {
        assert.deepEqual(Object.keys(modal).sort(), ['apply', 'close', 'destroy', 'element', 'isOpen', 'open']);
        assert.equal(typeof modal.open, 'function');
        assert.equal(document.body.contains(modal.element), true);

        const applied = [];
        const control = createSelectionModal({ mode: 'multiple', onApply: selection => applied.push(selection.length) });
        const own = parts(control);
        control.open({ options: OPTIONS, selection: [OPTIONS[0]] });
        await clock.tick(0);
        control.apply();                       // Enter in a caller's own shortcut
        assert.deepEqual(applied, [1]);
        assert.equal(control.isOpen(), false);

        control.open({ options: OPTIONS });
        await clock.tick(0);
        control.destroy();
        assert.equal(control.isOpen(), false);
        assert.equal(document.body.contains(own.root), false, 'the overlay is gone, not just hidden');
        assert.deepEqual(applied, [1], 'destroy is not an Apply');
    });
});

test('each modal gets its own ids, so two of them on one page do not share a listbox', async () => {
    await withModal({}, async ({ modal, clock, ui }) => {
        const second = createSelectionModal({ mode: 'multiple' });
        const own = parts(second);
        modal.open({ options: OPTIONS });
        second.open({ options: OPTIONS });
        await clock.tick(0);
        assert.notEqual(ui.listbox.id, own.listbox.id);
        assert.notEqual(ui.heading.id, own.heading.id);
        assert.notEqual(ui.rows()[0].id, own.rows()[0].id);
        assert.equal(ui.listbox.getAttribute('aria-activedescendant'), ui.rows()[0].id);
        assert.equal(own.listbox.getAttribute('aria-activedescendant'), own.rows()[0].id);
    });
});
