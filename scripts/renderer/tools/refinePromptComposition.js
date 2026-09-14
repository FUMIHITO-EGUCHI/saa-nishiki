import { filterPrompts } from './promptFilter.js';
import { applyPlanWeights, planWeightEntries } from './promptBatchExpansion.js';
import { composeNegativeChain, composeRegionalNegatives } from '../../shared/negativeComposition.js';

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

// The negative side fields are null when the model answered with schema 2, which knows
// nothing about them; the generated text of those units is then kept as it was.
function planSideNegative(value, entries) {
    return typeof value === 'string' ? applyPlanWeights(value, entries) : null;
}

export function applyRefinePlanWeights(editorFields = {}, weights = {}) {
    const byField = planWeightEntries(weights);
    return {
        common: applyPlanWeights(editorFields.common ?? '', byField.common ?? []),
        positive: applyPlanWeights(editorFields.positive ?? '', byField.positive ?? []),
        positiveRight: applyPlanWeights(editorFields.positiveRight ?? '', byField.positive_right ?? []),
        negative: applyPlanWeights(editorFields.negative ?? '', byField.negative ?? []),
        negativeLeft: planSideNegative(editorFields.negativeLeft, byField.negative_left ?? []),
        negativeRight: planSideNegative(editorFields.negativeRight, byField.negative_right ?? []),
    };
}

// The negative chain is rebuilt like the positive one: the editable Negative fields
// replace their units, every other unit - custom negative fields included - keeps the
// text generation gave it.
function negativeUnitTexts(fixedContext, editorFields) {
    const texts = { ...(fixedContext.negative?.texts ?? {}) };
    texts.negative = editorFields.negative ?? '';
    if (typeof editorFields.negativeLeft === 'string') texts.negative_left = editorFields.negativeLeft;
    if (typeof editorFields.negativeRight === 'string') texts.negative_right = editorFields.negativeRight;
    return texts;
}

// A chain is the ordered {id, text} units generation assembled for one prompt
// (refineContext.chain, .left.chain, .right.chain). The editor's common / positive /
// positive_right replace their units; every other unit - background, style, custom
// fields, the characters block with its JSON slots - keeps the text it had. The AI
// unit is left out: Refine is what replaces it.
function chainParts(chain, editorFields) {
    return chain.map(unit => {
        switch (unit?.id) {
            case 'common': return editorFields.common;
            case 'positive': return editorFields.positive;
            case 'positive_right': return editorFields.positiveRight;
            case 'ai': return '';
            default: return unit?.text ?? '';
        }
    });
}

export async function composeNormalRefinePrompt({
    editorFields = {},
    fixedContext = {},
    resolveComponent = identityResolver,
} = {}) {
    // without a chain (older queue items) the fixed shape common → views → characters → positive is used
    const parts = await resolveParts(Array.isArray(fixedContext.chain) ? [
        fixedContext.beforePrompts,
        ...chainParts(fixedContext.chain, editorFields),
        fixedContext.afterPrompts,
    ] : [
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
    const negativeChain = fixedContext.negative?.chain;
    return {
        positive: appendSlotLora(positivePrompt, fixedContext.slotLora),
        positiveRight: '',
        // without a negative chain (older queue items) only the editable Negative and the
        // character negatives are known
        negative: Array.isArray(negativeChain)
            ? composeNegativeChain({
                chain: negativeChain,
                texts: negativeUnitTexts(fixedContext, editorFields),
                characterNegative: fixedContext.characterNegative,
            })
            : mergeNegative(editorFields.negative, fixedContext.characterNegative),
    };
}

async function composeRegionalSide(editorFields, fixedContext, sideName, resolver) {
    const side = fixedContext[sideName] ?? {};
    const seed = sideName === 'left' ? fixedContext.leftSeed : fixedContext.rightSeed;
    const specific = sideName === 'left' ? editorFields.positive : editorFields.positiveRight;
    const parts = await resolveParts(Array.isArray(side.chain) ? [
        side.beforePrompts,
        ...chainParts(side.chain, editorFields),
        side.afterPrompts,
    ] : [
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

// Regional negatives: the shared Negative and "both" custom fields go to both sides,
// Negative (left / right) and the side custom fields to theirs, each side's character
// negatives last. `negative` is the merged one, for backends without regional negatives.
function composeRegionalNegativeSides(editorFields, fixedContext) {
    const chains = fixedContext.negative?.chains;
    if (!chains) {
        // older queue items carry no negative chain: one merged negative for every side
        const merged = mergeNegative(editorFields.negative, fixedContext.characterNegative);
        return { left: merged, right: merged, merged };
    }
    return composeRegionalNegatives({
        chains,
        texts: negativeUnitTexts(fixedContext, editorFields),
        characterLeft: fixedContext.characterNegativeLeft ?? '',
        characterRight: fixedContext.characterNegativeRight ?? '',
    });
}

export async function composeRegionalRefinePrompt({
    editorFields = {},
    fixedContext = {},
    resolveComponent = identityResolver,
} = {}) {
    const left = await composeRegionalSide(editorFields, fixedContext, 'left', resolveComponent);
    const right = await composeRegionalSide(editorFields, fixedContext, 'right', resolveComponent);
    const negatives = composeRegionalNegativeSides(editorFields, fixedContext);
    return {
        positive: appendSlotLora(left, fixedContext.slotLora),
        positiveRight: right,
        negative: negatives.merged,
        negativeLeft: negatives.left,
        negativeRight: negatives.right,
    };
}

export function mapRegionalBackendPrompts(prompts, swap = false) {
    return {
        positiveLeft: swap ? prompts.positiveRight : prompts.positive,
        positiveRight: swap ? prompts.positive : prompts.positiveRight,
        negative: prompts.negative,
        negativeLeft: swap ? prompts.negativeRight : prompts.negativeLeft,
        negativeRight: swap ? prompts.negativeLeft : prompts.negativeRight,
    };
}
