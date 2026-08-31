import { sendWebSocketMessage } from '../webserver/front/wsRequest.js';
import { extractPromptKeyFromSuggestion, getTagFilterOptions, TAG_FILTERS } from './tagAutoComplete.js';
import { createSelectionModal } from './components/selectionModal.js';
import { insertTagsAtCursor, normalizePromptToken } from './components/selectionModalLogic.js';

const DETAILED_TAG_FILTERS = TAG_FILTERS.filter(filter => filter.options?.category);

function stripMarkup(value) {
    return String(value ?? '').replaceAll(/<[^>]+>/g, '').replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&');
}

function categoryValueFromLabel(label) {
    return DETAILED_TAG_FILTERS.find(filter => filter.label === label)?.value || '';
}

function parseTagSuggestions(suggestions) {
    return (Array.isArray(suggestions) ? suggestions : []).map(item => {
        const markup = Array.isArray(item) ? item[0] : item;
        const key = extractPromptKeyFromSuggestion(String(markup ?? ''));
        if (!key) return null;
        const plainText = stripMarkup(markup);
        const categoryLabel = /\[([^\]]+)\]\s*$/.exec(plainText)?.[1] || '';
        return {
            key,
            value: key,
            label: key.replaceAll('_', ' '),
            category: categoryValueFromLabel(categoryLabel),
            attributes: [],
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

export function setupTagSelectionModal(textboxes = []) {
    const controls = [];
    for (const textboxControl of textboxes) {
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
            searchPrompt: 'Enter a tag or character name to search.',
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
                dynamicLoadOptions: ({ query, category }) => requestTagOptions(query, category),
            });
        });

        textbox.dataset.tagModalSetup = 'true';
        controls.push({ textbox, trigger, modal });
    }
    return controls;
}

export { normalizePromptToken };
