import test from 'node:test';
import assert from 'node:assert/strict';

import { withFakeDom } from './helpers/fakeDom.mjs';
import { myVariableCharacterList } from '../scripts/renderer/components/characterSelectionModal.js';

// A stored character key the current character pack (thumb_select) does not carry stays
// "pending": shown and generated as None, persisted as stored. These drive the real control.

const PACK = { Alice: 'alice_(pack)' };

async function withCharacterList(body) {
    const saved = { globalSettings: globalThis.globalSettings, cachedFiles: globalThis.cachedFiles };
    try {
        await withFakeDom(async document => {
            globalThis.globalSettings = { language: 'en-US', regional_split: 'left-right' };
            globalThis.cachedFiles = { language: { 'en-US': {} }, tagAssist: {}, characterNames: {}, characterWorks: {} };
            const container = document.createElement('div');
            container.className = 'dropdown-character';
            document.body.appendChild(container);
            const written = [];
            let list = null;
            // what callback_myCharacterList_updateThumb persists: the slots as getSlots reports them
            const callback = () => written.push(list.getSlots().map(slot => slot.key));
            list = myVariableCharacterList('dropdown-character', PACK, {}, callback, {
                slotCount: 2,
                labelsFor: count => Array.from({ length: count }, (_, index) => `Character ${index + 1}`),
            });
            await body({ list, written, document });
        });
    } finally {
        Object.assign(globalThis, saved);
    }
}

test('a key the pack cannot resolve is shown as None but persisted as stored', async () => {
    await withCharacterList(({ list }) => {
        list.setSlots([{ key: 'Missing', weight: 1 }, { key: 'Alice', weight: 1 }]);
        assert.deepEqual(list.getKey(), ['None', 'Alice']);
        assert.deepEqual(list.getValue(), ['none', 'alice_(pack)']);
        assert.deepEqual(list.getSlots().map(slot => slot.key), ['Missing', 'Alice']);
    });
});

test('adding or removing a slot keeps the pending key (the rebuild used to write None back)', async () => {
    await withCharacterList(({ list, written }) => {
        list.setSlots([{ key: 'Missing', weight: 1.2 }, { key: 'Alice', weight: 1 }]);
        list.addSlot();
        assert.deepEqual(written.at(-1), ['Missing', 'Alice', 'None'], 'the slot write after + carries the stored key');
        assert.deepEqual(list.getKey(), ['None', 'Alice', 'None'], 'still shown / generated as None');
        assert.equal(list.getSlots()[0].weight, 1.2);
        list.removeSlot();
        assert.deepEqual(written.at(-1), ['Missing', 'Alice']);
        assert.deepEqual(list.getSlots().map(slot => slot.key), ['Missing', 'Alice']);
    });
});

test('a new character list keeps the pending key, and resolves it once the list carries it', async () => {
    await withCharacterList(({ list }) => {
        list.setSlots([{ key: 'Missing', weight: 1 }, { key: 'Alice', weight: 1 }]);
        // the list manager applies an edit that still lacks the key
        list.setOptions([['Alice', 'Bob'], ['alice_(pack)', 'bob_(pack)']], []);
        assert.deepEqual(list.getSlots().map(slot => slot.key), ['Missing', 'Alice']);
        assert.deepEqual(list.getKey(), ['None', 'Alice']);
        // ... then one that adds it: the slot shows the character again
        list.setOptions([['Alice', 'Missing'], ['alice_(pack)', 'missing_(pack)']], []);
        assert.deepEqual(list.getKey(), ['Missing', 'Alice']);
        assert.deepEqual(list.getValue(), ['missing_(pack)', 'alice_(pack)']);
        assert.deepEqual(list.getSlots().map(slot => slot.key), ['Missing', 'Alice']);
    });
});

test('an explicit None for the slot replaces the pending key', async () => {
    await withCharacterList(({ list, written }) => {
        list.setSlots([{ key: 'Missing', weight: 1 }]);
        assert.deepEqual(list.getSlots().map(slot => slot.key), ['Missing']);
        // an explicit None through updateDefaults (a preset / undo writing None) clears it too
        list.updateDefaults('None');
        assert.deepEqual(list.getSlots().map(slot => slot.key), ['None']);
        list.addSlot();
        assert.deepEqual(written.at(-1), ['None', 'None']);
    });
});

test('a card with two slots on the same side arrives with one of them checked', async () => {
    // one slot per region: a stored model-type card or a hand-edited preset could put two
    // slots on L, and only the first one is ever drawn (regionalSlots)
    await withCharacterList(({ list }) => {
        list.setSlots([{ key: 'Alice', weight: 1, side: 'left' }, { key: 'Missing', weight: 1, side: 'left' }]);
        assert.deepEqual([list.getSide(0), list.getSide(1)], ['left', 'both']);
        assert.deepEqual(list.getSlots().map(slot => slot.side ?? 'both'), ['left', 'both']);
        assert.deepEqual(list.getSlots().map(slot => slot.key), ['Alice', 'Missing'], 'only the side is dropped');
    });
});
