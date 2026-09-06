// L1: one prompt field = integrated header (label / Choose tags / Text|Capsules toggle)
// + chip row + "+ Add tag" + footer. The textarea stays the source of truth; capsules are a
// derived view and variable plans live in a per-field sidecar (id → plan).
import {
    DEFAULT_BATCH,
    capsuleStats,
    collectPlans,
    excludedTagSet,
    expandAll,
    handleChipKey,
    insertCapsules,
    isVariablePlan,
    moveCapsule,
    normalizeBatch,
    normalizeTagName,
    nudgeCapsuleWeight,
    parsePlans,
    parsePromptToCapsules,
    reconcilePlans,
    removeCapsule,
    resolveBatchPlan,
    serializeCapsules,
    serializePlans,
    setAllCapsulesDisabled,
    setCapsulePlan,
    toggleCapsuleDisabled,
    transferCapsule,
} from './tagCapsuleLogic.js';
import { createIcon, renderChips } from './tagCapsuleChip.js';
import { FAVORITE_TAGS_CHANGED_EVENT, favGroupForKey, isFavoriteTag } from './favoriteTags.js';
import { getWeightPopover } from './weightPopover.js';
import { getBatchWeightDialog } from './batchWeightDialog.js';
import { setupFinalPromptDisclosure } from './finalPromptDisclosure.js';
import { tagText } from './tagUiText.js';
import { customFieldExtras, isCustomFieldId, setCustomFieldExtras } from '../../shared/promptFieldOrder.js';

export const PROMPT_FIELD_KEYS = Object.freeze(['common', 'background', 'style', 'positive', 'positive_right', 'negative', 'negative_left', 'negative_right', 'exclude']);

function el(tag, className, text = '') {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text) node.textContent = text;
    return node;
}

function setTextboxValue(textboxControl, textbox, value, guard) {
    guard(true);
    try {
        textboxControl.setValue(value);
        textbox.dispatchEvent(new Event('input', { bubbles: true }));
    } finally {
        guard(false);
    }
}

