import { hasRefineEditorConflict } from './refineEditorState.js';

const FIELD_SPECS = Object.freeze([
    ['common', 'common', 'custom_prompt'],
    ['positive', 'positive', 'api_prompt'],
    ['positiveRight', 'positive_right', 'api_prompt_right'],
    ['negative', 'negative', 'api_neg_prompt'],
]);

function validatedPatch(candidate) {
    if (candidate?.format !== 'v2' || candidate.validForEditorApply !== true || !candidate.editorFields) return null;
    const patch = {};
    for (const [candidateKey, controlKey] of FIELD_SPECS) {
        const value = candidate.editorFields[candidateKey];
        if (typeof value !== 'string') return null;
        patch[controlKey] = value;
    }
    return patch;
}

function planCount(tagCapsuleFields) {
    return FIELD_SPECS.reduce((total, [, controlKey]) => total + (tagCapsuleFields?.get?.(controlKey)?.getPlans?.().length ?? 0), 0);
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

    const previous = Object.fromEntries(FIELD_SPECS.map(([, controlKey, settingsKey]) => [
        controlKey,
        String(controls[controlKey]?.getValue?.() ?? settings[settingsKey] ?? ''),
    ]));
    const beforePlans = planCount(tagCapsuleFields);
    tagCapsuleFields?.beginBatchUpdate?.();
    try {
        for (const [, controlKey] of FIELD_SPECS) {
            if (typeof controls[controlKey]?.setValue !== 'function') throw new Error(`Prompt control ${controlKey} is unavailable`);
        }
        for (const [, controlKey, settingsKey] of FIELD_SPECS) settings[settingsKey] = patch[controlKey];
        for (const [, controlKey] of FIELD_SPECS) controls[controlKey].setValue(patch[controlKey]);
    } catch (error) {
        for (const [, controlKey, settingsKey] of FIELD_SPECS) {
            settings[settingsKey] = previous[controlKey];
            try { controls[controlKey]?.setValue?.(previous[controlKey]); } catch { /* best-effort DOM rollback */ }
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
