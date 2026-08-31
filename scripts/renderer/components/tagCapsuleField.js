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
    nudgeCapsuleWeight,
    parsePlans,
    parsePromptToCapsules,
    reconcilePlans,
    removeCapsule,
    resolveBatchPlan,
    serializeCapsules,
    serializePlans,
    setCapsulePlan,
} from './tagCapsuleLogic.js';
import { createIcon, renderChips } from './tagCapsuleChip.js';
import { getWeightPopover } from './weightPopover.js';
import { getBatchWeightDialog } from './batchWeightDialog.js';
import { setupFinalPromptDisclosure } from './finalPromptDisclosure.js';
import { tagText } from './tagUiText.js';

export const PROMPT_FIELD_KEYS = Object.freeze(['common', 'positive', 'positive_right', 'negative', 'exclude']);

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
    const addButton = el('button', 'tag-capsule-add');
    addButton.type = 'button';
    addButton.tabIndex = -1;
    addButton.appendChild(createIcon('plus', 12));
    const addButtonText = el('span', 'tag-capsule-add-text');
    addButton.appendChild(addButtonText);
    const addInput = el('input', 'tag-capsule-add-input');
    addInput.type = 'text';
    addInput.autocomplete = 'off';
    addInput.spellcheck = false;
    addInput.hidden = true;
    addInput.tabIndex = -1;
    const addSlot = el('span', 'tag-capsule-add-slot');
    addSlot.append(addButton, addInput);
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
    footer.append(stats, batchButton);
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
        addInput.setAttribute('aria-label', text('tag_ui_add_tag'));
        addInput.placeholder = text('tag_ui_add_placeholder');
        batchButtonText.textContent = text('tag_ui_batch_weights');
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
        addButton.tabIndex = focusIndex === capsules.length && addInput.hidden ? 0 : -1;
    }

    function render() {
        if (mode === 'capsule') {
            renderChips(chips, capsules, { text, excludedSet: excludedTagSet(getExcludeText()), trailing: addSlot });
            chips.setAttribute('aria-label', `${fieldLabel()} · ${text('tag_ui_chips_label', capsules.length)}`);
            updateRoving();
        }
        renderFooter();
        renderBadge();
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
            hideAddInput({ commit: true });
            writeCurrentText();
            mode = 'string';
            relativeContainer.hidden = false;
            view.hidden = true;
            updateToggle();
            renderBadge();
            if (focus) textbox.focus();
        }
        onChange?.(api);
    }

    // ---------------------------------------------------------------- add input
    function showAddInput(initial = '') {
        addButton.hidden = true;
        addInput.hidden = false;
        addInput.tabIndex = 0;
        addInput.value = initial;
        addInput.focus();
        addInput.setSelectionRange(addInput.value.length, addInput.value.length);
    }

    function hideAddInput({ commit }) {
        if (addInput.hidden) return;
        const value = addInput.value.trim();
        addInput.hidden = true;
        addInput.tabIndex = -1;
        addButton.hidden = false;
        addInput.value = '';
        if (commit && value) {
            commitCapsules(insertCapsules(capsules, value.split(/[,\n]/), capsules.length));
        }
        updateRoving();
    }

    addButton.addEventListener('click', () => { focusIndex = capsules.length; showAddInput(); });
    addButton.addEventListener('focus', () => { focusIndex = capsules.length; updateRoving(); });
    addInput.addEventListener('keydown', event => {
        if (event.isComposing || event.keyCode === 229) return;
        if (event.key === 'Enter' || event.key === ',') {
            event.preventDefault();
            const value = addInput.value.trim();
            if (!value) {
                hideAddInput({ commit: false });
                capsuleButton.focus();
                return;
            }
            hideAddInput({ commit: true });
            focusIndex = capsules.length;
            showAddInput();
        } else if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            hideAddInput({ commit: false });
            focusChip(Math.max(0, capsules.length - 1));
        } else if (event.key === 'Backspace' && addInput.value === '' && capsules.length > 0) {
            event.preventDefault();
            hideAddInput({ commit: false });
            focusChip(capsules.length - 1);
        }
    });
    addInput.addEventListener('blur', () => hideAddInput({ commit: true }));

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
        focusIndex = index;
        updateRoving();
        openPopover(index);
    });

    chips.addEventListener('focusin', event => {
        const index = chipIndexOf(event.target);
        if (index >= 0) { focusIndex = index; updateRoving(); }
    });

    chips.addEventListener('keydown', event => {
        if (event.target === addInput) return;
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
                focusIndex = capsules.length;
                showAddInput();
                break;
            case 'type':
                focusIndex = capsules.length;
                showAddInput(event.key);
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

    // Drag = Ctrl+←→ equivalent (§9.6)
    chips.addEventListener('dragstart', event => {
        dragIndex = chipIndexOf(event.target);
        if (dragIndex < 0) { event.preventDefault(); return; }
        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData('text/plain', capsules[dragIndex]?.value ?? '');
        event.target.classList.add('is-dragging');
    });
    chips.addEventListener('dragend', event => {
        event.target.classList?.remove('is-dragging');
        dragIndex = -1;
    });
    chips.addEventListener('dragover', event => {
        if (dragIndex < 0) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = 'move';
    });
    chips.addEventListener('drop', event => {
        if (dragIndex < 0) return;
        event.preventDefault();
        let target = chipIndexOf(event.target);
        if (target < 0) target = capsules.length - 1;
        if (target !== dragIndex) {
            commitCapsules(moveCapsule(capsules, dragIndex, target));
            focusChip(target);
        }
        dragIndex = -1;
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
        }),
    };
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
    } = options;

    const fields = new Map();
    let disclosure = null;

    const fieldList = () => [...fields.values()];
    const previewSeed = () => Math.max(0, getGenerationSeed());

    function expansionFields() {
        return fieldList().map(field => ({ key: field.key, capsules: field.getCapsules(), batch: field.getBatch() }));
    }

    function expandRows(count, seed) {
        return expandAll(expansionFields(), seed, count, { applyExclude });
    }

    function getBatchExpansion() {
        return resolveBatchPlan(expansionFields());
    }

    function refreshFinalPrompt() {
        disclosure?.refresh();
    }

    textboxControls.forEach((control, index) => {
        const key = keys[index] ?? `field_${index}`;
        const stored = settings();
        const field = setupTagCapsuleField(control, {
            key,
            text,
            getGenerationSeed,
            getExcludeText: () => fields.get('exclude')?.textbox?.value ?? globalThis.prompt?.exclude?.getValue?.() ?? '',
            initialPlans: stored[`${key}_weight_plans`] ?? [],
            initialBatch: stored[`${key}_batch`] ?? DEFAULT_BATCH,
            onPlansChange: plans => { settings()[`${key}_weight_plans`] = plans; },
            onBatchChange: batch => { settings()[`${key}_batch`] = { ...batch }; },
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
                refreshFinalPrompt();
            },
        });
        if (field) fields.set(key, field);
    });

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
        expandAll: (count, seed) => expandRows(count, seed),
        getBatchExpansion,
        getPromptOverrides: (imageIndex, seed) => {
            const row = expandRows(imageIndex + 1, seed)[imageIndex];
            return row ? { ...row.fields, weights: row.weights, terminal: row.terminal } : null;
        },
        loadFromSettings: (stored = settings()) => {
            for (const [key, field] of fields) {
                field.setPlans(stored?.[`${key}_weight_plans`] ?? []);
                field.setBatch(stored?.[`${key}_batch`] ?? DEFAULT_BATCH);
            }
            refreshFinalPrompt();
        },
        updateLanguage: () => {
            for (const field of fields.values()) field.updateLanguage();
            getWeightPopover().updateLanguage();
            getBatchWeightDialog().updateLanguage();
            disclosure?.updateLanguage();
        },
        refreshFinalPrompt,
        finalPrompt: () => disclosure,
    };
    return set;
}
