// Multi-selection on the chip row (Ctrl/Shift+click, Ctrl+A), group move / transfer /
// remove / toggle, the context menu acting on the selection, the visible enable
// dot, and the Fields editor's side blocks with drag-and-drop ordering.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
    insertionIndexFromRects,
    moveCapsule,
    moveCapsuleBlock,
    moveCapsules,
    parsePromptToCapsules,
    reorderIndex,
    removeCapsules,
    serializeCapsules,
    setCapsulesDisabled,
    transferCapsules,
} from '../scripts/renderer/components/tagCapsuleLogic.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8').replace(/\r\n/g, '\n');

test('moveCapsules moves the selection as one block, relative order kept', () => {
    const capsules = parsePromptToCapsules('a, b, c, d, e');
    const ids = [capsules[1].id, capsules[3].id];
    assert.equal(serializeCapsules(moveCapsules(capsules, ids, 0)), 'b, d, a, c, e');
    assert.equal(serializeCapsules(moveCapsules(capsules, ids, 2)), 'a, b, d, c, e', 'before the anchor chip');
    assert.equal(serializeCapsules(moveCapsules(capsules, ids, 5)), 'a, c, e, b, d', 'to the end');
    // `to` is an insertion slot: right before a selected chip, the block lands before the
    // next unselected one (it used to be a no-op, so a drop there silently did nothing)
    assert.equal(serializeCapsules(moveCapsules(capsules, ids, 1)), 'a, b, d, c, e', 'before a selected chip');
    assert.equal(serializeCapsules(moveCapsules(capsules, ids, 3)), 'a, c, b, d, e', 'before the second selected chip');
    const block = [capsules[1].id, capsules[2].id];
    assert.equal(moveCapsules(capsules, block, 2), capsules, 'a drop inside a contiguous block changes nothing');
    assert.equal(moveCapsules(capsules, [], 0), capsules);
});

test('a drop onto the chip row inserts where the pointer is (before / after by midpoint, blank = row end)', () => {
    // two rows: a b c on the first (y 0-20), d e on the second (y 30-50); each chip 40px wide at 50px pitch
    const rect = (row, column) => ({ top: row * 30, bottom: row * 30 + 20, left: column * 50, width: 40 });
    const rects = [rect(0, 0), rect(0, 1), rect(0, 2), rect(1, 0), rect(1, 1)];
    assert.equal(insertionIndexFromRects(rects, 5, 10), 0, 'left half of the first chip');
    assert.equal(insertionIndexFromRects(rects, 35, 10), 1, 'right half of the first chip');
    assert.equal(insertionIndexFromRects(rects, 400, 10), 3, 'blank space after the first row: that row ends');
    assert.equal(insertionIndexFromRects(rects, 5, 25), 3, 'the gap between rows: start of the next row');
    assert.equal(insertionIndexFromRects(rects, 5, 40), 3, 'left half of the first chip on the second row');
    assert.equal(insertionIndexFromRects(rects, 400, 40), 5, 'blank space after the last chip: the end');
    assert.equal(insertionIndexFromRects(rects, 5, 80), 5, 'below every row: the end');
    assert.equal(insertionIndexFromRects([], 5, 5), 0, 'an empty row');

    // one chip dragged within its row: the slot index still counts the chip itself
    const capsules = parsePromptToCapsules('a, b, c, d');
    const reorder = (from, insertAt) => serializeCapsules(moveCapsule(capsules, from, reorderIndex(from, insertAt)));
    assert.equal(reorder(1, 1), 'a, b, c, d', 'left half of itself');
    assert.equal(reorder(1, 2), 'a, b, c, d', 'right half of itself');
    assert.equal(reorder(1, 4), 'a, c, d, b', 'to the end');
    assert.equal(reorder(3, 0), 'd, a, b, c', 'to the front');
    assert.equal(reorder(0, 2), 'b, a, c, d', 'after the next chip');

    // a selection moved by drop keeps exactly the moved chips selected, not every chip of the same name
    const named = parsePromptToCapsules('smile, hat, smile, cat');
    const moved = moveCapsuleBlock(named, [named[2].id, named[3].id], 0);
    assert.equal(serializeCapsules(moved.capsules), 'smile, cat, smile, hat');
    assert.deepEqual(moved.ids, [moved.capsules[0].id, moved.capsules[1].id]);
    assert.notEqual(moved.ids[0], moved.capsules[2].id, 'the other "smile" is not part of the block');
});

