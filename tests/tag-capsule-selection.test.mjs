// Multi-selection on the chip row (Ctrl/Shift+click, Ctrl+A), group move / transfer /
// remove / toggle, the context menu acting on the selection, the visible enable
// dot, and the Fields editor's side blocks with drag-and-drop ordering.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
    moveCapsules,
    parsePromptToCapsules,
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
    assert.equal(moveCapsules(capsules, ids, 1), capsules, 'dropping on a selected chip is a no-op');
    assert.equal(moveCapsules(capsules, [], 0), capsules);
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
    assert.match(field, /moveCapsules\(capsules, selectionIds\(\), target < 0 \? capsules\.length : target\)/, 'a selected chip drags the block');
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
        assert.match(css, /\.tag-capsule-chip-toggle \{[^}]*width: 9px;[^}]*height: 9px;/, `${file}: dot size`);
        assert.match(css, /\.tag-capsule-chip\.is-disabled \{[^}]*opacity: 0\.5;/, `${file}: disabled chip`);
        assert.match(css, /\.tag-capsule-chip\.is-disabled \.tag-capsule-chip-name \{[^}]*line-through/, `${file}: struck name`);
        assert.equal((css.match(/^\.tag-capsule-chip-toggle \{/gm) ?? []).length, 1, `${file}: one dot rule`);
        assert.match(css, /\.tag-capsule-chip\.is-selected \{/, `${file}: selection`);
        assert.match(css, /\.prompt-field-editor-block\.is-left \{/, `${file}: editor side block`);
    }
});

test('every row of the Prompts field list (LEFT / RIGHT included) accepts a dragged capsule or selection', () => {
    const manager = read('scripts/renderer/components/promptFieldManager.js');
    assert.match(manager, /attachCapsuleDropTarget\(row, entry\.id\);/, 'wired on every field row');
    assert.match(manager, /const CAPSULE_MIME = 'application\/x-saa-capsule';/, 'same payload as the chip rows');
    assert.match(manager, /const what = Array\.isArray\(payload\.ids\) && payload\.ids\.length > 1 \? payload\.ids : payload\.id;/);
    assert.match(manager, /tagCapsuleFields\?\.transfer\?\.\(payload\.field, what, fieldId, \{ copy: event\.ctrlKey \|\| event\.altKey \}\)/);
    assert.match(manager, /if \(!payload\?\.field \|\| !payload\?\.id \|\| payload\.field === fieldId\) return;/, 'a drop on its own row is a no-op');
    for (const file of ['html/index_dark.css', 'html/index_light.css']) {
        assert.match(read(file), /\.prompt-field-list-row\.is-drop-target \{/, `${file}: drop highlight`);
    }
});

test('a Refine snapshot used as the prompt override never re-introduces disabled tags', () => {
    const bridge = read('scripts/renderer/tools/promptBatchExpansion.js');
    assert.match(bridge, /return stripDisabledTags\(activeOverride\.fields\[key\]\);/);
    assert.match(bridge, /return stripDisabledTags\(globalThis\.prompt\?\.\[key\]\?\.getValue\?\.\(\) \?\? ''\);/);
});

test('the Fields editor lists BOTH SIDES / LEFT / RIGHT blocks while Regional is on and orders rows by drag', () => {
    const manager = read('scripts/renderer/components/promptFieldManager.js');
    assert.match(manager, /const UNIT_MIME = 'application\/x-saa-field-unit';/);
    assert.match(manager, /function placeUnit\(orderKey, id, \{ beforeId = null, blockIds = \[\], side = null \} = \{\}\)/);
    assert.match(manager, /if \(custom && side && isRegional\(\)\) \{\s*if \(side === 'both'\) delete custom\.side; else custom\.side = side;/, 'a drop into another block changes the side');
    assert.match(manager, /row\.draggable = true;/);
    assert.match(manager, /head\.textContent = side === 'both' \? 'BOTH SIDES' : side\.toUpperCase\(\);/);
    assert.match(manager, /block\.className = `prompt-field-editor-block is-\$\{side\}`;/);
    assert.match(manager, /if \(!regional\) \{\s*for \(const id of order\) list\.appendChild\(buildEditorRow\(orderKey, id, false\)\);/, 'one flat list with Regional off');
    assert.match(manager, /function editorSideOf\(id\) \{[\s\S]*id === 'positive' \|\| id === 'negative'\) return 'both';/);
});
