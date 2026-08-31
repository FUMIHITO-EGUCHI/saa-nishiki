import { filterPrompts } from './promptFilter.js';
import { applyPlanWeights, planWeightEntries } from './promptBatchExpansion.js';

const identityResolver = async value => value;

function cleanPart(value) {
    return String(value ?? '').trim().replace(/^,\s*|,\s*$/g, '').trim();
}

function joinPromptParts(parts) {
    return parts.map(cleanPart).filter(Boolean).join(', ');
}

async function resolveParts(parts, seed, resolver) {
    const resolved = [];
    for (const part of parts) resolved.push(await resolver(String(part ?? ''), seed));
    return resolved;
}

function appendSlotLora(positive, slotLora) {
    const slot = String(slotLora ?? '').trim();
    if (!slot || positive.includes(slot)) return positive;
    return positive ? `${positive}\n${slot}` : slot;
}

function mergeNegative(editorNegative, characterNegative) {
    return joinPromptParts([editorNegative, characterNegative]);
}

export function applyRefinePlanWeights(editorFields = {}, weights = {}) {
    const byField = planWeightEntries(weights);
    return {
        common: applyPlanWeights(editorFields.common ?? '', byField.common ?? []),
        positive: applyPlanWeights(editorFields.positive ?? '', byField.positive ?? []),
        positiveRight: applyPlanWeights(editorFields.positiveRight ?? '', byField.positive_right ?? []),
        negative: applyPlanWeights(editorFields.negative ?? '', byField.negative ?? []),
    };
}

export async function composeNormalRefinePrompt({
    editorFields = {},
    fixedContext = {},
    resolveComponent = identityResolver,
} = {}) {
    const parts = await resolveParts([
        fixedContext.beforePrompts,
        editorFields.common,
        fixedContext.views,
        fixedContext.beforeCharacters,
        fixedContext.characters,
        fixedContext.afterCharacters,
        editorFields.positive,
        fixedContext.afterPrompts,
    ], fixedContext.seed, resolveComponent);
    const rawPositive = joinPromptParts(parts);
    const { positivePrompt } = filterPrompts(rawPositive, rawPositive, fixedContext.exclude ?? '');
    return {
        positive: appendSlotLora(positivePrompt, fixedContext.slotLora),
        positiveRight: '',
        negative: mergeNegative(editorFields.negative, fixedContext.characterNegative),
    };
}

async function composeRegionalSide(editorFields, fixedContext, sideName, resolver) {
    const side = fixedContext[sideName] ?? {};
    const seed = sideName === 'left' ? fixedContext.leftSeed : fixedContext.rightSeed;
    const specific = sideName === 'left' ? editorFields.positive : editorFields.positiveRight;
    const parts = await resolveParts([
        side.beforePrompts,
        editorFields.common,
        fixedContext.views,
        side.beforeCharacters,
        side.characters,
        side.afterCharacters,
        specific,
        side.afterPrompts,
    ], seed, resolver);
    const rawPositive = joinPromptParts(parts);
    return filterPrompts(rawPositive, rawPositive, fixedContext.exclude ?? '').positivePrompt;
}

export async function composeRegionalRefinePrompt({
    editorFields = {},
    fixedContext = {},
    resolveComponent = identityResolver,
} = {}) {
    const left = await composeRegionalSide(editorFields, fixedContext, 'left', resolveComponent);
    const right = await composeRegionalSide(editorFields, fixedContext, 'right', resolveComponent);
    return {
        positive: appendSlotLora(left, fixedContext.slotLora),
        positiveRight: right,
        negative: mergeNegative(editorFields.negative, fixedContext.characterNegative),
    };
}

export function mapRegionalBackendPrompts(prompts, swap = false) {
    return {
        positiveLeft: swap ? prompts.positiveRight : prompts.positive,
        positiveRight: swap ? prompts.positive : prompts.positiveRight,
        negative: prompts.negative,
    };
}
