import test from 'node:test';
import assert from 'node:assert/strict';

import {
    addRefineRunCandidate,
    completeRefineRunItem,
    createRefineRunController,
    createRefineRunState,
    finishRefineRun,
    recordRefineRunCandidate,
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

test('shared run controller finalizes once after every queued image completes', () => {
    const controller = createRefineRunController({
        runId: 'run-controller',
        role: 2,
        total: 2,
        snapshot: { revision: 'snapshot' },
    });
    recordRefineRunCandidate(controller, v2Candidate(0));
    assert.equal(completeRefineRunItem(controller), null);
    recordRefineRunCandidate(controller, v2Candidate(1));
    const decision = completeRefineRunItem(controller);
    assert.equal(decision.autoApply, true);
    assert.equal(decision.candidate.imageIndex, 1);
    assert.equal(controller.finalized, true);
    assert.equal(completeRefineRunItem(controller), decision, 'duplicate completion returns the same decision');
});

test('a run state without a usable runId is refused outright', () => {
    // every candidate is matched against the runId; a state without one would accept the
    // answers of a run that was already replaced
    assert.throws(() => createRefineRunState(), /runId is required/);
    assert.throws(() => createRefineRunState({ role: 1 }), /runId is required/);
    assert.throws(() => createRefineRunState({ runId: '', role: 1 }), /runId is required/);
    assert.throws(() => createRefineRunState({ runId: 17, role: 1 }), /runId is required/);
    assert.throws(() => createRefineRunState({ runId: null, role: 1 }), /runId is required/);

    // the controller makes one up when the caller has none, so it never throws
    const generated = createRefineRunController({ role: 1 });
    assert.equal(typeof generated.runId, 'string');
    assert.notEqual(generated.runId, '');
    assert.equal(generated.state.runId, generated.runId);
    assert.equal(createRefineRunController({ runId: 'given', role: 1 }).runId, 'given');
});

test('Last and "same prompt" take no candidate at all, not merely no auto-apply', () => {
    // role 3 (Last) applies the previous image's prompt: there is nothing for the editor to
    // take, and runSame is a re-run of text the user asked to keep as it is
    let last = createRefineRunState({ runId: 'run-last', role: 3 });
    last = addRefineRunCandidate(last, v2Candidate(0));
    assert.equal(last.candidate, null);
    assert.equal(finishRefineRun(last, { reason: 'complete' }).candidate, null);

    let same = createRefineRunState({ runId: 'run-runsame', role: 2, runSame: true });
    same = addRefineRunCandidate(same, v2Candidate(0));
    assert.equal(same.candidate, null);
    assert.equal(finishRefineRun(same, { reason: 'complete' }).candidate, null);

    // ... while Every, the same call without either flag, does keep one
    let every = createRefineRunState({ runId: 'run-every', role: 2 });
    every = addRefineRunCandidate(every, v2Candidate(0));
    assert.equal(every.candidate.imageIndex, 0);
    assert.equal(every.candidate.runId, 'run-every', 'the candidate is stamped with the run it belongs to');
});

test('a finalized controller is closed: a late answer neither lands nor moves the decision', () => {
    const controller = createRefineRunController({ runId: 'run-late', role: 2, total: 1 });
    recordRefineRunCandidate(controller, v2Candidate(0));
    const decision = completeRefineRunItem(controller);
    assert.equal(decision.candidate.imageIndex, 0);

    // Every keeps the last candidate, so an answer arriving after the decision was handed
    // out would otherwise replace what the user is looking at
    assert.equal(recordRefineRunCandidate(controller, v2Candidate(9)), controller);
    assert.equal(controller.state.candidate.imageIndex, 0);
    assert.equal(completeRefineRunItem(controller), decision);
    assert.equal(recordRefineRunCandidate(null, v2Candidate(0)), null, 'no controller, nothing to record');
    assert.equal(completeRefineRunItem(null), null);
});

test('cancel, skip and error finalize immediately as manual pending only', () => {
    for (const reason of ['cancel', 'skip', 'error']) {
        const controller = createRefineRunController({ runId: `run-${reason}`, role: 1, total: 3 });
        recordRefineRunCandidate(controller, v2Candidate(0));
        const decision = completeRefineRunItem(controller, { reason });
        assert.equal(decision.reason, reason);
        assert.equal(decision.autoApply, false);
        assert.equal(decision.candidate.imageIndex, 0);
        assert.equal(controller.finalized, true);
    }
});
