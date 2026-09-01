import { hasRefineEditorConflict } from './refineEditorState.js';

const FIELD_SPECS = Object.freeze([
    ['common', 'common'],
    ['positive', 'positive'],
    ['positiveRight', 'positive_right'],
    ['negative', 'negative'],
]);

function validatedPatch(candidate) {
    if (candidate?.format !== 'v2' || candidate.validForEditorApply !== true || !candidate.editorFields) return null;
    const patch = {};
    for (const [candidateKey, settingsKey] of FIELD_SPECS) {
        const value = candidate.editorFields[candidateKey];
        if (typeof value !== 'string') return null;
        patch[settingsKey] = value;
    }
    return patch;
}

function planCount(tagCapsuleFields) {
    return FIELD_SPECS.reduce((total, [, key]) => total + (tagCapsuleFields?.get?.(key)?.getPlans?.().length ?? 0), 0);
}

export function applyRefineEditorPatch({
    candidate,
    snapshot,
    currentSnapshot,
    controls = globalThis.prompt ?? {},
    settings = globalThis.globalSettings ?? {},
    tagCapsuleFields = globalThis.prompt?.tagCapsuleFields ?? null,
} = {}) {
    const patch = validatedPatch(candidate);
    if (!patch) return { status: 'invalid', discardedPlans: 0 };
    if (hasRefineEditorConflict(snapshot, currentSnapshot)) return { status: 'conflict', discardedPlans: 0 };

    const previous = Object.fromEntries(FIELD_SPECS.map(([, key]) => [key, String(controls[key]?.getValue?.() ?? settings[key] ?? '')]));
    const beforePlans = planCount(tagCapsuleFields);
    tagCapsuleFields?.beginBatchUpdate?.();
    try {
        for (const [, key] of FIELD_SPECS) {
            if (typeof controls[key]?.setValue !== 'function') throw new Error(`Prompt control ${key} is unavailable`);
        }
        for (const [, key] of FIELD_SPECS) settings[key] = patch[key];
        for (const [, key] of FIELD_SPECS) controls[key].setValue(patch[key]);
    } catch (error) {
        for (const [, key] of FIELD_SPECS) {
            settings[key] = previous[key];
            try { controls[key]?.setValue?.(previous[key]); } catch { /* best-effort DOM rollback */ }
        }
        return { status: 'error', discardedPlans: 0, error: error?.message ?? String(error) };
    } finally {
        tagCapsuleFields?.endBatchUpdate?.();
    }

    return {
        status: 'applied',
        discardedPlans: Math.max(0, beforePlans - planCount(tagCapsuleFields)),
    };
}
