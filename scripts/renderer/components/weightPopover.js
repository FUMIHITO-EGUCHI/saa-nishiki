// L2: per-tag weight popover (Fixed | Plan). Anchored to a chip, fixed-position,
// 336px wide, focus-trapped. Nothing is written until Apply.
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

const POPOVER_WIDTH = 336;
const VIEWPORT_MARGIN = 8;
const FOCUSABLE = 'button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])';
const MODES = ['increment', 'decrement', 'random'];

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

    // ---- header
    const head = el('div', 'tag-weight-popover-head');
    const title = el('span', 'tag-weight-popover-title');
    title.id = 'tag-weight-popover-title';
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
    tabs.append(fixedTab, planTab);
    root.appendChild(tabs);

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
    // "÷ batch count": step derived from the run's batch count so min → max lands exactly
    const autoStepLabel = el('label', 'tag-weight-toggle tag-weight-autostep');
    const autoStepInput = el('input', 'tag-weight-switch');
    autoStepInput.type = 'checkbox';
    const autoStepText = el('span', 'tag-weight-toggle-text');
    autoStepLabel.append(autoStepInput, autoStepText);
    planStepField.append(autoStepLabel);
    rangeRow.append(minField, maxField, planStepField);
    planPanel.appendChild(rangeRow);

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

    function applyText() {
        closeButton.setAttribute('aria-label', text('tag_ui_close'));
        fixedTab.textContent = text('tag_ui_tab_fixed');
        planTab.textContent = text('tag_ui_tab_plan');
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
        autoStepInput.checked = planDraft.autoStep === true;
        planStepInput.disabled = planDraft.autoStep === true;
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
        activeTab = tab === 'plan' ? 'plan' : 'fixed';
        const fixedOn = activeTab === 'fixed';
        fixedTab.setAttribute('aria-selected', fixedOn ? 'true' : 'false');
        planTab.setAttribute('aria-selected', fixedOn ? 'false' : 'true');
        fixedTab.tabIndex = fixedOn ? 0 : -1;
        planTab.tabIndex = fixedOn ? -1 : 0;
        fixedPanel.hidden = !fixedOn;
        planPanel.hidden = fixedOn;
        if (fixedOn) {
            renderFixed();
            hint.textContent = text('tag_ui_hint_fixed');
        } else {
            renderPlan();
        }
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
        const current = session;
        session = null;
        root.hidden = true;
        document.removeEventListener('pointerdown', onOutsidePointer, true);
        document.removeEventListener('scroll', onScroll, true);
        window.removeEventListener('resize', onScroll);
        document.removeEventListener('keydown', onKeyDown, true);
        if (apply) current.onApply?.(resultPlan());
        current.onClose?.({ apply });
        const target = current.anchor?.isConnected ? current.anchor : current.fallbackFocus;
        target?.focus?.();
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
        if (!root.contains(event.target)) return;
        if (event.key === 'Tab') {
            trapTab(event);
            return;
        }
        if (event.key === 'Enter' && event.target.tagName !== 'BUTTON') {
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
        planDraft = normalizeWeightPlan({ ...planDraft, ...patch });
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

    fixedTab.addEventListener('click', () => { setTab('fixed'); position(); weightInput.focus(); });
    planTab.addEventListener('click', () => { setTab('plan'); position(); modeButtons[MODES.indexOf(planDraft.mode)]?.focus(); });
    tabs.addEventListener('keydown', event => {
        if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
        event.preventDefault();
        const next = activeTab === 'fixed' ? 'plan' : 'fixed';
        setTab(next);
        position();
        (next === 'fixed' ? fixedTab : planTab).focus();
    });

    closeButton.addEventListener('click', () => close({ apply: false }));
    cancelButton.addEventListener('click', () => close({ apply: false }));
    applyButton.addEventListener('click', () => close({ apply: true }));

    applyText();

    return {
        open({ anchor, capsule, generationSeed = 0, fallbackFocus = null, onApply = null, onClose = null } = {}) {
            if (session) close({ apply: false });
            applyText();
            const plan = normalizeWeightPlan(capsule?.weightPlan);
            session = { anchor, capsule, generationSeed, fallbackFocus, onApply, onClose };
            title.textContent = text('tag_ui_weight_for', capsule?.value ?? '');
            title.title = capsule?.value ?? '';
            root.setAttribute('aria-label', text('tag_ui_weight_for', capsule?.value ?? ''));
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
            root.hidden = false;
            setTab(isVariablePlan(plan) ? 'plan' : 'fixed');
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
                } else {
                    modeButtons[MODES.indexOf(planDraft.mode)]?.focus();
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
