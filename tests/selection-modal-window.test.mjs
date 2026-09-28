// The selection modal sized by the window (design: Select Modal Resize, 2026-09-28): the
// dialog rule and its clamping, the size a drag leaves behind and where it is kept, the
// Selected row that stays one line high, the category rail, the sort box, the tile sizes
// and the click-previews grid. The DOM is the in-memory one (tests/helpers/fakeDom.mjs).
import assert from 'node:assert/strict';
import test from 'node:test';

import { withFakeDom } from './helpers/fakeDom.mjs';
import { createSelectionModal } from '../scripts/renderer/components/selectionModal.js';
import {
    DIALOG_FIT, clampDialogSize, dialogSizeKey, fitDialogSize, readStoredPreference, readStoredSize,
    writeStoredPreference, writeStoredSize,
} from '../scripts/renderer/components/selectionModalLogic.js';

const settle = () => new Promise(resolve => { setImmediate(resolve); });
const later = (ms = 150) => new Promise(resolve => { setTimeout(resolve, ms); });

function fakeStorage(initial = {}) {
    const map = new Map(Object.entries(initial));
    return {
        getItem: key => (map.has(key) ? map.get(key) : null),
        setItem: (key, value) => { map.set(key, String(value)); },
        removeItem: key => { map.delete(key); },
        keys: () => [...map.keys()],
    };
}

function fire(target, type, extra = {}) {
    let prevented = false;
    target.dispatchEvent({ type, bubbles: true, ...extra, preventDefault() { prevented = true; }, stopPropagation() {} });
    return prevented;
}

const PARTS = [
    { key: 'parts:blazer', value: 'parts:blazer', label: 'blazer', category: 'outfit', keywords: ['blazer, necktie'], created: '2026-09-01' },
    { key: 'parts:from above', value: 'parts:from above', label: 'from above', category: 'camera', keywords: ['from above'], created: '2026-09-27' },
    { key: 'parts:dutch angle', value: 'parts:dutch angle', label: 'dutch angle', category: 'camera', keywords: ['dutch angle'], created: '2026-09-20' },
    { key: 'parts:sepia', value: 'parts:sepia', label: 'sepia', category: 'tone', keywords: ['sepia'], created: '2026-09-10' },
];

function partsTab(document, extra = {}) {
    return {
        id: 'parts',
        label: 'Parts',
        view: 'grid',
        rail: true,
        clickPreviews: true,
        categories: [
            { value: 'outfit', label: 'Outfit', color: '#e0a72f' },
            { value: 'camera', label: 'Camera', color: '#7fb0ff' },
            { value: 'tone', label: 'Tone', color: '#f472b6' },
        ],
        categoryAll: 'All',
        sorts: [
            { value: 'name', label: 'Name', compare: (a, b) => a.label.localeCompare(b.label) },
            { value: 'newest', label: 'Newest', compare: (a, b) => b.created.localeCompare(a.created) },
        ],
        tileSizes: [
            { value: 's', label: 'S', px: 120 },
            { value: 'm', label: 'M', px: 168, default: true },
            { value: 'l', label: 'L', px: 220 },
        ],
        loadOptions: async () => PARTS,
        renderOption: option => { const tile = document.createElement('span'); tile.className = 'tile'; tile.textContent = option.label; return tile; },
        panel: option => { const about = document.createElement('p'); about.textContent = option ? `about ${option.label}` : 'pick one'; return about; },
        ...extra,
    };
}

function ui(modal) {
    const root = modal.element;
    return {
        root,
        dialog: root.querySelector('.selection-modal-dialog'),
        fit: root.querySelector('.selection-modal-fit'),
        handle: root.querySelector('.selection-modal-resize'),
        toggle: root.querySelector('.selection-modal-selected-toggle'),
        strip: root.querySelector('.selection-modal-selected-list'),
        popover: root.querySelector('.selection-modal-selected-popover'),
        clear: root.querySelector('.selection-modal-clear'),
        rail: root.querySelector('.selection-modal-rail'),
        sort: root.querySelector('.selection-modal-sort'),
        sizes: root.querySelector('.selection-modal-size'),
        listbox: root.querySelector('.selection-modal-list'),
        panel: root.querySelector('.selection-modal-panel'),
        tiles: () => root.querySelectorAll('.selection-modal-list [role="option"]'),
        tileLabels: () => root.querySelectorAll('.selection-modal-list [role="option"]').map(tile => tile.textContent),
        railItems: () => root.querySelectorAll('.selection-modal-rail-item').map(item => `${item.querySelector('.selection-modal-rail-name').textContent}:${item.querySelector('.selection-modal-rail-count').textContent}${item.classList.contains('is-active') ? '*' : ''}`),
        chips: () => root.querySelectorAll('.selection-modal-selected-list .selection-modal-chip'),
    };
}

