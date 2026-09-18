// The context menu (myRightClickMenu.js) driven on the in-memory DOM: what a right-click
// on a chip / a prompt textarea / an image actually puts in the menu box, which handler a
// click reaches, how a submenu moves tags across fields, and how the press state is reset.
// Nothing here reads the module's source - the menu is opened and clicked.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { hasSelector, parseStylesheet } from './helpers/cssRules.mjs';
import { FakeElement, withFakeDom } from './helpers/fakeDom.mjs';
import { addSpellCheckSuggestions, setupRightClickMenu } from '../scripts/renderer/components/myRightClickMenu.js';

const projectRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = relativePath => fs.readFileSync(path.join(projectRoot, relativePath), 'utf8');
const language = JSON.parse(read('data/language.json'));
const EN = language['en-US'];

// The menu tells a textarea from anything else with `instanceof HTMLTextAreaElement`.
class FakeTextArea extends FakeElement {
    constructor(ownerDocument) {
        super(ownerDocument, 'textarea');
        this.value = '';
        this.placeholder = '';
        this.selectionStart = 0;
        this.selectionEnd = 0;
    }
}

const flush = () => new Promise(resolve => setImmediate(resolve));

// ------------------------------------------------------------------ world

// One prompt field: the capsule-field API the menu asks for, plus the myTextbox control
// that owns the text. `calls` collects every effect a menu entry produced.
function makeWorld() {
    const calls = [];
    const record = (name, ...args) => { calls.push([name, ...args]); };

    const makeControl = (key, value) => ({
        getValue: () => value,
        commitValue: next => { value = next; record('commitValue', key, next); },
        readValue: () => value,
    });

    const makeField = (key, { capsules = [], selected = [], editWeight = true } = {}) => {
        const field = {
            getLabel: () => `${key} label`,
            getCapsules: () => capsules,
            findCapsule: id => capsules.find(capsule => capsule.id === id) ?? null,
            getSelectedIds: () => selected,
            showRelated: id => record('showRelated', key, id),
            setDisabledFor: (ids, disabled) => record('setDisabledFor', key, ids, disabled),
            removeIds: ids => record('removeIds', key, ids),
            setAllDisabled: disabled => record('setAllDisabled', key, disabled),
            setSelected: ids => { selected = ids; },
        };
        if (editWeight) field.editWeight = id => record('editWeight', key, id);
        return field;
    };

    const fields = new Map();
    const controls = {};
    const set = {
        fields,
        hasRelated: true,
        get: key => fields.get(key) ?? null,
        transfer: (from, what, to, options) => record('transfer', from, what, to, options),
    };

    const world = {
        calls,
        record,
        fields,
        controls,
        set,
        addField(key, value, options) {
            fields.set(key, makeField(key, options));
            controls[key] = makeControl(key, value);
            return fields.get(key);
        },
        took: name => calls.filter(entry => entry[0] === name).map(entry => entry.slice(1)),
    };
    return world;
}

function globalsFor(world, extra = {}) {
    // globalThis.prompt is read while the menu renders, so it has to follow the fields the
    // test adds after this object is built.
    const prompt = new Proxy({}, {
        get: (target, key) => {
            if (key === 'tagCapsuleFields') return world.set;
            if (key === 'fieldManager') return { listFields: () => [...world.fields.keys()].map(id => ({ id, label: `${id} label` })) };
            return world.controls[key];
        },
        has: (target, key) => key === 'tagCapsuleFields' || key === 'fieldManager' || key in world.controls,
    });
    return {
        HTMLTextAreaElement: FakeTextArea,
        rightClick: undefined,
        inBrowser: false,
        globalSettings: { language: 'en-US' },
        cachedFiles: { language },
        navigator: { clipboard: { writeText: async text => world.record('clipboard', text) } },
        api: {
            onSpellCheckSuggestions: callback => { world.spellCheck = callback; },
            replaceMisspelling: async word => world.record('replaceMisspelling', word),
            addToDictionary: async word => world.record('addToDictionary', word),
            readBase64Image: async dataUrl => { world.record('readBase64Image', dataUrl); return { metadata: { parameters: 'steps: 30' } }; },
        },
        prompt,
        imageInfo: { openImage: async (source, name) => world.record('openImage', source, name) },
        mainGallery: {
            removeCurrentImage: argument => world.record('removeCurrentImage', argument),
            clearGallery: () => world.record('clearGallery'),
        },
        settingsPersistence: { runEditTransaction: (meta, mutate) => { world.record('transaction', meta); return mutate(); } },
        lora: { flushSlot: value => world.record('flushSlot', value) },
        collapsedTabs: { lora: { setCollapsed: value => world.record('collapsedLora', value) } },
        ...extra,
    };
}