test('transferCapsules moves several capsules into another field with plans and disabled state', () => {
    const source = parsePromptToCapsules('1girl, ~(long hair:1.20), smile, hat');
    const target = parsePromptToCapsules('blue sky');
    const ids = [source[1].id, source[3].id];
    const moved = transferCapsules(source, target, ids, { at: 1 });
    assert.equal(serializeCapsules(moved.source), '1girl, smile');
    assert.equal(serializeCapsules(moved.target), 'blue sky, ~(long hair:1.20), hat');
    assert.deepEqual(moved.moved.map(capsule => capsule.value), ['long hair', 'hat']);
    const copied = transferCapsules(source, target, ids, { copy: true });
    assert.equal(copied.source, source);
    assert.equal(serializeCapsules(copied.target), 'blue sky, ~(long hair:1.20), hat');
    assert.deepEqual(transferCapsules(source, target, ['nope']).moved, []);
});

test('removeCapsules / setCapsulesDisabled act on the selected ids only', () => {
    const capsules = parsePromptToCapsules('a, b, c');
    assert.equal(serializeCapsules(removeCapsules(capsules, [capsules[0].id, capsules[2].id])), 'b');
    assert.equal(removeCapsules(capsules, ['x']), capsules);
    assert.equal(serializeCapsules(setCapsulesDisabled(capsules, [capsules[1].id], true)), 'a, ~b, c');
    assert.equal(serializeCapsules(setCapsulesDisabled(setCapsulesDisabled(capsules, [capsules[1].id], true), [capsules[0].id, capsules[1].id], 'toggle')), '~a, b, c');
});

