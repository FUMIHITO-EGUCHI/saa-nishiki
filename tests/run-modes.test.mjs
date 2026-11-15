// The run bar's Generate per mode (scripts/renderer/runModes.js, docs/sequence-batch-plan.md D34).
import assert from 'node:assert/strict';
import test from 'node:test';

import { generateState, normalizeRunMode } from '../scripts/renderer/runModes.js';

test('Single and Batch: one Generate, the count in Batch, no Run', () => {
    assert.deepEqual(generateState({ mode: 'single', batch: 5 }), { label: 'Generate', count: 1, blocked: [], paused: false, run: null, sampleOff: false });
    assert.deepEqual(generateState({ mode: 'batch', batch: 5 }), { label: 'Generate (5)', count: 5, blocked: [], paused: false, run: null, sampleOff: false });
    assert.equal(generateState({ mode: 'batch', batch: 5, paused: true }).label, 'Generate (Paused)');
});

test('Sequence: Sample is one image of the scene on the screen, Run carries the total and what blocks it', () => {
    const state = generateState({ mode: 'sequence', batch: 7, sequenceTotal: 48, sequenceBlocked: ['No characters'] });
    assert.equal(state.label, 'Sample', 'no scene number in the button');
    assert.equal(state.count, 1, 'the Batch count is not used');
    assert.deepEqual(state.run, { label: 'Run 48', count: 48 });
    assert.deepEqual(state.blocked, ['No characters']);
    assert.equal(state.sampleOff, false);
    assert.equal(generateState({ mode: 'sequence', sceneOnScreen: false }).sampleOff, true, 'no scene on the screen: nothing to sample');
    assert.equal(generateState({ mode: 'sequence', sequenceTotal: 2, labels: { sample: '试生成', sequence: '运行' } }).run.label, '运行 2');
});

test('an unknown mode is Single', () => {
    assert.equal(normalizeRunMode('sequence'), 'sequence');
    assert.equal(normalizeRunMode('batch-last'), 'single');
    assert.equal(normalizeRunMode(undefined), 'single');
});