// ------------------------------------------------------------------ menu driver

function menuBoxOf(document) {
    return document.body.querySelector('.right-click-menu');
}

const isItem = node => node.classList.contains('menu-item');
const isSeparator = node => node.classList.contains('menu-separator');

// The menu in the order it renders: an index per entry, '—' for a separator.
function layout(document) {
    const box = menuBoxOf(document);
    if (!box || box.style.display === 'none') return [];
    return box.children.filter(node => isItem(node) || isSeparator(node))
        .map(node => (isSeparator(node) ? '—' : node.dataset.index));
}

function itemsOf(document) {
    const box = menuBoxOf(document);
    return box ? box.children.filter(node => isItem(node)) : [];
}

function itemFor(document, index) {
    return itemsOf(document).find(node => node.dataset.index === index) ?? null;
}

// A right-click: the mousedown that arms the menu, an optional drag or wait, then the
// contextmenu event. An open menu is dismissed first (a user gets there by clicking or
// pressing Escape); `keepOpen` leaves it open to reach the already-open branch.
// `now` moves the whole press later in time, `at` only its contextmenu - a long press.
async function press(document, target, { x = 40, y = 60, move = null, at = 0, now = 0, keepOpen = false } = {}) {
    if (!keepOpen && menuBoxOf(document)?.style.display !== 'none') document.dispatchEvent({ type: 'keydown', key: 'Escape' });
    const clock = Date.now;
    const shift = offset => { Date.now = () => clock.call(Date) + offset; };
    try {
        shift(now);
        document.dispatchEvent({ type: 'mousedown', button: 2, clientX: x, clientY: y });
        if (move) document.dispatchEvent({ type: 'mousemove', clientX: move.x, clientY: move.y });
        shift(now + at);
        const event = { type: 'contextmenu', target, clientX: x, clientY: y, prevented: false, preventDefault() { this.prevented = true; } };
        document.dispatchEvent(event);
        await flush();
        return event;
    } finally {
        Date.now = clock;
    }
}

// A click on a rendered entry, the way the DOM delivers it: up the tree and on to the
// document, where the listener that closes the menu sits.
async function clickNode(node) {
    const event = { type: 'click', bubbles: true, target: node, preventDefault() {}, stopPropagation() {} };
    node.dispatchEvent(event);
    node.ownerDocument.dispatchEvent(event);
    await flush();
}

async function clickItem(document, index) {
    const node = itemFor(document, index);
    assert.ok(node, `menu entry ${index} is on the menu`);
    await clickNode(node);
}

// The accordion under an entry: [menuItem, submenu] are siblings.
function submenuOf(document, index) {
    const node = itemFor(document, index);
    assert.ok(node, `menu entry ${index} is on the menu`);
    const submenu = node.nextSibling;
    assert.equal(submenu?.className, 'menu-submenu', `${index} renders an accordion submenu`);
    return submenu;
}

// ------------------------------------------------------------------ fixtures

function buildField(document, key, { capsules = [], textarea = false } = {}) {
    const view = document.createElement('div');
    view.className = 'tag-capsule-field';
    view.dataset.fieldKey = key;
    document.body.appendChild(view);

    const chips = document.createElement('div');
    chips.className = 'tag-capsule-chips';
    chips.dataset.fieldKey = key;
    view.appendChild(chips);

    const built = { view, chips, chip: new Map() };
    for (const capsule of capsules) {
        const chip = document.createElement('div');
        chip.className = capsule.disabled ? 'tag-capsule-chip is-disabled' : 'tag-capsule-chip';
        chip.dataset.capsuleId = capsule.id;
        const name = document.createElement('span');
        name.className = 'tag-capsule-chip-name';
        name.textContent = capsule.value;
        const toggle = document.createElement('button');
        toggle.className = 'tag-capsule-chip-toggle';
        const remove = document.createElement('button');
        remove.className = 'tag-capsule-chip-remove';
        chip.append(name, toggle, remove);
        chips.appendChild(chip);
        built.chip.set(capsule.id, { chip, toggle, remove });
    }

    if (textarea) {
        const box = new FakeTextArea(document);
        box.className = `myTextbox-prompt-${key}-textarea`;
        box.dataset.fieldKey = key;
        view.appendChild(box);
        built.textarea = box;
    }
    return built;
}

