import test from 'node:test';
import assert from 'node:assert/strict';

import { assignSlotSide, migrateSlotSides, regionalSlots, slotSide, slotSideLabels, swapSlotSides } from '../scripts/shared/characterSides.js';
import { swapSidesPatch } from '../scripts/shared/regionalSides.js';
import { normalizeSection } from '../scripts/shared/settingsSections.js';

test('slotSide reads left / right and treats anything else as both', () => {
    assert.equal(slotSide({ side: 'left' }), 'left');
    assert.equal(slotSide({ side: 'right' }), 'right');
    assert.equal(slotSide({ side: 'top' }), 'both');
    assert.equal(slotSide({}), 'both');
    assert.equal(slotSide(null), 'both');
});

test('regionalSlots picks the first slot per side with its weight', () => {
    const slots = [
        { key: 'A', weight: 1 },
        { key: 'B', weight: 0.8, side: 'right' },
        { key: 'C', weight: 1.2, side: 'left' },
        { key: 'D', weight: 2, side: 'left' },
    ];
    assert.deepEqual(regionalSlots(slots), {
        left: { index: 2, key: 'C', weight: 1.2 },
        right: { index: 1, key: 'B', weight: 0.8 },
    });
    assert.deepEqual(regionalSlots([]), { left: null, right: null });
    assert.deepEqual(regionalSlots('nope'), { left: null, right: null });
});

test('assignSlotSide gives one slot the side and takes it away from the others', () => {
    const slots = [{ key: 'A', side: 'left' }, { key: 'B', side: 'right' }, { key: 'C' }];
    const moved = assignSlotSide(slots, 2, 'left');
    assert.deepEqual(moved, [{ key: 'A' }, { key: 'B', side: 'right' }, { key: 'C', side: 'left' }]);
    // the input is untouched
    assert.equal(slots[0].side, 'left');
    // "·" clears the slot only
    assert.deepEqual(assignSlotSide(moved, 2, 'both'), [{ key: 'A' }, { key: 'B', side: 'right' }, { key: 'C' }]);
});

test('swapSlotSides flips left and right and leaves both alone', () => {
    assert.deepEqual(swapSlotSides([{ key: 'A', side: 'left' }, { key: 'B' }, { key: 'C', side: 'right' }]),
        [{ key: 'A', side: 'right' }, { key: 'B' }, { key: 'C', side: 'left' }]);
});

test('swapSidesPatch flips the slot sides along with the other pairs', () => {
    const patch = swapSidesPatch({
        character_left: 'A', character_right: 'B',
        character_slots: [{ key: 'A', weight: 1, side: 'left' }, { key: 'B', weight: 1, side: 'right' }],
    });
    assert.equal(patch.character_left, 'B');
    assert.equal(patch.character_right, 'A');
    assert.deepEqual(patch.character_slots, [{ key: 'A', weight: 1, side: 'right' }, { key: 'B', weight: 1, side: 'left' }]);
});

test('migrateSlotSides marks matching slots, adds missing regional characters, keeps sided lists', () => {
    // matching slots take the side
    assert.deepEqual(migrateSlotSides([{ key: 'A', weight: 1 }, { key: 'B', weight: 1 }], 'B', 'A'),
        [{ key: 'A', weight: 1, side: 'right' }, { key: 'B', weight: 1, side: 'left' }]);
    // a regional character that is not a slot becomes one, with the stored regional weight
    assert.deepEqual(migrateSlotSides([{ key: 'A', weight: 1 }], 'A', 'Z', { weights: [1, 0.7] }),
        [{ key: 'A', weight: 1, side: 'left' }, { key: 'Z', weight: 0.7, side: 'right' }]);
    // None on a side adds nothing; the slot cap holds
    assert.deepEqual(migrateSlotSides([{ key: 'A', weight: 1 }], 'None', 'Z', { maxSlots: 1 }), [{ key: 'A', weight: 1 }]);
    // a list that already carries a side is returned as it is
    const sided = [{ key: 'A', weight: 1, side: 'right' }, { key: 'B', weight: 1 }];
    assert.deepEqual(migrateSlotSides(sided, 'B', 'None'), sided);
    // the same key twice: only the first free one takes the side
    assert.deepEqual(migrateSlotSides([{ key: 'A', weight: 1 }, { key: 'A', weight: 1 }], 'A', 'A'),
        [{ key: 'A', weight: 1, side: 'left' }, { key: 'A', weight: 1, side: 'right' }]);
});

test('slotSideLabels follow the split', () => {
    assert.deepEqual(slotSideLabels('left-right'), { left: 'L', right: 'R', both: '·' });
    assert.deepEqual(slotSideLabels(undefined), { left: 'L', right: 'R', both: '·' });
    assert.deepEqual(slotSideLabels('top-bottom'), { left: 'T', right: 'B', both: '·' });
});

test('the prompt section keeps a slot side and drops an invalid one', () => {
    const kept = normalizeSection('prompt', {
        character_slots: [{ key: 'A', weight: 1, side: 'left' }, { key: 'B', weight: 1, side: 'up' }, { key: 'C', weight: 1 }],
    });
    assert.deepEqual(kept.character_slots, [{ key: 'A', weight: 1, side: 'left' }, { key: 'B', weight: 1 }, { key: 'C', weight: 1 }]);
});
