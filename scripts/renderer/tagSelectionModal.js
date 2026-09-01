import { sendWebSocketMessage } from '../webserver/front/wsRequest.js';
import { extractPromptKeyFromSuggestion, getTagFilterOptions, TAG_FILTERS } from './tagAutoComplete.js';
import { createSelectionModal } from './components/selectionModal.js';
import { insertTagsAtCursor, normalizePromptToken } from './components/selectionModalLogic.js';
import { tagText } from './components/tagUiText.js';

const DETAILED_TAG_FILTERS = TAG_FILTERS.filter(filter => filter.options?.category);

function stripMarkup(value) {
    return String(value ?? '').replaceAll(/<[^>]+>/g, '').replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&');
}

function categoryValueFromLabel(label) {
    return DETAILED_TAG_FILTERS.find(filter => filter.label === label)?.value || '';
}

// `<b>tag</b>: (alias1, 日本語alias) (heat) [G] [category]` — the aliases carry the
// active language's translations (tagAutoComplete_backend merges the translate CSV
// into aliases), so surfacing them here is what shows Japanese names in the list.
function extractAliasesFromSuggestion(plainText) {
    const afterKey = /^[^:]*:\s*\((.*?)\)\s*\(\d+\)/.exec(plainText);
    return afterKey?.[1]?.trim() || '';
}

function parseTagSuggestions(suggestions) {
    return (Array.isArray(suggestions) ? suggestions : []).map(item => {
        const markup = Array.isArray(item) ? item[0] : item;
        const key = extractPromptKeyFromSuggestion(String(markup ?? ''));
        if (!key) return null;
        const plainText = stripMarkup(markup);
        const categoryLabel = /\[([^\]]+)\]\s*$/.exec(plainText)?.[1] || '';
        const aliases = extractAliasesFromSuggestion(plainText);
        return {
            key,
            value: key,
            label: key.replaceAll('_', ' '),
            description: aliases,
            category: categoryValueFromLabel(categoryLabel),
            attributes: aliases ? aliases.split(',').map(alias => alias.trim()).filter(Boolean) : [],
        };
    }).filter(Boolean);
}

function promptSelection(value) {
    return String(value ?? '')
        .split(/[,\n]/)
        .map(token => token.trim())
        .filter(Boolean)
        .map(token => ({ key: token, value: token, label: token }));
}

function storedCursor(textbox, key, fallback) {
    const parsed = Number.parseInt(textbox.dataset[key], 10);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.max(0, Math.min(textbox.value.length, parsed));
}

async function requestTagOptions(query, category) {
    if (!query) return [];
    const filterValue = category || 'all';
    const filterOptions = getTagFilterOptions(filterValue);
    const params = filterOptions ? [query, filterOptions] : [query];
    const suggestions = globalThis.inBrowser
        ? await sendWebSocketMessage({ type: 'API', method: 'tagGet', params })
        : await globalThis.api.tagGet(...params);
    return parseTagSuggestions(suggestions);
}

function applyTagsToTextbox(textbox, selectedOptions, start, end) {
    const selectedTags = selectedOptions.map(option => option.value || option.key).filter(Boolean);
    const result = insertTagsAtCursor(textbox.value, selectedTags, start, end);
    if (result.value === textbox.value) return;
    textbox.setRangeText(result.value, 0, textbox.value.length, 'end');
    textbox.setSelectionRange(result.cursor, result.cursor);
    textbox.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: null }));
}

// fav_tags is split into a positive and a negative pool so negative-only tags
// (lowres, bad hands, …) never surface as favorites in positive-side fields.
function favGroupForKey(fieldKey) {
    return fieldKey === 'negative' || fieldKey === 'exclude' ? 'negative' : 'positive';
}

function favTagList(group) {
    const stored = globalThis.globalSettings?.fav_tags;
    return Array.isArray(stored?.[group]) ? stored[group] : [];
}

function favTagSet(group) {
    return new Set(favTagList(group).map(normalizePromptToken).filter(Boolean));
}

function toggleFavTag(group, option) {
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
}

function favoriteOptions(group) {
    return favTagList(group).map(tag => ({ key: tag, value: tag, label: tag.replaceAll('_', ' ') }));
}

export function setupTagSelectionModal(textboxes = [], keys = []) {
    const controls = [];
    let fieldIndex = -1;
    for (const textboxControl of textboxes) {
        fieldIndex++;
        const fieldKey = keys[fieldIndex] ?? 'positive';
        const favGroup = favGroupForKey(fieldKey);
        const textbox = textboxControl?.getElement?.();
        if (!textbox || textbox.dataset.tagModalSetup === 'true') continue;
        const wrapper = textbox.closest('.myTextbox-wrapper');
        const relativeContainer = textbox.parentElement;
        if (!wrapper || !relativeContainer) continue;

        const toolbar = document.createElement('div');
        toolbar.className = 'tag-selection-toolbar';
        const trigger = document.createElement('button');
        trigger.type = 'button';
        trigger.className = 'tag-selection-trigger';
        trigger.textContent = 'Choose tags';
        trigger.setAttribute('aria-haspopup', 'dialog');
        trigger.setAttribute('aria-expanded', 'false');
        toolbar.appendChild(trigger);
        wrapper.insertBefore(toolbar, relativeContainer);

        const modal = createSelectionModal({
            mode: 'multiple',
            categoryOptions: DETAILED_TAG_FILTERS.map(filter => ({ value: filter.value, label: filter.label })),
            emptyMessage: 'No matching tags.',
            searchPrompt: tagText('tag_ui_modal_search_prompt'),
            allowFreeInput: true,
            onOpen: () => trigger.setAttribute('aria-expanded', 'true'),
            onClose: () => trigger.setAttribute('aria-expanded', 'false'),
            onApply: selected => applyTagsToTextbox(
                textbox,
                selected,
                storedCursor(textbox, 'tagModalStart', textbox.value.length),
                storedCursor(textbox, 'tagModalEnd', textbox.value.length),
            ),
        });

        trigger.addEventListener('click', () => {
            const start = Number.isInteger(textbox.selectionStart) ? textbox.selectionStart : textbox.value.length;
            const end = Number.isInteger(textbox.selectionEnd) ? textbox.selectionEnd : start;
            textbox.dataset.tagModalStart = String(start);
            textbox.dataset.tagModalEnd = String(end);
            modal.open({
                trigger,
                fallback: textbox,
                selection: promptSelection(textbox.value),
                // empty query lists the field's favorites instead of nothing
                dynamicLoadOptions: async ({ query, category }) => (query
                    ? await requestTagOptions(query, category)
                    : favoriteOptions(favGroup)),
                favorites: {
                    isFavorite: key => favTagSet(favGroup).has(normalizePromptToken(key)),
                    toggle: option => toggleFavTag(favGroup, option),
                },
            });
        });

        textbox.dataset.tagModalSetup = 'true';
        controls.push({ textbox, trigger, modal });
    }
    return controls;
}

export { normalizePromptToken };
