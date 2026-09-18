// L1: one prompt field = integrated header (label / Choose tags / Text|Capsules toggle)
// + chip row + "+ Add tag" + footer. The textarea stays the source of truth; capsules are a
// derived view and variable plans live in a per-field sidecar (id → plan).
import {
    DEFAULT_BATCH,
    assignCapsuleIds,
    capsuleStats,
    collectPlans,
    excludedTagSet,
    expandAll,
    handleChipKey,
    insertCapsules,
    isVariablePlan,
    migratePlanIds,
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
    moveCapsuleBlock,
    insertionIndexFromRects,
    reorderIndex,
    removeCapsules,
    setCapsulesDisabled,
    transferCapsules,
} from './tagCapsuleLogic.js';
import { createIcon, renderChips } from './tagCapsuleChip.js';
import { FAVORITE_TAGS_CHANGED_EVENT, favGroupForKey, isFavoriteTag } from './favoriteTags.js';
import { getWeightPopover } from './weightPopover.js';
import { getBatchWeightDialog } from './batchWeightDialog.js';
import { setupFinalPromptDisclosure } from './finalPromptDisclosure.js';
import { tagText } from './tagUiText.js';
import { TAG_DICTIONARY_EVENT, tagStatus } from './tagDictionaryStatus.js';
import { customFieldExtras, isCustomFieldId, normalizeCustomFields, normalizeOrder, setCustomFieldExtras } from '../../shared/promptFieldOrder.js';
import { sideOrder } from '../../shared/regionalSides.js';
import { castEnabled, isDiffusionFieldId } from '../../shared/castMembers.js';