test('the dialog rule: the window less 24px a side, no larger than 1800 by 1200 and no smaller than 640 by 480', () => {
    assert.deepEqual(fitDialogSize({ width: 1920, height: 1080 }), { width: 1800, height: 1032 });
    assert.deepEqual(fitDialogSize({ width: 1280, height: 800 }), { width: 1232, height: 752 });
    assert.deepEqual(fitDialogSize({ width: 600, height: 400 }), { width: DIALOG_FIT.minWidth, height: DIALOG_FIT.minHeight });
    // a remembered size never exceeds the fit and never goes under the minimum
    assert.deepEqual(clampDialogSize({ width: 1700, height: 1100 }, { width: 1280, height: 800 }), { width: 1232, height: 752 });
    assert.deepEqual(clampDialogSize({ width: 900, height: 600 }, { width: 1920, height: 1080 }), { width: 900, height: 600 });
    assert.deepEqual(clampDialogSize({ width: 10, height: 10 }, { width: 1920, height: 1080 }), { width: 640, height: 480 });
    assert.equal(dialogSizeKey(null), 'selection-modal-size:main');
    assert.equal(dialogSizeKey('parts'), 'selection-modal-size:parts');
});

test('a remembered size survives a round trip through storage, and a broken or missing store is no error', () => {
    const storage = fakeStorage();
    writeStoredSize(storage, 'k', { width: 900, height: 600 });
    assert.deepEqual(readStoredSize(storage, 'k'), { width: 900, height: 600 });
    writeStoredSize(storage, 'k', null);
    assert.equal(readStoredSize(storage, 'k'), null);
    assert.equal(readStoredSize(fakeStorage({ k: 'not json' }), 'k'), null);
    assert.equal(readStoredSize(fakeStorage({ k: '{"width":"x"}' }), 'k'), null);
    assert.equal(readStoredSize(null, 'k'), null);
    const throwing = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } };
    assert.equal(readStoredSize(throwing, 'k'), null);
    assert.doesNotThrow(() => writeStoredSize(throwing, 'k', { width: 1, height: 1 }));
    writeStoredPreference(storage, 'p', 'l');
    assert.equal(readStoredPreference(storage, 'p'), 'l');
    assert.equal(readStoredPreference(storage, 'none'), null);
});

test('a window-sized modal wears the rule by default, puts back a remembered size per tab clamped to the window, and the fit button forgets it', async () => {
    const storage = fakeStorage({ 'selection-modal-size:parts': JSON.stringify({ width: 1500, height: 1100 }) });
    await withFakeDom(async document => {
        const modal = createSelectionModal({ mode: 'multiple', fitWindow: true });
        const view = ui(modal);
        assert.equal(view.dialog.classList.contains('is-window-sized'), true);
        assert.equal(view.fit.hidden, false);
        assert.equal(view.handle.hidden, false);
        modal.open({ options: [], tabs: [partsTab(document)], tabLabel: 'Tags' });
        await settle();
        assert.equal(view.dialog.style.width || '', '', 'the tag list has no remembered size: the CSS rule applies');
        modal.selectTab('parts');
        await settle();
        assert.equal(view.dialog.style.width, '1232px', 'the parts size, clamped to the 1280 window');
        assert.equal(view.dialog.style.height, '752px');
        view.fit.click();
        assert.equal(view.dialog.style.width || '', '', 'fit the window: the inline size is gone…');
        assert.equal(storage.getItem('selection-modal-size:parts'), null, '…and so is the memory');
        modal.destroy();
        // a modal without the option keeps the old chrome
        const plain = createSelectionModal({ mode: 'multiple' });
        const plainView = ui(plain);
        assert.equal(plainView.dialog.classList.contains('is-window-sized'), false);
        assert.equal(plainView.fit.hidden, true);
        assert.equal(plainView.handle.hidden, true);
        plain.destroy();
    }, { localStorage: storage, innerWidth: 1280, innerHeight: 800 });
});

