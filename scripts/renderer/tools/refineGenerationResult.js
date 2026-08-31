import {
    PROMPT_MODE_REFINE,
    applyAiPromptResult,
    normalizePromptMode,
    parseRefineEnvelope,
    removeAiPromptMarker,
} from '../../aiPromptRefiner.js';
import { reapplyPlanWeights } from './promptBatchExpansion.js';
import {
    applyRefinePlanWeights,
    composeNormalRefinePrompt,
    composeRegionalRefinePrompt,
    mapRegionalBackendPrompts,
} from './refinePromptComposition.js';

function cleanOriginalPrompts(originalPrompts, marker) {
    return {
        positive: removeAiPromptMarker(String(originalPrompts?.positive ?? ''), marker),
        positiveRight: removeAiPromptMarker(String(originalPrompts?.positiveRight ?? ''), marker),
        negative: String(originalPrompts?.negative ?? ''),
    };
}

function withPlanWeights(result, planWeights) {
    return planWeights ? reapplyPlanWeights(result, planWeights) : result;
}

export async function resolveQueuedAiPrompt({
    mode = 'Expand',
    content = '',
    marker,
    originalPrompts = {},
    regional = false,
    regionalSwap = false,
    allowStructured = true,
    fixedContext = {},
    planWeights = null,
    resolveComponent,
} = {}) {
    if (normalizePromptMode(mode) !== PROMPT_MODE_REFINE) {
        const expanded = applyAiPromptResult({
            mode,
            content,
            marker,
            positive: originalPrompts.positive ?? '',
            positiveRight: originalPrompts.positiveRight ?? '',
            negative: originalPrompts.negative ?? '',
        });
        return { ...withPlanWeights(expanded, planWeights), envelope: null, editorFields: null };
    }

    const cleanOriginals = cleanOriginalPrompts(originalPrompts, marker);
    const envelope = parseRefineEnvelope(content, { regional, originalPrompts: cleanOriginals });
    if (envelope.format === 'v2' && !allowStructured) {
        return {
            ok: false,
            ...cleanOriginals,
            changes: '',
            preview: '',
            error: 'Structured Refine output is only accepted from Local Ollama',
            envelope: {
                ...envelope,
                format: 'invalid',
                validForGeneration: false,
                validForEditorApply: false,
                editorFields: null,
                error: 'Structured Refine output is only accepted from Local Ollama',
            },
            editorFields: null,
        };
    }
    if (envelope.format !== 'v2') {
        const fallback = envelope.generationFallback;
        const weightedFallback = withPlanWeights(fallback, planWeights);
        const backend = regional && weightedFallback.ok
            ? mapRegionalBackendPrompts(weightedFallback, regionalSwap)
            : null;
        return {
            ...weightedFallback,
            ...(backend ? {
                positive: backend.positiveLeft,
                positiveRight: backend.positiveRight,
                negative: backend.negative,
            } : {}),
            preview: fallback.ok ? (envelope.changes || fallback.positive) : '',
            envelope,
            editorFields: null,
        };
    }

    const plannedEditorFields = applyRefinePlanWeights(envelope.editorFields, planWeights ?? {});
    const logical = regional
        ? await composeRegionalRefinePrompt({ editorFields: plannedEditorFields, fixedContext, resolveComponent })
        : await composeNormalRefinePrompt({ editorFields: plannedEditorFields, fixedContext, resolveComponent });
    const backend = regional ? mapRegionalBackendPrompts(logical, regionalSwap) : null;
    return {
        ok: true,
        positive: regional ? backend.positiveLeft : logical.positive,
        positiveRight: regional ? backend.positiveRight : logical.positiveRight,
        negative: regional ? backend.negative : logical.negative,
        changes: envelope.changes,
        preview: envelope.changes || logical.positive,
        error: '',
        envelope,
        editorFields: envelope.editorFields,
    };
}