function buildImage(document, containerClass, source = 'data:image/png;base64,AAAA') {
    const container = document.createElement('div');
    container.className = containerClass;
    const img = document.createElement('img');
    img.src = source;
    container.appendChild(img);
    document.body.appendChild(container);
    return { container, img };
}

// ------------------------------------------------------------------ tests

test('a chip carries the tag entries and its field carries the field entries, in one scoped menu', async () => {
    const world = makeWorld();
    await withFakeDom(async document => {
        world.addField('positive', '1girl, smile', { capsules: [{ id: 'a#0', value: '1girl' }, { id: 'b#0', value: 'smile' }] });
        world.addField('negative', 'bad hands', { capsules: [] });
        const field = buildField(document, 'positive', { capsules: [{ id: 'a#0', value: '1girl' }, { id: 'b#0', value: 'smile' }] });
        setupRightClickMenu();

        await press(document, field.chip.get('a#0').chip);
        assert.deepEqual(layout(document), [
            'tag_edit_weight', 'tag_toggle', 'tag_related', '—',
            'tag_move_to', 'tag_copy_to', '—',
            'tag_copy_text', 'tag_remove', '—',
            'field_disable_all', '—', 'field_copy_text', 'field_clear',
        ]);
        // no leading, doubled or trailing separators once scoping thinned the list
        const marks = layout(document);
        assert.notEqual(marks.at(0), '—');
        assert.notEqual(marks.at(-1), '—');
        assert.ok(!marks.some((mark, index) => mark === '—' && marks[index + 1] === '—'));
        // every label came from the language table, none of them from a missing key
        for (const item of itemsOf(document)) {
            assert.ok(item.textContent && item.textContent !== 'undefined', `${item.dataset.index} has a label`);
        }
        assert.equal(itemFor(document, 'tag_edit_weight').textContent, EN.right_menu_edit_weight);
        assert.equal(itemFor(document, 'tag_toggle').textContent, EN.right_menu_disable_tag);
        assert.equal(itemFor(document, 'field_clear').textContent, EN.right_menu_clear_field);
    }, globalsFor(world));
});

test('nothing chip- or field-scoped shows on an image, and the image entries reach their handlers', async () => {
    const world = makeWorld();
    await withFakeDom(async document => {
        world.addField('positive', '1girl', { capsules: [] });
        buildField(document, 'positive', { capsules: [] });
        const image = buildImage(document, 'cg-main-image-container');
        setupRightClickMenu();

        await press(document, image.img);
        assert.deepEqual(layout(document), ['copy_image', 'copy_image_metadata', 'open_image_info', '—', 'remove_current_image']);

        await clickItem(document, 'open_image_info');
        assert.deepEqual(world.took('openImage'), [['data:image/png;base64,AAAA', 'gallery.png']]);
        assert.equal(menuBoxOf(document).style.display, 'none', 'the menu closes behind the click');

        await press(document, image.img);
        await clickItem(document, 'copy_image_metadata');
        assert.deepEqual(world.took('clipboard'), [['steps: 30']]);

        await press(document, image.img);
        await clickItem(document, 'remove_current_image');
        assert.deepEqual(world.took('removeCurrentImage'), [[image.container]]);
    }, globalsFor(world));
});

test('Clear gallery only exists inside the gallery', async () => {
    const world = makeWorld();
    await withFakeDom(async document => {
        world.addField('positive', '1girl', { capsules: [] });
        const field = buildField(document, 'positive', { capsules: [] });
        const gallery = document.createElement('div');
        gallery.className = 'gallery-main-main';
        document.body.appendChild(gallery);
        setupRightClickMenu();

        await press(document, field.view);
        assert.ok(!layout(document).includes('clear_gallery'), 'not on a prompt field');

        await press(document, gallery);
        assert.deepEqual(layout(document), ['clear_gallery']);
        await clickItem(document, 'clear_gallery');
        assert.equal(world.took('clearGallery').length, 1);
    }, globalsFor(world));
});

