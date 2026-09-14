import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { PROMPT_PLAN_KEYS, PROMPT_TEXT_KEYS, clearedPromptPatch } from '../scripts/shared/promptReset.js';
import { SECTION_KEYS } from '../scripts/shared/settingsSections.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

test('clearedPromptPatch empties every prompt text, the View row and the weight plans', () => {
    const patch = clearedPromptPatch({
        custom_prompt: 'masterpiece', api_prompt: '1girl', prompt_ban: 'text',
        view_angle: 'from side', view_camera: 'upper body',
        positive_weight_plans: [{ id: 'x' }],
    });
    for (const key of PROMPT_TEXT_KEYS) assert.equal(patch[key], '', key);
    for (const key of PROMPT_PLAN_KEYS) assert.deepEqual(patch[key], [], key);
    assert.equal(patch.view_angle, 'None');
    assert.equal(patch.view_camera, 'None');
    // every patched key belongs to the prompt section (one undo step through it)
    for (const key of Object.keys(patch)) assert.ok(SECTION_KEYS.prompt.includes(key), `${key} is a prompt-section key`);
});

test('custom fields keep their shape (name, side, polarity, batch, mute) and lose text and plans', () => {
    const patch = clearedPromptPatch({
        prompt_custom_fields: [
            { id: 'cf_a', name: 'Outfit', polarity: 'positive', text: 'necktie, gloves', side: 'left', weight_plans: [{ id: 'p' }], batch: { enabled: true, count: 3 }, muted: true },
            { id: 'cf_action', name: 'Action', polarity: 'positive', text: '@char1 waves' },
        ],
    });
    assert.deepEqual(patch.prompt_custom_fields, [
        { id: 'cf_a', name: 'Outfit', polarity: 'positive', text: '', side: 'left', batch: { enabled: true, count: 3 }, muted: true },
        { id: 'cf_action', name: 'Action', polarity: 'positive', text: '' },
    ]);
    assert.deepEqual(clearedPromptPatch({}).prompt_custom_fields, []);
});

test('a model type switch clears the Scene once, in one undo step, but not the boot-time or forced apply', () => {
    const callbacks = read('scripts/renderer/callbacks.js');
    assert.match(callbacks, /export async function callback_api_model_type\(index, selectedValue, \{ clearPrompts = true \} = \{\}\)/);
    assert.match(callbacks, /const previous = SETTINGS\.api_model_type;/);
    // the type itself is not undoable, so the whole switch (clear, settings swap) runs with history suspended
    assert.match(callbacks, /if \(clearPrompts && previous && previous !== value\) clearPromptContents\(\);/);
    assert.match(callbacks, /if \(previous && previous !== value && globalThis\.editHistory\?\.suspendRecording\) return globalThis\.editHistory\.suspendRecording\(run\);/);
    assert.match(callbacks, /callback_api_model_type\(0, \['Checkpoint'\], \{ clearPrompts: false \}\);/, 'the interface fallback keeps the prompts');
    assert.match(callbacks, /runEditTransaction\(\{ source: 'model-type-clear', sections: \['prompt'\] \}, mutate\)/);
    assert.match(callbacks, /Object\.assign\(SETTINGS, clearedPromptPatch\(SETTINGS\)\);/);
    // the controls are re-synced the way a preset load does it
    assert.match(callbacks, /prompt\?\.fieldManager\?\.refresh\?\.\(\);\s*prompt\?\.tagCapsuleFields\?\.loadFromSettings\?\.\(SETTINGS\);/);
});
