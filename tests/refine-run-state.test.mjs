import test from 'node:test';
import assert from 'node:assert/strict';

import {
    addRefineRunCandidate,
    createRefineRunState,
    finishRefineRun,
} from '../scripts/renderer/tools/refineRunState.js';

function v2Candidate(imageIndex, fields = {}) {
    return {
        imageIndex,
        format: 'v2',
        validForEditorApply: true,
        editorFields: {
            common: fields.common ?? 'masterpiece',
            positive: fields.positive ?? `portrait ${imageIndex}`,
            positiveRight: fields.positiveRight ?? '',
            negative: fields.negative ?? 'worst quality',
        },
    };
}

test('Once keeps the first valid v2 candidate from the current run', () => {
    let state = createRefineRunState({ runId: 'run-1', role: 1 });
    state = addRefineRunCandidate(state, v2Candidate(0));
    state = addRefineRunCandidate(state, v2Candidate(1));

    const decision = finishRefineRun(state, { reason: 'complete' });
    assert.equal(decision.candidate.imageIndex, 0);
    assert.equal(decision.autoApply, true);
});

test('Every keeps the last valid v2 and only auto-applies on normal completion', () => {
    let state = createRefineRunState({ runId: 'run-2', role: 2 });
    state = addRefineRunCandidate(state, v2Candidate(0));
    state = addRefineRunCandidate(state, { imageIndex: 1, format: 'invalid', validForEditorApply: false });
    state = addRefineRunCandidate(state, v2Candidate(2));

    assert.equal(finishRefineRun(state, { reason: 'complete' }).candidate.imageIndex, 2);
    assert.equal(finishRefineRun(state, { reason: 'complete' }).autoApply, true);
    assert.equal(finishRefineRun(state, { reason: 'cancel' }).autoApply, false);
    assert.equal(finishRefineRun(state, { reason: 'error' }).autoApply, false);
});

test('Last, runSame, legacy and stale run candidates never auto-apply', () => {
    let last = createRefineRunState({ runId: 'run-last', role: 3 });
    last = addRefineRunCandidate(last, v2Candidate(0));
    assert.equal(finishRefineRun(last, { reason: 'complete' }).autoApply, false);

    let same = createRefineRunState({ runId: 'run-same', role: 1, runSame: true });
    same = addRefineRunCandidate(same, v2Candidate(0));
    assert.equal(finishRefineRun(same, { reason: 'complete' }).autoApply, false);

    let legacy = createRefineRunState({ runId: 'run-legacy', role: 1 });
    legacy = addRefineRunCandidate(legacy, { imageIndex: 0, format: 'legacy', validForEditorApply: false });
    assert.equal(finishRefineRun(legacy, { reason: 'complete' }).candidate, null);

    let current = createRefineRunState({ runId: 'run-current', role: 1 });
    current = addRefineRunCandidate(current, { ...v2Candidate(0), runId: 'run-old' });
    assert.equal(finishRefineRun(current, { reason: 'complete' }).candidate, null);
});