test('a right-click on a selected chip addresses the whole selection, count and all', async () => {
    const world = makeWorld();
    await withFakeDom(async document => {
        const capsules = [{ id: 'a#0', value: '1girl' }, { id: 'b#0', value: 'smile' }, { id: 'c#0', value: 'blue eyes' }];
        const field = world.addField('positive', '1girl, smile, blue eyes', { capsules });
        world.addField('negative', '', { capsules: [] });
        field.setSelected(['a#0', 'b#0', 'c#0']);
        const built = buildField(document, 'positive', { capsules });
        setupRightClickMenu();

        await press(document, built.chip.get('b#0').chip);
        assert.equal(itemFor(document, 'tag_toggle').textContent, `${EN.right_menu_disable_tag} (3)`);
        assert.equal(itemFor(document, 'tag_move_to').textContent, `${EN.right_menu_move_to} (3)`);
        assert.equal(itemFor(document, 'tag_remove').textContent, `${EN.right_menu_remove_tag} (3)`);

        await clickItem(document, 'tag_toggle');
        assert.deepEqual(world.took('setDisabledFor'), [['positive', ['a#0', 'b#0', 'c#0'], true]]);

        await press(document, built.chip.get('b#0').chip);
        await clickItem(document, 'tag_copy_text');
        assert.deepEqual(world.took('clipboard'), [['1girl, smile, blue eyes']]);

        await press(document, built.chip.get('b#0').chip);
        await clickItem(document, 'tag_remove');
        assert.deepEqual(world.took('removeIds'), [['positive', ['a#0', 'b#0', 'c#0']]]);
    }, globalsFor(world));
});

test('an unselected chip is addressed alone and falls through to the chip\'s own buttons', async () => {
    const world = makeWorld();
    await withFakeDom(async document => {
        const capsules = [{ id: 'a#0', value: '1girl', disabled: true }, { id: 'b#0', value: 'smile' }];
        const field = world.addField('positive', '~1girl, smile', { capsules });
        field.setSelected(['b#0']);          // a different chip is selected
        const built = buildField(document, 'positive', { capsules });
        const toggled = [];
        built.chip.get('a#0').toggle.addEventListener('click', () => toggled.push('toggle'));
        built.chip.get('a#0').remove.addEventListener('click', () => toggled.push('remove'));
        setupRightClickMenu();

        await press(document, built.chip.get('a#0').chip);
        // a disabled chip offers to enable it, with no count for a single tag
        assert.equal(itemFor(document, 'tag_toggle').textContent, EN.right_menu_enable_tag);
        await clickItem(document, 'tag_toggle');
        assert.deepEqual(world.took('setDisabledFor'), [], 'a single chip is not a bulk change');
        assert.deepEqual(toggled, ['toggle'], 'the chip\'s own toggle button is clicked instead');

        await press(document, built.chip.get('a#0').chip);
        await clickItem(document, 'tag_remove');
        assert.deepEqual(toggled, ['toggle', 'remove']);
    }, globalsFor(world));
});

test('Edit weight opens the weight editor for the clicked capsule, and falls back to the chip when the field has none', async () => {
    const world = makeWorld();
    await withFakeDom(async document => {
        const capsules = [{ id: 'a#0', value: '1girl' }];
        world.addField('positive', '1girl', { capsules });
        const built = buildField(document, 'positive', { capsules });
        setupRightClickMenu();

        await press(document, built.chip.get('a#0').chip);
        await clickItem(document, 'tag_edit_weight');
        assert.deepEqual(world.took('editWeight'), [['positive', 'a#0']]);
    }, globalsFor(world));

    const plain = makeWorld();
    await withFakeDom(async document => {
        const capsules = [{ id: 'a#0', value: '1girl' }];
        plain.addField('positive', '1girl', { capsules, editWeight: false });
        const built = buildField(document, 'positive', { capsules });
        const clicked = [];
        built.chip.get('a#0').chip.addEventListener('click', () => clicked.push('chip'));
        setupRightClickMenu();

        await press(document, built.chip.get('a#0').chip);
        await clickItem(document, 'tag_edit_weight');
        assert.deepEqual(plain.took('editWeight'), []);
        assert.deepEqual(clicked, ['chip'], 'the chip opens its own popover instead');
    }, globalsFor(plain));
});