// Unit ids of each prompt in generation order (scripts/shared/regionalSides.js), so
// the Final prompt preview and the batch dialogs mirror what generate.js assembles.
// Regional: the left / right positive chains and one merged negative (shared, left,
// right); otherwise the single chains and no right prompt.
export function chainFromSettings(stored = {}) {
    // the "@alias" cast rows and the Action row join the chain for the Diffusion model type only
    const customs = normalizeCustomFields(stored?.prompt_custom_fields)
        .filter(field => castEnabled(stored) || !isDiffusionFieldId(field.id));
    const positive = normalizeOrder(stored?.prompt_positive_order, 'positive', customs);
    const negative = normalizeOrder(stored?.prompt_negative_order, 'negative', customs);
    if (!stored?.regional_condition) return { positive, positiveRight: null, negative };
    // the merged negative in the order generation writes it (negativeComposition.js
    // composeRegionalNegatives): the shared units first, then the left ones, then the right ones
    const negativeBoth = sideOrder(negative, 'both', customs);
    const negativeLeft = sideOrder(negative, 'left', customs).filter(id => !negativeBoth.includes(id));
    const negativeRight = sideOrder(negative, 'right', customs).filter(id => !negativeBoth.includes(id));
    return {
        positive: sideOrder(positive, 'left', customs),
        positiveRight: sideOrder(positive, 'right', customs),
        negative: [...negativeBoth, ...negativeLeft, ...negativeRight],
        // generation writes a shared unit once: a side unit repeating its text is dropped
        negativeShared: negativeBoth,
    };
}

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
        // the chips wrote this text; tagAutoComplete.js must not answer it with suggestions
        textbox.dispatchEvent(new CustomEvent('input', { bubbles: true, detail: { source: 'capsules' } }));
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
        readStoredPlans = null,  // () => the stored plan entries of this field (settings)
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

    // ---------------------------------------------------------------- multi-selection
    // Ctrl/Cmd+click toggles a chip, Shift+click extends from the focused chip, Ctrl+A
    // takes every chip, Escape clears. A drag, Delete or a context-menu action on a
    // selected chip applies to the whole selection.
    const selectedIds = new Set();
    let anchorIndex = -1;
    function selectionIds() {
        return capsules.filter(capsule => selectedIds.has(capsule.id)).map(capsule => capsule.id);
    }
    // true while at least one chip carries `is-selected`; an empty selection over an
    // unpainted row is a no-op, so plain renders skip the per-chip attribute writes
    let selectionPainted = false;
    function applySelectionClasses() {
        if (selectedIds.size === 0 && !selectionPainted) return;
        const chipNodes = chips.querySelectorAll(':scope > .tag-capsule-chip');
        chipNodes.forEach((chip, index) => {
            chip.classList.toggle('is-selected', selectedIds.has(capsules[index]?.id));
            chip.setAttribute('aria-selected', selectedIds.has(capsules[index]?.id) ? 'true' : 'false');
        });
        selectionPainted = selectedIds.size > 0;
    }
    function setSelection(ids) {
        selectedIds.clear();
        for (const id of ids ?? []) selectedIds.add(id);
        applySelectionClasses();
    }
    function clearSelection() {
        if (selectedIds.size === 0) return;
        selectedIds.clear();
        anchorIndex = -1;
        applySelectionClasses();
    }
    function toggleSelected(index) {
        const id = capsules[index]?.id;
        if (!id) return;
        if (selectedIds.has(id)) selectedIds.delete(id); else selectedIds.add(id);
        anchorIndex = index;
        applySelectionClasses();
    }
    function selectRange(index) {
        const from = anchorIndex >= 0 ? anchorIndex : focusIndex;
        const [start, end] = from <= index ? [from, index] : [index, from];
        for (let position = start; position <= end; position += 1) {
            if (capsules[position]) selectedIds.add(capsules[position].id);
        }
        applySelectionClasses();
    }
    function pruneSelection() {
        const alive = new Set(capsules.map(capsule => capsule.id));
        for (const id of [...selectedIds]) if (!alive.has(id)) selectedIds.delete(id);
    }
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
        // inside a Regional box the box names the side: "Positive (right)" reads "Positive"
        const boxed = Boolean(view.closest?.('.scene-side'));
        const labelKey = boxed && /^(positive|negative)_(left|right)$/.test(key) ? key.split('_')[0] : key;
        const short = LANG?.[`ui_field_${labelKey}`];
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
        // plans stored before the grouped-token parser name their chips the old way
        const migrated = migratePlanIds(plans, textbox.value);
        if (migrated.changed) plans = migrated.plans;
        const result = reconcilePlans(parsed, plans);
        capsules = result.capsules;
        const before = Object.keys(plans).length;
        plans = result.plans;
        if (result.discarded.length > 0) {
            discardedNotice = result.discarded.length;
            if (Object.keys(plans).length !== before) emitPlans();
        } else if (migrated.changed) {
            emitPlans();
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

    // ---------------------------------------------------------------- related tags
    // Related tags live in the chip popover's Related tab (weightPopover.js). This
    // opens it there for a chip: the footer spark button, the context menu's "Related
    // tags…" and Ctrl+R on a chip all land here. (Earlier builds drew a panel under
    // the field, and before that opened it on chip focus; both are gone.)
    function openRelated(index) {
        if (typeof fetchRelated !== 'function' || capsules.length === 0) return;
        const at = index >= 0 && index < capsules.length ? index : 0;
        openPopover(at, { tab: 'related' });
    }
    suggestButton.addEventListener('click', () => openRelated(focusIndex < capsules.length ? focusIndex : 0));

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

    // renderChips keeps the chips as the leading children of the row (the add slot is
    // always last), so the chip at a capsule index is a direct child lookup
    function chipAt(index) {
        const node = index >= 0 && index < capsules.length ? chips.children[index] : null;
        return node?.classList.contains('tag-capsule-chip') ? node : null;
    }

    // Roving tabindex: every chip is created with tabIndex -1, so only the previously
    // focused chip and the new one need a write (not the whole row on each focus move).
    let rovingChip = null;
    function updateRoving() {
        focusIndex = Math.max(0, Math.min(capsules.length, focusIndex));
        const chip = chipAt(focusIndex);
        if (rovingChip && rovingChip !== chip) rovingChip.tabIndex = -1;
        if (chip) chip.tabIndex = 0;
        rovingChip = chip;
        addButton.tabIndex = focusIndex === capsules.length ? 0 : -1;
    }

    // dictionary answers arrive after the first paint; the chips are re-marked then
    const onDictionaryEvent = () => { if (mode === 'capsule') render(); };
    document.addEventListener(TAG_DICTIONARY_EVENT, onDictionaryEvent);

    function render() {
        if (mode === 'capsule') {
            renderChips(chips, capsules, {
                text,
                excludedSet: excludedTagSet(getExcludeText()),
                trailing: addSlot,
                isFavorite: value => isFavoriteTag(favGroupForKey(key), value),
                tagStatus,
            });
            chips.setAttribute('aria-label', `${fieldLabel()} · ${text('tag_ui_chips_label', capsules.length)}`);
            updateRoving();
            pruneSelection();
            applySelectionClasses();
        }
        renderFooter();
        renderBadge();
    }

    function focusChip(index, { fallbackToAdd = true } = {}) {
        focusIndex = Math.max(0, Math.min(capsules.length, index));
        updateRoving();
        if (focusIndex < capsules.length) {
            chipAt(focusIndex)?.focus();
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
            // every chip edit already wrote the text (commitCapsules); rewriting it here
            // would re-join untouched text (line breaks, "1.125", "(tag:1.0)") on a mere toggle
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
        // each chip carries its capsule id (tagCapsuleChip.js updateChip); no DOM query needed
        const id = chip.dataset.capsuleId;
        return id ? capsules.findIndex(capsule => capsule.id === id) : -1;
    }

    function openPopover(index, { tab = null } = {}) {
        const capsule = capsules[index];
        const anchor = chipAt(index);
        if (!capsule || !anchor) return;
        getWeightPopover().open({
            anchor,
            capsule,
            generationSeed: Math.max(0, getGenerationSeed()),
            fallbackFocus: capsuleButton,
            tab,
            onApply: plan => {
                commitCapsules(setCapsulePlan(capsules, capsule.id, plan));
                focusChip(index);
            },
            // Related tab: the dictionary's neighbours of this chip's tag
            fetchRelated: typeof fetchRelated === 'function' ? fetchRelated : null,
            presentTags: () => new Set(capsules.map(item => normalizeTagName(item.value))),
            onPick: (tag, { replace = false } = {}) => {
                const at = capsules.findIndex(item => item.id === capsule.id);
                if (replace && at >= 0) {
                    // the picked tag takes this chip's place, weight plan and all
                    const next = assignCapsuleIds(capsules.map((item, i) => (i === at ? { ...item, value: tag } : item)));
                    commitCapsules(next);
                    focusChip(at);
                    return;
                }
                const next = insertCapsules(capsules, [tag], at >= 0 ? at + 1 : capsules.length);
                if (next !== capsules) commitCapsules(next);
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
            // on a selected chip the dot flips the whole selection together
            const ids = selectedIds.has(capsules[index]?.id) ? selectionIds() : [];
            commitCapsules(ids.length > 1 ? setCapsulesDisabled(capsules, ids, !capsules[index].disabled) : toggleCapsuleDisabled(capsules, index));
            focusChip(index);
            return;
        }
        if (event.ctrlKey || event.metaKey) {
            toggleSelected(index);
            focusIndex = index;
            updateRoving();
            return;
        }
        if (event.shiftKey) {
            selectRange(index);
            focusIndex = index;
            updateRoving();
            return;
        }
        clearSelection();
        focusIndex = index;
        anchorIndex = index;
        updateRoving();
        openPopover(index);
    });

    chips.addEventListener('focusin', event => {
        const index = chipIndexOf(event.target);
        if (index >= 0) { focusIndex = index; updateRoving(); }
    });

    chips.addEventListener('keydown', event => {
        if (event.isComposing || event.keyCode === 229) return;
        const onAdd = event.target === addButton;
        const state = { index: onAdd ? capsules.length : focusIndex, count: capsules.length };
        // Ctrl+R opens the chip popover on its Related tab for the focused chip; on the
        // add slot it does nothing. Either way the key is consumed here, so it never
        // reaches the window menu's Reload.
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'r') {
            event.preventDefault();
            if (!onAdd) openRelated(focusIndex);
            return;
        }
        // selection keys first: Ctrl+A selects every chip, Escape drops the selection,
        // Delete on a selected chip removes the whole selection
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a' && !onAdd) {
            event.preventDefault();
            setSelection(capsules.map(capsule => capsule.id));
            return;
        }
        if (event.key === 'Escape' && selectedIds.size > 0) {
            event.preventDefault();
            clearSelection();
            return;
        }
        if ((event.key === 'Delete' || event.key === 'Backspace') && !onAdd && selectedIds.size > 1 && selectedIds.has(capsules[focusIndex]?.id)) {
            event.preventDefault();
            const ids = selectionIds();
            const next = removeCapsules(capsules, ids);
            selectedIds.clear();
            commitCapsules(next);
            focusChip(Math.max(0, Math.min(focusIndex, next.length - 1)), { fallbackToAdd: true });
            return;
        }
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
        // a selected chip drags the whole selection; any other chip drags alone
        const ids = selectedIds.has(capsules[dragIndex]?.id) ? selectionIds() : [capsules[dragIndex]?.id ?? ''];
        event.dataTransfer.setData('text/plain', capsules.filter(capsule => ids.includes(capsule.id)).map(capsule => capsule.value).join(', '));
        event.dataTransfer.setData(CAPSULE_MIME, JSON.stringify({ field: key, id: capsules[dragIndex]?.id ?? '', ids }));
        event.target.classList.add('is-dragging');
        if (ids.length > 1) {
            for (const chip of chips.querySelectorAll(':scope > .tag-capsule-chip.is-selected')) chip.classList.add('is-dragging');
        }
    });
    // Where a pointer over the wrapped chip row would insert: every chip on a row
    // above the pointer counts, plus the chips on its row whose centre is left of it.
    // Blank row space and the add slot resolve to the end.
    function insertionIndexAt(x, y) {
        const rects = [...chips.querySelectorAll(':scope > .tag-capsule-chip')].map(chip => chip.getBoundingClientRect());
        return insertionIndexFromRects(rects, x, y);
    }
    // A thin bar at the insertion point while something is dragged over the row.
    let dropMarker = null;
    function showDropMarker(index) {
        dropMarker ??= Object.assign(document.createElement('span'), { className: 'tag-capsule-drop-marker' });
        const all = chips.querySelectorAll(':scope > .tag-capsule-chip');
        const anchor = all[index] ?? all[all.length - 1]?.nextElementSibling ?? null;
        if (dropMarker.nextElementSibling !== anchor || dropMarker.parentElement !== chips) chips.insertBefore(dropMarker, anchor);
    }
    function hideDropMarker() {
        dropMarker?.remove();
    }
    // One undo step per drop (the context menu's Move-to does the same).
    const dropTransaction = mutate => {
        if (globalThis.settingsPersistence?.runEditTransaction) return globalThis.settingsPersistence.runEditTransaction({ source: 'capsule-drag', sections: ['prompt'] }, mutate);
        return mutate();
    };
    function endDrag() {
        for (const chip of chips.querySelectorAll(':scope > .tag-capsule-chip.is-dragging')) chip.classList.remove('is-dragging');
        dragIndex = -1;
        hideDropMarker();
    }
    chips.addEventListener('dragend', endDrag);
    // A drop that moves the dragged chip into another field re-renders this row before
    // `dragend` fires, so that event lands on a detached chip and never reaches the row.
    // Any drop in the document ends this row's drag once the drop handlers have run.
    const onDocumentDrop = () => { if (dragIndex >= 0) setTimeout(endDrag, 0); };
    document.addEventListener('drop', onDocumentDrop, true);
    chips.addEventListener('dragover', event => {
        const own = dragIndex >= 0;
        if (!own && !isExternalDrag(event)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = own ? 'move' : (event.ctrlKey || event.altKey ? 'copy' : 'move');
        if (!own) chips.classList.add('is-drop-target');
        showDropMarker(insertionIndexAt(event.clientX, event.clientY));
    });
    chips.addEventListener('dragleave', event => {
        if (chips.contains(event.relatedTarget)) return;
        chips.classList.remove('is-drop-target');
        hideDropMarker();
    });
    chips.addEventListener('drop', event => {
        chips.classList.remove('is-drop-target');
        const insertAt = insertionIndexAt(event.clientX, event.clientY);
        hideDropMarker();
        if (dragIndex >= 0) {
            event.preventDefault();
            const from = dragIndex;
            dragIndex = -1;
            const draggedId = capsules[from]?.id;
            if (selectedIds.has(draggedId) && selectedIds.size > 1) {
                // the selection moves as a block to the insertion point (before the chip there, or the end)
                const moved = moveCapsuleBlock(capsules, selectionIds(), insertAt);
                if (moved.capsules !== capsules) {
                    const next = moved.capsules;
                    dropTransaction(() => commitCapsules(next));
                    // the moved block by position, not by value: an unselected chip with the same name stays unselected
                    setSelection(moved.ids);
                    focusChip(Math.max(0, next.findIndex(capsule => selectedIds.has(capsule.id))));
                }
                return;
            }
            // insertion index counts the dragged chip itself while it still sits before the point
            const to = reorderIndex(from, insertAt);
            if (to !== from) {
                dropTransaction(() => commitCapsules(moveCapsule(capsules, from, to)));
                focusChip(to);
            }
            return;
        }
        if (!isExternalDrag(event)) return;
        event.preventDefault();
        let payload = null;
        try { payload = JSON.parse(event.dataTransfer.getData(CAPSULE_MIME) || 'null'); } catch { payload = null; }
        if (!payload?.field || !payload?.id || payload.field === key) return;
        onExternalDrop?.(payload, insertAt, { copy: event.ctrlKey || event.altKey });
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
        // A programmatic set (Swap, preset load, undo, model-type restore) writes the
        // stored plans together with the text: reconcile the new text against those.
        // The plans of the text this field held before would be discarded and written
        // back over the stored ones.
        if (typeof readStoredPlans === 'function') plans = parsePlans(readStoredPlans());
        syncFromText();
        render();
        onChange?.(api);
    });

    const titleObserver = new MutationObserver(() => applyText());
    titleObserver.observe(textbox, { attributes: true, attributeFilter: ['placeholder', 'title'] });

    // star toggles in the selection modal reflect into the chips immediately
    const onFavoritesChanged = () => render();
    document.addEventListener(FAVORITE_TAGS_CHANGED_EVENT, onFavoritesChanged);

    // Field removal (custom rows): drops the document-level listeners, the title
    // observer and any pending timer so a detached field stops rendering.
    let disposed = false;
    function dispose() {
        if (disposed) return;
        disposed = true;
        document.removeEventListener(TAG_DICTIONARY_EVENT, onDictionaryEvent);
        document.removeEventListener(FAVORITE_TAGS_CHANGED_EVENT, onFavoritesChanged);
        document.removeEventListener('drop', onDocumentDrop, true);
        titleObserver.disconnect();
    }

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
        // multi-selection (context menu / drag entry points); ids in chip order
        getSelectedIds: selectionIds,
        setSelection,
        clearSelection,
        removeIds: ids => {
            const next = removeCapsules(capsules, ids);
            if (next === capsules) return;
            selectedIds.clear();
            commitCapsules(next);
            focusChip(Math.max(0, Math.min(focusIndex, next.length - 1)), { fallbackToAdd: true });
        },
        setDisabledFor: (ids, disabled) => {
            const next = setCapsulesDisabled(capsules, ids, disabled);
            if (next !== capsules) commitCapsules(next);
        },
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
            if (index >= 0) openRelated(index);
        },
        // the context menu's "Edit weight…": a weight tab even when Related was used last
        editWeight: id => {
            const index = capsules.findIndex(capsule => capsule.id === id);
            if (index < 0) return;
            clearSelection();
            focusIndex = index;
            anchorIndex = index;
            updateRoving();
            openPopover(index, { tab: 'weight' });
        },
        dispose,
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
        getChain = () => chainFromSettings(settings()),
    } = options;

    const fields = new Map();
    let disclosure = null;
    let batchUpdateDepth = 0;
    let finalRefreshPending = false;

    const fieldList = () => [...fields.values()];
    const previewSeed = () => Math.max(0, getGenerationSeed());

    // A muted field (the row's ● switch, promptFieldManager) keeps its chips but
    // sends nothing: the preview and the batch dialogs see it empty. A row the model type
    // hides - a cast or Action row on a checkpoint - is not in the prompt at all, so its
    // weight plans and its batch stay out too: they turned one click into a batch of
    // identical images.
    const mutedKeys = new Set();
    function expansionFields() {
        const cast = castEnabled(settings());
        return fieldList()
            .filter(field => cast || !isDiffusionFieldId(field.key))
            .map(field => ({ key: field.key, capsules: mutedKeys.has(field.key) ? [] : field.getCapsules(), batch: field.getBatch() }));
    }

    function expandRows(count, seed) {
        // slider ≥ 0: the seed is pinned for the whole batch, weights are the only variable
        return expandAll(expansionFields(), seed, count, { applyExclude, fixedSeed: getGenerationSeed() >= 0, chain: getChain() });
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
    // Fields that hold a sentence (the Action) stay text when the card flips to
    // capsules; their own toggle still works locally.
    const sentenceKeys = new Set();
    let propagatingMode = false;
    function propagateMode(mode) {
        if (propagatingMode || mode === sharedMode) return;
        sharedMode = mode;
        try { localStorage.setItem(MODE_STORAGE_KEY, mode); } catch { /* storage blocked */ }
        propagatingMode = true;
        try {
            for (const [key, field] of fields) {
                if (sentenceKeys.has(key) && mode === 'capsule') continue;
                if (field.getMode() !== mode) field.setMode(mode);
            }
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

    // The Exclude text re-marks the chips of every other field (excludedSet). Typing
    // there fires onChange per keystroke, so the fan-out is debounced (trailing);
    // the Final prompt refresh is not, it stays immediate.
    const EXCLUDE_FANOUT_DELAY = 150;
    let excludeFanOutTimer = 0;
    function scheduleExcludeFanOut(changed) {
        clearTimeout(excludeFanOutTimer);
        excludeFanOutTimer = setTimeout(() => {
            excludeFanOutTimer = 0;
            for (const other of fields.values()) if (other !== changed) other.refresh();
        }, EXCLUDE_FANOUT_DELAY);
    }

    function addField(control, key) {
        const stored = settings();
        const extras = readStoredExtras(stored, key);
        const field = setupTagCapsuleField(control, {
            key,
            text,
            getGenerationSeed,
            initialMode: sentenceKeys.has(key) ? 'string' : sharedMode,
            onModeChange: propagateMode,
            fetchRelated,
            onExternalDrop: (payload, at, { copy }) => set.transfer(payload.field, Array.isArray(payload.ids) && payload.ids.length > 1 ? payload.ids : payload.id, key, { at, copy }),
            // the Exclude row's ● switch off: nothing is excluded, so no chip is marked for it
            getExcludeText: () => (mutedKeys.has('exclude') ? ''
                : (fields.get('exclude')?.textbox?.value ?? globalThis.prompt?.exclude?.getValue?.() ?? '')),
            initialPlans: extras.weight_plans,
            initialBatch: extras.batch,
            readStoredPlans: () => readStoredExtras(settings(), key).weight_plans,
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
                if (changed.key === 'exclude') scheduleExcludeFanOut(changed);
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
            const field = fields.get(key);
            if (!field) return;
            field.dispose?.();
            fields.delete(key);
            requestFinalPromptRefresh();
        },
        getMode: () => sharedMode,
        setMode: mode => propagateMode(mode === 'capsule' ? 'capsule' : 'string'),
        // muted rows leave the Final prompt preview and the batch expansion
        setMuted: (key, muted = true) => {
            const was = mutedKeys.has(key);
            if (muted) mutedKeys.add(key); else mutedKeys.delete(key);
            if (was === mutedKeys.has(key)) return;
            // the Exclude row's switch changes what every other row counts as excluded
            if (key === 'exclude') for (const other of fields.values()) if (other.key !== 'exclude') other.refresh();
            requestFinalPromptRefresh();
        },
        // marks a field as a sentence (kept as text when the card shows capsules)
        setSentence: (key, sentence = true) => {
            if (sentence) sentenceKeys.add(key); else sentenceKeys.delete(key);
            const field = fields.get(key);
            if (field && sentence && field.getMode() === 'capsule') {
                propagatingMode = true;
                try { field.setMode('string'); } finally { propagatingMode = false; }
            }
        },
        // Moves (copy: duplicates) one capsule into another field, weight plan and
        // disabled state included. Returns the inserted capsule or null.
        // `capsuleId` may be an array: the whole selection moves as one block.
        transfer: (sourceKey, capsuleId, targetKey, { at, copy = false } = {}) => {
            const source = fields.get(sourceKey);
            const target = fields.get(targetKey);
            if (!source || !target || sourceKey === targetKey) return null;
            const many = Array.isArray(capsuleId);
            const result = many
                ? transferCapsules(source.getCapsules(), target.getCapsules(), capsuleId, { at, copy })
                : transferCapsule(source.getCapsules(), target.getCapsules(), capsuleId, { at, copy });
            const moved = many ? result.moved : (result.moved ? [result.moved] : []);
            if (moved.length === 0) return null;
            batchUpdateDepth += 1;
            try {
                if (!copy) source.replaceCapsules(result.source);
                target.replaceCapsules(result.target);
            } finally {
                batchUpdateDepth = Math.max(0, batchUpdateDepth - 1);
            }
            requestFinalPromptRefresh();
            if (many) target.setSelection(moved.map(capsule => capsule.id));
            target.focusCapsule(moved[0].id);
            return many ? moved : moved[0];
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
