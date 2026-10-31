// Where the LoRAs meet the prompt: a part that carries LoRAs (shared/parts.js), and the
// LoRA marks on a tag chip - the badge of the LoRAs suggested for it and the link mark of
// a trigger word that came in with a LoRA (tagCapsuleChip.js).
import assert from 'node:assert/strict';
import test from 'node:test';

import { applyPartsChange, cleanPart, normalizePartsDoc, partLorasIn } from '../scripts/shared/parts.js';
import { withFakeDom } from './helpers/fakeDom.mjs';

test('a part keeps its LoRAs, whether their trigger words come along, and what another base does', () => {
    const part = cleanPart({ name: 'turnaround', tags: 'multiple views', loras: [{ name: 'CharTurnIL.safetensors', weight: '0.8' }, { name: 'None' }, {}], otherBase: 'use' });
    assert.deepEqual(part.loras, [{ name: 'CharTurnIL.safetensors', weight: 0.8 }]);
    assert.equal(part.loraTriggers, true, 'trigger words come along unless the part says not');
    assert.equal(part.otherBase, 'use');
    assert.deepEqual(cleanPart({ name: 'plain', tags: 'a' }).loras, []);
    assert.equal(cleanPart({ name: 'plain', tags: 'a' }).otherBase, 'skip');
    const doc = applyPartsChange(normalizePartsDoc({}), { action: 'set', entry: { name: 'turnaround', tags: 'multiple views', loras: [{ name: 'CharTurnIL.safetensors', weight: 0.8 }], loraTriggers: false } });
    assert.deepEqual([doc.parts.turnaround.loras.length, doc.parts.turnaround.loraTriggers], [1, false]);
});

test('the LoRAs a prompt\'s parts bring: enabled tokens only, nested parts too, each LoRA once', () => {
    const parts = {
        sheet: { tags: 'parts:turn, white background', loras: [{ name: 'Sheet.safetensors', weight: 0.7 }] },
        turn: { tags: 'turnaround', loras: [{ name: 'CharTurnIL.safetensors', weight: 0.8 }, { name: 'Sheet.safetensors', weight: 1 }] },
        plain: { tags: 'smile', loras: [] },
    };
    const resolve = id => parts[id] ?? null;
    assert.deepEqual(partLorasIn('1girl, parts:sheet, parts:plain', resolve), [
        { name: 'Sheet.safetensors', weight: 0.7, part: 'sheet' },
        { name: 'CharTurnIL.safetensors', weight: 0.8, part: 'turn' },
    ]);
    assert.deepEqual(partLorasIn('1girl, ~parts:sheet', resolve), [], 'a disabled part brings nothing');
    assert.deepEqual(partLorasIn('1girl, smile', resolve), []);
    assert.deepEqual(partLorasIn('parts:missing', resolve), []);
});

test('a chip shows the LoRAs suggested for its tag, and the link of a word a LoRA brought', async () => {
    await withFakeDom(async document => {
        const { createChip, updateChip, renderChips } = await import('../scripts/renderer/components/tagCapsuleChip.js');
        const capsule = { id: 'multiple views#0', value: 'multiple views', weightPlan: null, disabled: false };
        const chip = createChip(capsule, { lora: { suggest: 3, from: false } });
        assert.equal(chip.querySelector('.tag-capsule-chip-lora').textContent, 'LoRA 3');
        assert.equal(chip.querySelector('.tag-capsule-chip-from-lora'), null);
        updateChip(chip, capsule, { lora: { suggest: 0, from: true } });
        assert.equal(chip.querySelector('.tag-capsule-chip-lora'), null, 'nothing left to suggest: no badge');
        assert.ok(chip.classList.contains('is-from-lora'));
        assert.ok(chip.querySelector('.tag-capsule-chip-from-lora'));

        // renderChips asks loraInfo per plain tag (never for a part) and repaints when it changes
        const container = document.createElement('div');
        const asked = [];
        let suggest = 2;
        const capsules = [capsule, { id: 'parts:x#0', value: 'parts:x', weightPlan: null, disabled: false }];
        const options = { loraInfo: value => { asked.push(value); return { suggest, from: false }; }, partInfo: () => ({ exists: true, count: 1 }) };
        renderChips(container, capsules, options);
        assert.deepEqual(asked, ['multiple views']);
        assert.equal(container.querySelector('.tag-capsule-chip-lora').textContent, 'LoRA 2');
        suggest = 1;
        renderChips(container, capsules, options);
        assert.equal(container.querySelector('.tag-capsule-chip-lora').textContent, 'LoRA 1');
    });
});