test('Related tags is offered only while a related dictionary is loaded', async () => {
    const world = makeWorld();
    world.set.hasRelated = false;
    await withFakeDom(async document => {
        const capsules = [{ id: 'a#0', value: '1girl' }];
        world.addField('positive', '1girl', { capsules });
        const built = buildField(document, 'positive', { capsules });
        setupRightClickMenu();

        await press(document, built.chip.get('a#0').chip);
        assert.ok(!layout(document).includes('tag_related'));

        world.set.hasRelated = true;
        await clickNode(document.body);                    // close the open menu
        await press(document, built.chip.get('a#0').chip);
        assert.ok(layout(document).includes('tag_related'));
        await clickItem(document, 'tag_related');
        assert.deepEqual(world.took('showRelated'), [['positive', 'a#0']]);
    }, globalsFor(world));
});

test('Move to / Copy to open an accordion of the other fields and transfer the whole selection', async () => {
    const world = makeWorld();
    await withFakeDom(async document => {
        const capsules = [{ id: 'a#0', value: '1girl' }, { id: 'b#0', value: 'smile' }];
        const field = world.addField('positive', '1girl, smile', { capsules });
        world.addField('negative', '', { capsules: [] });
        world.addField('common', '', { capsules: [] });
        const built = buildField(document, 'positive', { capsules });
        setupRightClickMenu();

        await press(document, built.chip.get('a#0').chip);
        const move = itemFor(document, 'tag_move_to');
        assert.ok(move.classList.contains('has-submenu'));
        const submenu = submenuOf(document, 'tag_move_to');
        assert.equal(submenu.hidden, true, 'the accordion starts closed');
        assert.deepEqual(submenu.children.map(node => node.textContent), ['negative label', 'common label'], 'the field itself is not a target');

        await clickNode(move);
        assert.equal(submenu.hidden, false, 'clicking the entry expands it in place');
        assert.ok(move.classList.contains('is-open'));
        assert.notEqual(menuBoxOf(document).style.display, 'none', 'expanding does not close the menu');

        await clickNode(submenu.children[0]);
        assert.deepEqual(world.took('transfer'), [['positive', 'a#0', 'negative', { copy: false }]]);
        assert.equal(menuBoxOf(document).style.display, 'none');

        field.setSelected(['a#0', 'b#0']);
        await press(document, built.chip.get('a#0').chip);
        await clickNode(submenuOf(document, 'tag_move_to').children[1]);
        assert.deepEqual(world.took('transfer').at(-1), ['positive', ['a#0', 'b#0'], 'common', { copy: false }]);

        await press(document, built.chip.get('a#0').chip);
        await clickNode(submenuOf(document, 'tag_copy_to').children[1]);
        assert.deepEqual(world.took('transfer').at(-1), ['positive', ['a#0', 'b#0'], 'common', { copy: true }]);
    }, globalsFor(world));
});

test('with no other field the accordion says so, and the entry cannot be clicked', async () => {
    const world = makeWorld();
    await withFakeDom(async document => {
        const capsules = [{ id: 'a#0', value: '1girl' }];
        world.addField('positive', '1girl', { capsules });
        const built = buildField(document, 'positive', { capsules });
        setupRightClickMenu();

        await press(document, built.chip.get('a#0').chip);
        const submenu = submenuOf(document, 'tag_move_to');
        assert.deepEqual(submenu.children.map(node => node.textContent), [EN.right_menu_no_target]);
        assert.ok(submenu.children[0].classList.contains('is-disabled'));
        await clickNode(submenu.children[0]);
        assert.deepEqual(world.took('transfer'), []);
        assert.notEqual(menuBoxOf(document).style.display, 'none', 'a dead entry does not close the menu');
    }, globalsFor(world));
});

test('a textarea selection moves across fields as text, inside one edit transaction', async () => {
    const world = makeWorld();
    await withFakeDom(async document => {
        world.addField('positive', '1girl, long hair, smile', { capsules: [] });
        world.addField('negative', 'bad hands', { capsules: [] });
        const built = buildField(document, 'positive', { textarea: true });
        built.textarea.value = '1girl, long hair, smile';
        built.textarea.selectionStart = 7;
        built.textarea.selectionEnd = 16;                  // "long hair"
        setupRightClickMenu();

        await press(document, built.textarea);
        assert.ok(layout(document).includes('field_move_selection'));
        assert.equal(itemFor(document, 'field_move_selection').textContent, EN.right_menu_move_selection_to);

        await clickNode(submenuOf(document, 'field_move_selection').children[0]);
        assert.deepEqual(world.took('transaction'), [[{ source: 'move-selection', sections: ['prompt'] }]]);
        assert.equal(world.controls.negative.readValue(), 'bad hands, long hair');
        assert.equal(world.controls.positive.readValue(), '1girl, smile');
    }, globalsFor(world));
});

