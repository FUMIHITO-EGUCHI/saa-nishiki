import {
    PROMPT_MODE_REFINE,
    applyAiPromptResult,
    isStructuredRefineFormat,
    normalizePromptMode,
    parseRefineEnvelope,
    refineRequestSchema,
    removeAiPromptMarker,
} from '../../aiPromptRefiner.js';
import { reapplyPlanWeights } from './promptBatchExpansion.js';
import {
    applyRefinePlanWeights,
    composeNormalRefinePrompt,
    composeRegionalRefinePrompt,
    mapRegionalBackendPrompts,
    ownedRefineEditorFields,
    splitLegacyRegionalNegative,
} from './refinePromptComposition.js';
import { mutedRefineFields } from './refineEditorState.js';

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

// The generation context a queued image carries for Refine, plus what the request was:
// the schema it was built with (0 when no structured request went out), so the answer is
// read against it, and the editor fields muted while the prompt was assembled.
export function refineRequestContext(refineContext, { structuredRefine = false, refineSystemPrompt = '', settings = {} } = {}) {
    if (!refineContext) return refineContext;
    return {
        ...refineContext,
        requestSchema: structuredRefine ? refineRequestSchema(refineSystemPrompt) : 0,
        muted: mutedRefineFields(settings),
    };
}

// `reusedAnswer` is the AI role "Last": the answer of an earlier run, which may have run
// in the other mode. Its empty Regional side fields are then not this run's answer, so the
// parse keeps the side fields generation made (parseRefineEnvelope, `reused`).
export async function resolveQueuedAiPrompt({
    mode = 'Expand',
    content = '',
    marker,
    originalPrompts = {},
    regional = false,
    regionalSwap = false,
    allowStructured = true,
    reusedAnswer = false,
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
    const envelope = parseRefineEnvelope(content, {
        regional,
        originalPrompts: cleanOriginals,
        requestSchema: fixedContext?.requestSchema,
        reused: reusedAnswer === true,
    });
    if (isStructuredRefineFormat(envelope.format) && !allowStructured) {
        return {
            ok: false,
            ...cleanOriginals,
            changes: '',
            preview: '',
            error: 'Structured Refine output is only accepted from an Ollama endpoint (Local or Pod)',
            envelope: {
                ...envelope,
                format: 'invalid',
                validForGeneration: false,
                validForEditorApply: false,
                editorFields: null,
                error: 'Structured Refine output is only accepted from an Ollama endpoint (Local or Pod)',
            },
            editorFields: null,
        };
    }
    if (!isStructuredRefineFormat(envelope.format)) {
        const fallback = envelope.generationFallback;
        // legacy output is one finished negative, so both regional sides take it, each
        // without the other side's own tags; a failed parse leaves the side negatives
        // untouched instead. The sides are split first and weighted with everything else:
        // the answer of image #1 ("Once") carries that image's weights, so a side negative
        // taken out of it needs this image's planned weight put back too.
        const sides = regional && fallback.ok ? splitLegacyRegionalNegative(fallback.negative, fixedContext) : null;
        const sided = withPlanWeights(sides
            ? { ...fallback, negativeLeft: sides.left, negativeRight: sides.right }
            : fallback, planWeights);
        const backend = regional && fallback.ok
            ? mapRegionalBackendPrompts(sided, regionalSwap)
            : null;
        return {
            ...sided,
            ...(backend ? {
                positive: backend.positiveLeft,
                positiveRight: backend.positiveRight,
                negative: backend.negative,
                negativeLeft: backend.negativeLeft,
                negativeRight: backend.negativeRight,
            } : {}),
            preview: fallback.ok ? (envelope.changes || fallback.positive) : '',
            envelope,
            editorFields: null,
        };
    }

    const ownedEditorFields = ownedRefineEditorFields(envelope.editorFields, fixedContext?.muted);
    const plannedEditorFields = applyRefinePlanWeights(ownedEditorFields, planWeights ?? {});
    const logical = regional
        ? await composeRegionalRefinePrompt({ editorFields: plannedEditorFields, fixedContext, resolveComponent })
        : await composeNormalRefinePrompt({ editorFields: plannedEditorFields, fixedContext, resolveComponent });
    const backend = regional ? mapRegionalBackendPrompts(logical, regionalSwap) : null;
    return {
        ok: true,
        positive: regional ? backend.positiveLeft : logical.positive,
        positiveRight: regional ? backend.positiveRight : logical.positiveRight,
        negative: regional ? backend.negative : logical.negative,
        ...(regional ? { negativeLeft: backend.negativeLeft, negativeRight: backend.negativeRight } : {}),
        changes: envelope.changes,
        preview: envelope.changes || logical.positive,
        error: '',
        envelope,
        editorFields: envelope.editorFields,
    };
}
