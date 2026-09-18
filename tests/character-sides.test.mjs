import test from 'node:test';
import assert from 'node:assert/strict';

import { assignSlotSide, migrateSlotSides, regionalSlots, slotSide, slotSideLabels, swapSlotSides, uniqueSlotSides } from '../scripts/shared/characterSides.js';
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
    // Regional on: a regional character that is not a slot becomes one, with the stored regional weight
    assert.deepEqual(migrateSlotSides([{ key: 'A', weight: 1 }], 'A', 'Z', { weights: [1, 0.7], regional: true }),
        [{ key: 'A', weight: 1, side: 'left' }, { key: 'Z', weight: 0.7, side: 'right' }]);
    // None on a side adds nothing; the slot cap holds
    assert.deepEqual(migrateSlotSides([{ key: 'A', weight: 1 }], 'None', 'Z', { maxSlots: 1, regional: true }), [{ key: 'A', weight: 1 }]);
    // a list that already carries a side is returned as it is
    const sided = [{ key: 'A', weight: 1, side: 'right' }, { key: 'B', weight: 1 }];
    assert.deepEqual(migrateSlotSides(sided, 'B', 'None'), sided);
    // the same key twice: only the first free one takes the side
    assert.deepEqual(migrateSlotSides([{ key: 'A', weight: 1 }, { key: 'A', weight: 1 }], 'A', 'A'),
        [{ key: 'A', weight: 1, side: 'left' }, { key: 'A', weight: 1, side: 'right' }]);
});

test('with Regional off the old regional characters never join the ordinary prompt', () => {
    // pre-side settings: Regional used once, then switched off; the slots are the ordinary characters
    const slots = [{ key: 'Random', weight: 1 }, { key: 'None', weight: 1 }, { key: 'None', weight: 1 }];
    assert.deepEqual(migrateSlotSides(slots, 'hatsune_miku', 'kagamine_rin', { weights: [1.3, 0.9], regional: false }), slots,
        'no slot added, so non-regional generation draws the same characters');
    assert.deepEqual(migrateSlotSides(slots, 'hatsune_miku', 'kagamine_rin'), slots, 'off is the default');
    // a character already among the slots only remembers its side; its weight is the ordinary prompt's
    assert.deepEqual(migrateSlotSides([{ key: 'hatsune_miku', weight: 1 }], 'hatsune_miku', 'kagamine_rin', { weights: [1.3, 0.9] }),
        [{ key: 'hatsune_miku', weight: 1, side: 'left' }]);
});

test('with Regional on the regional image keeps its characters and weights', () => {
    // the matching slot takes the regional weight it was drawn with
    assert.deepEqual(migrateSlotSides([{ key: 'hatsune_miku', weight: 1 }], 'hatsune_miku', 'None', { weights: [1.3, 1], regional: true }),
        [{ key: 'hatsune_miku', weight: 1.3, side: 'left' }]);
    // a full list gives a missing character its first empty side-less slot (alias kept)
    const full = ['A', 'None', 'C', 'D', 'E', 'F'].map(key => ({ key, weight: 1 }));
    full[1].alias = 'hero';
    const migrated = migrateSlotSides(full, 'None', 'Z', { weights: [1, 0.8], regional: true });
    assert.deepEqual(migrated[1], { key: 'Z', weight: 0.8, side: 'right', alias: 'hero' });
    assert.equal(migrated.length, 6);
    // six characters and no empty slot: nothing is overwritten
    const busy = ['A', 'B', 'C', 'D', 'E', 'F'].map(key => ({ key, weight: 1 }));
    assert.deepEqual(migrateSlotSides(busy, 'Z', 'None', { regional: true }), busy);
});

test('a side claimed by two slots stays with the first, the one regionalSlots draws', () => {
    const doubled = [{ key: 'A', weight: 1, side: 'left' }, { key: 'B', weight: 1, side: 'left' }, { key: 'C', weight: 1, side: 'right' }];
    assert.deepEqual(uniqueSlotSides(doubled), [{ key: 'A', weight: 1, side: 'left' }, { key: 'B', weight: 1 }, { key: 'C', weight: 1, side: 'right' }]);
    assert.equal(doubled[1].side, 'left', 'the input is untouched');
    // the load path (migrateSlotSides) hands the side column the de-duplicated list
    assert.deepEqual(migrateSlotSides(doubled, 'None', 'None'), uniqueSlotSides(doubled));
    assert.equal(regionalSlots(uniqueSlotSides(doubled)).left.key, regionalSlots(doubled).left.key);
    assert.deepEqual(uniqueSlotSides(null), []);
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

test('stored settings and presets give a side to one slot only', () => {
    // a hand-edited preset (or a card stored by an older build) with two L slots
    const doubled = normalizeSection('prompt', {
        character_slots: [{ key: 'A', weight: 1, side: 'left' }, { key: 'B', weight: 1, side: 'left' }, { key: 'C', weight: 1, side: 'right' }],
    });
    assert.deepEqual(doubled.character_slots,
        [{ key: 'A', weight: 1, side: 'left' }, { key: 'B', weight: 1 }, { key: 'C', weight: 1, side: 'right' }]);
    assert.equal(regionalSlots(doubled.character_slots).left.key, 'A');
});
