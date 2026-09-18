// L2: per-tag popover (Fixed | Plan | Related). Anchored to a chip, fixed-position,
// 336px wide, focus-trapped. The weight tabs write nothing until Apply; the Related
// tab lists the offline co-occurrence dictionary's neighbours of the tag (with their
// translations) and adds / replaces through the field's callbacks as they are clicked.
import {
    WEIGHT_PRESETS,
    adjustWeight,
    buildWeightCandidates,
    clampWeight,
    createFixedWeightPlan,
    formatTagWeight,
    isVariablePlan,
    normalizeWeightPlan,
    roundWeight,
    weightWarning,
} from './tagCapsuleLogic.js';
import { createIcon } from './tagCapsuleChip.js';
import { tagText } from './tagUiText.js';
import { TAG_ALIASES_EVENT, aliasFor, ensureAliases } from '../tagAliasClient.js';
import { lookupKey, promptTagForm } from '../../shared/tagRelated.js';

const POPOVER_WIDTH = 336;
const VIEWPORT_MARGIN = 8;
const FOCUSABLE = 'button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])';
const MODES = ['increment', 'decrement', 'random'];
const TABS = ['fixed', 'plan', 'related'];

// The tab the popover opens on next time: 'weight' (Fixed or Plan, whichever the
// capsule's plan calls for) or 'related'. Remembered for the session.
let lastTabKind = 'weight';

function displayTag(tag) {
    return String(tag ?? '').replaceAll('_', ' ');
}

function el(tag, className, text = '') {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text) node.textContent = text;
    return node;
}

function numberInput(className, step, ariaLabel) {
    const input = el('input', className);
    input.type = 'text';
    input.inputMode = 'decimal';
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.dataset.step = String(step);
    input.setAttribute('aria-label', ariaLabel);
    return input;
}

function readNumber(input, fallback) {
    const value = Number(String(input.value).trim());
    return Number.isFinite(value) ? value : fallback;
}

let singleton = null;