export function setupTagCapsuleField(textboxControl, options = {}) {
    const {
        key = 'positive',
        text = tagText,
        getGenerationSeed = () => 0,
        getExcludeText = () => '',
        onChange = null,
        onPlansChange = null,
        onBatchChange = null,
        initialPlans = [],
        initialBatch = DEFAULT_BATCH,
        expandForBatch = null,   // (count, seed) => rows (field-scoped expansion for the dialog)
        onSeedChange = null,
        onModeChange = null,     // (mode) — the field set mirrors the Text/Capsules choice to every field
        initialMode = 'string',
        onExternalDrop = null,   // ({ field, id }, at, { copy }) — a chip dragged in from another field
        fetchRelated = null,     // async (tagValue) => { related: [{tag, score}], family: [{tag}] }
    } = options;

    const textbox = textboxControl?.getElement?.();
    if (!textbox || textbox.dataset.tagCapsuleFieldSetup === 'true') return null;
    const wrapper = textbox.closest('.myTextbox-wrapper');
    const relativeContainer = textbox.parentElement;
    if (!wrapper || !relativeContainer) return null;

    // ---------------------------------------------------------------- state
    let mode = 'string';
    let plans = parsePlans(initialPlans);
    let batch = normalizeBatch(initialBatch);
    let capsules = [];
    let focusIndex = 0;
    let suppressInput = false;
    let discardedNotice = 0;
    let dragIndex = -1;
    const guard = value => { suppressInput = value; };

    // ---------------------------------------------------------------- header
    const header = el('div', 'tag-field-header');
    const label = el('span', 'tag-field-label');
    const tools = el('div', 'tag-field-tools');
    header.append(label, tools);

    const filterControl = wrapper.querySelector('.tag-filter-control');
    if (filterControl) tools.appendChild(filterControl);
    const legacyToolbar = wrapper.querySelector('.tag-selection-toolbar');
    const chooseButton = wrapper.querySelector('.tag-selection-trigger');
    if (chooseButton) {
        chooseButton.replaceChildren(createIcon('search', 13), el('span', 'tag-selection-trigger-text'));
        tools.appendChild(chooseButton);
    }
    if (legacyToolbar && legacyToolbar.childElementCount === 0) legacyToolbar.remove();

    const viewToggle = el('div', 'tag-view-toggle');
    viewToggle.setAttribute('role', 'radiogroup');
    const textButton = el('button', 'tag-view-button');
    textButton.type = 'button';
    textButton.setAttribute('role', 'radio');
    textButton.dataset.mode = 'string';
    textButton.appendChild(createIcon('text', 14));
    const capsuleButton = el('button', 'tag-view-button');
    capsuleButton.type = 'button';
    capsuleButton.setAttribute('role', 'radio');
    capsuleButton.dataset.mode = 'capsule';
    capsuleButton.appendChild(createIcon('pill', 14));
    viewToggle.append(textButton, capsuleButton);
    tools.appendChild(viewToggle);
    wrapper.insertBefore(header, relativeContainer);

    const badge = el('span', 'tag-capsule-badge');
    badge.hidden = true;
    relativeContainer.appendChild(badge);

    // ---------------------------------------------------------------- capsule view
    const view = el('section', 'tag-capsule-view');
    view.hidden = true;
    const chips = el('div', 'tag-capsule-chips');
    chips.setAttribute('role', 'group');
    // the right-click menu and cross-field drag-and-drop find the owning field by this key
    view.dataset.fieldKey = key;
    chips.dataset.fieldKey = key;
    textbox.dataset.fieldKey = key;
    const addButton = el('button', 'tag-capsule-add');
    addButton.type = 'button';
    addButton.tabIndex = -1;
    addButton.appendChild(createIcon('plus', 12));
    const addButtonText = el('span', 'tag-capsule-add-text');
    addButton.appendChild(addButtonText);
    const addSlot = el('span', 'tag-capsule-add-slot');
    addSlot.append(addButton);
    chips.appendChild(addSlot);
    view.appendChild(chips);

    // Related-tag strip: fed by the offline co-occurrence dictionary for the focused chip.
    const suggest = el('div', 'tag-capsule-suggest');
    suggest.hidden = true;
    const suggestHead = el('div', 'tag-capsule-suggest-head');
    const suggestTitle = el('span', 'tag-capsule-suggest-title');
    const suggestClose = el('button', 'tag-capsule-suggest-close');
    suggestClose.type = 'button';
    suggestClose.tabIndex = -1;
    suggestClose.appendChild(createIcon('close', 11));
    suggestHead.append(suggestTitle, suggestClose);
    const suggestBody = el('div', 'tag-capsule-suggest-body');
    suggest.append(suggestHead, suggestBody);
    view.appendChild(suggest);

    const footer = el('div', 'tag-capsule-footer');
    const stats = el('div', 'tag-capsule-stats');
    const statTags = el('span', 'tag-capsule-stat');
    const statWeighted = el('span', 'tag-capsule-stat tag-capsule-stat-weighted');
    const statVariable = el('span', 'tag-capsule-stat tag-capsule-stat-variable');
    const notice = el('span', 'tag-capsule-notice');
    notice.setAttribute('role', 'status');
    notice.setAttribute('aria-live', 'polite');
    stats.append(statTags, statWeighted, statVariable, notice);
    const batchButton = el('button', 'tag-capsule-batch');
    batchButton.type = 'button';
    batchButton.hidden = true;
    batchButton.appendChild(createIcon('layers', 13));
    const batchButtonText = el('span', 'tag-capsule-batch-text');
    batchButton.appendChild(batchButtonText);
    const suggestButton = el('button', 'tag-capsule-suggest-toggle');
    suggestButton.type = 'button';
    suggestButton.hidden = typeof fetchRelated !== 'function';
    suggestButton.appendChild(createIcon('spark', 13));
    const footerTools = el('div', 'tag-capsule-footer-tools');
    footerTools.append(suggestButton, batchButton);
    footer.append(stats, footerTools);
    view.appendChild(footer);
    wrapper.appendChild(view);

    // ---------------------------------------------------------------- helpers
    function fieldLabel() {
        const LANG = globalThis.cachedFiles?.language?.[globalThis.globalSettings?.language];
        const short = LANG?.[`ui_field_${key}`];
        if (typeof short === 'string' && short) return short;
        return textbox.placeholder || textbox.title || key;
    }

    function applyText() {
        label.textContent = fieldLabel();
        label.title = fieldLabel();
        if (chooseButton) {
            chooseButton.querySelector('.tag-selection-trigger-text').textContent = text('tag_ui_choose_tags');
            chooseButton.title = text('tag_ui_choose_tags');
        }
        viewToggle.setAttribute('aria-label', `${fieldLabel()} · ${text('tag_ui_view')}`);
        textButton.title = text('tag_ui_view_text');
        textButton.setAttribute('aria-label', text('tag_ui_view_text'));
        capsuleButton.title = text('tag_ui_view_capsules');
        capsuleButton.setAttribute('aria-label', text('tag_ui_view_capsules'));
        addButtonText.textContent = text('tag_ui_add_tag');
        addButton.setAttribute('aria-label', text('tag_ui_add_tag'));
        batchButtonText.textContent = text('tag_ui_batch_weights');
        suggestButton.title = text('tag_ui_related_toggle');
        suggestButton.setAttribute('aria-label', text('tag_ui_related_toggle'));
        suggestClose.title = text('tag_ui_close');
        suggestClose.setAttribute('aria-label', text('tag_ui_close'));
        chips.setAttribute('aria-label', `${fieldLabel()} · ${text('tag_ui_chips_label', capsules.length)}`);
        renderFooter();
        renderBadge();
    }

    function currentCapsules() {
        return capsules;
    }

    function tokenPrefix() {
        return key;
    }

    function writeCurrentText() {
        const value = serializeCapsules(capsules, { generationSeed: Math.max(0, getGenerationSeed()), imageIndex: 0, tokenPrefix: tokenPrefix() });
        if (value !== textbox.value) setTextboxValue(textboxControl, textbox, value, guard);
    }

    function syncFromText() {
        const parsed = parsePromptToCapsules(textbox.value);
        const result = reconcilePlans(parsed, plans);
        capsules = result.capsules;
        const before = Object.keys(plans).length;
        plans = result.plans;
        if (result.discarded.length > 0) {
            discardedNotice = result.discarded.length;
            if (Object.keys(plans).length !== before) emitPlans();
        }
    }

    function emitPlans() {
        onPlansChange?.(serializePlans(plans));
    }

    function commitCapsules(next, { rewrite = true } = {}) {
        capsules = next;
        plans = collectPlans(capsules);
        if (rewrite) writeCurrentText();
        emitPlans();
        render();
        onChange?.(api);
    }

    // ---------------------------------------------------------------- related-tag strip
    const SUGGEST_STORAGE_KEY = 'saa.tagSuggest';
    function suggestEnabled() {
        try { return localStorage.getItem(SUGGEST_STORAGE_KEY) !== 'off'; } catch { return true; }
    }
    function setSuggestEnabled(enabled) {
        try { localStorage.setItem(SUGGEST_STORAGE_KEY, enabled ? 'on' : 'off'); } catch { /* storage blocked */ }
        suggestButton.classList.toggle('is-on', enabled);
        if (!enabled) hideSuggestions();
    }
    let suggestFor = '';
    let suggestToken = 0;
    let suggestTimer = 0;

    function hideSuggestions() {
        suggestFor = '';
        suggestToken += 1;
        suggest.hidden = true;
        suggestBody.replaceChildren();
    }

    function displayTag(tag) {
        return String(tag ?? '').replaceAll('_', ' ');
    }

    function renderSuggestions(capsule, result) {
        const present = new Set(capsules.map(item => normalizeTagName(item.value)));
        const groups = [
            { label: text('tag_ui_related_cooccur'), items: result?.related ?? [] },
            { label: text('tag_ui_related_family', displayTag(result?.familyWord ?? '')), items: result?.family ?? [] },
        ];
        suggestTitle.textContent = text('tag_ui_related_title', capsule.value);
        suggestBody.replaceChildren();
        let shown = 0;
        for (const group of groups) {
            const items = group.items.filter(item => !present.has(normalizeTagName(displayTag(item.tag))));
            if (items.length === 0) continue;
            const row = el('div', 'tag-capsule-suggest-row');
            row.appendChild(el('span', 'tag-capsule-suggest-label', group.label));
            for (const item of items) {
                const button = el('button', 'tag-capsule-suggest-chip', displayTag(item.tag));
                button.type = 'button';
                button.tabIndex = -1;
                button.dataset.tag = displayTag(item.tag);
                if (Number.isFinite(item.score)) button.title = `${displayTag(item.tag)} · ${item.score}`;
                row.appendChild(button);
                shown += 1;
            }
            suggestBody.appendChild(row);
        }
        if (shown === 0) suggestBody.appendChild(el('span', 'tag-capsule-suggest-empty', text('tag_ui_related_none')));
        suggest.hidden = false;
    }

    async function showSuggestions(index, { force = false } = {}) {
        if (typeof fetchRelated !== 'function') return;
        if (!force && !suggestEnabled()) return;
        const capsule = capsules[index];
        if (!capsule) return;
        if (suggestFor === capsule.value && !suggest.hidden) return;
        suggestFor = capsule.value;
        const token = ++suggestToken;
        suggestTitle.textContent = text('tag_ui_related_title', capsule.value);
        suggestBody.replaceChildren(el('span', 'tag-capsule-suggest-empty', text('tag_ui_related_loading')));
        suggest.hidden = false;
        let result = null;
        try { result = await fetchRelated(capsule.value); } catch (error) { console.warn('[tagCapsuleField] related tags failed:', error); }
        if (token !== suggestToken) return;
        renderSuggestions(capsule, result);
    }

    function scheduleSuggestions(index) {
        clearTimeout(suggestTimer);
        suggestTimer = setTimeout(() => { showSuggestions(index); }, 160);
    }

    suggestBody.addEventListener('click', event => {
        const button = event.target.closest('.tag-capsule-suggest-chip');
        if (!button) return;
        const sourceIndex = capsules.findIndex(item => item.value === suggestFor);
        const at = sourceIndex >= 0 ? sourceIndex + 1 : capsules.length;
        const next = insertCapsules(capsules, [button.dataset.tag], at);
        if (next === capsules) return;
        commitCapsules(next);
        button.remove();
        focusChip(at);
    });
    suggestClose.addEventListener('click', () => hideSuggestions());
    suggestButton.addEventListener('click', () => {
        const enabled = !suggestEnabled();
        setSuggestEnabled(enabled);
        if (enabled && focusIndex < capsules.length) showSuggestions(focusIndex, { force: true });
    });
    suggestButton.classList.toggle('is-on', suggestEnabled());

    function renderBadge() {
        const { variable } = capsuleStats(capsules);
        const show = mode === 'string' && variable > 0;
        badge.hidden = !show;
        if (show) badge.textContent = text('tag_ui_badge_variable', variable);
    }

    function renderFooter() {
        const summary = capsuleStats(capsules);
        statTags.textContent = text('tag_ui_stats_tags', summary.total);
        statWeighted.textContent = text('tag_ui_stats_weighted', summary.weighted);
        statWeighted.hidden = summary.weighted === 0;
        statVariable.textContent = text('tag_ui_stats_variable', summary.variable);
        statVariable.hidden = summary.variable === 0;
        batchButton.hidden = summary.variable === 0;
        notice.textContent = discardedNotice > 0 ? text('tag_ui_plans_discarded', discardedNotice) : '';
        notice.hidden = discardedNotice === 0;
    }

    function updateRoving() {
        const chipNodes = chips.querySelectorAll(':scope > .tag-capsule-chip');
        focusIndex = Math.max(0, Math.min(capsules.length, focusIndex));
        chipNodes.forEach((chip, index) => { chip.tabIndex = index === focusIndex ? 0 : -1; });
        addButton.tabIndex = focusIndex === capsules.length ? 0 : -1;
    }

    function render() {
        if (mode === 'capsule') {
            renderChips(chips, capsules, {
                text,
                excludedSet: excludedTagSet(getExcludeText()),
                trailing: addSlot,
                isFavorite: value => isFavoriteTag(favGroupForKey(key), value),
            });
            chips.setAttribute('aria-label', `${fieldLabel()} · ${text('tag_ui_chips_label', capsules.length)}`);
            updateRoving();
        }
        renderFooter();
        renderBadge();
        // the strip follows a chip; once that chip is gone the strip goes too
        if (suggestFor && !capsules.some(item => item.value === suggestFor)) hideSuggestions();
    }

    function focusChip(index, { fallbackToAdd = true } = {}) {
        focusIndex = Math.max(0, Math.min(capsules.length, index));
        updateRoving();
        if (focusIndex < capsules.length) {
            chips.querySelectorAll(':scope > .tag-capsule-chip')[focusIndex]?.focus();
        } else if (fallbackToAdd) {
            addButton.focus();
        }
    }

    function updateToggle() {
        const capsule = mode === 'capsule';
        textButton.setAttribute('aria-checked', capsule ? 'false' : 'true');
        capsuleButton.setAttribute('aria-checked', capsule ? 'true' : 'false');
        textButton.tabIndex = capsule ? -1 : 0;
        capsuleButton.tabIndex = capsule ? 0 : -1;
        textButton.classList.toggle('is-on', !capsule);
        capsuleButton.classList.toggle('is-on', capsule);
    }

    function setMode(nextMode, { focus = false } = {}) {
        const target = nextMode === 'capsule' ? 'capsule' : 'string';
        if (target === mode) return;
        if (target === 'capsule') {
            syncFromText();
            mode = 'capsule';
            relativeContainer.hidden = true;
            view.hidden = false;
            render();
            updateToggle();
            if (focus) focusChip(0);
        } else {
            getWeightPopover().close();
            hideSuggestions();
            writeCurrentText();
            mode = 'string';
            relativeContainer.hidden = false;
            view.hidden = true;
            updateToggle();
            renderBadge();
            if (focus) textbox.focus();
        }
        onChange?.(api);
        onModeChange?.(mode);
    }

    // ---------------------------------------------------------------- add tag → selection modal
    // The "+ Add tag" button routes to the same tag selection modal as "Choose tags"
    // (tagSelectionModal.js wires the trigger on this wrapper before this setup runs).
    // The modal writes into the hidden textarea, whose input event syncs the capsules.
    function openTagModal() {
        if (!chooseButton) return;
        const length = textbox.value.length;
        try { textbox.setSelectionRange(length, length); } catch { /* non-focusable state */ }
        chooseButton.click();
    }

    addButton.addEventListener('click', () => { focusIndex = capsules.length; openTagModal(); });
    addButton.addEventListener('focus', () => { focusIndex = capsules.length; updateRoving(); });

    // ---------------------------------------------------------------- chip events
    function chipIndexOf(target) {
        const chip = target?.closest?.('.tag-capsule-chip');
        if (!chip) return -1;
        return [...chips.querySelectorAll(':scope > .tag-capsule-chip')].indexOf(chip);
    }

    function openPopover(index) {
        const capsule = capsules[index];
        const anchor = chips.querySelectorAll(':scope > .tag-capsule-chip')[index];
        if (!capsule || !anchor) return;
        getWeightPopover().open({
            anchor,
            capsule,
            generationSeed: Math.max(0, getGenerationSeed()),
            fallbackFocus: capsuleButton,
            onApply: plan => {
                commitCapsules(setCapsulePlan(capsules, capsule.id, plan));
                focusChip(index);
            },
        });
    }

    function deleteAt(index) {
        if (index < 0 || index >= capsules.length) return;
        const next = removeCapsule(capsules, index);
        commitCapsules(next);
        // next chip takes the slot; the previous one when the last chip was removed; add slot when empty
        focusChip(Math.max(0, Math.min(index, next.length - 1)), { fallbackToAdd: true });
    }

    chips.addEventListener('click', event => {
        const index = chipIndexOf(event.target);
        if (index < 0) return;
        if (event.target.closest('.tag-capsule-chip-remove')) {
            deleteAt(index);
            return;
        }
        if (event.target.closest('.tag-capsule-chip-toggle')) {
            commitCapsules(toggleCapsuleDisabled(capsules, index));
            focusChip(index);
            return;
        }
        focusIndex = index;
        updateRoving();
        openPopover(index);
    });

    chips.addEventListener('focusin', event => {
        const index = chipIndexOf(event.target);
        if (index >= 0) { focusIndex = index; updateRoving(); scheduleSuggestions(index); }
    });

    chips.addEventListener('keydown', event => {
        if (event.isComposing || event.keyCode === 229) return;
        const onAdd = event.target === addButton;
        const state = { index: onAdd ? capsules.length : focusIndex, count: capsules.length };
        const result = handleChipKey(state, event.key, { ctrlKey: event.ctrlKey, metaKey: event.metaKey });
        const handled = result.action !== null || result.index !== state.index
            || ['ArrowLeft', 'ArrowRight', 'Home', 'End', 'Enter', ' '].includes(event.key);
        if (!handled) return;
        event.preventDefault();
        switch (result.action) {
            case 'open':
                focusIndex = result.index;
                updateRoving();
                openPopover(result.index);
                break;
            case 'add':
            case 'type':
                focusIndex = capsules.length;
                openTagModal();
                break;
            case 'delete':
                deleteAt(state.index);
                break;
            case 'move-left':
            case 'move-right':
                commitCapsules(moveCapsule(capsules, state.index, result.index));
                focusChip(result.index);
                break;
            case 'weight-up':
            case 'weight-down': {
                const next = nudgeCapsuleWeight(capsules, state.index, result.action === 'weight-up' ? 0.05 : -0.05);
                if (next !== capsules) commitCapsules(next);
                focusChip(state.index);
                break;
            }
            case 'exit':
                capsuleButton.focus();
                break;
            default:
                focusChip(result.index);
        }
    });

    // Drag = Ctrl+←→ equivalent (§9.6) inside one field; dropping on another field's chip
    // row moves the capsule there (Ctrl/Alt held = copy). The payload rides under its own
    // MIME type so only chip rows accept it.
    const CAPSULE_MIME = 'application/x-saa-capsule';
    const isExternalDrag = event => dragIndex < 0 && Array.from(event.dataTransfer?.types ?? []).includes(CAPSULE_MIME);
    chips.addEventListener('dragstart', event => {
        dragIndex = chipIndexOf(event.target);
        if (dragIndex < 0) { event.preventDefault(); return; }
        event.dataTransfer.effectAllowed = 'copyMove';
        event.dataTransfer.setData('text/plain', capsules[dragIndex]?.value ?? '');
        event.dataTransfer.setData(CAPSULE_MIME, JSON.stringify({ field: key, id: capsules[dragIndex]?.id ?? '' }));
        event.target.classList.add('is-dragging');
    });
    chips.addEventListener('dragend', event => {
        event.target.classList?.remove('is-dragging');
        dragIndex = -1;
    });
    chips.addEventListener('dragover', event => {
        if (dragIndex >= 0) {
            event.preventDefault();
            event.dataTransfer.dropEffect = 'move';
            return;
        }
        if (!isExternalDrag(event)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = event.ctrlKey || event.altKey ? 'copy' : 'move';
        chips.classList.add('is-drop-target');
    });
    chips.addEventListener('dragleave', event => {
        if (!chips.contains(event.relatedTarget)) chips.classList.remove('is-drop-target');
    });
    chips.addEventListener('drop', event => {
        chips.classList.remove('is-drop-target');
        if (dragIndex >= 0) {
            event.preventDefault();
            let target = chipIndexOf(event.target);
            if (target < 0) target = capsules.length - 1;
            if (target !== dragIndex) {
                commitCapsules(moveCapsule(capsules, dragIndex, target));
                focusChip(target);
            }
            dragIndex = -1;
            return;
        }
        if (!isExternalDrag(event)) return;
        event.preventDefault();
        let payload = null;
        try { payload = JSON.parse(event.dataTransfer.getData(CAPSULE_MIME) || 'null'); } catch { payload = null; }
        if (!payload?.field || !payload?.id || payload.field === key) return;
        const over = chipIndexOf(event.target);
        const at = over < 0 ? capsules.length : over;
        onExternalDrop?.(payload, at, { copy: event.ctrlKey || event.altKey });
    });

    // ---------------------------------------------------------------- toggle events
    textButton.addEventListener('click', () => setMode('string', { focus: false }));
    capsuleButton.addEventListener('click', () => setMode('capsule', { focus: false }));
    viewToggle.addEventListener('keydown', event => {
        if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
        event.preventDefault();
        const next = mode === 'capsule' ? 'string' : 'capsule';
        setMode(next);
        (next === 'capsule' ? capsuleButton : textButton).focus();
    });

    // ---------------------------------------------------------------- batch dialog
    batchButton.addEventListener('click', () => {
        getBatchWeightDialog().open({
            trigger: batchButton,
            fallback: capsuleButton,
            fieldLabel: fieldLabel(),
            tokenPrefix: tokenPrefix(),
            capsules,
            batch,
            generationSeed: getGenerationSeed(),
            expand: (count, seed) => (typeof expandForBatch === 'function'
                ? expandForBatch(count, seed, key)
                : expandAll([{ key, capsules }], seed, count).map(row => ({
                    imageIndex: row.imageIndex,
                    weights: row.weights,
                    terminal: row.terminal,
                    prompt: row.fields[key],
                }))),
            onApply: (nextBatch, seed) => {
                batch = normalizeBatch(nextBatch);
                onBatchChange?.(batch);
                if (typeof onSeedChange === 'function') onSeedChange(seed);
                render();
                onChange?.(api);
            },
        });
    });

    // ---------------------------------------------------------------- textarea sync
    textbox.addEventListener('input', () => {
        if (suppressInput) return;
        syncFromText();
        render();
        onChange?.(api);
    });
    textbox.addEventListener('mytextbox-value-set', () => {
        if (suppressInput) return;
        syncFromText();
        render();
        onChange?.(api);
    });

    const titleObserver = new MutationObserver(() => applyText());
    titleObserver.observe(textbox, { attributes: true, attributeFilter: ['placeholder', 'title'] });

    // star toggles in the selection modal reflect into the chips immediately
    document.addEventListener(FAVORITE_TAGS_CHANGED_EVENT, () => render());

    // ---------------------------------------------------------------- init
    textbox.dataset.tagCapsuleFieldSetup = 'true';
    syncFromText();
    updateToggle();
    applyText();
    render();

    const api = {
        key,
        textbox,
        element: view,
        header,
        getMode: () => mode,
        setMode,
        getCapsules: () => capsules.map(capsule => ({ ...capsule, weightPlan: { ...capsule.weightPlan } })),
        getPlans: () => serializePlans(plans),
        getBatch: () => ({ ...batch }),
        focusFromHistory: (capsuleId, fallbackIndex = 0) => {
            const index = capsules.findIndex(capsule => capsule.id === capsuleId);
            focusChip(index >= 0 ? index : Math.max(0, Math.min(capsules.length, fallbackIndex)));
        },
        setPlans: entries => {
            plans = parsePlans(entries);
            syncFromText();
            discardedNotice = 0;
            emitPlans();
            render();
            onChange?.(api);
        },
        setBatch: next => {
            batch = normalizeBatch(next);
            render();
            onChange?.(api);
        },
        refresh: () => { syncFromText(); render(); },
        clearNotice: () => { discardedNotice = 0; renderFooter(); },
        updateLanguage: applyText,
        expandedText: (imageIndex, seed) => serializeCapsules(capsules, {
            generationSeed: Math.max(0, seed),
            imageIndex,
            tokenPrefix: tokenPrefix(),
            omitDisabled: true,
        }),
        setAllDisabled: disabled => { commitCapsules(setAllCapsulesDisabled(capsules, disabled)); },
        getLabel: fieldLabel,
        // cross-field transfer + context menu entry points
        replaceCapsules: next => { commitCapsules(Array.isArray(next) ? next : capsules); },
        findCapsule: id => capsules.find(capsule => capsule.id === id) ?? null,
        insertTags: (values, at = capsules.length) => {
            const next = insertCapsules(capsules, values, at);
            if (next !== capsules) commitCapsules(next);
        },
        focusCapsule: id => {
            const index = capsules.findIndex(capsule => capsule.id === id);
            if (index >= 0) focusChip(index);
        },
        showRelated: id => {
            const index = capsules.findIndex(capsule => capsule.id === id);
            if (index >= 0) showSuggestions(index, { force: true });
        },
    };
    if (initialMode === 'capsule') setMode('capsule');
    return api;
}

// Wires every prompt field, the shared Final prompt disclosure, and settings persistence.
export function setupTagCapsuleFields(textboxControls = [], options = {}) {
    const {
        keys = PROMPT_FIELD_KEYS,
        text = tagText,
        settings = () => globalThis.globalSettings ?? {},
        getGenerationSeed = () => Number(globalThis.generate?.seed?.getValue?.() ?? -1),
        setGenerationSeed = seed => globalThis.generate?.seed?.setValue?.(seed),
        applyExclude = null,
        finalPromptContainer = null,
        showRight = () => Boolean(globalThis.globalSettings?.regional_condition),
        fetchRelated = null,     // async (tagValue) => related-tag groups (null disables the strip)
    } = options;

    const fields = new Map();
    let disclosure = null;
    let batchUpdateDepth = 0;
    let finalRefreshPending = false;

    const fieldList = () => [...fields.values()];
    const previewSeed = () => Math.max(0, getGenerationSeed());

    function expansionFields() {
        return fieldList().map(field => ({ key: field.key, capsules: field.getCapsules(), batch: field.getBatch() }));
    }

    function expandRows(count, seed) {
        // slider ≥ 0: the seed is pinned for the whole batch, weights are the only variable
        return expandAll(expansionFields(), seed, count, { applyExclude, fixedSeed: getGenerationSeed() >= 0 });
    }

    function getBatchExpansion() {
        return resolveBatchPlan(expansionFields());
    }

    function refreshFinalPrompt() {
        disclosure?.refresh();
    }

    function requestFinalPromptRefresh() {
        if (batchUpdateDepth > 0) {
            finalRefreshPending = true;
            return;
        }
        refreshFinalPrompt();
    }

    // One Text/Capsules choice for the whole prompt card: flipping it on any field
    // flips every field (custom ones included) and is remembered per machine.
    const MODE_STORAGE_KEY = 'saa.capsuleMode';
    let sharedMode = 'string';
    try { sharedMode = localStorage.getItem(MODE_STORAGE_KEY) === 'capsule' ? 'capsule' : 'string'; } catch { /* storage blocked */ }
    let propagatingMode = false;
    function propagateMode(mode) {
        if (propagatingMode || mode === sharedMode) return;
        sharedMode = mode;
        try { localStorage.setItem(MODE_STORAGE_KEY, mode); } catch { /* storage blocked */ }
        propagatingMode = true;
        try {
            for (const field of fields.values()) if (field.getMode() !== mode) field.setMode(mode);
        } finally {
            propagatingMode = false;
        }
    }

    // Built-in fields keep their plans / batch under `<key>_weight_plans` /
    // `<key>_batch`; a custom field (cf_*) keeps them inside its
    // prompt_custom_fields entry, owned by the field manager.
    function readStoredExtras(stored, key) {
        if (isCustomFieldId(key)) return customFieldExtras(stored?.prompt_custom_fields, key);
        return { weight_plans: stored?.[`${key}_weight_plans`] ?? [], batch: stored?.[`${key}_batch`] ?? DEFAULT_BATCH };
    }

    function writeStoredExtras(key, extras) {
        const stored = settings();
        if (isCustomFieldId(key)) {
            const manager = globalThis.prompt?.fieldManager;
            if (manager?.setFieldExtras) manager.setFieldExtras(key, extras);
            else stored.prompt_custom_fields = setCustomFieldExtras(stored.prompt_custom_fields, key, extras);
            return;
        }
        if (extras.weight_plans !== undefined) stored[`${key}_weight_plans`] = extras.weight_plans;
        if (extras.batch !== undefined) stored[`${key}_batch`] = { ...extras.batch };
    }

    function addField(control, key) {
        const stored = settings();
        const extras = readStoredExtras(stored, key);
        const field = setupTagCapsuleField(control, {
            key,
            text,
            getGenerationSeed,
            initialMode: sharedMode,
            onModeChange: propagateMode,
            fetchRelated,
            onExternalDrop: (payload, at, { copy }) => set.transfer(payload.field, payload.id, key, { at, copy }),
            getExcludeText: () => fields.get('exclude')?.textbox?.value ?? globalThis.prompt?.exclude?.getValue?.() ?? '',
            initialPlans: extras.weight_plans,
            initialBatch: extras.batch,
            onPlansChange: plans => writeStoredExtras(key, { weight_plans: plans }),
            onBatchChange: batch => writeStoredExtras(key, { batch }),
            onSeedChange: seed => { if (Number.isFinite(seed)) setGenerationSeed(seed); },
            expandForBatch: (count, seed, fieldKey) => expandRows(count, seed).map(row => ({
                imageIndex: row.imageIndex,
                weights: row.weights,
                terminal: row.terminal,
                prompt: fieldKey === 'positive' || fieldKey === 'common' ? row.positive
                    : fieldKey === 'positive_right' ? row.positiveRight
                        : row.fields[fieldKey],
            })),
            onChange: changed => {
                if (changed.key === 'exclude') {
                    for (const other of fields.values()) if (other !== changed) other.refresh();
                }
                requestFinalPromptRefresh();
            },
        });
        if (field) fields.set(key, field);
        return field ?? null;
    }

    textboxControls.forEach((control, index) => addField(control, keys[index] ?? `field_${index}`));

    if (finalPromptContainer) {
        disclosure = setupFinalPromptDisclosure({
            container: finalPromptContainer,
            text,
            showRight,
            getExpansion: () => {
                const plan = getBatchExpansion();
                const count = plan.variable > 0 ? (plan.enabled ? plan.count : Math.max(1, ...fieldList().map(field => field.getBatch().count))) : 1;
                return { rows: expandRows(count, previewSeed()), count, variable: plan.variable };
            },
        });
    }

    const set = {
        fields,
        get: key => fields.get(key) ?? null,
        // custom prompt fields are created after boot (promptFieldManager) and can go away again
        add: (control, key) => {
            const field = addField(control, key);
            if (field) requestFinalPromptRefresh();
            return field;
        },
        remove: key => {
            if (!fields.delete(key)) return;
            requestFinalPromptRefresh();
        },
        getMode: () => sharedMode,
        setMode: mode => propagateMode(mode === 'capsule' ? 'capsule' : 'string'),
        // Moves (copy: duplicates) one capsule into another field, weight plan and
        // disabled state included. Returns the inserted capsule or null.
        transfer: (sourceKey, capsuleId, targetKey, { at, copy = false } = {}) => {
            const source = fields.get(sourceKey);
            const target = fields.get(targetKey);
            if (!source || !target || sourceKey === targetKey) return null;
            const result = transferCapsule(source.getCapsules(), target.getCapsules(), capsuleId, { at, copy });
            if (!result.moved) return null;
            batchUpdateDepth += 1;
            try {
                if (!copy) source.replaceCapsules(result.source);
                target.replaceCapsules(result.target);
            } finally {
                batchUpdateDepth = Math.max(0, batchUpdateDepth - 1);
            }
            requestFinalPromptRefresh();
            target.focusCapsule(result.moved.id);
            return result.moved;
        },
        fieldKeyOf: element => element?.closest?.('[data-field-key]')?.dataset.fieldKey ?? null,
        hasRelated: typeof fetchRelated === 'function',
        beginBatchUpdate: () => { batchUpdateDepth += 1; },
        endBatchUpdate: () => {
            batchUpdateDepth = Math.max(0, batchUpdateDepth - 1);
            if (batchUpdateDepth === 0 && finalRefreshPending) {
                finalRefreshPending = false;
                refreshFinalPrompt();
            }
        },
        expandAll: (count, seed) => expandRows(count, seed),
        getBatchExpansion,
        // `count` is the whole batch: "÷ batch count" plans derive their step from it,
        // so expanding image i as a batch of i + 1 would give every image a different step.
        getPromptOverrides: (imageIndex, seed, count = imageIndex + 1) => {
            const total = Math.max(imageIndex + 1, Math.floor(Number(count) || 0));
            const row = expandRows(total, seed)[imageIndex];
            return row ? { ...row.fields, weights: row.weights, terminal: row.terminal } : null;
        },
        loadFromSettings: (stored = settings()) => {
            for (const [key, field] of fields) {
                const extras = readStoredExtras(stored, key);
                field.setPlans(extras.weight_plans);
                field.setBatch(extras.batch);
            }
            refreshFinalPrompt();
        },
        updateLanguage: () => {
            for (const field of fields.values()) field.updateLanguage();
            getWeightPopover().updateLanguage();
            getBatchWeightDialog().updateLanguage();
            disclosure?.updateLanguage();
        },
        refreshFinalPrompt: requestFinalPromptRefresh,
        finalPrompt: () => disclosure,
    };
    return set;
}
