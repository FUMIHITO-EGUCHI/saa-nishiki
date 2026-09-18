import { mapPromptTokens, splitGroupToken, splitPromptTokens } from '../components/tagCapsuleLogic.js';

////////////////////////////////////////////////////////////////////////////////
// Helper Function: Escape special characters for Regular Expressions
////////////////////////////////////////////////////////////////////////////////
function escapeRegExp(text) {
    return text.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
}

////////////////////////////////////////////////////////////////////////////////
// Basic Normalization: Strip prompt weight modifiers like (1.2), (tag:1.3), 
// or [tag] to allow precise tag matching
////////////////////////////////////////////////////////////////////////////////
function normalizeTag(tag) {
    return tag
        .replaceAll(/^\(+/g, '')
        .replaceAll(/\)+$/g, '')    // NOSONAR S8786
        .replaceAll(/:\s*[\d.]+$/g, '')
        .trim();
}

////////////////////////////////////////////////////////////////////////////////
// Cleanup Formatting: Remove redundant commas, whitespace, and empty [color] tags
// Preserves newlines (\n) and line-ending commas specifically for Diffusion prompts
////////////////////////////////////////////////////////////////////////////////
function cleanPromptText(text) {
    return text
        // Remove empty [color=xxx][/color] blocks or those containing only spaces/commas/semicolons
        .replaceAll(/\[color=[^\]]+\][\s,;]*\[\/color\]/gi, '')
        // Normalize spaces around commas while preserving surrounding newlines
        .replaceAll(/[ \t]*,[ \t]*/g, ', ') // NOSONAR S8786
        // Remove duplicate consecutive commas (e.g. "tag1,, tag2" -> "tag1, tag2")
        .replaceAll(/(,[ \t]*)+,/g, ',')
        // Clean multiple consecutive horizontal spaces (spaces and tabs only, leaving \n intact)
        .replaceAll(/[ \t]{2,}/g, ' ')
        // Trim spaces at line start/end, but preserve commas at line endings
        .replaceAll(/^[ \t,]+|[ \t]+$/gm, '')   // NOSONAR S8786
        // Clean up leading/trailing empty lines or trailing commas at the very end of the prompt
        .trim();
}

////////////////////////////////////////////////////////////////////////////////
// Core Processing Logic: Handles both tag replacement (key:value) 
// and tag removal (plain tag)
////////////////////////////////////////////////////////////////////////////////
// eslint-disable-next-line sonarjs/cognitive-complexity
function processExcludedTags(text, excludeList) {
    if (!text || !excludeList.length) return text;

    const replacementItems = []; // [{ target, replacement }]
    const removalTags = [];       // [ tag ]

    // 1. Categorize excludeList items into replacements and removals
    for (const item of excludeList) {
        if (item.includes(':')) {
            const parts = item.split(':');
            const target = normalizeTag(parts[0]);
            const replacement = parts.slice(1).join(':').trim(); // Support replacements that might contain colons
            if (target && replacement) {
                replacementItems.push({ target, replacement });
            }
        } else {
            const tag = normalizeTag(item);
            if (tag) {
                removalTags.push(tag);
            }
        }
    }

    // 2. Replacements (sorted by target length descending)
    replacementItems.sort((a, b) => b.target.length - a.target.length);
    const replacements = replacementItems.map(({ target, replacement }) => ({
        // Regex captures optional leading brackets ($1), weight modifier ($2), and trailing brackets ($3)
        regex: new RegExp(String.raw`(\(+)?\b${escapeRegExp(target)}\b(:[\d.]+)?(\)*)`, 'gi'),
        replacement,
    }));

    // 3. Removals (sorted by tag length descending)
    removalTags.sort((a, b) => b.length - a.length);
    const removeRegex = removalTags.length > 0
        ? new RegExp(removalTags.map(tag => String.raw`(?:\(+)?\b${escapeRegExp(tag)}\b(?::[\d.]+)?\)*`).join('|'), 'gi')
        : null;

    // Applied tag by tag, with the chips' tokenizer: a weighted group is one tag, so a tag
    // excluded inside it is taken out of the group ("(red hair, blue eyes:1.2)" without
    // "red hair" is "(blue eyes:1.2)") instead of cutting the group in half. A group left
    // with nothing inside goes away with it.
    const applyRules = tag => {
        let value = tag;
        for (const { regex, replacement } of replacements) {
            value = value.replace(regex, (match, p1 = '', p2 = '', p3 = '') => `${p1}${replacement}${p2}${p3}`);
        }
        return removeRegex ? value.replace(removeRegex, '') : value;
    };
    const rewriteTag = token => {
        const group = splitGroupToken(token);
        if (!group || !group.body.includes(',')) return applyRules(token);
        const kept = splitPromptTokens(mapPromptTokens(group.body, rewriteTag));
        const inside = kept.length === 0 ? '' : `${group.open}${kept.join(', ')}${group.close}`;
        // the colored copy wraps tags in [color=..], so a group can sit inside a token
        return `${applyRules(group.before)}${inside}${rewriteTag(group.after)}`;
    };

    // 4. Clean up structural artifacts (isolated commas and spaces left after removal/replacement)
    return cleanPromptText(mapPromptTokens(text, rewriteTag));
}

////////////////////////////////////////////////////////////////////////////////
// Exported Entry Function
////////////////////////////////////////////////////////////////////////////////
// The Exclude field is a chip field as well: a weighted group chip in it names every tag
// inside the group ("(red hair, blue eyes:1.2)" excludes "red hair" and "blue eyes"),
// which is what its halves meant before the group became one chip.
function expandExcludeToken(token) {
    const group = splitGroupToken(token);
    if (!group || group.open !== '(' || group.before !== '' || group.after !== '') return [token];
    return splitPromptTokens(group.body).flatMap(expandExcludeToken);
}

export function filterPrompts(positivePrompt, positivePromptColored, exclude) {
    const excludeList = splitPromptTokens(exclude).flatMap(expandExcludeToken);

    if (excludeList.length === 0) {
        return { positivePrompt, positivePromptColored };
    }

    // Process positivePrompt directly while preserving \n and line-end commas
    const newPlainPrompt = processExcludedTags(positivePrompt, excludeList);

    // Process positivePromptColored with full tag and color cleanup
    const newColoredPrompt = processExcludedTags(positivePromptColored, excludeList);

    return {
        positivePrompt: newPlainPrompt,
        positivePromptColored: newColoredPrompt
    };
}