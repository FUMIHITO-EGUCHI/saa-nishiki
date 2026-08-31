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

export function createRefineRunController({ runId, role, runSame = false, total = 1, snapshot = null } = {}) {
    const resolvedRunId = runId || globalThis.crypto?.randomUUID?.() || `refine-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    return {
        runId: resolvedRunId,
        state: createRefineRunState({ runId: resolvedRunId, role, runSame }),
        snapshot,
        total: Math.max(1, Number.parseInt(total, 10) || 1),
        completed: 0,
        finalized: false,
        decision: null,
        lastAiPrompt: '',
    };
}

export function recordRefineRunCandidate(controller, candidate) {
    if (!controller || controller.finalized) return controller;
    controller.state = addRefineRunCandidate(controller.state, { ...candidate, runId: controller.runId });
    return controller;
}

export function completeRefineRunItem(controller, { reason = 'complete' } = {}) {
    if (!controller) return null;
    if (controller.finalized) return controller.decision;
    if (reason === 'complete') {
        controller.completed += 1;
        if (controller.completed < controller.total) return null;
    }
    controller.finalized = true;
    controller.decision = finishRefineRun(controller.state, { reason });
    return controller.decision;
}