test('Copy selection leaves the source alone; with nothing selected neither entry is offered', async () => {
    const world = makeWorld();
    await withFakeDom(async document => {
        world.addField('positive', '1girl, long hair', { capsules: [] });
        world.addField('negative', '', { capsules: [] });
        const built = buildField(document, 'positive', { textarea: true });
        built.textarea.value = '1girl, long hair';
        built.textarea.selectionStart = 0;
        built.textarea.selectionEnd = 5;                   // "1girl"
        setupRightClickMenu();

        await press(document, built.textarea);
        await clickNode(submenuOf(document, 'field_copy_selection').children[0]);
        assert.equal(world.controls.negative.readValue(), '1girl');
        assert.equal(world.controls.positive.readValue(), '1girl, long hair', 'a copy leaves the source as it was');

        built.textarea.selectionStart = 4;
        built.textarea.selectionEnd = 4;                   // a caret, not a selection
        await press(document, built.textarea);
        const marks = layout(document);
        assert.ok(!marks.includes('field_move_selection'));
        assert.ok(!marks.includes('field_copy_selection'));
    }, globalsFor(world));
});

test('Send LoRA to Slot only appears where a <lora:…> is, and never on negative / exclude', async () => {
    const world = makeWorld();
    await withFakeDom(async document => {
        world.addField('positive', '1girl, <lora:foo:1>', { capsules: [] });
        world.addField('negative', 'bad, <lora:bar:1>', { capsules: [] });
        world.addField('common', 'plain text', { capsules: [] });
        const positive = buildField(document, 'positive', { capsules: [] });
        const negative = buildField(document, 'negative', { capsules: [] });
        const common = buildField(document, 'common', { capsules: [] });
        setupRightClickMenu();

        await press(document, common.view);
        assert.ok(!layout(document).includes('field_lora_to_slot'), 'no LoRA in the text');
        await press(document, negative.view);
        assert.ok(!layout(document).includes('field_lora_to_slot'), 'negative never sends a LoRA to the slot');

        await press(document, positive.view);
        assert.ok(layout(document).includes('field_lora_to_slot'));
        await clickItem(document, 'field_lora_to_slot');
        assert.deepEqual(world.took('flushSlot'), [['<lora:foo:1>']]);
        assert.equal(world.controls.positive.readValue(), '1girl');
        assert.deepEqual(world.took('collapsedLora'), [[false]]);
        assert.deepEqual(world.took('transaction'), [[{ source: 'send-lora-to-slot', sections: ['prompt', 'lora'] }]]);
    }, globalsFor(world));
});

test('Enable / Disable all follow what the field holds; Copy field and Clear follow its text', async () => {
    const world = makeWorld();
    await withFakeDom(async document => {
        world.addField('positive', '1girl, ~smile', { capsules: [{ id: 'a#0', value: '1girl' }, { id: 'b#0', value: 'smile', disabled: true }] });
        world.addField('negative', '', { capsules: [] });
        const positive = buildField(document, 'positive', { capsules: [] });
        const negative = buildField(document, 'negative', { capsules: [] });
        setupRightClickMenu();

        await press(document, positive.view);
        const marks = layout(document);
        assert.ok(marks.includes('field_enable_all') && marks.includes('field_disable_all'), 'mixed field offers both');
        await clickItem(document, 'field_enable_all');
        assert.deepEqual(world.took('setAllDisabled'), [['positive', false]]);

        await press(document, positive.view);
        await clickItem(document, 'field_copy_text');
        assert.deepEqual(world.took('clipboard'), [['1girl, ~smile']]);

        await press(document, positive.view);
        await clickItem(document, 'field_clear');
        assert.equal(world.controls.positive.readValue(), '');

        await press(document, negative.view);
        const empty = layout(document);
        assert.ok(!empty.includes('field_copy_text'), 'nothing to copy out of an empty field');
        assert.ok(!empty.includes('field_clear'));
        assert.ok(!empty.includes('field_enable_all') && !empty.includes('field_disable_all'), 'no capsules, no bulk switch');
    }, globalsFor(world));
});