test('dragging the corner sizes the dialog within the rule and keeps the size for the tab', async () => {
    const storage = fakeStorage();
    await withFakeDom(async document => {
        const modal = createSelectionModal({ mode: 'multiple', fitWindow: true });
        const view = ui(modal);
        modal.open({ options: [], tabs: [partsTab(document)], tabLabel: 'Tags' });
        await settle();
        view.dialog.setLayoutBox({ left: 24, top: 24, width: 1872, height: 1032 });
        fire(view.handle, 'pointerdown', { clientX: 1896, clientY: 1056, pointerId: 1 });
        fire(view.handle, 'pointermove', { clientX: 1500, clientY: 900, pointerId: 1 });
        assert.equal(view.dialog.style.width, '1476px');
        assert.equal(view.dialog.style.height, '876px');
        fire(view.handle, 'pointermove', { clientX: 100, clientY: 100, pointerId: 1 });
        assert.equal(view.dialog.style.width, '640px', 'never under the minimum');
        assert.equal(view.dialog.style.height, '480px');
        fire(view.handle, 'pointermove', { clientX: 3000, clientY: 3000, pointerId: 1 });
        assert.equal(view.dialog.style.width, '1800px', 'never over the rule');
        assert.equal(view.dialog.style.height, '1032px');
        fire(view.handle, 'pointermove', { clientX: 1200, clientY: 800, pointerId: 1 });
        fire(view.handle, 'pointerup', { pointerId: 1 });
        assert.deepEqual(readStoredSize(storage, 'selection-modal-size:main'), { width: 1176, height: 776 });
        assert.equal(storage.getItem('selection-modal-size:parts'), null, 'the parts tab keeps its own');
        modal.destroy();
    }, { localStorage: storage, innerWidth: 1920, innerHeight: 1080 });
});

test('the Selected row: every chip in one strip, the count on the button, the whole list only in the popover, Clear empties it', async () => {
    await withFakeDom(async () => {
        const many = Array.from({ length: 12 }, (_, i) => ({ key: `tag${i}`, value: `tag ${i}`, label: `tag ${i}` }));
        const modal = createSelectionModal({ mode: 'multiple', fitWindow: true });
        const view = ui(modal);
        modal.open({ options: many, selection: many });
        await settle();
        assert.equal(view.chips().length, 12, 'the strip holds every chip');
        assert.equal(view.toggle.querySelector('.selection-modal-selected-count').textContent, '12');
        assert.equal(view.popover.hidden, true);
        assert.equal(view.popover.children.length, 0, 'the popover is empty while folded');
        view.toggle.click();
        assert.equal(view.popover.hidden, false);
        assert.equal(view.popover.querySelectorAll('.selection-modal-chip').length, 12);
        assert.equal(view.toggle.getAttribute('aria-expanded'), 'true');
        // a chip removed from the popover leaves both lists
        view.popover.querySelector('.selection-modal-chip-remove').click();
        assert.equal(view.chips().length, 11);
        assert.equal(view.popover.querySelectorAll('.selection-modal-chip').length, 11);
        // Escape folds the popover first; the modal is still open
        fire(document, 'keydown', { key: 'Escape' });
        assert.equal(view.popover.hidden, true);
        assert.equal(modal.isOpen(), true);
        view.clear.click();
        assert.equal(view.chips().length, 0);
        assert.equal(view.strip.textContent, 'None');
        assert.equal(view.toggle.disabled, true);
        assert.equal(view.clear.disabled, true);
        fire(document, 'keydown', { key: 'Escape' });
        assert.equal(modal.isOpen(), false, 'the next Escape closes the modal');
        modal.destroy();
    });
});