export function createWeightPopover({ text = tagText } = {}) {
    const root = el('div', 'tag-weight-popover');
    root.hidden = true;
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-modal', 'false');
    root.tabIndex = -1;

    // ---- header: the tag on the first line, its translation on the second
    const head = el('div', 'tag-weight-popover-head');
    const title = el('span', 'tag-weight-popover-title');
    title.id = 'tag-weight-popover-title';
    const titleName = el('span', 'tag-weight-popover-title-name');
    const titleAlias = el('span', 'tag-weight-popover-title-alias');
    titleAlias.hidden = true;
    title.append(titleName, titleAlias);
    root.setAttribute('aria-labelledby', title.id);
    const closeButton = el('button', 'tag-weight-popover-close');
    closeButton.type = 'button';
    closeButton.appendChild(createIcon('close', 14));
    head.append(title, closeButton);
    root.appendChild(head);

    // ---- tabs
    const tabs = el('div', 'tag-weight-popover-tabs');
    tabs.setAttribute('role', 'tablist');
    const fixedTab = el('button', 'tag-weight-popover-tab');
    fixedTab.type = 'button';
    fixedTab.setAttribute('role', 'tab');
    fixedTab.dataset.tab = 'fixed';
    const planTab = el('button', 'tag-weight-popover-tab');
    planTab.type = 'button';
    planTab.setAttribute('role', 'tab');
    planTab.dataset.tab = 'plan';
    const relatedTab = el('button', 'tag-weight-popover-tab');
    relatedTab.type = 'button';
    relatedTab.setAttribute('role', 'tab');
    relatedTab.dataset.tab = 'related';
    tabs.append(fixedTab, planTab, relatedTab);
    root.appendChild(tabs);
    const tabButtons = { fixed: fixedTab, plan: planTab, related: relatedTab };

    // ---- fixed panel
    const fixedPanel = el('div', 'tag-weight-popover-body');
    fixedPanel.setAttribute('role', 'tabpanel');
    const fixedRow = el('div', 'tag-weight-row tag-weight-row-space');
    const weightField = el('div', 'tag-weight-field');
    const weightLabel = el('span', 'tag-weight-label');
    const stepper = el('div', 'tag-weight-stepper');
    const decreaseButton = el('button', 'tag-weight-stepbtn');
    decreaseButton.type = 'button';
    decreaseButton.appendChild(createIcon('minus', 14));
    const weightInput = numberInput('tag-weight-number tag-weight-number-main', 0.05, 'Weight');
    const increaseButton = el('button', 'tag-weight-stepbtn');
    increaseButton.type = 'button';
    increaseButton.appendChild(createIcon('plus', 14));
    stepper.append(decreaseButton, weightInput, increaseButton);
    weightField.append(weightLabel, stepper);
    const stepField = el('div', 'tag-weight-field');
    const stepLabel = el('span', 'tag-weight-label');
    const stepInput = numberInput('tag-weight-number tag-weight-number-step', 0.01, 'Step');
    stepField.append(stepLabel, stepInput);
    fixedRow.append(weightField, stepField);
    fixedPanel.appendChild(fixedRow);

    const presetField = el('div', 'tag-weight-field');
    const presetLabel = el('span', 'tag-weight-label');
    const presetRow = el('div', 'tag-weight-presets');
    const presetButtons = WEIGHT_PRESETS.map(value => {
        const button = el('button', 'tag-weight-preset', formatTagWeight(value));
        button.type = 'button';
        button.dataset.value = String(value);
        presetRow.appendChild(button);
        return button;
    });
    presetField.append(presetLabel, presetRow);
    fixedPanel.appendChild(presetField);

    const outputField = el('div', 'tag-weight-field');
    const outputLabel = el('span', 'tag-weight-label');
    const output = el('output', 'tag-weight-output');
    outputField.append(outputLabel, output);
    fixedPanel.appendChild(outputField);
    const fixedNote = el('span', 'tag-weight-note');
    fixedPanel.appendChild(fixedNote);
    root.appendChild(fixedPanel);

    // ---- plan panel
    const planPanel = el('div', 'tag-weight-popover-body');
    planPanel.setAttribute('role', 'tabpanel');
    const modeGroup = el('div', 'tag-weight-modes');
    modeGroup.setAttribute('role', 'radiogroup');
    const modeButtons = MODES.map(mode => {
        const button = el('button', 'tag-weight-mode');
        button.type = 'button';
        button.setAttribute('role', 'radio');
        button.dataset.mode = mode;
        button.appendChild(createIcon(mode, 14));
        button.appendChild(el('span', 'tag-weight-mode-name'));
        modeGroup.appendChild(button);
        return button;
    });
    planPanel.appendChild(modeGroup);

    const rangeRow = el('div', 'tag-weight-row');
    const minField = el('div', 'tag-weight-field');
    const minLabel = el('span', 'tag-weight-label');
    const minInput = numberInput('tag-weight-number', 0.05, 'Min');
    minField.append(minLabel, minInput);
    const maxField = el('div', 'tag-weight-field');
    const maxLabel = el('span', 'tag-weight-label');
    const maxInput = numberInput('tag-weight-number', 0.05, 'Max');
    maxField.append(maxLabel, maxInput);
    const planStepField = el('div', 'tag-weight-field');
    const planStepLabel = el('span', 'tag-weight-label');
    const planStepInput = numberInput('tag-weight-number', 0.01, 'Step');
    planStepField.append(planStepLabel, planStepInput);
    rangeRow.append(minField, maxField, planStepField);
    planPanel.appendChild(rangeRow);
    // "÷ batch count": step derived from the run's batch count so min → max lands
    // exactly. Its own row under the three inputs (inside the step column it made that
    // column taller and pushed the Min / Max boxes out of line), and only for the
    // stepped modes: a random draw has no step to derive.
    const autoStepRow = el('div', 'tag-weight-row tag-weight-autostep-row');
    const autoStepLabel = el('label', 'tag-weight-toggle tag-weight-autostep');
    const autoStepInput = el('input', 'tag-weight-switch');
    autoStepInput.type = 'checkbox';
    const autoStepText = el('span', 'tag-weight-toggle-text');
    autoStepLabel.append(autoStepInput, autoStepText);
    autoStepRow.appendChild(autoStepLabel);
    planPanel.appendChild(autoStepRow);

    const seedField = el('div', 'tag-weight-field tag-weight-seed');
    const seedLabel = el('span', 'tag-weight-label');
    const seedRow = el('div', 'tag-weight-row');
    const followLabel = el('label', 'tag-weight-toggle');
    const followInput = el('input', 'tag-weight-switch');
    followInput.type = 'checkbox';
    const followText = el('span', 'tag-weight-toggle-text');
    followLabel.append(followInput, followText);
    const seedValue = el('div', 'tag-weight-seed-value');
    const seedLock = createIcon('lock', 12);
    const seedInput = numberInput('tag-weight-number tag-weight-number-seed', 1, 'Seed');
    seedInput.inputMode = 'numeric';
    seedValue.append(seedLock, seedInput);
    seedRow.append(followLabel, seedValue);
    seedField.append(seedLabel, seedRow);
    planPanel.appendChild(seedField);
    root.appendChild(planPanel);

    // ---- related panel: neighbours of the tag from the co-occurrence dictionary
    const relatedPanel = el('div', 'tag-weight-popover-body tag-weight-related');
    relatedPanel.setAttribute('role', 'tabpanel');
    relatedPanel.hidden = true;
    root.appendChild(relatedPanel);

    // ---- footer
    const foot = el('div', 'tag-weight-popover-foot');
    const hint = el('span', 'tag-weight-hint');
    const actions = el('div', 'tag-weight-actions');
    const cancelButton = el('button', 'tag-weight-button');
    cancelButton.type = 'button';
    const applyButton = el('button', 'tag-weight-button tag-weight-button-primary');
    applyButton.type = 'button';
    actions.append(cancelButton, applyButton);
    foot.append(hint, actions);
    root.appendChild(foot);

    document.body.appendChild(root);

    // ---- state
    let session = null;   // { anchor, capsule, generationSeed, onApply, onClose, restoreFocus }
    let activeTab = 'fixed';
    let fixedWeight = 1;
    let fixedStep = 0.05;
    let planDraft = normalizeWeightPlan({ mode: 'increment', min: 1, max: 1.3, step: 0.05, seed: 0 });
    let followSeed = true;
    let relatedToken = 0;      // an answer for an earlier tag is dropped
    let relatedResult = null;  // the last answer, re-rendered when aliases arrive

    function applyText() {
        closeButton.setAttribute('aria-label', text('tag_ui_close'));
        fixedTab.textContent = text('tag_ui_tab_fixed');
        planTab.textContent = text('tag_ui_tab_plan');
        relatedTab.textContent = text('tag_ui_tab_related');
        weightLabel.textContent = text('tag_ui_weight');
        stepLabel.textContent = text('tag_ui_step');
        presetLabel.textContent = text('tag_ui_presets');
        outputLabel.textContent = text('tag_ui_output');
        fixedNote.textContent = text('tag_ui_weight_note');
        decreaseButton.setAttribute('aria-label', text('tag_ui_decrease'));
        increaseButton.setAttribute('aria-label', text('tag_ui_increase'));
        weightInput.setAttribute('aria-label', text('tag_ui_weight'));
        stepInput.setAttribute('aria-label', text('tag_ui_step'));
        modeGroup.setAttribute('aria-label', text('tag_ui_mode'));
        for (const button of modeButtons) {
            button.querySelector('.tag-weight-mode-name').textContent = text(`tag_ui_mode_${button.dataset.mode}`);
        }
        minLabel.textContent = text('tag_ui_min');
        maxLabel.textContent = text('tag_ui_max');
        planStepLabel.textContent = text('tag_ui_step');
        minInput.setAttribute('aria-label', text('tag_ui_min'));
        maxInput.setAttribute('aria-label', text('tag_ui_max'));
        planStepInput.setAttribute('aria-label', text('tag_ui_step'));
        autoStepText.textContent = text('tag_ui_step_auto');
        autoStepInput.setAttribute('aria-label', text('tag_ui_step_auto'));
        seedLabel.textContent = text('tag_ui_seed');
        followText.textContent = text('tag_ui_follow_seed');
        seedInput.setAttribute('aria-label', text('tag_ui_seed'));
        cancelButton.textContent = text('tag_ui_cancel');
        applyButton.textContent = text('tag_ui_apply');
    }

    function currentFixedPlan() {
        return createFixedWeightPlan(clampWeight(fixedWeight));
    }

    function renderFixed() {
        weightInput.value = formatTagWeight(fixedWeight);
        stepInput.value = formatTagWeight(fixedStep);
        weightInput.dataset.step = String(fixedStep);
        const plan = currentFixedPlan();
        const warn = weightWarning(plan);
        weightInput.classList.toggle('is-warn', warn);
        for (const button of presetButtons) {
            const on = Math.abs(Number(button.dataset.value) - fixedWeight) < 1e-6;
            button.classList.toggle('is-on', on);
            button.setAttribute('aria-pressed', on ? 'true' : 'false');
        }
        output.replaceChildren();
        const value = session?.capsule?.value ?? '';
        if (Math.abs(fixedWeight - 1) < 1e-9) {
            output.appendChild(document.createTextNode(value));
        } else {
            const span = el('span', fixedWeight > 1 ? 'tag-weight-output-up' : 'tag-weight-output-down', `(${value}:${formatTagWeight(fixedWeight)})`);
            output.appendChild(span);
        }
    }

    function renderPlan() {
        for (const button of modeButtons) {
            const on = button.dataset.mode === planDraft.mode;
            button.setAttribute('aria-checked', on ? 'true' : 'false');
            button.classList.toggle('is-on', on);
            button.tabIndex = on ? 0 : -1;
        }
        minInput.value = formatTagWeight(planDraft.min);
        maxInput.value = formatTagWeight(planDraft.max);
        planStepInput.value = formatTagWeight(planDraft.step);
        // a random draw has no step to derive from the batch count
        autoStepRow.hidden = planDraft.mode === 'random';
        autoStepInput.checked = planDraft.autoStep === true && planDraft.mode !== 'random';
        planStepInput.disabled = autoStepInput.checked;
        const warn = weightWarning(planDraft);
        minInput.classList.toggle('is-warn', warn && planDraft.min < 0.5);
        maxInput.classList.toggle('is-warn', warn && planDraft.max > 1.5);
        seedField.hidden = planDraft.mode !== 'random';
        followInput.checked = followSeed;
        seedInput.disabled = followSeed;
        seedLock.style.display = followSeed ? '' : 'none';
        seedInput.value = followSeed ? String(session?.generationSeed ?? 0) : String(planDraft.seed);
        hint.textContent = planDraft.mode === 'random' ? text('tag_ui_reproducible') : text('tag_ui_hint_plan');
    }

    function setTab(tab) {
        activeTab = TABS.includes(tab) ? tab : 'fixed';
        lastTabKind = activeTab === 'related' ? 'related' : 'weight';
        for (const [name, button] of Object.entries(tabButtons)) {
            const on = name === activeTab;
            button.setAttribute('aria-selected', on ? 'true' : 'false');
            button.tabIndex = on ? 0 : -1;
        }
        fixedPanel.hidden = activeTab !== 'fixed';
        planPanel.hidden = activeTab !== 'plan';
        relatedPanel.hidden = activeTab !== 'related';
        // the weight tabs apply on Apply; Related writes as it goes, so it only closes
        applyButton.hidden = activeTab === 'related';
        cancelButton.textContent = activeTab === 'related' ? text('tag_ui_close') : text('tag_ui_cancel');
        if (activeTab === 'fixed') {
            renderFixed();
            hint.textContent = text('tag_ui_hint_fixed');
        } else if (activeTab === 'plan') {
            renderPlan();
        } else {
            hint.textContent = text('tag_ui_related_hint');
            loadRelated();
        }
    }

    // ---- related tab
    function relatedChip(item, present) {
        const tag = displayTag(item.tag);
        const button = el('button', 'tag-weight-related-chip');
        button.type = 'button';
        button.dataset.tag = tag;
        button.dataset.value = promptTagForm(item.tag);   // what a click writes into the field
        // the dictionary key: "long_hair" / "long hair" / "1990s \(style\)" match their chips
        const known = present.has(lookupKey(item.tag));
        button.classList.toggle('is-present', known);
        button.disabled = known;
        button.appendChild(el('span', 'tag-weight-related-mark', known ? '✓' : '+'));
        button.appendChild(el('span', 'tag-weight-related-name', tag));
        const alias = el('span', 'tag-weight-related-alias');
        alias.dataset.tag = tag;
        const translation = aliasFor(tag);
        alias.textContent = translation;
        alias.hidden = !translation;
        button.appendChild(alias);
        if (Number.isFinite(item.score)) button.title = `${tag} · ${item.score}`;
        return button;
    }

    function renderRelated() {
        relatedPanel.replaceChildren();
        const result = relatedResult;
        if (!result) {
            relatedPanel.appendChild(el('span', 'tag-weight-related-empty', text('tag_ui_related_loading')));
            return;
        }
        const present = new Set([...(typeof session?.presentTags === 'function' ? session.presentTags() : [])].map(lookupKey));
        const groups = [
            { label: text('tag_ui_related_cooccur'), items: result.related ?? [] },
            { label: text('tag_ui_related_family', displayTag(result.familyWord ?? '')), items: result.family ?? [] },
        ];
        let shown = 0;
        for (const group of groups) {
            if (group.items.length === 0) continue;
            const block = el('div', 'tag-weight-related-group');
            block.appendChild(el('span', 'tag-weight-related-label', group.label));
            const row = el('div', 'tag-weight-related-row');
            for (const item of group.items) {
                row.appendChild(relatedChip(item, present));
                shown += 1;
            }
            block.appendChild(row);
            relatedPanel.appendChild(block);
        }
        if (shown === 0) relatedPanel.appendChild(el('span', 'tag-weight-related-empty', text('tag_ui_related_none')));
        ensureAliases([...relatedPanel.querySelectorAll('.tag-weight-related-alias')].map(node => node.dataset.tag));
    }

    async function loadRelated() {
        const value = session?.capsule?.value ?? '';
        const loader = session?.fetchRelated;
        const token = ++relatedToken;
        relatedResult = null;
        renderRelated();
        if (typeof loader !== 'function' || !value) {
            relatedResult = { related: [], family: [] };
            renderRelated();
            return;
        }
        let result = null;
        try { result = await loader(value); } catch (error) { console.warn('[weightPopover] related tags failed:', error); }
        if (token !== relatedToken || !session) return;
        relatedResult = result ?? { related: [], family: [] };
        renderRelated();
        position();
    }

    // a late alias answer fills the blanks in place (header line and chips)
    function onAliasesUpdated() {
        if (!session) return;
        applyTitleAlias();
        for (const node of relatedPanel.querySelectorAll('.tag-weight-related-alias')) {
            const translation = aliasFor(node.dataset.tag);
            node.textContent = translation;
            node.hidden = !translation;
        }
    }
    document.addEventListener(TAG_ALIASES_EVENT, onAliasesUpdated);

    function applyTitleAlias() {
        const translation = aliasFor(session?.capsule?.value ?? '');
        titleAlias.textContent = translation;
        titleAlias.hidden = !translation;
    }

    relatedPanel.addEventListener('click', event => {
        const button = event.target.closest('.tag-weight-related-chip');
        if (!button || button.disabled || !session) return;
        const tag = button.dataset.value;
        const replace = event.shiftKey;
        session.onPick?.(tag, { replace });
        if (replace) {
            // the anchor chip is a different capsule now: nothing to keep the popover on
            close({ apply: false });
            return;
        }
        const wasFocused = document.activeElement === button;
        button.disabled = true;
        button.classList.add('is-present');
        button.querySelector('.tag-weight-related-mark').textContent = '✓';
        // a button that is disabled while it has the focus hands it to <body>: the popover
        // would then see none of the keys (Ctrl+R would reach the window menu's Reload) and
        // close without giving the focus back to the chip
        if (wasFocused) focusAfterPick(button);
    });

    // The next tag that can still be picked, or the tab strip when the list is used up.
    function focusAfterPick(button) {
        const chips = [...relatedPanel.querySelectorAll('.tag-weight-related-chip')];
        const at = chips.indexOf(button);
        const next = chips.slice(at + 1).find(chip => !chip.disabled)
            ?? chips.slice(0, Math.max(0, at)).reverse().find(chip => !chip.disabled);
        (next ?? relatedTab ?? root).focus();
    }

    function position() {
        const anchor = session?.anchor;
        if (!anchor?.isConnected) return;
        const rect = anchor.getBoundingClientRect();
        root.style.width = `${POPOVER_WIDTH}px`;
        const height = root.offsetHeight;
        let left = rect.left;
        if (left + POPOVER_WIDTH > window.innerWidth - VIEWPORT_MARGIN) left = rect.right - POPOVER_WIDTH;
        left = Math.max(VIEWPORT_MARGIN, left);
        let top = rect.bottom + 4;
        if (top + height > window.innerHeight - VIEWPORT_MARGIN) top = rect.top - height - 4;
        top = Math.max(VIEWPORT_MARGIN, top);
        root.style.left = `${Math.round(left)}px`;
        root.style.top = `${Math.round(top)}px`;
    }

    function resultPlan() {
        if (activeTab === 'fixed') return currentFixedPlan();
        return normalizeWeightPlan({ ...planDraft, seed: followSeed ? 0 : planDraft.seed });
    }

    function close({ apply }) {
        if (!session) return;
        // focus goes back to the chip only when the popover held it: a Shift+click
        // replace has already focused the new chip, which the anchor no longer is
        const hadFocus = root.contains(document.activeElement);
        const current = session;
        session = null;
        relatedToken += 1;   // a related-tags answer still in flight is dropped
        root.hidden = true;
        document.removeEventListener('pointerdown', onOutsidePointer, true);
        document.removeEventListener('scroll', onScroll, true);
        window.removeEventListener('resize', onScroll);
        document.removeEventListener('keydown', onKeyDown, true);
        if (apply) current.onApply?.(resultPlan());
        current.onClose?.({ apply });
        const target = current.anchor?.isConnected ? current.anchor : current.fallbackFocus;
        if (hadFocus) target?.focus?.();
    }

    function onOutsidePointer(event) {
        if (root.contains(event.target)) return;
        close({ apply: false });
    }

    function onScroll(event) {
        if (event?.target && root.contains(event.target)) return;
        close({ apply: false });
    }

    function trapTab(event) {
        const focusable = [...root.querySelectorAll(FOCUSABLE)].filter(node => node.getClientRects().length > 0);
        if (focusable.length === 0) {
            event.preventDefault();
            root.focus();
            return;
        }
        const first = focusable[0];
        const last = focusable.at(-1);
        if (event.shiftKey && (document.activeElement === first || !root.contains(document.activeElement))) {
            event.preventDefault();
            last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first.focus();
        }
    }

    function onKeyDown(event) {
        if (!session) return;
        if (event.key === 'Escape') {
            if (event.isComposing || event.keyCode === 229) return;
            event.preventDefault();
            event.stopPropagation();
            close({ apply: false });
            return;
        }
        // Ctrl+R opened this popover from a chip; pressed again while it is open it must
        // not reach the window menu's Reload - wherever the focus sits (a picked Related
        // tag disables its button, which can drop the focus out of the popover)
        if ((event.ctrlKey || event.metaKey) && !event.altKey && String(event.key).toLowerCase() === 'r') {
            event.preventDefault();
            return;
        }
        if (!root.contains(event.target)) return;
        if (event.key === 'Tab') {
            trapTab(event);
            return;
        }
        if (event.key === 'Enter' && event.target.tagName !== 'BUTTON' && activeTab !== 'related') {
            event.preventDefault();
            close({ apply: true });
        }
    }

    // ---- number field behaviour: ↑↓ ±step, Shift ×2, wheel ±step
    function bindNumber(input, onChange) {
        const nudge = direction => {
            const step = Number(input.dataset.step) || 0.05;
            onChange(readNumber(input, 0) + (direction * step), 'nudge');
        };
        input.addEventListener('keydown', event => {
            if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
                event.preventDefault();
                const direction = (event.key === 'ArrowUp' ? 1 : -1) * (event.shiftKey ? 2 : 1);
                nudge(direction);
            }
        });
        input.addEventListener('wheel', event => {
            if (document.activeElement !== input) return;
            event.preventDefault();
            nudge(event.deltaY < 0 ? 1 : -1);
        }, { passive: false });
        input.addEventListener('change', () => onChange(readNumber(input, Number.NaN), 'commit'));
        input.addEventListener('input', () => {
            const value = readNumber(input, Number.NaN);
            if (Number.isFinite(value)) onChange(value, 'typing');
        });
    }

    bindNumber(weightInput, (value, source) => {
        if (!Number.isFinite(value)) return renderFixed();
        fixedWeight = source === 'typing' ? roundWeight(value) : clampWeight(value);
        if (source === 'typing') {
            weightInput.classList.toggle('is-warn', weightWarning(createFixedWeightPlan(fixedWeight)));
            renderOutputOnly();
        } else {
            renderFixed();
        }
    });
    bindNumber(stepInput, (value, source) => {
        if (!Number.isFinite(value) || value <= 0) return source === 'typing' ? undefined : renderFixed();
        fixedStep = roundWeight(Math.min(1, value));
        weightInput.dataset.step = String(fixedStep);
        if (source !== 'typing') renderFixed();
    });
    function renderOutputOnly() {
        const snapshot = weightInput.value;
        renderFixed();
        weightInput.value = snapshot;
    }
    decreaseButton.addEventListener('click', () => { fixedWeight = adjustWeight(fixedWeight, -fixedStep); renderFixed(); });
    increaseButton.addEventListener('click', () => { fixedWeight = adjustWeight(fixedWeight, fixedStep); renderFixed(); });
    for (const button of presetButtons) {
        button.addEventListener('click', () => { fixedWeight = Number(button.dataset.value); renderFixed(); weightInput.focus(); });
    }

    const updatePlan = patch => {
        // the draft keeps the "÷ batch count" choice through a detour to Random (whose
        // normalized plan drops it); resultPlan normalizes it away if Random is applied
        const autoStep = patch.autoStep ?? planDraft.autoStep;
        planDraft = { ...normalizeWeightPlan({ ...planDraft, ...patch }), autoStep };
        renderPlan();
    };
    bindNumber(minInput, (value, source) => {
        if (!Number.isFinite(value)) return;
        if (source === 'typing') { planDraft = { ...planDraft, min: roundWeight(value) }; return; }
        updatePlan({ min: clampWeight(value), max: Math.max(clampWeight(value), planDraft.max) });
    });
    bindNumber(maxInput, (value, source) => {
        if (!Number.isFinite(value)) return;
        if (source === 'typing') { planDraft = { ...planDraft, max: roundWeight(value) }; return; }
        updatePlan({ max: clampWeight(value), min: Math.min(clampWeight(value), planDraft.min) });
    });
    bindNumber(planStepInput, (value, source) => {
        if (!Number.isFinite(value) || value <= 0) return;
        if (source === 'typing') { planDraft = { ...planDraft, step: roundWeight(value) }; return; }
        updatePlan({ step: roundWeight(Math.min(1, value)) });
    });
    bindNumber(seedInput, (value, source) => {
        if (!Number.isFinite(value)) return;
        planDraft = { ...planDraft, seed: Math.max(0, Math.floor(value)) };
        if (source !== 'typing') renderPlan();
    });
    followInput.addEventListener('change', () => {
        followSeed = followInput.checked;
        renderPlan();
        if (!followSeed) seedInput.focus();
    });
    autoStepInput.addEventListener('change', () => {
        updatePlan({ autoStep: autoStepInput.checked });
    });

    for (const button of modeButtons) {
        button.addEventListener('click', () => { updatePlan({ mode: button.dataset.mode }); button.focus(); });
    }
    modeGroup.addEventListener('keydown', event => {
        const index = MODES.indexOf(planDraft.mode);
        let next = -1;
        if (event.key === 'ArrowRight' || event.key === 'ArrowDown') next = (index + 1) % MODES.length;
        if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') next = (index - 1 + MODES.length) % MODES.length;
        if (next < 0) return;
        event.preventDefault();
        updatePlan({ mode: MODES[next] });
        modeButtons[next].focus();
    });

    function focusTabContent() {
        if (activeTab === 'fixed') weightInput.focus();
        else if (activeTab === 'plan') modeButtons[MODES.indexOf(planDraft.mode)]?.focus();
        else relatedPanel.querySelector('.tag-weight-related-chip:not(:disabled)')?.focus();
    }
    fixedTab.addEventListener('click', () => { setTab('fixed'); position(); focusTabContent(); });
    planTab.addEventListener('click', () => { setTab('plan'); position(); focusTabContent(); });
    relatedTab.addEventListener('click', () => { setTab('related'); position(); focusTabContent(); });
    tabs.addEventListener('keydown', event => {
        if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
        event.preventDefault();
        const index = TABS.indexOf(activeTab);
        const next = TABS[(index + (event.key === 'ArrowRight' ? 1 : TABS.length - 1)) % TABS.length];
        setTab(next);
        position();
        tabButtons[next].focus();
    });

    closeButton.addEventListener('click', () => close({ apply: false }));
    cancelButton.addEventListener('click', () => close({ apply: false }));
    applyButton.addEventListener('click', () => close({ apply: true }));

    applyText();

    return {
        // `tab`: 'fixed' | 'plan' | 'related' to force one, 'weight' for Fixed / Plan by the
        // capsule's plan; otherwise the kind used last
        // time (Related stays Related; a weight tab is Fixed or Plan by the capsule's plan).
        // `fetchRelated(value)`, `presentTags()` and `onPick(tag, { replace })` feed the
        // Related tab; without a loader that tab is hidden.
        open({ anchor, capsule, generationSeed = 0, fallbackFocus = null, onApply = null, onClose = null,
            tab = null, fetchRelated = null, presentTags = null, onPick = null } = {}) {
            if (session) close({ apply: false });
            applyText();
            const plan = normalizeWeightPlan(capsule?.weightPlan);
            session = { anchor, capsule, generationSeed, fallbackFocus, onApply, onClose, fetchRelated, presentTags, onPick };
            const value = capsule?.value ?? '';
            titleName.textContent = value;
            title.title = value;
            applyTitleAlias();
            ensureAliases([value]);
            root.setAttribute('aria-label', value);
            if (isVariablePlan(plan)) {
                planDraft = plan;
                followSeed = plan.seed === 0;
                fixedWeight = buildWeightCandidates(plan)[0];
            } else {
                fixedWeight = plan.min;
                planDraft = normalizeWeightPlan({ mode: 'increment', min: Math.min(plan.min, 1), max: Math.max(plan.min, 1.3), step: 0.05, seed: 0 });
                followSeed = true;
            }
            fixedStep = 0.05;
            const hasRelated = typeof fetchRelated === 'function';
            relatedTab.hidden = !hasRelated;
            const weightTab = isVariablePlan(plan) ? 'plan' : 'fixed';
            // 'weight' asks for Fixed / Plan by the capsule's plan, whatever tab was used last
            let initial = TABS.includes(tab) ? tab : (tab !== 'weight' && lastTabKind === 'related' ? 'related' : weightTab);
            if (initial === 'related' && !hasRelated) initial = weightTab;
            root.hidden = false;
            setTab(initial);
            position();
            document.addEventListener('pointerdown', onOutsidePointer, true);
            document.addEventListener('scroll', onScroll, true);
            window.addEventListener('resize', onScroll);
            document.addEventListener('keydown', onKeyDown, true);
            requestAnimationFrame(() => {
                position();
                if (activeTab === 'fixed') {
                    weightInput.focus();
                    weightInput.select();
                } else if (activeTab === 'plan') {
                    modeButtons[MODES.indexOf(planDraft.mode)]?.focus();
                } else {
                    (relatedPanel.querySelector('.tag-weight-related-chip:not(:disabled)') ?? relatedTab).focus();
                }
            });
        },
        close: () => close({ apply: false }),
        isOpen: () => session !== null,
        element: root,
        updateLanguage: applyText,
    };
}

export function getWeightPopover() {
    if (!singleton) singleton = createWeightPopover();
    return singleton;
}
