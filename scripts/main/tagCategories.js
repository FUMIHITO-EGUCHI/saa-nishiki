import fs from 'node:fs';
import { COARSE_GROUP_FILTERS, E621_GROUP_IDS } from './tagCategoryConstants.js';

export { COARSE_GROUP_FILTERS, E621_GROUP_IDS };

export const TAG_CATEGORY_LABELS = Object.freeze({
    body: 'Body',
    pose_action: 'Pose / Action',
    clothing: 'Clothing',
    appearance: 'Appearance',
    object: 'Object',
    composition_quality: 'Composition / Quality',
    unknown: 'Unknown',
});

const VALID_CATEGORIES = new Set(Object.keys(TAG_CATEGORY_LABELS).filter(category => category !== 'unknown'));
const MAX_GROUP_FILTER_IDS = 32;

function normalizePromptKey(prompt) {
    return typeof prompt === 'string'
        ? prompt.trim().toLowerCase().replace(/\s+/g, '_')
        : '';
}

function normalizeGroupIds(groupIds) {
    if (!Array.isArray(groupIds)) return null;

    const ids = new Set();
    for (const groupId of groupIds.slice(0, MAX_GROUP_FILTER_IDS)) {
        if (Number.isInteger(groupId) && groupId >= 0) ids.add(groupId);
    }
    return ids.size > 0 ? [...ids] : null;
}

export function normalizeTagFilterOptions(options) {
    if (!options || typeof options !== 'object' || Array.isArray(options)) {
        return { groupIds: null, category: null };
    }

    const category = VALID_CATEGORIES.has(options.category) ? options.category : null;
    return {
        groupIds: normalizeGroupIds(options.groupIds),
        category,
    };
}

export function createTagCategoryIndex(categoryData) {
    const index = new Map();
    if (!categoryData || categoryData.schemaVersion !== 1 || !categoryData.tags || typeof categoryData.tags !== 'object') {
        return index;
    }

    for (const [prompt, record] of Object.entries(categoryData.tags)) {
        if (!normalizePromptKey(prompt) || !record || typeof record !== 'object') continue;
        if (record.status !== 'verified' || !VALID_CATEGORIES.has(record.category)) continue;
        // Two provenance forms are trusted: hand-checked wiki entries, and batch
        // LLM assignments that passed the categorizeTags.mjs verification pass.
        const isWiki = record.source === 'Danbooru Wiki'
            && typeof record.sourceUrl === 'string'
            && record.sourceUrl.startsWith('https://danbooru.donmai.us/wiki_pages/');
        const isLlm = record.source === 'LLM' && typeof record.model === 'string' && record.model !== '';
        if (!isWiki && !isLlm) continue;
        index.set(normalizePromptKey(prompt), record.category);
    }

    return index;
}

export function loadTagCategories(filePath) {
    try {
        const categoryData = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        return createTagCategoryIndex(categoryData);
    } catch {
        return new Map();
    }
}

export function getCategoryForPrompt(categoryIndex, prompt) {
    return categoryIndex instanceof Map
        ? categoryIndex.get(normalizePromptKey(prompt)) || 'unknown'
        : 'unknown';
}

export function getCategoryLabel(category) {
    return TAG_CATEGORY_LABELS[category] || TAG_CATEGORY_LABELS.unknown;
}

export function createTagFilterMatcher(options, categoryIndex) {
    const { groupIds, category } = normalizeTagFilterOptions(options);

    return (promptInfo) => {
        if (!promptInfo || typeof promptInfo !== 'object') return false;
        if (groupIds !== null && !groupIds.includes(promptInfo.group)) return false;
        if (category !== null && getCategoryForPrompt(categoryIndex, promptInfo.prompt) !== category) return false;
        return true;
    };
}

export function matchesPromptInfo(promptInfo, options, categoryIndex) {
    return createTagFilterMatcher(options, categoryIndex)(promptInfo);
}

export { VALID_CATEGORIES };
