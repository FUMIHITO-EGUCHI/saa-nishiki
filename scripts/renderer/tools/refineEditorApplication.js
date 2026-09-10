import { isStructuredRefineFormat } from '../../aiPromptRefiner.js';
import { hasRefineEditorConflict } from './refineEditorState.js';

const FIELD_SPECS = Object.freeze([
    ['common', 'common', 'custom_prompt'],
    ['positive', 'positive', 'api_prompt'],
    ['positiveRight', 'positive_right', 'api_prompt_right'],
    ['negative', 'negative', 'api_neg_prompt'],
]);

// Schema 3 rewrites the Regional per-side negatives too. A schema 2 answer knows
// nothing about them, and outside Regional the fields are not part of the prompt, so
// both cases keep whatever the editor holds.
const SIDE_NEGATIVE_SPECS = Object.freeze([
    ['negativeLeft', 'negative_left', 'api_neg_prompt_left'],
    ['negativeRight', 'negative_right', 'api_neg_prompt_right'],
]);

function patchSpecs(candidate, controls, snapshot) {
    if (snapshot?.mode !== 'regional') return [...FIELD_SPECS];
    return [...FIELD_SPECS, ...SIDE_NEGATIVE_SPECS.filter(([candidateKey, controlKey]) =>
        typeof candidate?.editorFields?.[candidateKey] === 'string'
        && typeof controls[controlKey]?.setValue === 'function')];
}

function validatedPatch(candidate, specs) {
    if (!isStructuredRefineFormat(candidate?.format) || candidate.validForEditorApply !== true || !candidate.editorFields) return null;
    const patch = {};
    for (const [candidateKey, controlKey] of specs) {
        const value = candidate.editorFields[candidateKey];
        if (typeof value !== 'string') return null;
        patch[controlKey] = value;
    }
    return patch;
}

function planCount(tagCapsuleFields, specs) {
    return specs.reduce((total, [, controlKey]) => total + (tagCapsuleFields?.get?.(controlKey)?.getPlans?.().length ?? 0), 0);
}

export function applyRefineEditorPatch({
    candidate,
    snapshot,
    currentSnapshot,
    controls = globalThis.prompt ?? {},
    settings = globalThis.globalSettings ?? {},
    tagCapsuleFields = globalThis.prompt?.tagCapsuleFields ?? null,
} = {}) {
    const specs = patchSpecs(candidate, controls, snapshot);
    const patch = validatedPatch(candidate, specs);
    if (!patch) return { status: 'invalid', discardedPlans: 0 };
    if (hasRefineEditorConflict(snapshot, currentSnapshot)) return { status: 'conflict', discardedPlans: 0 };

    const previous = Object.fromEntries(specs.map(([, controlKey, settingsKey]) => [
        controlKey,
        String(controls[controlKey]?.getValue?.() ?? settings[settingsKey] ?? ''),
    ]));
    const beforePlans = planCount(tagCapsuleFields, specs);
    tagCapsuleFields?.beginBatchUpdate?.();
    try {
        for (const [, controlKey] of specs) {
            if (typeof controls[controlKey]?.setValue !== 'function') throw new Error(`Prompt control ${controlKey} is unavailable`);
        }
        for (const [, controlKey, settingsKey] of specs) settings[settingsKey] = patch[controlKey];
        for (const [, controlKey] of specs) controls[controlKey].setValue(patch[controlKey]);
    } catch (error) {
        for (const [, controlKey, settingsKey] of specs) {
            settings[settingsKey] = previous[controlKey];
            try { controls[controlKey]?.setValue?.(previous[controlKey]); } catch { /* best-effort DOM rollback */ }
        }
        return { status: 'error', discardedPlans: 0, error: error?.message ?? String(error) };
    } finally {
        tagCapsuleFields?.endBatchUpdate?.();
    }

    return {
        status: 'applied',
        discardedPlans: Math.max(0, beforePlans - planCount(tagCapsuleFields, specs)),
    };
}
