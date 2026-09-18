// The JSON slot (slots/myJsonSlot.js) on the in-memory DOM: what a loaded dictionary
// becomes, what one row reports to the generators, and where that row lands in the
// prompt they build. The row is an array - [prompt, strength, regional, position] -
// and generate.js / generate_regional.js destructure it in that order.
import assert from 'node:assert/strict';
import test from 'node:test';

import { getPrompts } from '../scripts/renderer/generate_regional.js';
import { withFakeDom } from './helpers/fakeDom.mjs';

// the textbox measures itself on a timer that outlives the fake document
globalThis.getComputedStyle = () => ({ lineHeight: '20px' });

const flush = () => new Promise(resolve => setTimeout(resolve, 0));
const asFile = (name, text) => ({ name, arrayBuffer: async () => new TextEncoder().encode(text).buffer });

// setupJsonSlot keeps one manager per module, so every test gets its own copy of the module
let moduleCase = 0;

async function withJsonSlot(body) {
    moduleCase += 1;
    const warnings = [];
    const realError = console.error;
    console.error = (...args) => warnings.push(args.join(' '));
    try {
        return await withFakeDom(async document => {
            const field = value => ({ getValue: () => value });
            globalThis.globalSettings = { language: 'en-US', css_style: 'dark' };
            globalThis.cachedFiles = { language: { 'en-US': {} } };
            globalThis.imageInfo = { showOverlay() {} };
            globalThis.overlay = { custom: { createCustomOverlay: (...args) => { globalThis.overlay.custom.calls.push(args); }, calls: [] } };
            globalThis.prompt = {
                common: field(''), positive: field('1girl'), positive_right: field('1boy'),
                exclude: field(''), background: field(''), style: field(''),
            };
            globalThis.lora = { getValues: () => [] };

            const container = document.createElement('div');
            container.className = 'json-slot';
            document.body.appendChild(container);

            const { setupJsonSlot } = await import(`../scripts/renderer/slots/myJsonSlot.js?case=${moduleCase}`);
            const manager = setupJsonSlot('json-slot');
            globalThis.jsonlist = manager;
            return body({ document, container, manager, warnings });
        }, {
            localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
            getComputedStyle: () => ({ lineHeight: '20px' }),
        });
    } finally {
        console.error = realError;
    }
}