test('the chip row keeps a selection: Ctrl/Shift+click, Ctrl+A, Escape, Delete, group drag', () => {
    const field = read('scripts/renderer/components/tagCapsuleField.js');
    assert.match(field, /const selectedIds = new Set\(\);/);
    assert.match(field, /if \(event\.ctrlKey \|\| event\.metaKey\) \{\s*toggleSelected\(index\);/);
    assert.match(field, /if \(event\.shiftKey\) \{\s*selectRange\(index\);/);
    assert.match(field, /event\.key\.toLowerCase\(\) === 'a' && !onAdd/, 'Ctrl+A selects every chip');
    assert.match(field, /event\.key === 'Escape' && selectedIds\.size > 0/);
    assert.match(field, /selectedIds\.size > 1 && selectedIds\.has\(capsules\[focusIndex\]\?\.id\)/, 'Delete removes the selection');
    assert.match(field, /moveCapsuleBlock\(capsules, selectionIds\(\), insertAt\)/, 'a selected chip drags the block to the insertion point');
    assert.match(field, /setSelection\(moved\.ids\)/, 'the moved block stays selected by position, not by name');
    assert.match(field, /function insertionIndexAt\(x, y\)/, 'the drop point comes from the pointer, not the chip dropped on');
    assert.match(field, /return insertionIndexFromRects\(rects, x, y\);/);
    assert.match(field, /const to = reorderIndex\(from, insertAt\);/);
    // a move into another field re-renders this row before `dragend`: a document drop ends the drag here too
    assert.match(field, /document\.addEventListener\('drop', onDocumentDrop, true\);/);
    assert.match(field, /document\.removeEventListener\('drop', onDocumentDrop, true\);/);
    assert.match(field, /className: 'tag-capsule-drop-marker'/, 'a marker shows where the drop lands');
    assert.match(field, /source: 'capsule-drag', sections: \['prompt'\]/, 'a drop is one undo step');
    assert.match(field, /chip\.classList\.toggle\('is-selected', selectedIds\.has\(capsules\[index\]\?\.id\)\)/);
    for (const name of ['getSelectedIds: selectionIds', 'setSelection,', 'clearSelection,', 'removeIds: ids =>', 'setDisabledFor: (ids, disabled) =>']) {
        assert.ok(field.includes(name), `field api exposes ${name}`);
    }
    assert.match(field, /const many = Array\.isArray\(capsuleId\);/, 'set.transfer takes an id list');
    // the enable dot on a selected chip flips the whole selection
    assert.match(field, /setCapsulesDisabled\(capsules, ids, !capsules\[index\]\.disabled\) : toggleCapsuleDisabled\(capsules, index\)/);
});

test('the enable dot, the disabled look, the selection and the editor blocks are styled in both themes', () => {
    for (const file of ['html/index_dark.css', 'html/index_light.css']) {
        const css = read(file);
        // the whole left end of the chip is the toggle; the dot inside it shows the state
        assert.match(css, /\.tag-capsule-chip-toggle \{[^}]*width: 22px;[^}]*height: 100%;/, `${file}: toggle block`);
        assert.match(css, /\.tag-capsule-chip-toggle::before \{[^}]*width: 9px;[^}]*height: 9px;/, `${file}: dot size`);
        assert.match(css, /\.tag-capsule-drop-marker \{/, `${file}: drop marker`);
        assert.match(css, /\.tag-capsule-chip\.is-disabled \{[^}]*opacity: 0\.5;/, `${file}: disabled chip`);
        assert.match(css, /\.tag-capsule-chip\.is-disabled \.tag-capsule-chip-name \{[^}]*line-through/, `${file}: struck name`);
        assert.equal((css.match(/^\.tag-capsule-chip-toggle \{/gm) ?? []).length, 1, `${file}: one dot rule`);
        assert.match(css, /\.tag-capsule-chip\.is-selected \{/, `${file}: selection`);
    }
    assert.match(read('html/index.css'), /\.scene-side \{/, 'Scene side box');
});

test('every row of the Prompts field list (LEFT / RIGHT included) accepts a dragged capsule or selection', () => {
    const manager = read('scripts/renderer/components/promptFieldManager.js');
    assert.match(manager, /attachCapsuleDropTarget\(header, id\);/, 'wired on every Scene row header');
    assert.match(manager, /const CAPSULE_MIME = 'application\/x-saa-capsule';/, 'same payload as the chip rows');
    assert.match(manager, /const what = Array\.isArray\(payload\.ids\) && payload\.ids\.length > 1 \? payload\.ids : payload\.id;/);
    assert.match(manager, /tagCapsuleFields\?\.transfer\?\.\(payload\.field, what, fieldId, \{ copy: event\.ctrlKey \|\| event\.altKey \}\)/);
    assert.match(manager, /if \(!payload\?\.field \|\| !payload\?\.id \|\| payload\.field === fieldId\) return;/, 'a drop on its own row is a no-op');
    assert.match(read('html/index.css'), /\.prompt-scene \.tag-field-header\.is-drop-target \{/, 'drop highlight');
});

test('a Refine snapshot used as the prompt override never re-introduces disabled tags', () => {
    const bridge = read('scripts/renderer/tools/promptBatchExpansion.js');
    assert.match(bridge, /return stripDisabledTags\(activeOverride\.fields\[key\]\);/);
    assert.match(bridge, /return stripDisabledTags\(globalThis\.prompt\?\.\[key\]\?\.getValue\?\.\(\) \?\? ''\);/);
});

test('Scene rows are ordered by drag; a drop into a LEFT / RIGHT box sets the side while Regional is on', () => {
    const manager = read('scripts/renderer/components/promptFieldManager.js');
    assert.match(manager, /const UNIT_MIME = 'application\/x-saa-field-unit';/);
    assert.match(manager, /function placeUnit\(orderKey, id, \{ beforeId = null, side = 'both', zone = null \} = \{\}\)/);
    assert.match(manager, /if \(custom && isRegional\(\)\) \{\s*if \(side === 'both'\) delete custom\.side; else custom\.side = side;/, 'a drop into another box changes the side');
    // the grip arms the row's native drag; chip drags bubbling through the row are left alone
    assert.match(manager, /container\.draggable = true;/);
    assert.match(manager, /if \(!container \|\| container !== armed \|\| event\.target\.closest\('\.tag-capsule-chip'\)\) return;/);
    assert.match(manager, /setText\(box\.querySelector\('\.scene-side-name'\), sideLabel\(side, SETTINGS\.regional_split\)\);/, 'box names read TOP / BOTTOM for a top-bottom split');
    // pinned side built-ins and Exclude never move
    assert.match(manager, /const PINNED_UNITS = new Set\(\['positive_right', 'negative_left', 'negative_right', 'exclude'\]\);/);
});
