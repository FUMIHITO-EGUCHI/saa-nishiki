import assert from 'node:assert/strict';
import test from 'node:test';
import { buildPresetOptions, resolveSaveName, nextCurrentAfterDelete, formatPresetMessage } from '../scripts/renderer/components/presetControlLogic.js';

test('buildPresetOptions puts the placeholder first and selects the current preset', () => {
    assert.deepEqual(buildPresetOptions(['b', 'a'], 'a', 'Preset…'), [
        { value: '', label: 'Preset…', selected: false },
        { value: 'b', label: 'b', selected: false },
        { value: 'a', label: 'a', selected: true },
    ]);
    assert.deepEqual(buildPresetOptions([], '', 'Preset…'), [{ value: '', label: 'Preset…', selected: true }]);
    assert.equal(buildPresetOptions(['a'], 'gone', 'Preset…')[0].selected, true, 'unknown current falls back to the placeholder');
    assert.equal(buildPresetOptions(null, '', 'x').length, 1);
});

test('resolveSaveName prefers the typed name, then the current preset, then nothing', () => {
    assert.equal(resolveSaveName(' Scene 1.json', 'old'), 'Scene 1');
    assert.equal(resolveSaveName('', 'old'), 'old');
    assert.equal(resolveSaveName(null, ''), null);
    assert.equal(resolveSaveName('a/b', ''), 'a b');
});

test('nextCurrentAfterDelete clears the selection only when the current preset was deleted', () => {
    assert.equal(nextCurrentAfterDelete(['a', 'b'], 'a', 'a'), '');
    assert.equal(nextCurrentAfterDelete(['a', 'b'], 'b', 'a'), 'b');
});

test('formatPresetMessage substitutes section and preset names', () => {
    assert.equal(formatPresetMessage('Delete {0} preset "{1}"?', 'LoRA', 'base'), 'Delete LoRA preset "base"?');
    assert.equal(formatPresetMessage(undefined, 'x'), '');
});
