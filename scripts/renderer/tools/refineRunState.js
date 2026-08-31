function cloneCandidate(candidate) {
    if (!candidate) return null;
    return {
        ...candidate,
        editorFields: candidate.editorFields ? { ...candidate.editorFields } : null,
    };
}

export function createRefineRunState({ runId, role, runSame = false } = {}) {
    if (typeof runId !== 'string' || runId === '') throw new Error('runId is required');
    return {
        runId,
        role: Number(role),
        runSame: Boolean(runSame),
        candidate: null,
    };
}

export function addRefineRunCandidate(state, candidate) {
    if (!state || !candidate || candidate.validForEditorApply !== true || candidate.format !== 'v2') return state;
    if (candidate.runId && candidate.runId !== state.runId) return state;
    if (state.role === 3 || state.runSame) return state;
    if (state.role === 1 && state.candidate) return state;
    return { ...state, candidate: cloneCandidate({ ...candidate, runId: state.runId }) };
}

export function finishRefineRun(state, { reason = 'complete' } = {}) {
    const candidate = cloneCandidate(state?.candidate);
    return {
        runId: state?.runId ?? '',
        candidate,
        autoApply: Boolean(candidate && reason === 'complete' && !state.runSame && (state.role === 1 || state.role === 2)),
        reason,
    };
}
