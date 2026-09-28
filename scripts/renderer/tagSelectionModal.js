import { sendWebSocketMessage } from '../webserver/front/wsRequest.js';
import { extractPromptKeyFromSuggestion, getTagFilterOptions, PAGE_SIZE, TAG_FILTERS } from './tagAutoComplete.js';
import { createSelectionModal } from './components/selectionModal.js';
import { insertTagsAtCursor, normalizePromptToken } from './components/selectionModalLogic.js';
import { tagText } from './components/tagUiText.js';
import { favGroupForKey, favoriteOptions, isFavoriteTag, toggleFavTag } from './components/favoriteTags.js';
import { aliasesFor } from './tagAliasClient.js';
import { PART_PREFIX, partNameOf } from '../shared/parts.js';

const DETAILED_TAG_FILTERS = TAG_FILTERS.filter(filter => filter.options?.category);

// The rows whose tag modal carries no Parts tab: a part is a bundle of tags, not a
// cast list or an Action sentence (promptFieldManager marks those rows)
const NO_PARTS_FIELDS = new Set(['characters']);

// The Parts tab of a row's modal, from partsUi.js when it is set up (globalThis, as the
// row tools reach it: partsUi imports this module for its own tag picker)
function fieldTabs(fieldKey, textbox, trigger) {
    if (NO_PARTS_FIELDS.has(fieldKey) || textbox?.closest?.('.prompt-action-field')) return [];
    const tab = globalThis.partsUi?.pickerTab?.({ fieldKey, trigger });
    return tab ? [tab] : [];
}

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

// The row's tokens as the modal's Selected chips; a part token gets the part chip's dress
function promptSelection(value) {
    return String(value ?? '')
        .split(/[,\n]/)
        .map(token => token.trim())
        .filter(Boolean)
        .map(token => {
            const name = partNameOf(normalizePromptToken(token));
            if (name === null) return { key: token, value: token, label: token };
            return { key: token, value: token, label: name, prefix: PART_PREFIX, chipClass: 'is-part' };
        });
}

function storedCursor(textbox, key, fallback) {
    const parsed = Number.parseInt(textbox.dataset[key], 10);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.max(0, Math.min(textbox.value.length, parsed));
}

// One page of the tags matching `query`: { items, total }; the modal asks for the
// next page (offset = rows it has) as its list is scrolled.
async function requestTagOptions(query, category, offset = 0) {
    if (!query) return { items: [], total: 0 };
    const filterOptions = getTagFilterOptions(category || 'all') || {};
    const params = [query, { ...filterOptions, offset, limit: PAGE_SIZE }];
    const answer = globalThis.inBrowser
        ? await sendWebSocketMessage({ type: 'API', method: 'tagSearch', params })
        : await globalThis.api.tagSearch(...params);
    const items = parseTagSuggestions(answer?.items);
    return { items, total: Number.isInteger(answer?.total) ? answer.total : items.length };
}

// The favorites list with each tag's translation on its description line, as a search
// result row has it (the favorites are stored as bare tags).
async function favoriteOptionsWithAliases(favGroup) {
    const options = favoriteOptions(favGroup);
    const translations = await aliasesFor(options.map(option => option.value));
    return options.map(option => {
        const description = translations.get(option.value) || '';
        return description ? { ...option, description, attributes: [description] } : option;
    });
}

// What the picker hands the modal for a search: the first page plus a loader for the
// next ones; an empty query lists the favorites instead. `filter` narrows the rows
// (single-tag options only, for the list editor).
function tagPageLoader(favGroup, filter = options => options) {
    return async ({ query, category }) => {
        if (!query) return filter(await favoriteOptionsWithAliases(favGroup));
        const page = await requestTagOptions(query, category, 0);
        return {
            items: filter(page.items),
            total: page.total,
            loadMore: async offset => filter((await requestTagOptions(query, category, offset)).items),
        };
    };
}

function applyTagsToTextbox(textbox, selectedOptions, start, end) {
    const selectedTags = selectedOptions.map(option => option.value || option.key).filter(Boolean);
    const result = insertTagsAtCursor(textbox.value, selectedTags, start, end);
    if (result.value === textbox.value) return;
    textbox.setRangeText(result.value, 0, textbox.value.length, 'end');
    textbox.setSelectionRange(result.cursor, result.cursor);
    textbox.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: null }));
}

// "1 tag = 1 prompt" candidates only: list entries expand to whole prompts, so anything
// that itself expands further is not offered inside one — multi-tag favorites (commas /
// newlines), __wildcard__ tokens and {a|b} random blocks. Free typing in the target
// textarea stays unrestricted; this only filters what the picker proposes.
function isSingleTagOption(option) {
    const value = String(option?.value ?? option?.key ?? '').trim();
    return value !== ''
        && !value.includes(',')
        && !value.includes('\n')
        && !/__[a-zA-Z0-9_-]+__/.test(value)
        && !value.includes('{');
}