test('a tab with the rail: All and its categories with counts for the search, the box hidden, the chosen category narrowing the grid', async () => {
    await withFakeDom(async document => {
        const modal = createSelectionModal({ mode: 'multiple', fitWindow: true });
        const view = ui(modal);
        modal.open({ options: [], tabs: [partsTab(document)], tab: 'parts', tabLabel: 'Tags' });
        await later();
        assert.equal(view.rail.hidden, false);
        assert.deepEqual(view.railItems(), ['All:4*', 'Outfit:1', 'Camera:2', 'Tone:1']);
        assert.equal(view.rail.querySelectorAll('.selection-modal-rail-dot')[1].style.background, '#e0a72f');
        assert.equal(view.root.querySelectorAll('.selection-modal-filter')[0].parentElement.hidden, true, 'no Category box beside the rail');
        assert.equal(modal.category(), '');
        view.rail.querySelectorAll('.selection-modal-rail-item')[2].click();
        await later();
        assert.equal(modal.category(), 'camera');
        assert.deepEqual(view.tileLabels(), ['dutch angle', 'from above']);
        assert.deepEqual(view.railItems(), ['All:4', 'Outfit:1', 'Camera:2*', 'Tone:1'], 'the counts ignore the chosen category');
        // the search narrows the counts
        const search = view.root.querySelector('.selection-modal-search');
        search.value = 'angle';
        fire(search, 'input');
        await later();
        assert.deepEqual(view.railItems(), ['All:1', 'Outfit:0', 'Camera:1*', 'Tone:0']);
        modal.destroy();
        // the View row opens on camera
        const camera = createSelectionModal({ mode: 'multiple', fitWindow: true });
        camera.open({ options: [], tabs: [partsTab(document, { defaultCategory: 'camera' })], tab: 'parts' });
        await later();
        assert.equal(camera.category(), 'camera');
        assert.deepEqual(ui(camera).tileLabels(), ['dutch angle', 'from above']);
        camera.destroy();
    });
});

test('the sort box orders the grid and is remembered; the tile size sets the grid track and is remembered', async () => {
    const storage = fakeStorage();
    await withFakeDom(async document => {
        const modal = createSelectionModal({ mode: 'multiple', fitWindow: true });
        const view = ui(modal);
        modal.open({ options: [], tabs: [partsTab(document)], tab: 'parts' });
        await later();
        assert.equal(view.sort.parentElement.hidden, false);
        assert.equal(view.sort.value, 'name');
        assert.deepEqual(view.tileLabels(), ['blazer', 'dutch angle', 'from above', 'sepia']);
        view.sort.value = 'newest';
        fire(view.sort, 'change');
        assert.deepEqual(view.tileLabels(), ['from above', 'dutch angle', 'sepia', 'blazer']);
        assert.equal(storage.getItem('selection-modal-sort:parts'), 'newest');
        // tiles: M by default, the chosen size on the list and in the store
        assert.equal(view.sizes.hidden, false);
        assert.equal(view.listbox.style.getPropertyValue('--selection-tile'), '168px');
        assert.equal(view.listbox.classList.contains('is-tile-m'), true);
        const buttons = view.sizes.querySelectorAll('.selection-modal-size-button');
        assert.deepEqual(buttons.map(button => button.getAttribute('aria-pressed')), ['false', 'true', 'false']);
        buttons[2].click();
        assert.equal(view.listbox.style.getPropertyValue('--selection-tile'), '220px');
        assert.equal(view.listbox.classList.contains('is-tile-l'), true);
        assert.equal(view.listbox.classList.contains('is-tile-m'), false);
        assert.equal(storage.getItem('selection-modal-tile-size:parts'), 'l');
        modal.close();
        // reopened: both come back
        modal.open({ options: [], tabs: [partsTab(document)], tab: 'parts' });
        await later();
        assert.equal(view.sort.value, 'newest');
        assert.equal(view.listbox.style.getPropertyValue('--selection-tile'), '220px');
        // the tag list has neither
        modal.selectTab(null);
        await later();
        assert.equal(view.sort.parentElement.hidden, true);
        assert.equal(view.sizes.hidden, true);
        assert.equal(view.listbox.style.getPropertyValue('--selection-tile'), '');
        modal.destroy();
    }, { localStorage: storage });
});

test('a click-previews grid: one click shows the tile in the panel, a double click or Enter picks it', async () => {
    await withFakeDom(async document => {
        const modal = createSelectionModal({ mode: 'multiple', fitWindow: true });
        const view = ui(modal);
        modal.open({ options: [], tabs: [partsTab(document)], tab: 'parts' });
        await later();
        const tiles = view.tiles();
        tiles[1].click();
        assert.equal(view.panel.textContent, 'about dutch angle');
        assert.equal(tiles[1].classList.contains('is-previewed'), true);
        assert.equal(view.chips().length, 0, 'a click does not pick');
        fire(tiles[1], 'dblclick');
        assert.equal(view.chips().length, 1, 'a double click picks');
        assert.equal(view.chips()[0].textContent, 'dutch angle×');
        fire(view.listbox, 'keydown', { key: 'ArrowRight' });
        fire(view.listbox, 'keydown', { key: 'Enter' });
        assert.equal(view.chips().length, 2, 'Enter picks the tile the arrows reached');
        assert.equal(view.panel.textContent, 'about from above');
        modal.destroy();
    });
});
