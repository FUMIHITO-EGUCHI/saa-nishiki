import { pagedCountText, tagText } from './tagUiText.js';
import {
    clampDialogSize,
    dialogSizeKey,
    filterSelectionOptions,
    limitSelectionOptions,
    normalizeSelectionKey,
    readStoredPreference,
    readStoredSize,
    removeSelectedOption,
    selectOption,
    writeStoredPreference,
    writeStoredSize,
} from './selectionModalLogic.js';

const NARROW_DIALOG = 1400;    // under this width the rail and the panel take their narrow widths

const FOCUSABLE_SELECTOR = [
    'button:not([disabled])',
    'input:not([disabled])',
    'select:not([disabled])',
    '[tabindex]:not([tabindex="-1"])',
].join(',');

const DEFAULT_LIMIT = 200;
let modalSequence = 0;

const DOCUMENT_POSITION_FOLLOWING = 4; // Node.DOCUMENT_POSITION_FOLLOWING

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
    // the dialog fills the window (design/parts, the row's Tags | Parts modal): sized by
    // the window, shrinkable from its corner, the size kept per tab; see selectionModalLogic
    fitWindow = false,
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
    dialog.classList.toggle('is-window-sized', fitWindow);

    const header = createElement('header', 'selection-modal-header');
    const heading = createElement('h2', 'selection-modal-title');
    heading.id = `${id}-title`;
    header.appendChild(heading);
    const headerTools = createElement('div', 'selection-modal-header-tools');
    // back to the window-sized rule after the corner was dragged
    const fitButton = createElement('button', 'selection-modal-fit', '⛶');
    fitButton.type = 'button';
    fitButton.hidden = !fitWindow;
    headerTools.appendChild(fitButton);
    const closeButton = createElement('button', 'selection-modal-close', '×');
    closeButton.type = 'button';
    closeButton.setAttribute('aria-label', 'Close');
    headerTools.appendChild(closeButton);
    header.appendChild(headerTools);
    dialog.appendChild(header);

    // the tab strip: shown only when open() brings extra tabs (a caller's own view of
    // other things to pick, e.g. the parts grid next to the tag list); the search box,
    // the filters, the Selected row and the footer stay in place across the tabs
    const tabStrip = createElement('div', 'selection-modal-tabs');
    tabStrip.setAttribute('role', 'tablist');
    tabStrip.hidden = true;
    dialog.appendChild(tabStrip);

    const toolbar = createElement('div', 'selection-modal-toolbar');
    const searchLabel = createElement('label', 'selection-modal-search-label', 'Search');
    const searchInput = createElement('input', 'selection-modal-search');
    searchInput.type = 'search';
    searchInput.id = `${id}-search`;
    searchInput.placeholder = 'Search by name or tag';
    searchInput.setAttribute('aria-label', 'Search');
    searchLabel.appendChild(searchInput);
    toolbar.appendChild(searchLabel);

    const categoryLabel = createElement('label', 'selection-modal-filter-label');
    const categoryText = createElement('span', 'selection-modal-filter-text', 'Category');
    const categorySelect = createElement('select', 'selection-modal-filter');
    categorySelect.id = `${id}-category`;
    categorySelect.setAttribute('aria-label', 'Category');
    categoryLabel.append(categoryText, categorySelect);
    toolbar.appendChild(categoryLabel);

    const attributeLabel = createElement('label', 'selection-modal-filter-label');
    const attributeText = createElement('span', 'selection-modal-filter-text', 'Attribute');
    const attributeSelect = createElement('select', 'selection-modal-filter');
    attributeSelect.id = `${id}-attribute`;
    attributeSelect.setAttribute('aria-label', 'Attribute');
    attributeLabel.append(attributeText, attributeSelect);
    toolbar.appendChild(attributeLabel);

    // a tab may offer sort orders and tile sizes (the Parts grid); both stay hidden on a
    // tab that has none, and the star keeps the last place so nothing shifts between tabs
    const sortLabel = createElement('label', 'selection-modal-sort-label');
    const sortText = createElement('span', 'selection-modal-filter-text', 'Sort');
    const sortSelect = createElement('select', 'selection-modal-sort');
    sortSelect.id = `${id}-sort`;
    sortLabel.append(sortText, sortSelect);
    sortLabel.hidden = true;
    toolbar.appendChild(sortLabel);
    const sizeSegment = createElement('div', 'selection-modal-size');
    sizeSegment.setAttribute('role', 'group');
    sizeSegment.hidden = true;
    toolbar.appendChild(sizeSegment);

    const favOnlyButton = createElement('button', 'selection-modal-favonly', '★');
    favOnlyButton.type = 'button';
    favOnlyButton.hidden = true;
    favOnlyButton.setAttribute('aria-pressed', 'false');
    toolbar.appendChild(favOnlyButton);
    dialog.appendChild(toolbar);

    // the Selected row is one line high whatever the count: the chips scroll sideways,
    // the "Selected N" button opens the whole list in a popover, Clear empties it
    const selectedSection = createElement('section', 'selection-modal-selected');
    const selectedToggle = createElement('button', 'selection-modal-selected-toggle');
    selectedToggle.type = 'button';
    selectedToggle.setAttribute('aria-expanded', 'false');
    const selectedList = createElement('div', 'selection-modal-selected-list');
    selectedList.setAttribute('aria-label', 'Selected items');
    const clearButton = createElement('button', 'selection-modal-clear');
    clearButton.type = 'button';
    const selectedPopover = createElement('div', 'selection-modal-selected-popover');
    selectedPopover.hidden = true;
    selectedSection.append(selectedToggle, selectedList, clearButton, selectedPopover);
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
    // the list and, for a tab that has one, the panel beside it about the active row,
    // and before the list the category rail of a tab that asks for one
    const body = createElement('div', 'selection-modal-body');
    const rail = createElement('nav', 'selection-modal-rail');
    rail.hidden = true;
    body.appendChild(rail);
    body.appendChild(listbox);
    const panel = createElement('aside', 'selection-modal-panel');
    panel.hidden = true;
    body.appendChild(panel);
    dialog.appendChild(body);
    // under the list of the main tab: "N of them on the <other> tab" for the same search
    const crosslink = createElement('button', 'selection-modal-crosslink');
    crosslink.type = 'button';
    crosslink.hidden = true;
    dialog.appendChild(crosslink);

    const footer = createElement('footer', 'selection-modal-footer');
    const footerActions = createElement('div', 'selection-modal-footer-actions');
    footerActions.hidden = true;
    const footerNote = createElement('span', 'selection-modal-footer-note');
    footerNote.hidden = mode !== 'multiple';
    const cancelButton = createElement('button', 'selection-modal-cancel', 'Cancel');
    cancelButton.type = 'button';
    const applyButton = createElement('button', 'selection-modal-apply', 'Apply');
    applyButton.type = 'button';
    footer.append(footerActions, footerNote, cancelButton, applyButton);
    dialog.appendChild(footer);
    // the corner a window-sized dialog is dragged smaller by
    const resizeHandle = createElement('div', 'selection-modal-resize');
    resizeHandle.hidden = !fitWindow;
    resizeHandle.setAttribute('aria-hidden', 'true');
    dialog.appendChild(resizeHandle);

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
    let tabs = [];                 // the extra tabs open() brought, in order
    let activeTab = null;          // null = the main tab
    let mainTabLabel = 'Items';
    let mainConfig = null;         // the main tab's view, as open() set it
    let staticOptions = [];        // the main tab's options when there is no loader
    let refreshHook = null;        // { type, listener } while a tab asked to follow an event
    let crosslinkTab = null;
    let railCategory = '';         // the rail's category on a tab that has the rail
    let sortValue = '';            // the sort order on a tab that offers some
    let tileSize = '';             // the tile size on a grid tab that offers some
    let popoverOpen = false;       // the Selected list unfolded
    let soleTab = false;           // the one extra tab is the whole modal: no strip, no main tab
    let applyText = null;          // count -> the Apply button's words, when the caller names them
    let activeConfig = { categories: [], attributes: [], onOptionHover, onOptionLeave, onActiveOption, favorites: null, sorts: [], tileSizes: [], optionLimit };

    // Everything a tab can set: its filters (and what they are called), its loader, its
    // favourites, and for a grid its tile renderer, its side panel and its footer actions.
    function configFor(tab) {
        if (!tab) return mainConfig;
        const favoritesOf = tab.favorites && typeof tab.favorites.isFavorite === 'function' ? tab.favorites : null;
        return {
            categories: Array.isArray(tab.categories) ? tab.categories : [],
            defaultCategory: typeof tab.defaultCategory === 'string' ? tab.defaultCategory : '',
            attributes: Array.isArray(tab.attributes) ? tab.attributes : [],
            // the attribute the tab opens on (the LoRA tab: the ones that fit the model)
            defaultAttribute: typeof tab.defaultAttribute === 'string' ? tab.defaultAttribute : '',
            categoryLabel: tab.categoryLabel ?? 'Category',
            attributeLabel: tab.attributeLabel ?? 'Attribute',
            categoryAll: tab.categoryAll ?? 'All categories',
            attributeAll: tab.attributeAll ?? 'All attributes',
            onOptionHover: null,
            onOptionLeave: null,
            onActiveOption: null,
            loadOptions: typeof tab.loadOptions === 'function' ? tab.loadOptions : null,
            favorites: favoritesOf,
            view: tab.view === 'grid' ? 'grid' : 'list',
            renderOption: typeof tab.renderOption === 'function' ? tab.renderOption : null,
            panel: typeof tab.panel === 'function' ? tab.panel : null,
            actions: Array.isArray(tab.actions) ? tab.actions : [],
            emptyMessage: tab.emptyMessage ?? emptyMessage,
            searchPrompt: tab.searchPrompt ?? searchPrompt,
            refreshEvent: typeof tab.refreshEvent === 'string' ? tab.refreshEvent : null,
            // the categories as a rail beside the list instead of the Category box
            rail: tab.rail === true,
            // a click on a tile shows it in the panel; a double click (or Enter) picks it
            clickPreviews: tab.clickPreviews === true,
            sorts: Array.isArray(tab.sorts) ? tab.sorts.filter(sort => sort && sort.value) : [],
            tileSizes: Array.isArray(tab.tileSizes) ? tab.tileSizes.filter(size => size && size.value && size.px > 0) : [],
            // how many rows a list without a pager shows; the modal's own by default
            optionLimit: Number.isInteger(tab.optionLimit) && tab.optionLimit > 0 ? tab.optionLimit : optionLimit,
        };
    }

    // the category the list is narrowed to: the rail's on a tab with the rail, else the box's
    function currentCategory() {
        return activeConfig.rail ? railCategory : categorySelect.value;
    }

    // ---------------------------------------------------------------- the window-sized dialog

    const storage = () => globalThis.localStorage ?? null;
    const viewport = () => ({ width: globalThis.innerWidth || 0, height: globalThis.innerHeight || 0 });
    const tabKey = () => activeTab?.id ?? 'main';

    function updateNarrow() {
        const width = dialog.getBoundingClientRect?.().width || 0;
        dialog.classList.toggle('is-narrow', width > 0 && width < NARROW_DIALOG);
    }

    // the CSS rule sizes the dialog by the window; a size the user dragged is kept per
    // tab and put back, clamped to the window it is opened in
    function applySize() {
        if (!fitWindow) return;
        const saved = readStoredSize(storage(), dialogSizeKey(tabKey()));
        if (saved) {
            const size = clampDialogSize(saved, viewport());
            dialog.style.width = `${size.width}px`;
            dialog.style.height = `${size.height}px`;
        } else {
            dialog.style.width = '';
            dialog.style.height = '';
        }
        updateNarrow();
    }

    function onWindowResize() {
        if (isOpen()) applySize();
    }

    let drag = null;
    resizeHandle.addEventListener('pointerdown', event => {
        if (!fitWindow) return;
        event.preventDefault();
        const rect = dialog.getBoundingClientRect();
        drag = { x: event.clientX, y: event.clientY, width: rect.width, height: rect.height, pointerId: event.pointerId };
        resizeHandle.setPointerCapture?.(event.pointerId);
    });
    resizeHandle.addEventListener('pointermove', event => {
        if (!drag) return;
        const size = clampDialogSize({ width: drag.width + (event.clientX - drag.x), height: drag.height + (event.clientY - drag.y) }, viewport());
        dialog.style.width = `${size.width}px`;
        dialog.style.height = `${size.height}px`;
        updateNarrow();
    });
    const endDrag = event => {
        if (!drag) return;
        drag = null;
        writeStoredSize(storage(), dialogSizeKey(tabKey()), { width: Number.parseFloat(dialog.style.width), height: Number.parseFloat(dialog.style.height) });
        resizeHandle.releasePointerCapture?.(event?.pointerId);
    };
    resizeHandle.addEventListener('pointerup', endDrag);
    resizeHandle.addEventListener('pointercancel', endDrag);
    fitButton.addEventListener('click', () => {
        writeStoredSize(storage(), dialogSizeKey(tabKey()), null);
        applySize();
    });

    function isFavoriteOption(option) {
        return Boolean(activeConfig.favorites?.isFavorite?.(optionKey(option)));
    }

    // Favorites are narrowed with the Fav-only button; the search text is taken as
    // written ('@' is a cast reference elsewhere and no longer a search prefix).
    function effectiveSearch() {
        return { query: searchInput.value, favoritesOnly: favOnly };
    }

    function renderFavOnlyButton() {
        // with tabs the star keeps its place on a tab that has no favourites (greyed),
        // so the toolbar does not shift between the tabs
        const none = !activeConfig.favorites;
        favOnlyButton.hidden = none && tabs.length === 0;
        favOnlyButton.disabled = none;
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
        if (typeof applyText === 'function') applyButton.textContent = applyText(selectedOptions.length);
        else applyButton.textContent = mode === 'multiple' && selectedOptions.length > 0
            ? tagText('tag_ui_apply_count', selectedOptions.length)
            : tagText('tag_ui_apply');
        cancelButton.textContent = tagText('tag_ui_cancel');
        footerNote.textContent = tagText('tag_ui_modal_note');
    }

    function selectedChip(option) {
        const chip = createElement('span', 'selection-modal-chip');
        // an option may dress its chip (a part: gold frame, "parts:" small in front)
        if (option.chipClass) chip.classList.add(option.chipClass);
        const label = createElement('span', 'selection-modal-chip-label', optionLabel(option));
        if (option.prefix) label.prepend(createElement('span', 'selection-modal-chip-prefix', option.prefix));
        chip.appendChild(label);
        const removeButton = createElement('button', 'selection-modal-chip-remove', '×');
        removeButton.type = 'button';
        removeButton.setAttribute('aria-label', `Remove ${optionLabel(option)}`);
        removeButton.addEventListener('click', () => {
            selectedOptions = removeSelectedOption(selectedOptions, optionKey(option));
            renderSelected();
            renderOptions();
        });
        chip.appendChild(removeButton);
        return chip;
    }

    function renderSelected() {
        renderApplyLabel();
        const count = selectedOptions.length;
        selectedToggle.replaceChildren(
            createElement('span', 'selection-modal-selected-word', tagText('tag_ui_selected')),
            createElement('span', 'selection-modal-selected-count', String(count)),
        );
        selectedToggle.title = tagText('tag_ui_selected_all');
        selectedToggle.setAttribute('aria-label', `${tagText('tag_ui_selected')} ${count}`);
        selectedToggle.disabled = count === 0;
        clearButton.textContent = tagText('tag_ui_clear_selection');
        clearButton.disabled = count === 0;
        selectedList.replaceChildren();
        selectedPopover.replaceChildren();
        if (count === 0) {
            popoverOpen = false;
            selectedList.appendChild(createElement('span', 'selection-modal-no-selection', tagText('tag_ui_selected_none')));
        } else {
            for (const option of selectedOptions) selectedList.appendChild(selectedChip(option));
        }
        renderPopover();
    }

    // the unfolded list holds its chips only while it is open
    function renderPopover() {
        selectedPopover.replaceChildren();
        if (popoverOpen) for (const option of selectedOptions) selectedPopover.appendChild(selectedChip(option));
        selectedPopover.hidden = !popoverOpen;
        selectedToggle.setAttribute('aria-expanded', String(popoverOpen));
        selectedToggle.classList.toggle('is-open', popoverOpen);
    }

    function setPopover(open) {
        popoverOpen = Boolean(open) && selectedOptions.length > 0;
        renderPopover();
    }

    // ---------------------------------------------------------------- the category rail

    // the rail: All and every category the tab named, each with the number of options
    // it holds for the current search (the category itself does not narrow the count)
    function renderRail() {
        rail.hidden = !activeConfig.rail;
        if (!activeConfig.rail) {
            rail.replaceChildren();
            return;
        }
        const { query, favoritesOnly } = effectiveSearch();
        let pool = filterSelectionOptions(currentOptions, { query, attribute: attributeSelect.value });
        if (favoritesOnly && activeConfig.favorites) pool = pool.filter(option => isFavoriteOption(option));
        const counts = new Map();
        for (const option of pool) {
            const key = String(option.category ?? '');
            counts.set(key, (counts.get(key) ?? 0) + 1);
        }
        const entries = [{ value: '', label: activeConfig.categoryAll ?? 'All', color: '' }, ...normalizeSelectOptions(activeConfig.categories).map(option => {
            const source = activeConfig.categories.find(entry => entry && typeof entry === 'object' && entry.value === option.value);
            return { ...option, color: source?.color ?? '' };
        })];
        rail.replaceChildren();
        rail.setAttribute('aria-label', activeConfig.categoryLabel ?? 'Category');
        for (const entry of entries) {
            const button = createElement('button', 'selection-modal-rail-item');
            button.type = 'button';
            button.dataset.category = entry.value;
            const on = entry.value === railCategory;
            button.classList.toggle('is-active', on);
            button.setAttribute('aria-pressed', String(on));
            const name = createElement('span', 'selection-modal-rail-name');
            const dot = createElement('span', 'selection-modal-rail-dot');
            if (entry.color) dot.style.background = entry.color;
            dot.classList.toggle('is-blank', !entry.color);
            name.append(dot, document.createTextNode(entry.label));
            const count = entry.value === '' ? pool.length : (counts.get(entry.value) ?? 0);
            button.append(name, createElement('span', 'selection-modal-rail-count', String(count)));
            button.addEventListener('click', () => {
                if (railCategory === entry.value) return;
                railCategory = entry.value;
                scheduleRefresh();
                renderRail();
            });
            rail.appendChild(button);
        }
    }

    // ---------------------------------------------------------------- sort and tile size

    function renderSortSelect() {
        const sorts = activeConfig.sorts ?? [];
        sortLabel.hidden = sorts.length === 0;
        sortText.textContent = tagText('tag_ui_sort');
        sortSelect.setAttribute('aria-label', sortText.textContent);
        sortSelect.replaceChildren();
        if (sorts.length === 0) {
            sortValue = '';
            return;
        }
        for (const sort of sorts) {
            const element = document.createElement('option');
            element.value = sort.value;
            element.textContent = typeof sort.label === 'function' ? sort.label() : sort.label ?? sort.value;
            sortSelect.appendChild(element);
        }
        const stored = readStoredPreference(storage(), `selection-modal-sort:${tabKey()}`);
        sortValue = sorts.some(sort => sort.value === stored) ? stored : sorts[0].value;
        sortSelect.value = sortValue;
    }

    function applyTileSize() {
        const sizes = activeConfig.tileSizes ?? [];
        const chosen = sizes.find(size => size.value === tileSize) ?? null;
        for (const size of sizes) listbox.classList.remove(`is-tile-${size.value}`);
        if (chosen) {
            listbox.style.setProperty('--selection-tile', `${chosen.px}px`);
            listbox.classList.add(`is-tile-${chosen.value}`);
        } else {
            listbox.style.removeProperty('--selection-tile');
        }
        for (const button of sizeSegment.children) {
            const on = button.dataset.size === tileSize;
            button.classList.toggle('is-on', on);
            button.setAttribute('aria-pressed', String(on));
        }
    }

    function renderSizeSegment() {
        const sizes = activeConfig.tileSizes ?? [];
        sizeSegment.hidden = sizes.length === 0;
        sizeSegment.setAttribute('aria-label', tagText('tag_ui_tile_size'));
        sizeSegment.replaceChildren();
        if (sizes.length === 0) {
            tileSize = '';
            applyTileSize();
            return;
        }
        const stored = readStoredPreference(storage(), `selection-modal-tile-size:${tabKey()}`);
        tileSize = sizes.some(size => size.value === stored) ? stored : (sizes.find(size => size.default)?.value ?? sizes[0].value);
        for (const size of sizes) {
            const button = createElement('button', 'selection-modal-size-button', typeof size.label === 'function' ? size.label() : size.label ?? size.value);
            button.type = 'button';
            button.dataset.size = size.value;
            if (size.title) button.title = size.title;
            button.addEventListener('click', () => {
                tileSize = size.value;
                writeStoredPreference(storage(), `selection-modal-tile-size:${tabKey()}`, tileSize);
                applyTileSize();
            });
            sizeSegment.appendChild(button);
        }
        applyTileSize();
    }

    function renderPanel(option) {
        if (!activeConfig.panel) return;
        panel.replaceChildren();
        const content = activeConfig.panel(option ?? null, panelApi);
        if (content) panel.appendChild(content);
    }

    function updateActiveDescendant({ scroll = true } = {}) {
        const item = visibleOptions[activeIndex];
        activeConfig.onActiveOption?.(item ?? null);
        renderPanel(item ?? null);
        for (const previewed of listbox.querySelectorAll('.is-previewed')) previewed.classList.remove('is-previewed');
        if (!item) {
            listbox.removeAttribute('aria-activedescendant');
            return;
        }
        const itemId = `${id}-option-${activeIndex}`;
        listbox.setAttribute('aria-activedescendant', itemId);
        // the rows are the list's children in the order of visibleOptions; the active one
        // wears a frame in a grid where a click previews (the panel is about it)
        const element = listbox.children[activeIndex] ?? null;
        element?.classList.add('is-previewed');
        if (scroll) element?.scrollIntoView?.({ block: 'nearest' });
    }

    // ---------------------------------------------------------------- tabs

    function renderTabs() {
        tabStrip.replaceChildren();
        tabStrip.hidden = tabs.length === 0 || soleTab;
        if (tabStrip.hidden) return;
        const entries = [{ id: null, label: mainTabLabel, tab: null }, ...tabs.map(tab => ({ id: tab.id, label: tab.label ?? tab.id, tab }))];
        for (const entry of entries) {
            const button = createElement('button', 'selection-modal-tab', entry.label);
            button.type = 'button';
            button.setAttribute('role', 'tab');
            button.setAttribute('aria-selected', String(entry.tab === activeTab));
            button.classList.toggle('is-active', entry.tab === activeTab);
            button.addEventListener('click', () => selectTab(entry.tab));
            tabStrip.appendChild(button);
        }
    }

    function renderActions() {
        footerActions.replaceChildren();
        const actions = activeConfig.actions ?? [];
        footerActions.hidden = actions.length === 0;
        for (const action of actions) {
            const label = typeof action.label === 'function' ? action.label() : action.label;
            const button = createElement('button', 'selection-modal-action', label ?? '');
            button.type = 'button';
            if (action.title) button.title = action.title;
            button.disabled = typeof action.disabled === 'function' ? Boolean(action.disabled()) : Boolean(action.disabled);
            button.addEventListener('click', () => action.onClick?.(panelApi));
            footerActions.appendChild(button);
        }
    }

    function renderCrosslink() {
        crosslink.hidden = true;
        crosslinkTab = null;
        if (activeTab || tabs.length === 0) return;
        const query = searchInput.value.trim();
        if (!query) return;
        for (const tab of tabs) {
            const count = typeof tab.peek === 'function' ? Number(tab.peek(query)) || 0 : 0;
            if (count <= 0) continue;
            crosslink.textContent = typeof tab.peekLabel === 'function' ? tab.peekLabel(count) : `${count} · ${tab.label ?? tab.id}`;
            crosslink.hidden = false;
            crosslinkTab = tab;
            return;
        }
    }

    function hookRefreshEvent() {
        const type = activeConfig.refreshEvent;
        if (!type || refreshHook) return;
        const listener = () => { if (isOpen()) refreshOptions({ keep: true }).catch(() => {}); };
        document.addEventListener(type, listener);
        refreshHook = { type, listener };
    }

    function unhookRefreshEvent() {
        if (!refreshHook) return;
        document.removeEventListener(refreshHook.type, refreshHook.listener);
        refreshHook = null;
    }

    // The toolbar for the active tab: its filter names and choices, the star, the list
    // as a list or a grid, the panel, the footer actions.
    function applyTabConfig() {
        renderFavOnlyButton();
        categoryText.textContent = activeConfig.categoryLabel ?? 'Category';
        attributeText.textContent = activeConfig.attributeLabel ?? 'Attribute';
        categorySelect.setAttribute('aria-label', categoryText.textContent);
        attributeSelect.setAttribute('aria-label', attributeText.textContent);
        // a tab with the rail keeps the Category box empty (and so hidden)
        setFilterOptions(categorySelect, activeConfig.rail ? [] : activeConfig.categories, activeConfig.categoryAll ?? 'All categories');
        setFilterOptions(attributeSelect, activeConfig.attributes, activeConfig.attributeAll ?? 'All attributes');
        // a tab may open on one of its categories (the Parts tab of the View row: camera)
        const preset = typeof activeConfig.defaultCategory === 'string' && activeConfig.defaultCategory !== ''
            && (activeConfig.categories ?? []).some(entry => (typeof entry === 'string' ? entry : entry?.value) === activeConfig.defaultCategory);
        categorySelect.value = preset && !activeConfig.rail ? activeConfig.defaultCategory : '';
        railCategory = preset && activeConfig.rail ? activeConfig.defaultCategory : '';
        const presetAttribute = typeof activeConfig.defaultAttribute === 'string' && activeConfig.defaultAttribute !== ''
            && (activeConfig.attributes ?? []).some(entry => (typeof entry === 'string' ? entry : entry?.value) === activeConfig.defaultAttribute);
        attributeSelect.value = presetAttribute ? activeConfig.defaultAttribute : '';
        renderSortSelect();
        renderSizeSegment();
        listbox.classList.toggle('is-grid', activeConfig.view === 'grid');
        listbox.classList.toggle('is-preview-click', activeConfig.clickPreviews);
        panel.hidden = !activeConfig.panel;
        if (!activeConfig.panel) panel.replaceChildren();
        renderActions();
        renderTabs();
    }

    function selectTab(tab) {
        if (!isOpen() || tab === activeTab) return;
        unhookRefreshEvent();
        activeTab = tab;
        activeConfig = configFor(tab);
        favOnly = false;
        clearTimeout(searchTimer);
        currentOptions = tab ? [] : staticOptions.slice();
        pager = null;
        activeIndex = -1;
        applyTabConfig();
        applySize();
        hookRefreshEvent();
        renderOptions();
        if (activeConfig.loadOptions) {
            refreshOptions().catch(error => {
                console.error('[SelectionModal] Failed to load options:', error);
                currentOptions = [];
                renderOptions();
            });
        }
        searchInput.focus();
    }

    // In a grid the arrows walk the tiles: the column count is read off the layout
    function gridColumns() {
        const items = [...listbox.children];
        if (items.length < 2) return 1;
        const top = items[0].offsetTop;
        let columns = 0;
        for (const item of items) {
            if (item.offsetTop !== top) break;
            columns += 1;
        }
        return Math.max(1, columns);
    }

    function renderStatus(totalCount, hasMore) {
        if (totalCount === 0 && !(pager && pager.total > 0)) {
            status.textContent = searchInput.value.trim() ? activeConfig.emptyMessage ?? emptyMessage : activeConfig.searchPrompt ?? searchPrompt;
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
            category: currentCategory(),
            attribute: attributeSelect.value,
        });
        const sort = (activeConfig.sorts ?? []).find(entry => entry.value === sortValue);
        if (typeof sort?.compare === 'function') filteredOptions = filteredOptions.slice().sort(sort.compare);
        if (activeConfig.favorites) {
            if (favoritesOnly) filteredOptions = filteredOptions.filter(option => isFavoriteOption(option));
            // stable sort: favorites first, source order preserved otherwise
            filteredOptions = filteredOptions
                .map((option, index) => ({ option, index, fav: isFavoriteOption(option) ? 0 : 1 }))
                .sort((a, b) => a.fav - b.fav || a.index - b.index)
                .map(entry => entry.option);
        }
        const limited = limitSelectionOptions(filteredOptions, pager ? Number.MAX_SAFE_INTEGER : activeConfig.optionLimit);
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
            if (activeConfig.view === 'grid' && activeConfig.renderOption) {
                // a tile: the tab draws it
                item.classList.add('selection-modal-tile');
                const content = activeConfig.renderOption(option, { selected: selected.has(optionKey(option)) });
                if (content) item.appendChild(content);
                listbox.appendChild(item);
                return;
            }
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
        renderCrosslink();
        renderRail();
    }

    // `keep`: the list is reloaded in place (a tab's store changed), the active row and
    // the scroll stay where they are
    async function refreshOptions({ keep = false } = {}) {
        const generation = ++requestGeneration;
        const activeKey = keep && visibleOptions[activeIndex] ? optionKey(visibleOptions[activeIndex]) : null;
        const config = {
            query: effectiveSearch().query.trim(),
            category: currentCategory(),
            attribute: attributeSelect.value,
        };
        let nextOptions = currentOptions;
        if (typeof activeConfig.loadOptions === 'function') {
            nextOptions = await activeConfig.loadOptions(config);
        }
        if (generation !== requestGeneration || !isOpen()) return;
        currentOptions = typeof activeConfig.loadOptions === 'function' ? takeLoaded(nextOptions) : currentOptions;
        if (keep) {
            renderOptions({ scrollActive: false });
            // the item the panel is about stays, wherever the new list puts it (a rename moves it)
            const index = activeKey === null ? -1 : visibleOptions.findIndex(option => optionKey(option) === activeKey);
            if (index >= 0 && index !== activeIndex) {
                activeIndex = index;
                updateActiveDescendant({ scroll: false });
            }
            renderActions();
            return;
        }
        listbox.scrollTop = 0;
        activeIndex = -1;
        renderOptions();
        renderActions();
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
        unhookRefreshEvent();
        overlay.hidden = true;
        overlay.setAttribute('aria-hidden', 'true');
        document.removeEventListener('keydown', onDialogKeyDown);
        globalThis.removeEventListener?.('resize', onWindowResize);
        setPopover(false);
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

    // a grid does not wrap: the arrows stop at the edges
    function moveActiveInGrid(delta) {
        if (visibleOptions.length === 0) return;
        const from = activeIndex < 0 ? 0 : activeIndex;
        activeIndex = Math.max(0, Math.min(visibleOptions.length - 1, from + delta));
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

    // a dialog opened over this one (from its panel, or a modal opened from that) comes
    // later in the body: the keys are its own
    function coveredByLaterDialog() {
        if (typeof overlay.compareDocumentPosition !== 'function') return false;
        const shown = node => { for (let current = node; current; current = current.parentElement) if (current.hidden) return false; return true; };
        for (const other of document.querySelectorAll('[aria-modal="true"]')) {
            if (overlay.contains(other) || !shown(other)) continue;
            if (overlay.compareDocumentPosition(other) & DOCUMENT_POSITION_FOLLOWING) return true;
        }
        return false;
    }

    function onDialogKeyDown(event) {
        if (coveredByLaterDialog()) return;
        if (event.key === 'Escape') {
            if (event.isComposing || event.keyCode === 229) return;
            event.preventDefault();
            // the unfolded Selected list goes first, the dialog on the next Escape
            if (popoverOpen) {
                setPopover(false);
                return;
            }
            close({ apply: false });
            return;
        }
        if (tabs.length > 0 && !soleTab && event.ctrlKey && !event.altKey && !event.metaKey) {
            // Ctrl+Tab cycles the tabs, Ctrl+1…9 jumps to one
            const all = [null, ...tabs];
            if (event.key === 'Tab') {
                event.preventDefault();
                const at = all.indexOf(activeTab);
                selectTab(all[(at + (event.shiftKey ? -1 : 1) + all.length) % all.length]);
                return;
            }
            if (/^[1-9]$/.test(event.key)) {
                const target = all[Number(event.key) - 1];
                if (target !== undefined) {
                    event.preventDefault();
                    selectTab(target);
                }
                return;
            }
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
    sortSelect.addEventListener('change', () => {
        sortValue = sortSelect.value;
        writeStoredPreference(storage(), `selection-modal-sort:${tabKey()}`, sortValue);
        renderOptions();
    });
    selectedToggle.addEventListener('click', () => setPopover(!popoverOpen));
    clearButton.addEventListener('click', () => {
        selectedOptions = [];
        renderSelected();
        renderOptions();
    });
    // a click outside the unfolded Selected list folds it
    dialog.addEventListener('pointerdown', event => {
        if (!popoverOpen) return;
        if (event.target.closest?.('.selection-modal-selected-popover, .selection-modal-selected-toggle')) return;
        setPopover(false);
    });
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
        if (activeConfig.clickPreviews) {
            // a tile: one click shows it in the panel, a double click (below) picks it
            updateActiveDescendant({ scroll: false });
            listbox.focus();
            return;
        }
        toggleActive();
    });
    listbox.addEventListener('dblclick', event => {
        if (!activeConfig.clickPreviews) return;
        const item = event.target.closest('[role="option"]');
        if (!item) return;
        activeIndex = Number.parseInt(item.dataset.index, 10);
        toggleActive();
    });
    listbox.addEventListener('scroll', () => {
        if (listbox.scrollTop + listbox.clientHeight >= listbox.scrollHeight - 32) loadNextPage();
    });
    listbox.addEventListener('keydown', event => {
        const grid = activeConfig.view === 'grid';
        if (grid && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
            event.preventDefault();
            moveActiveInGrid(event.key === 'ArrowRight' ? 1 : -1);
        } else if (event.key === 'ArrowDown') {
            event.preventDefault();
            if (grid) moveActiveInGrid(gridColumns()); else moveActive(1);
        } else if (event.key === 'ArrowUp') {
            event.preventDefault();
            if (grid) moveActiveInGrid(-gridColumns()); else moveActive(-1);
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
    crosslink.addEventListener('click', () => { if (crosslinkTab) selectTab(crosslinkTab); });

    // what a tab's panel and actions get to act on the modal
    const panelApi = {
        refresh: () => refreshOptions({ keep: true }).catch(() => {}),
        toggle(option) {
            if (!option) return;
            selectedOptions = selectOption(selectedOptions, option, mode);
            renderSelected();
            renderOptions({ scrollActive: false });
        },
        isSelected: option => selectedKeys().has(optionKey(option)),
        close: () => close({ apply: false }),
        apply: () => close({ apply: true }),
    };

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
            // extra tabs beside the main one (each: id, label, and what configFor lists);
            // `tab` names the one to open on, `tabLabel` what the main tab is called
            tabs: extraTabs = [],
            tab: initialTab = null,
            tabLabel = 'Items',
            // the modal is the `tab` alone (the LoRA card's "+ LoRA": the LoRA tab, titled LoRA)
            soleTab: onlyTab = false,
            // count -> the Apply button's words ("Add (2)"); the modal's own when null
            applyLabel = null,
        } = {}) {
            lastTrigger = trigger;
            applyText = typeof applyLabel === 'function' ? applyLabel : null;
            fallbackFocus = fallback;
            unhookRefreshEvent();
            mainConfig = {
                categories,
                attributes,
                categoryLabel: 'Category',
                attributeLabel: 'Attribute',
                categoryAll: 'All categories',
                attributeAll: 'All attributes',
                onOptionHover,
                onActiveOption,
                onOptionLeave,
                loadOptions: dynamicLoadOptions,
                favorites: favorites && typeof favorites.isFavorite === 'function' ? favorites : null,
                view: 'list',
                renderOption: null,
                panel: null,
                actions: [],
                emptyMessage,
                searchPrompt,
                refreshEvent: null,
                rail: false,
                clickPreviews: false,
                sorts: [],
                tileSizes: [],
                optionLimit,
            };
            tabs = (Array.isArray(extraTabs) ? extraTabs : []).filter(tab => tab && typeof tab === 'object' && tab.id);
            mainTabLabel = tabLabel;
            activeTab = tabs.find(tab => tab.id === initialTab) ?? null;
            soleTab = Boolean(onlyTab) && activeTab !== null;
            activeConfig = configFor(activeTab);
            favOnly = false;
            heading.textContent = modalTitle;
            searchInput.value = '';
            selectedOptions = Array.isArray(selection) ? selection.slice() : [];
            staticOptions = Array.isArray(options) ? options.slice() : [];
            currentOptions = activeTab ? [] : staticOptions.slice();
            pager = null;
            activeIndex = -1;
            popoverOpen = false;
            fitButton.title = tagText('tag_ui_fit_window');
            fitButton.setAttribute('aria-label', fitButton.title);
            applyTabConfig();
            // the overlays share one z-index, so the last one in the body is on top: a
            // modal opened from inside another dialog (the part editor's Choose tags…)
            // goes to the end, above the dialog that opened it
            if (document.body.lastElementChild !== overlay) document.body.appendChild(overlay);
            overlay.hidden = false;
            overlay.setAttribute('aria-hidden', 'false');
            applySize();
            document.addEventListener('keydown', onDialogKeyDown);
            globalThis.addEventListener?.('resize', onWindowResize);
            hookRefreshEvent();
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
            if (typeof activeConfig.loadOptions === 'function') scheduleRefresh();
        },
        close: () => close({ apply: false }),
        apply: () => close({ apply: true }),
        isOpen,
        element: overlay,
        destroy: () => {
            close({ apply: false });
            overlay.remove();
        },
        // the tab strip from outside: a caller's own button opens the modal on a tab
        selectTab: tabId => selectTab(tabs.find(tab => tab.id === tabId) ?? null),
        activeTab: () => activeTab?.id ?? null,
        // the rail's category on a tab with one (tests and callers that follow it)
        category: () => currentCategory(),
    };
}
