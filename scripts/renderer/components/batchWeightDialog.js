// L3: per-field batch dialog. Left column = settings, right column = per-image preview.
// Nothing is written to the field until Apply.
import {
    BATCH_COUNT_MAX,
    BATCH_COUNT_MIN,
    formatTagWeight,
    isVariablePlan,
    normalizeBatch,
    normalizeWeightPlan,
} from './tagCapsuleLogic.js';
import { createIcon } from './tagCapsuleChip.js';
import { createDialogShell } from './dialogShell.js';
import { tagText } from './tagUiText.js';

function el(tag, className, text = '') {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text) node.textContent = text;
    return node;
}

let singleton = null;

export function createBatchWeightDialog({ text = tagText } = {}) {
    const shell = createDialogShell({ className: 'tag-batch-dialog' });
    const { body, footer } = shell;

    const grid = el('div', 'tag-batch-grid');
    body.appendChild(grid);

    // ---- settings column
    const settings = el('div', 'tag-batch-settings');
    const enableLabel = el('label', 'tag-weight-toggle tag-batch-enable');
    const enableInput = el('input', 'tag-weight-switch');
    enableInput.type = 'checkbox';
    const enableText = el('span', 'tag-weight-toggle-text');
    enableLabel.append(enableInput, enableText);
    settings.appendChild(enableLabel);

    const countField = el('div', 'tag-weight-field');
    const countLabel = el('span', 'tag-weight-label');
    const countStepper = el('div', 'tag-weight-stepper');
    const countDown = el('button', 'tag-weight-stepbtn');
    countDown.type = 'button';
    countDown.appendChild(createIcon('minus', 14));
    const countInput = el('input', 'tag-weight-number');
    countInput.type = 'text';
    countInput.inputMode = 'numeric';
    const countUp = el('button', 'tag-weight-stepbtn');
    countUp.type = 'button';
    countUp.appendChild(createIcon('plus', 14));
    countStepper.append(countDown, countInput, countUp);
    countField.append(countLabel, countStepper);
    settings.appendChild(countField);

    const seedField = el('div', 'tag-weight-field');
    const seedLabel = el('span', 'tag-weight-label');
    const seedRow = el('div', 'tag-weight-row');
    const seedInput = el('input', 'tag-weight-number tag-batch-seed');
    seedInput.type = 'text';
    seedInput.inputMode = 'numeric';
    const seedRandom = el('button', 'tag-weight-button');
    seedRandom.type = 'button';
    seedRow.append(seedInput, seedRandom);
    const seedNote = el('span', 'tag-weight-note');
    seedField.append(seedLabel, seedRow, seedNote);
    settings.appendChild(seedField);

    const variableField = el('div', 'tag-weight-field');
    const variableLabel = el('span', 'tag-weight-label');
    const variableList = el('div', 'tag-batch-variable-list');
    const variableNote = el('span', 'tag-weight-note');
    variableField.append(variableLabel, variableList, variableNote);
    settings.appendChild(variableField);

    const comfyNote = el('div', 'tag-batch-note');
    settings.appendChild(comfyNote);
    grid.appendChild(settings);

    // ---- preview column
    const preview = el('div', 'tag-batch-preview');
    const previewHead = el('div', 'tag-weight-row tag-weight-row-space');
    const previewLabel = el('span', 'tag-weight-label');
    const previewBadges = el('div', 'tag-weight-row');
    const endBadge = el('span', 'tag-batch-end');
    const randomBadge = el('span', 'tag-batch-badge');
    previewBadges.append(endBadge, randomBadge);
    previewHead.append(previewLabel, previewBadges);
    preview.appendChild(previewHead);

    const tableWrap = el('div', 'tag-batch-table-wrap');
    const table = el('table', 'tag-batch-table');
    const thead = el('thead');
    const tbody = el('tbody');
    table.append(thead, tbody);
    tableWrap.appendChild(table);
    preview.appendChild(tableWrap);

    const previewFoot = el('div', 'tag-weight-row tag-weight-row-space');
    const summary = el('span', 'tag-weight-note');
    const copyHint = el('span', 'tag-weight-note');
    copyHint.setAttribute('role', 'status');
    copyHint.setAttribute('aria-live', 'polite');
    previewFoot.append(summary, copyHint);
    preview.appendChild(previewFoot);
    grid.appendChild(preview);

    // ---- footer
    const status = el('span', 'tag-weight-note tag-batch-status');
    const actions = el('div', 'tag-weight-actions');
    const cancelButton = el('button', 'selection-modal-cancel');
    cancelButton.type = 'button';
    const applyButton = el('button', 'selection-modal-apply');
    applyButton.type = 'button';
    actions.append(cancelButton, applyButton);
    footer.append(status, actions);

    let session = null;   // { capsules, expand, onApply, initial, fieldLabel }
    let draft = { enabled: false, count: 4, seed: -1 };

    function applyText() {
        shell.closeButton.setAttribute('aria-label', text('tag_ui_close'));
        enableText.textContent = text('tag_ui_expand_per_image');
        countLabel.textContent = text('tag_ui_batch_count');
        countInput.setAttribute('aria-label', text('tag_ui_batch_count'));
        countDown.setAttribute('aria-label', text('tag_ui_decrease'));
        countUp.setAttribute('aria-label', text('tag_ui_increase'));
        seedLabel.textContent = text('tag_ui_generation_seed');
        seedInput.setAttribute('aria-label', text('tag_ui_generation_seed'));
        seedRandom.textContent = text('tag_ui_random');
        seedNote.textContent = text('tag_ui_seed_note');
        variableNote.textContent = text('tag_ui_edit_in_popover');
        previewLabel.textContent = text('tag_ui_preview');
        cancelButton.textContent = text('tag_ui_cancel');
        applyButton.textContent = text('tag_ui_apply');
    }

    function variableCapsules() {
        return (session?.capsules ?? []).filter(capsule => isVariablePlan(capsule.weightPlan));
    }

    function isDirty() {
        if (!session) return false;
        const { initial } = session;
        return draft.enabled !== initial.enabled || draft.count !== initial.count || draft.seed !== initial.seed;
    }

    function renderVariableList() {
        variableList.replaceChildren();
        const capsules = variableCapsules();
        variableLabel.textContent = text('tag_ui_variable_tags', capsules.length);
        for (const capsule of capsules) {
            const plan = normalizeWeightPlan(capsule.weightPlan);
            const row = el('div', 'tag-batch-variable');
            const name = el('span', 'tag-batch-variable-name');
            const icon = createIcon(plan.mode, 13);
            icon.classList.add(`tag-ui-mode-${plan.mode}`);
            const label = el('span', 'tag-batch-variable-label', capsule.value);
            label.title = capsule.value;
            name.append(icon, label);
            const range = el('span', 'tag-batch-variable-range', `${formatTagWeight(plan.min)}–${formatTagWeight(plan.max)} / ${formatTagWeight(plan.step)}`);
            row.append(name, range);
            variableList.appendChild(row);
        }
    }

    function renderTable() {
        const capsules = variableCapsules();
        const previewSeed = draft.seed < 0 ? 0 : draft.seed;
        const rows = session?.expand?.(draft.count, previewSeed) ?? [];

        thead.replaceChildren();
        const headRow = el('tr');
        headRow.appendChild(el('th', 'tag-batch-col-index', '#'));
        for (const capsule of capsules) {
            const th = el('th', 'tag-batch-col-weight');
            th.appendChild(createIcon(normalizeWeightPlan(capsule.weightPlan).mode, 13));
            th.appendChild(document.createTextNode(capsule.value));
            th.title = capsule.value;
            headRow.appendChild(th);
        }
        headRow.appendChild(el('th', 'tag-batch-col-prompt', text('tag_ui_final_prompt_col', session?.fieldLabel ?? '')));
        thead.appendChild(headRow);

        tbody.replaceChildren();
        let endValue = null;
        for (const row of rows) {
            const tr = el('tr', 'tag-batch-row');
            tr.tabIndex = 0;
            tr.dataset.prompt = row.prompt ?? '';
            tr.appendChild(el('td', 'tag-batch-col-index', String(row.imageIndex + 1)));
            for (const capsule of capsules) {
                const tokenId = `${session.tokenPrefix}/${capsule.id}`;
                const weight = row.weights?.[tokenId];
                const terminal = row.terminal?.includes(tokenId);
                const td = el('td', 'tag-batch-col-weight');
                const plan = normalizeWeightPlan(capsule.weightPlan);
                td.classList.add(plan.mode === 'random' ? 'is-plan' : 'is-up');
                if (weight !== undefined && Math.abs(weight - 1) < 1e-9) td.classList.add('is-neutral');
                td.textContent = weight === undefined ? '' : formatTagWeight(weight);
                if (terminal) {
                    td.classList.add('is-end');
                    const mark = el('span', 'tag-batch-end-mark', ' ■');
                    mark.title = text('tag_ui_end_reached_title');
                    td.appendChild(mark);
                    if (endValue === null && weight !== undefined) endValue = weight;
                }
                tr.appendChild(td);
            }
            const promptCell = el('td', 'tag-batch-col-prompt', row.prompt || text('tag_ui_fp_empty'));
            tr.appendChild(promptCell);
            tbody.appendChild(tr);
        }

        endBadge.hidden = endValue === null;
        endBadge.textContent = endValue === null ? '' : text('tag_ui_end_reached', formatTagWeight(endValue));
        const hasRandom = capsules.some(capsule => normalizeWeightPlan(capsule.weightPlan).mode === 'random');
        randomBadge.hidden = !hasRandom;
        randomBadge.replaceChildren();
        if (hasRandom) {
            randomBadge.appendChild(createIcon('random', 12));
            randomBadge.appendChild(document.createTextNode(draft.seed < 0
                ? `${text('tag_ui_mode_random')} · ${text('tag_ui_seed_random')}`
                : text('tag_ui_random_badge', draft.seed)));
        }
        summary.textContent = text('tag_ui_images_summary', rows.length, capsules.length);
        copyHint.textContent = text('tag_ui_copy_row');
        comfyNote.textContent = text('tag_ui_comfy_note', draft.enabled ? draft.count : 1);
    }

    function render() {
        enableInput.checked = draft.enabled;
        countInput.value = String(draft.count);
        countInput.disabled = !draft.enabled;
        countDown.disabled = !draft.enabled || draft.count <= BATCH_COUNT_MIN;
        countUp.disabled = !draft.enabled || draft.count >= BATCH_COUNT_MAX;
        seedInput.value = draft.seed < 0 ? text('tag_ui_seed_random') : String(draft.seed);
        seedInput.classList.toggle('is-random', draft.seed < 0);
        status.textContent = isDirty() ? text('tag_ui_unapplied') : text('tag_ui_no_changes');
        renderVariableList();
        renderTable();
    }

    function setCount(value) {
        const count = normalizeBatch({ enabled: true, count: value }).count;
        draft = { ...draft, count };
        render();
    }

    enableInput.addEventListener('change', () => { draft = { ...draft, enabled: enableInput.checked }; render(); });
    countDown.addEventListener('click', () => setCount(draft.count - 1));
    countUp.addEventListener('click', () => setCount(draft.count + 1));
    countInput.addEventListener('change', () => setCount(Number(countInput.value)));
    countInput.addEventListener('keydown', event => {
        if (event.key === 'ArrowUp') { event.preventDefault(); setCount(draft.count + (event.shiftKey ? 2 : 1)); }
        if (event.key === 'ArrowDown') { event.preventDefault(); setCount(draft.count - (event.shiftKey ? 2 : 1)); }
    });
    seedInput.addEventListener('focus', () => { if (draft.seed < 0) seedInput.value = ''; });
    seedInput.addEventListener('change', () => {
        const value = Number(String(seedInput.value).trim());
        draft = { ...draft, seed: Number.isFinite(value) && value >= 0 ? Math.floor(value) : -1 };
        render();
    });
    seedInput.addEventListener('blur', () => { if (draft.seed < 0) seedInput.value = text('tag_ui_seed_random'); });
    seedRandom.addEventListener('click', () => { draft = { ...draft, seed: -1 }; render(); });

    tbody.addEventListener('keydown', event => {
        if (event.key.toLowerCase() !== 'c' || event.ctrlKey || event.metaKey) return;
        const row = event.target.closest('tr.tag-batch-row');
        if (!row) return;
        event.preventDefault();
        navigator.clipboard?.writeText?.(row.dataset.prompt ?? '')
            .then(() => { copyHint.textContent = text('tag_ui_copied'); })
            .catch(() => {});
    });
    tbody.addEventListener('keydown', event => {
        if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
        const row = event.target.closest('tr.tag-batch-row');
        if (!row) return;
        const next = event.key === 'ArrowDown' ? row.nextElementSibling : row.previousElementSibling;
        if (next) { event.preventDefault(); next.focus(); }
    });

    cancelButton.addEventListener('click', () => shell.close({ apply: false }));
    applyButton.addEventListener('click', () => shell.close({ apply: true }));
    shell.setCloseHandler(({ apply }) => {
        if (!session) return;
        const current = session;
        session = null;
        if (apply) current.onApply?.({ enabled: draft.enabled, count: draft.count }, draft.seed);
        current.onClose?.({ apply });
    });

    applyText();

    return {
        open({
            trigger = null,
            fallback = null,
            fieldLabel = '',
            tokenPrefix = '',
            capsules = [],
            batch = {},
            generationSeed = -1,
            expand = null,
            onApply = null,
            onClose = null,
        } = {}) {
            applyText();
            const normalized = normalizeBatch(batch);
            const seed = Number.isFinite(Number(generationSeed)) ? Math.floor(Number(generationSeed)) : -1;
            draft = { enabled: normalized.enabled, count: normalized.count, seed };
            session = {
                capsules: capsules.slice(),
                expand,
                onApply,
                onClose,
                tokenPrefix,
                fieldLabel,
                initial: { ...draft },
            };
            render();
            shell.open({
                trigger,
                fallback,
                title: text('tag_ui_batch_title', fieldLabel),
                initialFocus: () => enableInput,
            });
        },
        close: () => shell.close({ apply: false }),
        isOpen: shell.isOpen,
        element: shell.overlay,
        updateLanguage: applyText,
    };
}

export function getBatchWeightDialog() {
    if (!singleton) singleton = createBatchWeightDialog();
    return singleton;
}