// A custom Scene field, not one of the built-in keys: its textarea has to be recognised too.
test('the word under the caret is what the spellcheck suggestions are offered for', async () => {
    const world = makeWorld();
    await withFakeDom(async document => {
        world.addField('custom-1', 'smiel girl', { capsules: [] });
        const built = buildField(document, 'custom-1', { textarea: true });
        built.textarea.value = 'smiel girl';
        built.textarea.selectionStart = 3;
        built.textarea.selectionEnd = 3;                   // inside "smiel"
        setupRightClickMenu();
        assert.equal(typeof world.spellCheck, 'function', 'the main process can answer with suggestions');

        await press(document, built.textarea);
        world.spellCheck(['smile', 'smiled'], 'smiel');    // the answer for a different word is ignored
        world.spellCheck(['nope'], 'girl');
        const indexes = itemsOf(document).map(node => node.dataset.index);
        assert.deepEqual(indexes.slice(0, 3), ['spellcheck_0', 'spellcheck_1', 'spellcheck_add_to_dict'], 'suggestions go on top');
        assert.deepEqual(itemsOf(document).slice(0, 2).map(node => node.textContent), ['smile', 'smiled']);

        await clickItem(document, 'spellcheck_0');
        assert.deepEqual(world.took('replaceMisspelling'), [['smile']]);

        // with text selected it is the selection, not the whole box, that is looked up
        built.textarea.selectionStart = 0;
        built.textarea.selectionEnd = 5;                   // "smiel"
        await press(document, built.textarea);
        world.spellCheck(['whole box'], 'smiel girl');
        assert.ok(!itemsOf(document).some(node => node.dataset.index?.startsWith('spellcheck')), 'an answer for other text is dropped');
        world.spellCheck(['smile'], 'smiel');
        assert.equal(itemsOf(document)[0]?.textContent, 'smile');
    }, globalsFor(world));
});

test('a textarea that is not a prompt field asks for no spellcheck word', async () => {
    const world = makeWorld();
    await withFakeDom(async document => {
        world.addField('positive', '', { capsules: [] });
        buildField(document, 'positive', { capsules: [] });
        const stray = new FakeTextArea(document);
        stray.className = 'some-other-textarea';
        stray.value = 'smiel';
        document.body.appendChild(stray);
        setupRightClickMenu();

        await press(document, stray);
        assert.equal(menuBoxOf(document).style.display, 'none', 'nothing is scoped to a stray textarea');
        world.spellCheck(['smile'], 'smiel');
        assert.deepEqual(itemsOf(document).map(node => node.dataset.index), [], 'and no suggestion is grafted onto a closed menu');
    }, globalsFor(world));
});

test('every early exit of the contextmenu handler leaves the next right-click working (#1)', async () => {
    const world = makeWorld();
    await withFakeDom(async document => {
        const capsules = [{ id: 'a#0', value: '1girl' }];
        world.addField('positive', '1girl', { capsules });
        const built = buildField(document, 'positive', { capsules });
        const chip = built.chip.get('a#0').chip;
        setupRightClickMenu();

        // a drag (the right button held while the pointer moves) suppresses the menu
        await press(document, chip, { move: { x: 200, y: 200 } });
        assert.equal(layout(document).length, 0);
        // ... and the next, still press opens it
        await press(document, chip, { now: 500 });
        assert.ok(layout(document).length > 0, 'the drag did not poison the next press');

        // with the menu open, a second right-click is swallowed and the state reset
        const second = await press(document, chip, { now: 1000, keepOpen: true });
        assert.equal(second.prevented, true);
        await clickNode(document.body);
        // a press that starts later than the swallowed one: only a state left behind makes
        // it look like a long press
        await press(document, chip, { now: 1500 });
        assert.ok(layout(document).length > 0, 'the swallowed press did not poison the next one');

        // a long press is a resize gesture, not a menu
        await press(document, chip, { now: 2000, at: 400 });
        assert.equal(layout(document).length, 0);
        await press(document, chip, { now: 2500 });
        assert.ok(layout(document).length > 0, 'the long press did not poison the next one');
    }, globalsFor(world));
});

