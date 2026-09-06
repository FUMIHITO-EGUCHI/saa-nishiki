// Shared favorite-tag store helpers. fav_tags is split into a positive and a
// negative pool so negative-only tags (lowres, bad hands, …) never surface as
// favorites in positive-side fields.
import { normalizePromptToken } from './selectionModalLogic.js';

export const FAVORITE_TAGS_CHANGED_EVENT = 'saa-favorite-tags-changed';

export function favGroupForKey(fieldKey) {
    return fieldKey === 'negative' || fieldKey === 'negative_left' || fieldKey === 'negative_right' || fieldKey === 'exclude' ? 'negative' : 'positive';
}

export function favTagList(group) {
    const stored = globalThis.globalSettings?.fav_tags;
    return Array.isArray(stored?.[group]) ? stored[group] : [];
}

export function favTagSet(group) {
    return new Set(favTagList(group).map(normalizePromptToken).filter(Boolean));
}

export function isFavoriteTag(group, value) {
    return favTagSet(group).has(normalizePromptToken(value));
}

export function toggleFavTag(group, option) {
    const settings = globalThis.globalSettings;
    if (!settings) return;
    const tag = String(option?.value ?? option?.key ?? '').trim();
    const normalized = normalizePromptToken(tag);
    if (!normalized) return;
    const list = favTagList(group);
    const next = favTagSet(group).has(normalized)
        ? list.filter(item => normalizePromptToken(item) !== normalized)
        : [...list, tag].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
    settings.fav_tags = { positive: favTagList('positive'), negative: favTagList('negative'), [group]: next };
    document.dispatchEvent(new CustomEvent(FAVORITE_TAGS_CHANGED_EVENT, { detail: { group } }));
}

export function favoriteOptions(group) {
    return favTagList(group).map(tag => ({ key: tag, value: tag, label: tag.replaceAll('_', ' ') }));
}