// Shared pickers for plain textareas outside the prompt-field set (e.g. the list
// manager's entry editor). One modal per favGroup / restriction combo; the active
// textbox is swapped in on open.
const sharedPickers = new Map();

export function openTagPicker(textbox, { favGroup = 'positive', singleTagsOnly = false, trigger = null } = {}) {
    if (!textbox) return;
    const cacheKey = `${favGroup}|${singleTagsOnly ? 1 : 0}`;
    let picker = sharedPickers.get(cacheKey);
    if (!picker) {
        picker = { textbox: null };
        picker.modal = createSelectionModal({
            mode: 'multiple',
            categoryOptions: DETAILED_TAG_FILTERS.map(filter => ({ value: filter.value, label: filter.label })),
            emptyMessage: 'No matching tags.',
            searchPrompt: tagText('tag_ui_modal_search_prompt'),
            allowFreeInput: true,
            onApply: selected => {
                const target = picker.textbox;
                if (!target) return;
                applyTagsToTextbox(
                    target,
                    selected,
                    storedCursor(target, 'tagModalStart', target.value.length),
                    storedCursor(target, 'tagModalEnd', target.value.length),
                );
            },
        });
        sharedPickers.set(cacheKey, picker);
    }
    picker.textbox = textbox;
    const start = Number.isInteger(textbox.selectionStart) ? textbox.selectionStart : textbox.value.length;
    const end = Number.isInteger(textbox.selectionEnd) ? textbox.selectionEnd : start;
    textbox.dataset.tagModalStart = String(start);
    textbox.dataset.tagModalEnd = String(end);
    const filter = singleTagsOnly ? options => options.filter(isSingleTagOption) : options => options;
    picker.modal.open({
        trigger: trigger ?? textbox,
        fallback: textbox,
        selection: promptSelection(textbox.value),
        dynamicLoadOptions: tagPageLoader(favGroup, filter),
        favorites: {
            isFavorite: key => isFavoriteTag(favGroup, key),
            toggle: option => toggleFavTag(favGroup, option),
        },
    });
}

// The prompt rows' modals by field key (setupTagSelectionModal), for a caller that
// opens one from its own button - the row's "parts" button opens it on the Parts tab.
const fieldControls = new Map();

/**
 * Open a prompt row's tag modal at the end of the row. `tab` = the tab to open on
 * ('parts'), null for the tag list. False when the row has no modal.
 */
export function openFieldTagModal(fieldKey, { tab = null, trigger = null } = {}) {
    const control = fieldControls.get(fieldKey);
    if (!control) return false;
    const { textbox } = control;
    const length = textbox.value.length;
    try { textbox.setSelectionRange(length, length); } catch { /* not focusable right now */ }
    control.openWith({ tab, trigger: trigger ?? control.trigger });
    return true;
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
            // the row's modal (Tags | Parts) is sized by the window; the Parts grid needs the room
            fitWindow: true,
            onOpen: () => trigger.setAttribute('aria-expanded', 'true'),
            onClose: () => trigger.setAttribute('aria-expanded', 'false'),
            onApply: selected => applyTagsToTextbox(
                textbox,
                selected,
                storedCursor(textbox, 'tagModalStart', textbox.value.length),
                storedCursor(textbox, 'tagModalEnd', textbox.value.length),
            ),
        });

        // `tab`: the tab to open on (null = the tag list); `source`: the button that
        // opened it, which gets the focus back
        const openWith = ({ tab = null, trigger: source = trigger } = {}) => {
            const start = Number.isInteger(textbox.selectionStart) ? textbox.selectionStart : textbox.value.length;
            const end = Number.isInteger(textbox.selectionEnd) ? textbox.selectionEnd : start;
            textbox.dataset.tagModalStart = String(start);
            textbox.dataset.tagModalEnd = String(end);
            modal.open({
                trigger: source,
                fallback: textbox,
                selection: promptSelection(textbox.value),
                // empty query lists the field's favorites instead of nothing
                dynamicLoadOptions: tagPageLoader(favGroup),
                favorites: {
                    isFavorite: key => isFavoriteTag(favGroup, key),
                    toggle: option => toggleFavTag(favGroup, option),
                },
                // the Parts tab beside the tags: the search box, the filters, Selected and
                // Apply stay in place; a picked part is applied as its parts: token
                tabs: fieldTabs(fieldKey, textbox, source),
                tab,
                tabLabel: tagText('tag_ui_tab_tags'),
            });
        };
        trigger.addEventListener('click', () => openWith());

        textbox.dataset.tagModalSetup = 'true';
        const control = { textbox, trigger, modal, openWith };
        fieldControls.set(fieldKey, control);
        controls.push(control);
    }
    return controls;
}

export { normalizePromptToken };