test('Escape and a click outside close the menu', async () => {
    const world = makeWorld();
    await withFakeDom(async document => {
        const capsules = [{ id: 'a#0', value: '1girl' }];
        world.addField('positive', '1girl', { capsules });
        const built = buildField(document, 'positive', { capsules });
        setupRightClickMenu();

        await press(document, built.chip.get('a#0').chip);
        document.dispatchEvent({ type: 'keydown', key: 'Escape' });
        assert.equal(menuBoxOf(document).style.display, 'none');

        await press(document, built.chip.get('a#0').chip);
        await clickNode(document.body);
        assert.equal(menuBoxOf(document).style.display, 'none');
    }, globalsFor(world));
});

test('a language change retitles the menu that is rendered next', async () => {
    const world = makeWorld();
    await withFakeDom(async document => {
        const capsules = [{ id: 'a#0', value: '1girl' }];
        world.addField('positive', '1girl', { capsules });
        world.addField('negative', '', { capsules: [] });
        const built = buildField(document, 'positive', { capsules });
        setupRightClickMenu();

        globalThis.globalSettings.language = 'zh-CN';
        globalThis.rightClick.updateLanguage();
        await press(document, built.chip.get('a#0').chip);
        const zh = language['zh-CN'];
        assert.equal(itemFor(document, 'tag_edit_weight').textContent, zh.right_menu_edit_weight);
        assert.equal(itemFor(document, 'tag_related').textContent, zh.right_menu_related_tags);
        assert.equal(itemFor(document, 'tag_toggle').textContent, zh.right_menu_disable_tag);
        assert.equal(itemFor(document, 'tag_move_to').textContent, zh.right_menu_move_to);
        assert.equal(itemFor(document, 'field_copy_text').textContent, zh.right_menu_copy_field);
        assert.equal(itemFor(document, 'field_clear').textContent, zh.right_menu_clear_field);
        assert.equal(submenuOf(document, 'tag_move_to').children[0].textContent, 'negative label');
    }, globalsFor(world));
});

test('the menu box stays inside the window, whatever corner was clicked', async () => {
    const world = makeWorld();
    await withFakeDom(async document => {
        const capsules = [{ id: 'a#0', value: '1girl' }];
        world.addField('positive', '1girl', { capsules });
        const built = buildField(document, 'positive', { capsules });
        setupRightClickMenu();

        await press(document, built.chip.get('a#0').chip, { x: 1270, y: 795 });
        const box = menuBoxOf(document);
        // nothing is laid out here, so the menu falls back to its 200 x 100 estimate
        assert.equal(box.style.left, `${1280 - 200 - 10}px`);
        assert.equal(box.style.top, `${800 - 100 - 10}px`);

        await clickNode(document.body);
        await press(document, built.chip.get('a#0').chip, { x: 20, y: 30 });
        assert.equal(box.style.left, '20px');
        assert.equal(box.style.top, '30px');
    }, globalsFor(world));
});

// --------------------------------------------------- contracts that live outside the menu

test('the capsule field publishes the field key and the drag payload the menu and the drops rely on', () => {
    const field = read('scripts/renderer/components/tagCapsuleField.js');
    assert.match(field, /textbox\.dataset\.fieldKey = key/);
    assert.match(field, /chips\.dataset\.fieldKey = key/);
    assert.match(field, /CAPSULE_MIME = 'application\/x-saa-capsule'/);
    assert.match(field, /event\.dataTransfer\.effectAllowed = 'copyMove'/);
    assert.match(field, /onExternalDrop\?\.\(payload, insertAt, \{ copy: event\.ctrlKey \|\| event\.altKey \}\)/);
    assert.match(field, /JSON\.stringify\(\{ field: key, id: capsules\[dragIndex\]\?\.id \?\? '', ids \}\)/, 'the payload lists every selected capsule');
    assert.match(read('scripts/renderer/components/promptFieldManager.js'), /listFields: \(\) => sceneRows\(\)/, 'move targets follow the Scene order');
});

test('both themes style the accordion submenu and the cross-field drop target', () => {
    for (const theme of ['html/index_dark.css', 'html/index_light.css']) {
        const rules = parseStylesheet(read(theme));
        assert.ok(hasSelector(rules, '.right-click-menu .menu-submenu'), `${theme} has a rule for the submenu`);
        assert.ok(hasSelector(rules, '.right-click-menu .menu-subitem'), `${theme} has a rule for a submenu entry`);
        assert.ok(hasSelector(rules, '.tag-capsule-chips.is-drop-target'), `${theme} has a rule for the drop target`);
    }
});