// The dictionary a file carries becomes one row; the row's four controls are reached
// through the manager the way its own getValue does.
async function addRow(manager, dictionary, type = 'application/json') {
    const text = type === 'application/json' ? JSON.stringify(dictionary) : dictionary;
    await manager.addJsonSlotFromFile(asFile(`slot.${type === 'text/csv' ? 'csv' : 'json'}`, text), type);
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

test('a JSON file becomes one row: its prompt, a strength, a side and a position', async () => {
    await withJsonSlot(async ({ container, manager }) => {
        const row = await addRow(manager, { red: 'red dress', blue: 'blue dress' });

        assert.equal(manager.getSlots().length, 1);
        assert.equal(container.querySelectorAll('.content-row').length, 1);
        assert.equal(container.querySelectorAll('.add-row').length, 1, 'a fresh + row waits under it');

        row.set('json_name', 'red');
        assert.deepEqual(manager.getValues(), [['red dress', '1.0', 'Both', 'Off']]);

        row.set('json_strength', '0.8').set('json_regional', 'Left').set('json_position', 'EOP');
        assert.deepEqual(manager.getValues(), [['red dress', '0.8', 'Left', 'EOP']]);
    });
});

test('flush keeps the dictionary with the row, and reload rebuilds the same rows from it', async () => {
    await withJsonSlot(async ({ manager }) => {
        const row = await addRow(manager, { red: 'red dress', blue: 'blue dress' });
        row.set('json_name', 'blue').set('json_strength', '1.2').set('json_position', 'BOC');

        const [stored] = manager.flush();
        assert.deepEqual(stored.slice(0, 4), ['blue', '1.2', 'Both', 'BOC'], 'settings keep the key, not the text behind it');
        assert.deepEqual(JSON.parse(decodeURIComponent(atob(stored[4]))), { red: 'red dress', blue: 'blue dress' });

        manager.reload();
        await flush();
        assert.equal(manager.getSlots().length, 1, 'the row was rebuilt, not doubled');
        assert.deepEqual(manager.getValues(), [['blue dress', '1.2', 'Both', 'BOC']]);
    });
});

test('a CSV becomes name -> tags, quotes dropped and the rest of the line joined', async () => {
    await withJsonSlot(async ({ manager }) => {
        const csv = ['red,"red dress", smile', 'plain,one', 'empty,', ',orphan'].join('\n');
        const row = await addRow(manager, csv, 'text/csv');

        row.set('json_name', 'red');
        assert.deepEqual(manager.getValues(), [['red dress, smile', '1.0', 'Both', 'Off']]);
        row.set('json_name', 'plain');
        assert.equal(manager.getValues()[0][0], 'one');
        row.set('json_name', 'empty');
        assert.equal(manager.getValues()[0][0], '', 'a key with no tags is kept as a blank entry');

        const dictionary = manager.slotIndex.get(row.className).jsonObj;
        assert.deepEqual(Object.keys(dictionary), ['red', 'plain', 'empty'], 'a line with no key is dropped');
    });
});

test('a file the slot cannot read adds no row at all', async () => {
    await withJsonSlot(async ({ manager, warnings }) => {
        await manager.addJsonSlotFromFile(asFile('notes.txt', 'red, blue'), 'text/plain');
        await manager.addJsonSlotFromFile(asFile('broken.json', '{ not json'), 'application/json');
        await manager.addJsonSlotFromFile(asFile('empty.csv', '\n'), 'text/csv');
        await flush();

        assert.equal(manager.getSlots().length, 0);
        assert.equal(warnings.length, 3, 'each one is reported');
    });
});

test('Random takes one of the entries, Enumerate walks them in loop order', async () => {
    await withJsonSlot(async ({ manager }) => {
        const dictionary = { a: 'tag a', b: 'tag b', c: 'tag c' };
        const row = await addRow(manager, dictionary);

        // Random is the name a fresh row starts on
        for (let attempt = 0; attempt < 20; attempt++) {
            assert.ok(Object.values(dictionary).includes(manager.getValues()[0][0]));
        }

        row.set('json_name', '___Enumerate___');
        assert.deepEqual([0, 1, 2, 3, 4].map(loop => manager.getValues(loop)[0][0]),
            ['tag a', 'tag b', 'tag c', 'tag a', 'tag b'], 'the batch walks the dictionary and wraps');
        assert.ok(Object.values(dictionary).includes(manager.getValues(-1)[0][0]),
            'outside a batch there is no loop to follow, so it draws one');
    });
});

test('deleting a row takes its controls with it', async () => {
    await withJsonSlot(async ({ container, manager }) => {
        const first = await addRow(manager, { a: 'tag a' });
        const second = await addRow(manager, { b: 'tag b' });
        second.set('json_name', 'b');
        assert.equal(manager.getSlots().length, 2);

        const del = container.querySelector(`.${manager.slotIndex.get(first.className).itemClasses.delete}`);
        container.dispatchEvent({ type: 'click', target: del, bubbles: false, preventDefault() {}, stopPropagation() {} });

        assert.deepEqual(manager.getSlots(), [second.className]);
        assert.deepEqual(manager.getValues(), [['tag b', '1.0', 'Both', 'Off']]);
        assert.equal(container.querySelectorAll('.content-row').length, 1);
        assert.equal([...manager.componentInstances.keys()].some(key => key.startsWith(first.className)), false);
    });
});

test('the Info button shows the entry behind the name, weighted when the strength is not 1', async () => {
    await withJsonSlot(async ({ container, manager }) => {
        const row = await addRow(manager, { red: 'red dress' });
        const info = container.querySelector('.slot-action-info');
        const click = () => container.dispatchEvent({ type: 'click', target: info, bubbles: false, preventDefault() {}, stopPropagation() {} });

        click();
        assert.deepEqual(globalThis.overlay.custom.calls, [], 'Random has no single entry to show');

        row.set('json_name', 'red');
        click();
        assert.equal(globalThis.overlay.custom.calls.at(-1)[1], '\n\nred\nred dress');
        row.set('json_strength', '0.8');
        click();
        assert.equal(globalThis.overlay.custom.calls.at(-1)[1], '\n\nred\n(red dress:0.8)');
    });
});

test('typing a minus in the Strength box does not throw', async () => {
    await withJsonSlot(async ({ container, manager }) => {
        await addRow(manager, { red: 'red dress' });
        const strength = container.querySelector('.numeric-input');
        assert.ok(strength, 'the Strength box is the row\'s number input');

        // the row's own keydown guard read an undeclared cursorPos: a ReferenceError
        // on every "-" typed into the box
        for (const key of ['-', '.', '5', 'a', 'Backspace']) {
            strength.dispatchEvent({ type: 'keydown', key, target: strength, bubbles: true, preventDefault() {}, stopPropagation() {} });
        }
    });
});

// ---------------------------------------------- what the generators do with such a row

// the regional generator is the one that exports its prompt builder; it reads the rows
// off globalThis.jsonlist, which is the manager under test
const regionalPrompts = () => getPrompts('alice, ', 'bob, ', '', '', 'ComfyUI', -1, 0);

test('the position column decides where the row lands, and Off sends nothing', async () => {
    await withJsonSlot(async ({ manager }) => {
        const row = await addRow(manager, { red: 'red dress' });
        row.set('json_name', 'red');

        const off = regionalPrompts();
        assert.equal(off.posL, 'alice, 1girl', 'an Off row is skipped');

        row.set('json_position', 'BOP');
        assert.equal((regionalPrompts()).posL, 'red dress, alice, 1girl');
        row.set('json_position', 'BOC');
        assert.equal((regionalPrompts()).posL, 'red dress, alice, 1girl');
        row.set('json_position', 'EOC');
        assert.equal((regionalPrompts()).posL, 'alice, red dress, 1girl');
        row.set('json_position', 'EOP');
        assert.equal((regionalPrompts()).posL, 'alice, 1girl, red dress, ', 'an end-of-prompt row keeps its own trailing separator');
    });
});

test('the Regional column sends the row to one side only, and a weight wraps it', async () => {
    await withJsonSlot(async ({ manager }) => {
        const row = await addRow(manager, { red: 'red dress' });
        row.set('json_name', 'red').set('json_position', 'BOP').set('json_regional', 'Right');

        const right = regionalPrompts();
        assert.equal(right.posL, 'alice, 1girl', 'the left side never sees it');
        assert.equal(right.posR, 'red dress, bob, 1boy');

        row.set('json_strength', '1.2');
        assert.equal((regionalPrompts()).posR, '(red dress:1.2), bob, 1boy');
    });
});

test('a blank entry leaves the prompt alone instead of writing a stray comma', async () => {
    await withJsonSlot(async ({ manager }) => {
        const row = await addRow(manager, { nothing: '   ' });
        row.set('json_name', 'nothing').set('json_position', 'BOP');

        assert.deepEqual(manager.getValues(), [['   ', '1.0', 'Both', 'BOP']]);
        assert.equal((regionalPrompts()).posL, 'alice, 1girl');
    });
});
