// The LoRA card's line on the positive prompt (shared/slotLoraLine.js): a run adds it after
// the prompt, and a Batch (Last) run swaps the last run's line for the card as it is now.
import assert from 'node:assert/strict';
import test from 'node:test';

import { swapSlotLoras, withSlotLoras } from '../scripts/shared/slotLoraLine.js';

const A = '<lora:a.safetensors:0.8:0.8>';
const B = '<lora:b.safetensors:1:1>';

test('a run puts the LoRA line after the prompt, and none when the card is empty', () => {
    assert.equal(withSlotLoras('1girl, solo', A + B), `1girl, solo\n${A}${B}`);
    assert.equal(withSlotLoras('1girl, solo', ''), '1girl, solo');
});

test('Batch (Last): a LoRA switched off since is not sent, one added since is', () => {
    const last = withSlotLoras('1girl, solo', A + B);
    assert.equal(swapSlotLoras(last, A + B, A), `1girl, solo\n${A}`, 'B switched off');
    assert.equal(swapSlotLoras(last, A + B, ''), '1girl, solo', 'every LoRA off');
    assert.equal(swapSlotLoras('1girl, solo', '', B), `1girl, solo\n${B}`, 'a first LoRA after a run without any');
    assert.equal(swapSlotLoras(last, A + B, '<lora:a.safetensors:0.4:0.4>'), '1girl, solo\n<lora:a.safetensors:0.4:0.4>', 'a new weight');
});

test('a <lora:…> written in the prompt itself stays; only the card\'s line is swapped', () => {
    const last = withSlotLoras(`1girl, ${B}, solo`, A);
    assert.equal(swapSlotLoras(last, A, ''), `1girl, ${B}, solo`);
});

test('a prompt kept from before the line was recorded: a last line of LoRA tags alone is taken for it', () => {
    assert.equal(swapSlotLoras(`1girl, solo\n${A}${B}`, undefined, A), `1girl, solo\n${A}`);
    assert.equal(swapSlotLoras('1girl, solo', undefined, A), `1girl, solo\n${A}`);
    assert.equal(swapSlotLoras(`1girl\n${A}, smile`, undefined, ''), `1girl\n${A}, smile`, 'a line with more than tags is the prompt\'s');
});
