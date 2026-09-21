import { pagedCountText, tagText } from './tagUiText.js';
import {
    filterSelectionOptions,
    limitSelectionOptions,
    normalizeSelectionKey,
    removeSelectedOption,
    selectOption,
} from './selectionModalLogic.js';

const FOCUSABLE_SELECTOR = [
    'button:not([disabled])',
    'input:not([disabled])',
    'select:not([disabled])',
    '[tabindex]:not([tabindex="-1"])',
].join(',');

const DEFAULT_LIMIT = 200;
let modalSequence = 0;

function optionKey(option) {
    return normalizeSelectionKey(option?.key ?? option?.value ?? '');
}

function optionLabel(option) {
    const label = typeof option?.label === 'function' ? option.label() : option?.label;
    return String(label ?? option?.value ?? option?.key ?? '');
}

function createElement(tagName, className, text = '') {
    const element = document.createElement(tagName);
    if (className) element.className = className;
    if (text) element.textContent = text;
    return element;
}

function normalizeSelectOptions(options) {
    return (Array.isArray(options) ? options : []).map(option => {
        if (typeof option === 'string') return { value: option, label: option };
        return { value: option.value, label: option.label ?? option.value };
    }).filter(option => option.value);
}

export function createSelectionModal({
    mode = 'single',
    title = 'Select',
    categoryOptions = [],
    attributeOptions = [],
    optionLimit = DEFAULT_LIMIT,
    emptyMessage = 'No matching items.',
    searchPrompt = 'Enter a search term to find items.',
    allowFreeInput = false,
    onApply = null,
    onOpen = null,
    onClose = null,
    onOptionHover = null,
    // fires whenever the highlighted row changes, by mouse or by keyboard, so a caller can
    // bind a side panel to it (null when nothing is highlighted)
    onActiveOption = null,
    onOptionLeave = null,
    loadOptions = null,
} = {}) {
    const id = `selection-modal-${++modalSequence}`;
    const overlay = createElement('div', 'selection-modal');
    overlay.hidden = true;
    overlay.setAttribute('aria-hidden', 'true');

    const dialog = createElement('div', 'selection-modal-dialog');
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-labelledby', `${id}-title`);
    dialog.tabIndex = -1;

    const header = createElement('header', 'selection-modal-header');
    const heading = createElement('h2', 'selection-modal-title');
    heading.id = `${id}-title`;
    header.appendChild(heading);
    const closeButton = createElement('button', 'selection-modal-close', '×');
    closeButton.type = 'button';
    closeButton.setAttribute('aria-label', 'Close');
    header.appendChild(closeButton);
    dialog.appendChild(header);

    const toolbar = createElement('div', 'selection-modal-toolbar');
    const searchLabel = createElement('label', 'selection-modal-search-label', 'Search');
    const searchInput = createElement('input', 'selection-modal-search');
    searchInput.type = 'search';
    searchInput.id = `${id}-search`;
    searchInput.placeholder = 'Search by name or tag';
    searchInput.setAttribute('aria-label', 'Search');
    searchLabel.appendChild(searchInput);
    toolbar.appendChild(searchLabel);

    const categoryLabel = createElement('label', 'selection-modal-filter-label', 'Category');
    const categorySelect = createElement('select', 'selection-modal-filter');
    categorySelect.id = `${id}-category`;
    categorySelect.setAttribute('aria-label', 'Category');
    categoryLabel.appendChild(categorySelect);
    toolbar.appendChild(categoryLabel);

    const attributeLabel = createElement('label', 'selection-modal-filter-label', 'Attribute');
    const attributeSelect = createElement('select', 'selection-modal-filter');
    attributeSelect.id = `${id}-attribute`;
    attributeSelect.setAttribute('aria-label', 'Attribute');
    attributeLabel.appendChild(attributeSelect);
    toolbar.appendChild(attributeLabel);

    const favOnlyButton = createElement('button', 'selection-modal-favonly', '★');
    favOnlyButton.type = 'button';
    favOnlyButton.hidden = true;
    favOnlyButton.setAttribute('aria-pressed', 'false');
    toolbar.appendChild(favOnlyButton);
    dialog.appendChild(toolbar);

    const selectedSection = createElement('section', 'selection-modal-selected');
    const selectedHeading = createElement('h3', 'selection-modal-section-title', 'Selected');
    selectedSection.appendChild(selectedHeading);
    const selectedList = createElement('div', 'selection-modal-selected-list');
    selectedList.setAttribute('aria-label', 'Selected items');
    selectedSection.appendChild(selectedList);
    dialog.appendChild(selectedSection);

    const status = createElement('div', 'selection-modal-status');
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    dialog.appendChild(status);

    const listbox = createElement('div', 'selection-modal-list');
    listbox.id = `${id}-listbox`;
    listbox.setAttribute('role', 'listbox');
    listbox.tabIndex = 0;
    if (mode === 'multiple') listbox.setAttribute('aria-multiselectable', 'true');
    dialog.appendChild(listbox);

    const footer = createElement('footer', 'selection-modal-footer');
    const footerNote = createElement('span', 'selection-modal-footer-note');
    footerNote.hidden = mode !== 'multiple';
    const cancelButton = createElement('button', 'selection-modal-cancel', 'Cancel');
    cancelButton.type = 'button';
    const applyButton = createElement('button', 'selection-modal-apply', 'Apply');
    applyButton.type = 'button';
    footer.append(footerNote, cancelButton, applyButton);
    dialog.appendChild(footer);

    overlay.appendChild(createElement('div', 'selection-modal-backdrop'));
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);

    let currentOptions = [];
    let visibleOptions = [];
    let selectedOptions = [];
    let activeIndex = -1;
    let lastTrigger = null;
    let fallbackFocus = null;
    let requestGeneration = 0;
    let searchTimer = null;
    let favOnly = false;
    let pager = null;
    let activeConfig = { categories: [], attributes: [], onOptionHover, onOptionLeave, onActiveOption, favorites: null };

    function isFavoriteOption(option) {
        return Boolean(activeConfig.favorites?.isFavorite?.(optionKey(option)));
    }

    // Favorites are narrowed with the Fav-only button; the search text is taken as
    // written ('@' is a cast reference elsewhere and no longer a search prefix).
    function effectiveSearch() {
        return { query: searchInput.value, favoritesOnly: favOnly };
    }

    function renderFavOnlyButton() {
        favOnlyButton.hidden = !activeConfig.favorites;
        favOnlyButton.classList.toggle('is-on', favOnly);
        favOnlyButton.setAttribute('aria-pressed', String(favOnly));
        favOnlyButton.title = tagText('tag_ui_fav_only');
        favOnlyButton.setAttribute('aria-label', tagText('tag_ui_fav_only'));
    }

    function isOpen() {
        return !overlay.hidden;
    }

    function setFilterOptions(select, options, includeAllLabel) {
        select.replaceChildren();
        const allOption = document.createElement('option');
        allOption.value = '';
        allOption.textContent = includeAllLabel;
        select.appendChild(allOption);
        for (const option of normalizeSelectOptions(options)) {
            const element = document.createElement('option');
            element.value = option.value;
            element.textContent = option.label;
            select.appendChild(element);
        }
        select.parentElement.hidden = select.options.length <= 1;
    }

    function selectedKeys() {
        return new Set(selectedOptions.map(optionKey).filter(Boolean));
    }

    function renderApplyLabel() {
        applyButton.textContent = mode === 'multiple' && selectedOptions.length > 0
            ? tagText('tag_ui_apply_count', selectedOptions.length)
            : tagText('tag_ui_apply');
        cancelButton.textContent = tagText('tag_ui_cancel');
        footerNote.textContent = tagText('tag_ui_modal_note');
    }

    function renderSelected() {
        renderApplyLabel();
        selectedList.replaceChildren();
        if (selectedOptions.length === 0) {
            selectedList.appendChild(createElement('span', 'selection-modal-no-selection', 'None'));
            return;
        }
        for (const option of selectedOptions) {
            const chip = createElement('span', 'selection-modal-chip');
            chip.appendChild(createElement('span', 'selection-modal-chip-label', optionLabel(option)));
            const removeButton = createElement('button', 'selection-modal-chip-remove', '×');
            removeButton.type = 'button';
            removeButton.setAttribute('aria-label', `Remove ${optionLabel(option)}`);
            removeButton.addEventListener('click', () => {
                selectedOptions = removeSelectedOption(selectedOptions, optionKey(option));
                renderSelected();
                renderOptions();
            });
            chip.appendChild(removeButton);
            selectedList.appendChild(chip);
        }
    }

    function updateActiveDescendant({ scroll = true } = {}) {
        const item = visibleOptions[activeIndex];
        activeConfig.onActiveOption?.(item ?? null);
        if (!item) {
            listbox.removeAttribute('aria-activedescendant');
            return;
        }
        const itemId = `${id}-option-${activeIndex}`;
        listbox.setAttribute('aria-activedescendant', itemId);
        if (scroll) listbox.querySelector(`#${CSS.escape(itemId)}`)?.scrollIntoView({ block: 'nearest' });
    }

    function renderStatus(totalCount, hasMore) {
        if (totalCount === 0 && !(pager && pager.total > 0)) {
            status.textContent = searchInput.value.trim() ? emptyMessage : searchPrompt;
            return;
        }
        const hint = mode === 'multiple' ? ` · ${tagText('tag_ui_modal_hint')}` : '';
        if (pager) {
            // a paged answer: what is on screen out of everything the search matched
            status.textContent = `${pagedCountText(currentOptions.length, Math.max(pager.total, currentOptions.length))}${hint}`;
            return;
        }
        status.textContent = hasMore
            ? `${totalCount} results shown. Refine your search to see more.${hint}`
            : `${totalCount} result${totalCount === 1 ? '' : 's'}${hint}`;
    }

    // A loader may answer with a page instead of a list: { items, total, loadMore(offset) }.
    // The list then grows as it is scrolled (or arrowed) to its end, and the client-side
    // cut of optionLimit is left to the loader.
    function takeLoaded(answer) {
        if (answer && !Array.isArray(answer) && Array.isArray(answer.items)) {
            const total = Number.isInteger(answer.total) ? answer.total : answer.items.length;
            pager = typeof answer.loadMore === 'function' && total > answer.items.length
                ? { total, loadMore: answer.loadMore, loading: false }
                : { total, loadMore: null, loading: false };
            return answer.items;
        }
        pager = null;
        return Array.isArray(answer) ? answer : [];
    }

    function hasMorePages() {
        return Boolean(pager?.loadMore) && !pager.loading && currentOptions.length < pager.total;
    }

    async function loadNextPage() {
        if (!hasMorePages()) return;
        const generation = requestGeneration;
        const page = pager;
        page.loading = true;
        try {
            const more = await page.loadMore(currentOptions.length);
            if (generation !== requestGeneration || !isOpen() || pager !== page) return;
            const items = Array.isArray(more) ? more : [];
            if (items.length === 0) page.total = currentOptions.length;   // the loader ran dry
            currentOptions = currentOptions.concat(items);
            renderOptions({ scrollActive: false });
        } catch (error) {
            console.error('[SelectionModal] Failed to load the next page:', error);
        } finally {
            page.loading = false;
        }
    }

    function renderOptions({ scrollActive = true } = {}) {
        const { query, favoritesOnly } = effectiveSearch();
        let filteredOptions = filterSelectionOptions(currentOptions, {
            query,
            category: categorySelect.value,
            attribute: attributeSelect.value,
        });
        if (activeConfig.favorites) {
            if (favoritesOnly) filteredOptions = filteredOptions.filter(option => isFavoriteOption(option));
            // stable sort: favorites first, source order preserved otherwise
            filteredOptions = filteredOptions
                .map((option, index) => ({ option, index, fav: isFavoriteOption(option) ? 0 : 1 }))
                .sort((a, b) => a.fav - b.fav || a.index - b.index)
                .map(entry => entry.option);
        }
        const limited = limitSelectionOptions(filteredOptions, pager ? Number.MAX_SAFE_INTEGER : optionLimit);
        visibleOptions = limited.items;
        // the list is redrawn in place (a page arrived, a row was toggled): the redraw
        // empties the box, which drops its scroll, so the position is put back after
        const scrollTop = listbox.scrollTop;
        listbox.replaceChildren();
        const selected = selectedKeys();
        visibleOptions.forEach((option, index) => {
            const item = createElement('div', 'selection-modal-option');
            item.id = `${id}-option-${index}`;
            item.setAttribute('role', 'option');
            item.setAttribute('aria-selected', String(selected.has(optionKey(option))));
            item.dataset.index = String(index);
            item.dataset.key = optionKey(option);
            const labelSpan = createElement('span', 'selection-modal-option-label', optionLabel(option));
            const description = typeof option.description === 'function' ? option.description() : option.description;
            if (description) {
                labelSpan.appendChild(createElement('span', 'selection-modal-option-desc', ` ${description}`));
            }
            item.appendChild(labelSpan);
            if (option.category) item.appendChild(createElement('span', 'selection-modal-option-category', option.category));
            if (activeConfig.favorites) {
                const favButton = createElement('button', 'selection-modal-option-fav');
                favButton.type = 'button';
                favButton.tabIndex = -1;
                const isFav = isFavoriteOption(option);
                item.classList.toggle('is-fav', isFav);
                favButton.classList.toggle('is-fav', isFav);
                favButton.textContent = isFav ? '★' : '☆';
                favButton.title = tagText(isFav ? 'tag_ui_fav_remove' : 'tag_ui_fav_add', optionLabel(option));
                favButton.setAttribute('aria-label', favButton.title);
                item.appendChild(favButton);
            }
            item.addEventListener('mouseenter', () => activeConfig.onOptionHover?.(option, item));
            item.addEventListener('mouseleave', () => activeConfig.onOptionLeave?.(option, item));
            listbox.appendChild(item);
        });
        listbox.scrollTop = scrollTop;
        activeIndex = visibleOptions.length === 0 ? -1 : Math.min(Math.max(activeIndex, 0), visibleOptions.length - 1);
        // the active row is scrolled into view when the list is (re)built for a search
        // or a toggle - not when a page is appended to a list the mouse scrolled down,
        // which threw the list back up to the active row (the first) every 50 rows
        updateActiveDescendant({ scroll: scrollActive });
        renderStatus(filteredOptions.length, limited.hasMore);
    }

    async function refreshOptions() {
        const generation = ++requestGeneration;
        const config = {
            query: effectiveSearch().query.trim(),
            category: categorySelect.value,
            attribute: attributeSelect.value,
        };
        let nextOptions = currentOptions;
        if (typeof activeConfig.loadOptions === 'function') {
            nextOptions = await activeConfig.loadOptions(config);
        }
        if (generation !== requestGeneration || !isOpen()) return;
        currentOptions = typeof activeConfig.loadOptions === 'function' ? takeLoaded(nextOptions) : currentOptions;
        listbox.scrollTop = 0;
        activeIndex = -1;
        renderOptions();
    }

    function scheduleRefresh() {
        clearTimeout(searchTimer);
        searchTimer = setTimeout(() => refreshOptions().catch(error => {
            console.error('[SelectionModal] Failed to load options:', error);
            currentOptions = [];
            renderOptions();
        }), 120);
    }

    function restoreFocus() {
        const target = lastTrigger?.isConnected ? lastTrigger : fallbackFocus;
        if (target && typeof target.focus === 'function') {
            target.focus();
        } else {
            document.body.tabIndex = -1;
            document.body.focus();
        }
        lastTrigger = null;
        fallbackFocus = null;
    }

    function close({ apply }) {
        if (!isOpen()) return;
        if (apply && typeof onApply === 'function') onApply(selectedOptions.slice());
        activeConfig.onOptionLeave?.();
        overlay.hidden = true;
        overlay.setAttribute('aria-hidden', 'true');
        document.removeEventListener('keydown', onDialogKeyDown);
        clearTimeout(searchTimer);
        if (typeof onClose === 'function') onClose({ apply });
        restoreFocus();
    }

    function moveActive(delta) {
        if (visibleOptions.length === 0) return;
        // at the end of a paged list the arrow fetches the next page instead of wrapping
        if (delta > 0 && activeIndex === visibleOptions.length - 1 && hasMorePages()) {
            loadNextPage();
            return;
        }
        activeIndex = (activeIndex + delta + visibleOptions.length) % visibleOptions.length;
        updateActiveDescendant();
    }

    function toggleActive() {
        const option = visibleOptions[activeIndex];
        if (!option) return;
        selectedOptions = selectOption(selectedOptions, option, mode);
        renderSelected();
        renderOptions();
        if (mode === 'single') listbox.focus();
    }

    function onDialogKeyDown(event) {
        if (event.key === 'Escape') {
            if (event.isComposing || event.keyCode === 229) return;
            event.preventDefault();
            close({ apply: false });
            return;
        }
        if (event.key === 'Tab') {
            const focusable = [...dialog.querySelectorAll(FOCUSABLE_SELECTOR)]
                .filter(element => element.getClientRects().length > 0);
            if (focusable.length === 0) {
                event.preventDefault();
                dialog.focus();
                return;
            }
            const first = focusable[0];
            const last = focusable.at(-1);
            if (event.shiftKey && document.activeElement === first) {
                event.preventDefault();
                last.focus();
            } else if (!event.shiftKey && document.activeElement === last) {
                event.preventDefault();
                first.focus();
            }
        }
    }

    searchInput.addEventListener('input', scheduleRefresh);
    searchInput.addEventListener('keydown', event => {
        if (event.key === 'ArrowDown') {
            event.preventDefault();
            listbox.focus();
            if (activeIndex < 0 && visibleOptions.length > 0) activeIndex = 0;
            updateActiveDescendant();
        } else if (event.key === 'Enter') {
            if (event.isComposing || event.keyCode === 229) return;
            event.preventDefault();
            const query = searchInput.value.trim();
            const queryKey = normalizeSelectionKey(query);
            const exactIndex = visibleOptions.findIndex(option => optionKey(option) === queryKey);
            if (exactIndex >= 0) {
                activeIndex = exactIndex;
                toggleActive();
            } else if (visibleOptions.length === 1) {
                activeIndex = 0;
                toggleActive();
            } else if (allowFreeInput && queryKey) {
                // unknown text becomes a free-form tag in the selection
                selectedOptions = selectOption(selectedOptions, { key: query, value: query, label: query }, mode);
                renderSelected();
                renderOptions();
                searchInput.value = '';
                scheduleRefresh();
            }
        }
    });
    favOnlyButton.addEventListener('click', () => {
        favOnly = !favOnly;
        renderFavOnlyButton();
        renderOptions();
    });
    categorySelect.addEventListener('change', scheduleRefresh);
    attributeSelect.addEventListener('change', scheduleRefresh);
    listbox.addEventListener('click', event => {
        const item = event.target.closest('[role="option"]');
        if (!item) return;
        const index = Number.parseInt(item.dataset.index, 10);
        if (event.target.closest('.selection-modal-option-fav')) {
            const option = visibleOptions[index];
            if (option && activeConfig.favorites?.toggle) {
                activeConfig.favorites.toggle(option);
                renderOptions();
            }
            return;
        }
        activeIndex = index;
        toggleActive();
    });
    listbox.addEventListener('scroll', () => {
        if (listbox.scrollTop + listbox.clientHeight >= listbox.scrollHeight - 32) loadNextPage();
    });
    listbox.addEventListener('keydown', event => {
        if (event.key === 'ArrowDown') {
            event.preventDefault();
            moveActive(1);
        } else if (event.key === 'ArrowUp') {
            event.preventDefault();
            moveActive(-1);
        } else if (event.key === 'Home') {
            event.preventDefault();
            activeIndex = visibleOptions.length > 0 ? 0 : -1;
            updateActiveDescendant();
        } else if (event.key === 'End') {
            event.preventDefault();
            activeIndex = visibleOptions.length - 1;
            updateActiveDescendant();
        } else if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            toggleActive();
        }
    });

    closeButton.addEventListener('click', () => close({ apply: false }));
    cancelButton.addEventListener('click', () => close({ apply: false }));
    applyButton.addEventListener('click', () => close({ apply: true }));

    return {
        open({
            trigger = null,
            fallback = null,
            selection = [],
            options = [],
            categories = categoryOptions,
            attributes = attributeOptions,
            modalTitle = title,
            dynamicLoadOptions = loadOptions,
            favorites = null,
        } = {}) {
            lastTrigger = trigger;
            fallbackFocus = fallback;
            activeConfig = {
                categories,
                attributes,
                onOptionHover,
                onActiveOption,
                onOptionLeave,
                loadOptions: dynamicLoadOptions,
                favorites: favorites && typeof favorites.isFavorite === 'function' ? favorites : null,
            };
            favOnly = false;
            renderFavOnlyButton();
            heading.textContent = modalTitle;
            setFilterOptions(categorySelect, categories, 'All categories');
            setFilterOptions(attributeSelect, attributes, 'All attributes');
            searchInput.value = '';
            categorySelect.value = '';
            attributeSelect.value = '';
            selectedOptions = Array.isArray(selection) ? selection.slice() : [];
            currentOptions = Array.isArray(options) ? options.slice() : [];
            pager = null;
            activeIndex = -1;
            overlay.hidden = false;
            overlay.setAttribute('aria-hidden', 'false');
            document.addEventListener('keydown', onDialogKeyDown);
            if (typeof onOpen === 'function') onOpen();
            renderSelected();
            renderOptions();
            requestAnimationFrame(() => {
                searchInput.focus();
                const selected = selectedKeys();
                const firstSelectedIndex = visibleOptions.findIndex(option => selected.has(optionKey(option)));
                if (firstSelectedIndex >= 0) {
                    activeIndex = firstSelectedIndex;
                    updateActiveDescendant();
                }
            });
            if (typeof dynamicLoadOptions === 'function') scheduleRefresh();
        },
        close: () => close({ apply: false }),
        apply: () => close({ apply: true }),
        isOpen,
        element: overlay,
        destroy: () => {
            close({ apply: false });
            overlay.remove();
        },
    };
}
