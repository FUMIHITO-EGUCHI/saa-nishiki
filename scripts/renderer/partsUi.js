// The Parts UI (design/parts): the picker that inserts a "parts:<name>" chip into a
// Scene row, the card a part chip opens, the editor that makes or changes a part
// (also "Save as part…" on a chip selection), a part's sample history, and the
// sample jobs (one fixed prompt on a white mannequin, scripts/shared/parts.js
// samplePrompt) that go through the ordinary generation queue.
import {
    PART_CATEGORIES, SAMPLE_GENERATION, SAMPLE_SEED, SAMPLE_SIZE, expandOnePart, modelTypeLabel, partId, partNameOf,
    partToken, pickSample, sampleModelLabels, samplePrompt,
} from '../shared/parts.js';
import {
    PARTS_CHANGED_EVENT, addPartSample, applyPartsChange, expandParts, getPart, loadParts, partList,
    partsAvailable, sampleImage,
} from './partsClient.js';
import {
    assignCapsuleIds, createFixedWeightPlan, parsePromptToCapsules, serializeCapsules,
} from './components/tagCapsuleLogic.js';
import { openFieldTagModal, openTagPicker } from './tagSelectionModal.js';
import { attachPartsSampleJob, partsSampleQueued } from './generate.js';
import { loraCatalog, loraEntry } from './loraClient.js';
import { loraFitsModel, loraLabel } from '../shared/loraCatalog.js';
import { element as el } from './dom.js';

const CAT = '[PartsUI]';

function lang() {
    return globalThis.cachedFiles?.language?.[globalThis.globalSettings?.language] ?? {};
}

function text(key, fallback, ...args) {
    const value = lang()[key];
    let out = typeof value === 'string' && value ? value : fallback;
    args.forEach((arg, index) => { out = out.replaceAll(`{${index}}`, String(arg)); });
    return out;
}

function button(className, label, onClick, { title = '' } = {}) {
    const node = el('button', className, label);
    node.type = 'button';
    if (title) node.title = title;
    if (onClick) node.addEventListener('click', onClick);
    return node;
}

function fieldSet() {
    return globalThis.prompt?.tagCapsuleFields ?? null;
}

function fieldApi(key) {
    return key ? fieldSet()?.get?.(key) ?? null : null;
}

function modelType() {
    return globalThis.globalSettings?.api_model_type === 'Diffusion' ? 'Diffusion' : 'Checkpoint';
}

function categoryLabel(category) {
    return text(`parts_category_${category}`, category.charAt(0).toUpperCase() + category.slice(1));
}

// The tags of the first character slot, for a sample "on the current character".
function currentCharacterTags() {
    const key = String(globalThis.characterList?.getKey?.()?.[0] ?? 'None');
    if (!key || key.toLowerCase() === 'none') return '';
    const FILES = globalThis.cachedFiles ?? {};
    if (key.startsWith('oc:')) return String(FILES.ocList?.[key.slice(3)] ?? '');
    return String(FILES.characterList?.[key] ?? '');
}

// ---------------------------------------------------------------- sample tile

// An <img> that fills itself with the part's tile sample once it arrives (or a
// placeholder when there is none). `foreign` = a sample of the other model type.
export function sampleTile(id, { className = 'parts-tile-image', empty = null } = {}) {
    const holder = el('span', `${className} is-empty`);
    const sample = pickSample(getPart(id), modelType());
    if (!sample) {
        holder.append(el('span', 'parts-tile-empty', empty ?? text('parts_no_sample', 'No sample')));
        return holder;
    }
    const image = document.createElement('img');
    image.alt = '';
    image.decoding = 'async';
    holder.classList.toggle('is-foreign', sample.foreign);
    sampleImage(id, sample.id).then(url => {
        if (!url) return;
        image.src = url;
        holder.classList.remove('is-empty');
        holder.replaceChildren(image);
    }).catch(() => {});
    holder.append(el('span', 'parts-tile-empty', '…'));
    return holder;
}

function sampleMeta(id) {
    const entry = getPart(id);
    const sample = pickSample(entry, modelType());
    if (!sample) return text('parts_no_sample_for', 'None for {0}', modelTypeLabel(modelType()));
    const when = sample.created ? new Date(sample.created).toLocaleString() : '';
    const base = sample.base === 'character'
        ? (sample.character || text('parts_base_character_short', 'character'))
        : text('parts_base_mannequin_short', 'mannequin');
    return [modelTypeLabel(sample.modelType), base, `seed ${sample.seed}`, when].filter(Boolean).join(' · ');
}

// ---------------------------------------------------------------- overlays

// One dialog frame shared by the picker, the editor and the history: the selection
// modal's chrome (header / body / footer) so it looks like the other pickers.
function openFrame({ title, className = '', onClose = null }) {
    const overlay = el('div', `selection-modal parts-modal ${className}`);
    overlay.append(el('div', 'selection-modal-backdrop'));
    const dialog = el('div', 'selection-modal-dialog parts-dialog');
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.tabIndex = -1;
    const header = el('header', 'selection-modal-header parts-header');
    const heading = el('h2', 'selection-modal-title');
    if (typeof title === 'string') heading.textContent = title; else heading.append(title);
    const close = button('selection-modal-close', '×', () => api.close());
    close.setAttribute('aria-label', text('tag_ui_cancel', 'Close'));
    header.append(heading, close);
    const body = el('div', 'parts-body');
    const footer = el('footer', 'selection-modal-footer parts-footer');
    dialog.append(header, body, footer);
    overlay.append(dialog);
    document.body.append(overlay);
    // Escape closes this frame only while it is the topmost overlay: a picker opened
    // from it (Choose tags…) sits above it and takes the key
    const onKey = event => {
        if (event.key !== 'Escape') return;
        const open = document.querySelectorAll('.selection-modal:not([hidden])');
        if (open[open.length - 1] !== overlay) return;
        event.stopPropagation();
        api.close();
    };
    document.addEventListener('keydown', onKey, true);
    overlay.querySelector('.selection-modal-backdrop').addEventListener('click', () => api.close());
    const api = {
        overlay, dialog, header, heading, body, footer,
        close() {
            if (!overlay.isConnected) return;
            document.removeEventListener('keydown', onKey, true);
            overlay.remove();
            onClose?.();
        },
    };
    requestAnimationFrame(() => dialog.focus());
    return api;
}

// ---------------------------------------------------------------- the editor

// The LoRAs a part carries, as the editor shows them: a row per LoRA (the LoRA, its
// weight, whether it fits the model in use), whether its trigger words come along, and
// what a model of another base does with it. `state` is { loras, loraTriggers, otherBase }.
function partLoraEditor(state, onChange) {
    const box = el('div', 'parts-lora-box');
    const rows = el('div', 'parts-lora-rows');
    const modelLabel = name => String(name ?? '').split(/[\\/]/).pop().replace(/\.safetensors$/i, '');
    const fits = name => {
        const entry = loraEntry(name);
        if (!entry || entry.base === 'unknown') return null;
        return loraFitsModel(entry.base, globalThis.globalSettings?.api_model_type === 'Diffusion' ? 'Diffusion' : 'Checkpoint');
    };
    const baseText = name => {
        const entry = loraEntry(name);
        if (!entry || entry.base === 'unknown') return '';
        const label = entry.base === 'anima' ? 'Anima' : 'Illustrious';
        return fits(name) ? `${label} ✓` : label;
    };
    const paint = () => {
        rows.replaceChildren();
        state.loras.forEach((lora, index) => {
            const row = el('div', 'parts-lora-row');
            const select = el('select', 'parts-lora-select');
            select.setAttribute('aria-label', 'LoRA');
            const names = Array.isArray(globalThis.cachedFiles?.loraList) ? globalThis.cachedFiles.loraList.filter(name => name && name !== 'None') : [];
            for (const name of names.includes(lora.name) ? names : [lora.name, ...names]) {
                const option = el('option', '', modelLabel(name));
                option.value = name;
                select.append(option);
            }
            select.value = lora.name;
            select.addEventListener('change', () => { state.loras[index] = { ...lora, name: select.value }; paint(); onChange(); });
            const weight = el('input', 'parts-lora-weight');
            weight.type = 'number';
            weight.step = '0.05';
            weight.value = String(lora.weight);
            weight.setAttribute('aria-label', text('parts_lora_weight', 'Weight'));
            weight.addEventListener('change', () => {
                const value = Number(weight.value);
                if (Number.isFinite(value)) { state.loras[index] = { ...state.loras[index], weight: value }; onChange(); }
            });
            const base = el('span', `parts-lora-base${fits(lora.name) === false ? ' is-other' : fits(lora.name) ? ' is-fit' : ''}`, baseText(lora.name));
            const remove = button('parts-lora-remove', '×', () => { state.loras.splice(index, 1); paint(); onChange(); }, { title: text('parts_lora_remove', 'Remove LoRA') });
            row.append(select, weight, base, remove);
            rows.append(row);
        });
        triggers.hidden = state.loras.length === 0;
        otherBase.hidden = state.loras.length === 0;
    };
    // its own class: the editor's .parts-check is the sample switch (and the E2E story's)
    const triggers = el('label', 'parts-lora-check');
    const triggersCheck = document.createElement('input');
    triggersCheck.type = 'checkbox';
    triggersCheck.checked = state.loraTriggers !== false;
    triggersCheck.addEventListener('change', () => { state.loraTriggers = triggersCheck.checked; onChange(); });
    triggers.append(triggersCheck, el('span', '', text('parts_lora_triggers', 'Add trigger words')));
    const add = button('parts-lora-add', text('parts_lora_add', '+ Add LoRA'), () => {
        const first = loraCatalog().loras.find(entry => fits(entry.name) !== false) ?? loraCatalog().loras[0];
        const name = first?.name ?? (globalThis.cachedFiles?.loraList ?? []).find(item => item && item !== 'None');
        if (!name) return;
        state.loras.push({ name, weight: first?.range?.def ?? 0.8 });
        paint();
        onChange();
    });
    const otherBase = el('label', 'parts-field-label parts-lora-other');
    otherBase.append(el('span', '', text('parts_lora_other_base', 'Other base')));
    const otherSelect = el('select', 'parts-lora-other-select');
    for (const [value, label] of [['skip', text('parts_lora_skip', 'Skip LoRA')], ['use', text('parts_lora_use', 'Use anyway')]]) {
        const option = el('option', '', label);
        option.value = value;
        otherSelect.append(option);
    }
    otherSelect.value = state.otherBase === 'use' ? 'use' : 'skip';
    otherSelect.addEventListener('change', () => { state.otherBase = otherSelect.value; onChange(); });
    otherBase.append(otherSelect);
    box.append(el('span', 'parts-field-title', text('parts_loras', 'LoRAs')), rows, triggers, add, otherBase);
    paint();
    return box;
}

/**
 * Make or change a part. `initial` = { name, category, tags }; `id` names the part
 * being edited (null for a new one). `onSaved(entry, { id })` runs after the store
 * answered. The dialog offers to queue a sample right away.
 */
export function openPartEditor({ id = null, initial = {}, onSaved = null, trigger = null } = {}) {
    const existing = id ? getPart(id) : null;
    const start = {
        name: initial.name ?? existing?.name ?? '',
        category: initial.category ?? existing?.category ?? 'outfit',
        tags: initial.tags ?? existing?.tags ?? '',
    };
    const usedIn = id ? rowsUsing(id).length : 0;

    // the title bar is the form's name and category, where the card shows them
    const titleBox = el('span', 'parts-title-form');
    const nameLabel = el('label', 'parts-name-field');
    nameLabel.append(el('span', 'parts-prefix', 'parts:'));
    const nameInput = el('input', 'parts-name-input');
    nameInput.type = 'text';
    nameInput.value = start.name;
    nameInput.placeholder = text('parts_name_placeholder', 'name');
    nameInput.setAttribute('aria-label', text('parts_name', 'Name'));
    nameLabel.append(nameInput);
    const categorySelect = el('select', 'parts-category-select');
    categorySelect.setAttribute('aria-label', text('parts_category', 'Category'));
    for (const category of PART_CATEGORIES) {
        const option = el('option', '', categoryLabel(category));
        option.value = category;
        categorySelect.append(option);
    }
    categorySelect.value = start.category;
    titleBox.append(nameLabel, el('span', 'parts-title-dot', '·'), categorySelect);

    const frame = openFrame({ title: titleBox, className: 'parts-editor-modal' });
    frame.heading.classList.add('parts-title-editable');
    frame.dialog.classList.add('parts-editor-dialog');

    const row = el('div', 'parts-editor-row');
    row.append(sampleTile(id ?? '', { className: 'parts-editor-image', empty: id ? null : text('parts_sample_after_save', 'Sample after saving') }));
    const form = el('div', 'parts-editor-form');
    const tagsLabel = el('label', 'parts-field-label');
    tagsLabel.append(el('span', '', text('parts_tags', 'Tags')), el('span', 'parts-hint', text('parts_tags_hint', ' · weights and disabled marks travel with the part')));
    const tagsInput = el('textarea', 'parts-tags-input');
    tagsInput.rows = 4;
    tagsInput.value = start.tags;
    tagsLabel.append(tagsInput);
    const pickRow = el('div', 'parts-editor-tools');
    const pick = button('list-manager-button', text('ui_lists_pick_tags', 'Choose tags…'), () => openTagPicker(tagsInput, { favGroup: 'positive', trigger: pick }));
    pickRow.append(pick);
    form.append(tagsLabel, pickRow);

    // the LoRAs the part brings, and what the part becomes in a prompt
    const loraState = {
        loras: (existing?.loras ?? []).map(lora => ({ ...lora })),
        loraTriggers: existing?.loraTriggers !== false,
        otherBase: existing?.otherBase === 'use' ? 'use' : 'skip',
    };
    const preview = el('div', 'parts-expand-preview');
    const paintPreview = () => {
        const name = nameInput.value.trim() || text('parts_name_placeholder', 'name');
        const draft = { tags: tagsInput.value.trim(), ...loraState };
        const words = loraState.loraTriggers ? globalThis.loraUi?.partTriggers?.(draft) ?? [] : [];
        const running = loraState.loras.filter(lora => draft.otherBase === 'use' || !loraEntry(lora.name) || loraEntry(lora.name).base === 'unknown'
            || loraFitsModel(loraEntry(lora.name).base, globalThis.globalSettings?.api_model_type === 'Diffusion' ? 'Diffusion' : 'Checkpoint'));
        const lines = [[draft.tags, ...words].filter(Boolean).join(', '), ...running.map(lora => `+ LoRA  ${loraEntry(lora.name)?.label ?? loraLabel(lora.name)}  ${lora.weight}`)];
        preview.replaceChildren(
            el('span', 'parts-field-title', text('parts_sends_as', 'Sends as')),
            el('code', 'parts-picker-token', partToken(name)),
            el('span', 'parts-field-title', text('parts_expands_to', 'Expands to')),
            el('code', 'parts-expand-code', lines.join('\n')),
        );
    };
    form.append(partLoraEditor(loraState, paintPreview), preview);
    nameInput.addEventListener('input', paintPreview);
    tagsInput.addEventListener('input', paintPreview);
    paintPreview();

    const sampleBox = el('div', 'parts-sample-options');
    const generateLabel = el('label', 'parts-check');
    const generateCheck = document.createElement('input');
    generateCheck.type = 'checkbox';
    generateCheck.checked = true;
    generateLabel.append(generateCheck, el('span', '', id ? text('parts_regenerate_sample', 'Make a new sample after saving') : text('parts_generate_sample', 'Generate a sample now')));
    generateLabel.append(el('span', 'parts-hint', ` ${resourceNote()}`));
    const baseRow = el('div', 'parts-base-row');
    const mannequin = radio('parts-base', 'mannequin', text('parts_base_mannequin', 'On the mannequin'), true);
    const character = radio('parts-base', 'character', text('parts_base_character', 'On the current character'), false);
    const characterTags = currentCharacterTags();
    if (!characterTags) {
        character.input.disabled = true;
        character.label.title = text('parts_base_character_none', 'No character is selected');
    }
    baseRow.append(mannequin.label, character.label);
    sampleBox.append(generateLabel, baseRow);
    if (!partsAvailable() || globalThis.generate?.api_interface?.getValue?.() !== 'ComfyUI') {
        generateCheck.checked = false;
        generateCheck.disabled = true;
        sampleBox.append(el('div', 'parts-hint', text('parts_sample_comfy_only', 'Samples are generated through ComfyUI.')));
    }
    form.append(sampleBox);
    row.append(form);
    frame.body.append(row);

    const note = el('span', 'selection-modal-footer-note parts-footer-note',
        usedIn > 0 ? text('parts_used_in_rows', 'Used in {0} rows — saving changes them all', usedIn) : text('parts_name_taken_note', 'A name already taken asks to overwrite or keep both'));
    const cancel = button('selection-modal-cancel', text('tag_ui_cancel', 'Cancel'), () => frame.close());
    const save = button('selection-modal-apply', text('ui_lists_edit_save', 'Save'), async () => {
        const name = nameInput.value.trim().replaceAll(/\s+/g, ' ');
        const tags = tagsInput.value.trim();
        if (!name) { nameInput.focus(); return; }
        if (!tags) { tagsInput.focus(); return; }
        const targetId = partId(name);
        const clash = getPart(targetId);
        if (clash && (!id || partId(id) !== targetId)) {
            const overwrite = await confirmOverwrite(name);
            if (overwrite === null) return;
            if (!overwrite) { nameInput.focus(); return; }
            // overwrite = remove the other part first (its samples go with it)
            await applyPartsChange({ action: 'remove', id: targetId });
        }
        const change = { action: 'set', entry: { name, category: categorySelect.value, tags, loras: loraState.loras, loraTriggers: loraState.loraTriggers, otherBase: loraState.otherBase } };
        if (id) change.id = id;
        const doc = await applyPartsChange(change);
        if (!doc) { console.warn(CAT, 'save refused', change); return; }
        // a renamed part: its chips follow the new name
        if (id && partId(id) !== targetId) renameInFields(id, name);
        frame.close();
        onSaved?.(doc.parts[targetId], { id: targetId });
        if (generateCheck.checked && !generateCheck.disabled) {
            queuePartSample(targetId, { base: character.input.checked ? 'character' : 'mannequin' });
        }
    });
    frame.footer.append(note, cancel, save);
    requestAnimationFrame(() => (start.name ? tagsInput : nameInput).focus());
    frame.dialog.addEventListener('keydown', event => {
        if (event.key === 'Enter' && event.target === nameInput) { event.preventDefault(); tagsInput.focus(); }
    });
    return frame;
}

function radio(name, value, label, checked) {
    const wrap = el('label', 'parts-radio');
    const input = document.createElement('input');
    input.type = 'radio';
    input.name = name;
    input.value = value;
    input.checked = checked;
    wrap.append(input, el('span', '', label));
    return { label: wrap, input };
}

function resourceNote() {
    const model = globalThis.dropdownList?.model?.getValue?.() ?? '';
    const pod = globalThis.globalSettings?.api_pod_ssh_enable === true;
    return [pod ? 'Pod' : 'Local', modelTypeLabel(modelType()), model].filter(Boolean).join(' · ');
}

// "The name is taken": true = overwrite, false = keep both (rename), null = cancel.
function confirmOverwrite(name) {
    return new Promise(resolve => {
        const frame = openFrame({ title: text('parts_name_taken_title', 'Name already used'), className: 'parts-confirm-modal', onClose: () => resolve(null) });
        frame.body.append(el('p', 'parts-confirm-text', text('parts_name_taken', 'A part called "{0}" exists. Overwrite it, or go back and choose another name?', name)));
        const back = button('selection-modal-cancel', text('parts_keep_both', 'Choose another name'), () => { resolve(false); frame.close(); });
        const overwrite = button('selection-modal-apply', text('parts_overwrite', 'Overwrite'), () => { resolve(true); frame.close(); });
        frame.footer.append(back, overwrite);
    });
}

// ---------------------------------------------------------------- fields ↔ parts

function allFields() {
    const set = fieldSet();
    return set?.fields ? [...set.fields.keys()].map(key => set.get(key)).filter(Boolean) : [];
}

/** The field keys whose chips use the part. */
export function rowsUsing(id) {
    const target = partId(id);
    return allFields()
        .filter(field => field.getCapsules().some(capsule => {
            const name = partNameOf(capsule.value);
            return name !== null && partId(name) === target;
        }))
        .map(field => field.key);
}

function renameInFields(fromId, toName) {
    const target = partId(fromId);
    for (const field of allFields()) {
        const capsules = field.getCapsules();
        let changed = false;
        const next = capsules.map(capsule => {
            const name = partNameOf(capsule.value);
            if (name === null || partId(name) !== target) return capsule;
            changed = true;
            return { ...capsule, value: partToken(toName) };
        });
        if (changed) field.replaceCapsules(assignCapsuleIds(next));
    }
}

/** Put one part chip into a field (at the end, or at `at`). */
export function insertPart(fieldKey, name, at = undefined) {
    const field = fieldApi(fieldKey);
    if (!field) return false;
    field.insertTags([partToken(name)], at ?? field.getCapsules().length);
    return true;
}

/** "Expand to tags": the part chip becomes its member chips, weights applied. */
export function expandPartChip(fieldKey, capsuleId) {
    const field = fieldApi(fieldKey);
    const capsule = field?.findCapsule(capsuleId);
    const name = capsule ? partNameOf(capsule.value) : null;
    if (!field || name === null) return false;
    const entry = getPart(name);
    const token = serializeCapsules([capsule]);
    const expanded = expandOnePart(token, name, entry ?? { tags: name });
    const members = parsePromptToCapsules(expanded).map(member => ({ ...member, disabled: capsule.disabled === true }));
    const capsules = field.getCapsules();
    const index = capsules.findIndex(item => item.id === capsuleId);
    const next = [...capsules.slice(0, index), ...members, ...capsules.slice(index + 1)];
    field.replaceCapsules(assignCapsuleIds(next));
    return true;
}

/** "Swap…": the picker replaces this chip with another part of the same category. */
export function swapPartChip(fieldKey, capsuleId, trigger = null) {
    const field = fieldApi(fieldKey);
    const capsule = field?.findCapsule(capsuleId);
    const name = capsule ? partNameOf(capsule.value) : null;
    if (!field || name === null) return;
    const entry = getPart(name);
    openPartsPicker({
        fieldKey,
        category: entry?.category ?? '',
        trigger,
        title: text('parts_swap_title', 'Swap {0}', name),
        onPick: picked => {
            const capsules = field.getCapsules();
            const index = capsules.findIndex(item => item.id === capsuleId);
            if (index < 0) return;
            const next = capsules.map((item, i) => (i === index ? { ...item, value: partToken(picked.name) } : item));
            field.replaceCapsules(assignCapsuleIds(next));
        },
    });
}

/** "Save as part…" on a chip selection: the chips become one part chip once it is saved. */
export function savePartFromSelection(fieldKey, ids = [], trigger = null) {
    const field = fieldApi(fieldKey);
    if (!field) return;
    const wanted = new Set(ids);
    const capsules = field.getCapsules();
    const chosen = capsules.filter(capsule => wanted.has(capsule.id));
    if (chosen.length === 0) return;
    // a part inside a part is allowed, but a bare selection of one part chip has nothing to bundle
    const tags = serializeCapsules(chosen);
    openPartEditor({
        initial: { tags, category: guessCategory(tags) },
        trigger,
        onSaved: entry => {
            const current = field.getCapsules();
            const first = current.findIndex(capsule => wanted.has(capsule.id));
            if (first < 0) return;
            const remaining = current.filter(capsule => !wanted.has(capsule.id));
            const at = current.slice(0, first).filter(capsule => !wanted.has(capsule.id)).length;
            const chip = { value: partToken(entry.name), weightPlan: createFixedWeightPlan(1), disabled: false };
            field.replaceCapsules(assignCapsuleIds([...remaining.slice(0, at), chip, ...remaining.slice(at)]));
        },
    });
}

const CATEGORY_HINTS = [
    ['hair', /\b(hair|ponytail|twintails|twin tails|braid|bangs|ahoge|bun|drill)\b/],
    ['background', /\b(background|scenery|outdoors|indoors|sky|room|street|forest|beach|classroom|city|night|sunset)\b/],
    ['body', /\b(breasts|muscular|abs|tall|short|skinny|plump|thighs|hips|petite|curvy|body)\b/],
    ['outfit', /\b(dress|uniform|skirt|shirt|jacket|coat|shoes|boots|socks|thighhighs|hat|gloves|bikini|swimsuit|kimono|armor|apron|hoodie|pants|shorts)\b/],
];

function guessCategory(tags) {
    const lower = String(tags).toLowerCase();
    for (const [category, pattern] of CATEGORY_HINTS) if (pattern.test(lower)) return category;
    return 'other';
}

// ---------------------------------------------------------------- the card

let openCardElement = null;

function closeCard() {
    openCardElement?.remove();
    openCardElement = null;
}

/** The card a part chip opens: sample, tags, this row's weight, and the actions. */
export function openPartCard({ anchor, fieldKey, capsuleId }) {
    closeCard();
    const field = fieldApi(fieldKey);
    const capsule = field?.findCapsule(capsuleId);
    const name = capsule ? partNameOf(capsule.value) : null;
    if (!field || name === null || !anchor) return null;
    const id = partId(name);
    const entry = getPart(id);

    const card = el('div', 'parts-card');
    card.setAttribute('role', 'dialog');
    const head = el('div', 'parts-card-head');
    const title = el('span', 'parts-card-title');
    title.append(el('span', 'parts-prefix', 'parts:'), document.createTextNode(entry?.name ?? name));
    if (entry) title.append(el('span', 'parts-card-category', ` · ${categoryLabel(entry.category)}`));
    head.append(title, button('selection-modal-close', '×', closeCard));
    const body = el('div', 'parts-card-body');
    if (entry) {
        body.append(sampleTile(id, { className: 'parts-card-image' }));
        const info = el('div', 'parts-card-info');
        info.append(el('span', 'parts-section-label', text('parts_tags', 'Tags').toUpperCase()));
        const chips = el('div', 'parts-card-tags');
        for (const member of parsePromptToCapsules(entry.tags)) {
            const chip = el('span', `parts-card-tag${member.disabled ? ' is-off' : ''}`, member.value);
            const w = member.weightPlan?.min;
            if (Number.isFinite(w) && Math.abs(w - 1) > 1e-9) chip.append(el('span', 'parts-card-tag-weight', String(w)));
            chips.append(chip);
        }
        info.append(chips);
        const weightRow = el('label', 'parts-card-weight');
        weightRow.append(el('span', '', text('parts_weight', 'Weight')));
        const weightInput = el('input', 'parts-card-weight-input');
        weightInput.type = 'text';
        weightInput.value = String(capsule.weightPlan?.min ?? 1);
        weightInput.addEventListener('change', () => {
            const value = Number.parseFloat(weightInput.value);
            const weight = Number.isFinite(value) ? value : 1;
            const capsules = field.getCapsules();
            field.replaceCapsules(capsules.map(item => (item.id === capsuleId ? { ...item, weightPlan: createFixedWeightPlan(weight) } : item)));
        });
        weightRow.append(weightInput, el('span', 'parts-hint', text('parts_weight_hint', 'this chip only')));
        info.append(weightRow, el('span', 'parts-card-meta', sampleMeta(id)));
        body.append(info);
    } else {
        body.append(el('p', 'parts-card-missing', text('parts_missing', 'No part of this name. The name goes out as a plain tag.')));
    }
    const foot = el('div', 'parts-card-foot');
    if (entry) {
        foot.append(
            button('list-manager-button', text('parts_swap', 'Swap…'), () => { closeCard(); swapPartChip(fieldKey, capsuleId, anchor); }),
            button('list-manager-button', text('parts_expand', 'Expand to tags'), () => { closeCard(); expandPartChip(fieldKey, capsuleId); }),
            button('list-manager-button', text('parts_history_n', 'History ({0})', entry.samples.length), () => { closeCard(); openPartHistory(id); }),
            button('list-manager-button is-primary parts-card-edit', text('parts_edit', 'Edit part…'), () => { closeCard(); openPartEditor({ id, trigger: anchor }); }),
        );
    } else {
        foot.append(
            button('list-manager-button', text('parts_expand', 'Expand to tags'), () => { closeCard(); expandPartChip(fieldKey, capsuleId); }),
            button('list-manager-button is-primary', text('parts_create_named', 'Create "{0}"…', name), () => {
                closeCard();
                openPartEditor({ initial: { name, tags: '' }, trigger: anchor });
            }),
        );
    }
    card.append(head, body, foot);
    document.body.append(card);
    place(card, anchor);
    openCardElement = card;
    const onDown = event => {
        if (card.contains(event.target) || anchor.contains(event.target)) return;
        document.removeEventListener('mousedown', onDown, true);
        document.removeEventListener('keydown', onKey, true);
        closeCard();
    };
    const onKey = event => {
        if (event.key !== 'Escape') return;
        document.removeEventListener('mousedown', onDown, true);
        document.removeEventListener('keydown', onKey, true);
        closeCard();
        anchor.focus?.();
    };
    document.addEventListener('mousedown', onDown, true);
    document.addEventListener('keydown', onKey, true);
    return card;
}

function place(card, anchor) {
    const rect = anchor.getBoundingClientRect();
    const width = card.offsetWidth || 380;
    const height = card.offsetHeight || 260;
    let left = rect.left;
    let top = rect.bottom + 6;
    if (left + width > window.innerWidth - 8) left = Math.max(8, window.innerWidth - width - 8);
    if (top + height > window.innerHeight - 8) top = Math.max(8, rect.top - height - 6);
    card.style.left = `${Math.round(left)}px`;
    card.style.top = `${Math.round(top)}px`;
}

// ---------------------------------------------------------------- the picker

function comfyInterface() {
    return globalThis.generate?.api_interface?.getValue?.() === 'ComfyUI';
}

// The parts without a sample of the current model type
function lackingSamples() {
    const type = modelType();
    return partList().filter(entry => { const sample = pickSample(entry, type); return !sample || sample.foreign; }).length;
}

// The rail's colour per category (the modal's category rail, selectionModal.js)
// values: design/tokens.json
const CATEGORY_COLORS = Object.freeze({
    outfit: 'var(--saa-cat-amber)', hair: 'var(--saa-cat-clay)', body: 'var(--saa-cat-violet)', background: 'var(--saa-cat-green)', camera: 'var(--saa-cat-blue)',
    composition: 'var(--saa-cat-sky)', tone: 'var(--saa-cat-pink)', pose: 'var(--saa-cat-yellow)', expression: 'var(--saa-cat-orange)', other: 'var(--saa-cat-stone)',
});

// The sample of the model in use, or null: a sample of the other model is not shown
// in the picker (the tile says "No sample yet" instead)
function sampleInUse(entry) {
    const sample = pickSample(entry, modelType());
    return sample && !sample.foreign ? sample : null;
}

// A tile of the row modal's Parts tab: the sample of the model in use (or "No sample
// yet"), "parts:<name>", and the tags on one line
function pickerTile(id) {
    const entry = getPart(id);
    const box = el('span', 'parts-tile-body');
    if (!entry) return box;
    if (sampleInUse(entry)) {
        box.append(sampleTile(id));
    } else {
        const holder = el('span', 'parts-tile-image is-empty is-missing');
        holder.append(el('span', 'parts-tile-empty', text('parts_no_sample_yet', 'No sample yet')));
        box.append(holder);
    }
    const name = el('span', 'parts-tile-name');
    name.append(el('span', 'parts-prefix', 'parts:'), document.createTextNode(entry.name));
    box.append(name, el('span', 'parts-tile-meta parts-tile-tags', entry.tags));
    return box;
}

// The panel beside the grid of the row modal's Parts tab: the name, where the part
// came from, the sample of the model in use, the tags, what the chip sends, and Add
// to selection / Edit / Sample
function pickerPanel(id, { trigger = null, onChanged = null } = {}) {
    const entry = id ? getPart(id) : null;
    const panel = el('div', 'parts-panel-content parts-picker-panel');
    if (!entry) {
        panel.append(el('p', 'parts-panel-empty', partList().length ? text('parts_panel_pick', 'Pick a part to see its tags and sample.') : text('parts_panel_none', 'No parts yet. Select chips in a row and choose "Save as part…", or press New part.')));
        return panel;
    }
    const head = el('div', 'parts-picker-head');
    head.append(
        el('span', 'parts-panel-name', entry.name),
        el('span', 'parts-panel-sub', `${categoryLabel(entry.category)} · ${entry.starter ? text('parts_origin_starter', 'starter') : text('parts_origin_user', 'yours')}`),
    );
    panel.append(head);
    const figure = el('div', 'parts-picker-sample');
    const sample = sampleInUse(entry);
    if (sample) {
        figure.append(sampleTile(id, { className: 'parts-panel-image' }));
        figure.append(el('span', 'parts-card-meta', `${modelTypeLabel(modelType())} · v${sample.promptVersion}`));
    } else {
        const holder = el('span', 'parts-panel-image is-empty is-missing');
        holder.append(el('span', 'parts-tile-empty', text('parts_no_sample_yet', 'No sample yet')));
        figure.append(holder, el('span', 'parts-card-meta', modelTypeLabel(modelType())));
    }
    panel.append(figure);
    panel.append(el('span', 'parts-section-label', text('parts_tags', 'Tags').toUpperCase()));
    const chips = el('div', 'parts-card-tags');
    for (const member of parsePromptToCapsules(entry.tags)) chips.append(el('span', `parts-card-tag${member.disabled ? ' is-off' : ''}`, member.value));
    panel.append(chips);
    panel.append(el('span', 'parts-section-label', text('parts_sends_as', 'Sends as').toUpperCase()));
    panel.append(el('code', 'parts-picker-token', partToken(entry.name)));
    // picking happens on the tile (as a tag is picked); the panel edits and resamples
    const actions = el('div', 'parts-picker-actions');
    const edit = button('list-manager-button parts-picker-edit', text('parts_edit_short', 'Edit'), () => openPartEditor({ id, trigger, onSaved: () => onChanged?.() }));
    const sampleButton = button('list-manager-button parts-picker-sample', text('parts_sample_short', 'Sample'), () => queuePartSample(id, { base: 'mannequin' }), { title: text('parts_new_sample', 'New sample') });
    sampleButton.disabled = !comfyInterface();
    actions.append(edit, sampleButton);
    panel.append(actions);
    return panel;
}

// One part's tile: the sample, "parts:<name>", the category and the models it has samples for
function tileContent(id) {
    const entry = getPart(id);
    const box = el('span', 'parts-tile-body');
    if (!entry) return box;
    box.append(sampleTile(id));
    const name = el('span', 'parts-tile-name');
    name.append(el('span', 'parts-prefix', 'parts:'), document.createTextNode(entry.name));
    const labels = sampleModelLabels(entry);
    box.append(name, el('span', 'parts-tile-meta', `${categoryLabel(entry.category)} · ${labels.length ? labels.join(' / ') : text('parts_not_generated', 'not generated')}`));
    return box;
}

// The panel beside the grid about one part: sample, tags, History / New sample /
// Edit part…; `onChanged` runs after the editor saved
function panelContent(id, { trigger = null, onChanged = null } = {}) {
    const entry = id ? getPart(id) : null;
    const panel = el('div', 'parts-panel-content');
    if (!entry) {
        panel.append(el('p', 'parts-panel-empty', partList().length ? text('parts_panel_pick', 'Pick a part to see its tags and sample.') : text('parts_panel_none', 'No parts yet. Select chips in a row and choose "Save as part…", or press New part.')));
        return panel;
    }
    const top = el('div', 'parts-panel-top');
    top.append(sampleTile(id, { className: 'parts-panel-image' }));
    const info = el('div', 'parts-panel-info');
    const name = el('span', 'parts-panel-name');
    name.append(el('span', 'parts-prefix', 'parts:'), document.createTextNode(entry.name));
    const labels = sampleModelLabels(entry);
    info.append(name, el('span', 'parts-panel-sub', `${categoryLabel(entry.category)} · ${countTags(entry)} tags${labels.length ? ` · ${labels.join(' / ')}` : ''}`));
    info.append(el('span', 'parts-card-meta', sampleMeta(id)));
    info.append(
        button('list-manager-button', text('parts_history_n', 'History ({0})', entry.samples.length), () => openPartHistory(id)),
        button('list-manager-button', text('parts_new_sample', 'New sample'), () => queuePartSample(id, { base: 'mannequin' })),
        button('list-manager-button', text('parts_sample_on_character', 'On current character'), () => queuePartSample(id, { base: 'character' })),
    );
    top.append(info);
    panel.append(top);
    panel.append(el('span', 'parts-section-label', text('parts_tags', 'Tags').toUpperCase()));
    const chips = el('div', 'parts-card-tags');
    for (const member of parsePromptToCapsules(entry.tags)) chips.append(el('span', `parts-card-tag${member.disabled ? ' is-off' : ''}`, member.value));
    panel.append(chips);
    panel.append(button('list-manager-button parts-panel-edit', text('parts_edit', 'Edit part…'), () => openPartEditor({ id, trigger, onSaved: () => onChanged?.() })));
    return panel;
}

/**
 * The Parts tab of a row's tag modal (tagSelectionModal.js, design/parts AddTag):
 * the parts as tiles behind the same search box, Category = the part categories,
 * the Attribute box = whether a sample exists for the current model, a panel about
 * the focused part, "+ New part" and "Generate missing" in the footer. A picked
 * tile joins the modal's selection as its parts: token and Apply inserts it like a
 * tag. Null when parts are not available.
 */
function optionLabelOf(option) {
    return String(option?.label ?? option?.value ?? '');
}

export function partsPickerTab({ fieldKey = null, trigger = null } = {}) {
    if (!partsAvailable()) return null;
    const type = modelType();
    const sampled = entry => { const sample = pickSample(entry, type); return Boolean(sample && !sample.foreign); };
    const option = entry => ({
        key: partToken(entry.name),
        value: partToken(entry.name),
        label: entry.name,
        prefix: 'parts:',
        chipClass: 'is-part',
        category: entry.category,
        attributes: [sampled(entry) ? 'sampled' : 'missing'],
        keywords: [entry.tags],
        part: entry.id,
    });
    const matching = query => {
        const needle = String(query).trim().toLowerCase();
        return partList().filter(entry => entry.name.toLowerCase().includes(needle) || entry.tags.toLowerCase().includes(needle)).length;
    };
    const created = item => getPart(item.part)?.created ?? '';
    return {
        id: 'parts',
        label: text('parts_tab', 'Parts'),
        view: 'grid',
        // the categories as a rail beside the grid, All first, each with its colour
        rail: true,
        categories: PART_CATEGORIES.map(category => ({ value: category, label: categoryLabel(category), color: CATEGORY_COLORS[category] ?? '' })),
        // the View row opens on the camera parts (the rail is still free to change)
        defaultCategory: fieldKey === 'views' && PART_CATEGORIES.includes('camera') ? 'camera' : '',
        categoryLabel: text('parts_category', 'Category'),
        categoryAll: text('parts_category_all', 'All'),
        // no Sample box: a tile without a sample of the model in use says so itself
        attributes: [],
        // a click picks the tile and shows it in the panel, as on the tag list
        clickPreviews: false,
        sorts: [
            { value: 'name', label: text('parts_sort_name', 'Name'), compare: (a, b) => optionLabelOf(a).localeCompare(optionLabelOf(b)) },
            { value: 'newest', label: text('parts_sort_newest', 'Newest'), compare: (a, b) => created(b).localeCompare(created(a)) || optionLabelOf(a).localeCompare(optionLabelOf(b)) },
        ],
        tileSizes: [
            { value: 's', label: 'S', px: 120, title: text('parts_tile_size_s', 'Small tiles') },
            { value: 'm', label: 'M', px: 168, default: true, title: text('parts_tile_size_m', 'Medium tiles') },
            { value: 'l', label: 'L', px: 220, title: text('parts_tile_size_l', 'Large tiles') },
        ],
        // every part is a tile: the modal's cut of 200 rows hid the rest of the 295 starter
        // parts from All, with no way to page to them
        optionLimit: Number.MAX_SAFE_INTEGER,
        emptyMessage: text('parts_grid_empty', 'No part matches.'),
        searchPrompt: text('parts_panel_none', 'No parts yet. Select chips in a row and choose "Save as part…", or press New part.'),
        refreshEvent: PARTS_CHANGED_EVENT,
        loadOptions: async () => {
            await loadParts();
            return partList().map(option);
        },
        renderOption: item => pickerTile(item.part),
        panel: (item, api) => pickerPanel(item?.part ?? null, { trigger, onChanged: () => api.refresh() }),
        actions: [
            { label: text('parts_new', '+ New part'), onClick: api => openPartEditor({ trigger, onSaved: () => api.refresh() }) },
            {
                label: () => text('parts_generate_missing', 'Generate missing ({0})', lackingSamples()),
                disabled: () => lackingSamples() === 0 || !comfyInterface(),
                onClick: () => generateMissing(),
            },
        ],
        peek: matching,
        peekLabel: count => text('parts_tab_peek', '{0} parts match → Parts', count),
        fieldKey,
    };
}

/**
 * The grid of parts. `onPick(entry)` gets the chosen part; without it the part is
 * inserted into `fieldKey` - through the row's tag modal on its Parts tab when the
 * row has one, else this picker's own window. `category` preselects a tab.
 */
export function openPartsPicker({ fieldKey = null, at = undefined, category = '', trigger = null, title = null, onPick = null } = {}) {
    if (!onPick && fieldKey && at === undefined && openFieldTagModal(fieldKey, { tab: 'parts', trigger })) return null;
    const state = { category, query: '', selected: null };
    const frame = openFrame({ title: title ?? text('parts_insert_title', 'Insert part'), className: 'parts-picker-modal', onClose: () => document.removeEventListener(PARTS_CHANGED_EVENT, repaint) });
    frame.dialog.classList.add('parts-picker-dialog');
    const sub = el('span', 'parts-title-sub', fieldKey ? text('parts_insert_into', 'into {0} · one chip', fieldApi(fieldKey)?.getLabel?.() ?? fieldKey) : '');
    frame.heading.append(sub);

    const toolbar = el('div', 'parts-toolbar');
    const tabs = el('div', 'parts-tabs');
    const search = el('input', 'selection-modal-search parts-search');
    search.type = 'search';
    search.placeholder = text('parts_search_placeholder', 'Search parts by name or tag');
    search.setAttribute('aria-label', search.placeholder);
    search.addEventListener('input', () => { state.query = search.value; repaint(); });
    const count = el('span', 'parts-count');
    toolbar.append(tabs, search, count);

    const layout = el('div', 'parts-picker-layout');
    const grid = el('div', 'parts-grid');
    grid.setAttribute('role', 'listbox');
    const panel = el('div', 'parts-panel');
    layout.append(grid, panel);
    frame.body.append(toolbar, layout);

    const missing = button('list-manager-button', '', () => generateMissing());
    const newPart = button('list-manager-button', text('parts_new', '+ New part'), () => openPartEditor({ trigger, onSaved: () => repaint() }));
    const hint = el('span', 'selection-modal-footer-note parts-footer-note', text('parts_picker_keys', '←↑↓→ move · Enter insert'));
    const cancel = button('selection-modal-cancel', text('tag_ui_cancel', 'Cancel'), () => frame.close());
    const apply = button('selection-modal-apply', text('parts_insert', 'Insert'), () => choose());
    frame.footer.append(missing, newPart, hint, cancel, apply);

    function entries() {
        const needle = state.query.trim().toLowerCase();
        return partList(state.category).filter(entry => !needle || entry.name.toLowerCase().includes(needle) || entry.tags.toLowerCase().includes(needle));
    }

    function choose() {
        const entry = state.selected ? getPart(state.selected) : null;
        if (!entry) return;
        frame.close();
        if (onPick) onPick({ id: state.selected, ...entry });
        else if (fieldKey) insertPart(fieldKey, entry.name, at);
    }

    function repaintTabs() {
        tabs.replaceChildren();
        const all = button(`parts-tab${state.category === '' ? ' is-active' : ''}`, text('parts_category_all', 'All'), () => { state.category = ''; repaint(); });
        all.setAttribute('aria-pressed', String(state.category === ''));
        tabs.append(all);
        for (const cat of PART_CATEGORIES) {
            const tab = button(`parts-tab${state.category === cat ? ' is-active' : ''}`, categoryLabel(cat), () => { state.category = cat; repaint(); });
            tab.setAttribute('aria-pressed', String(state.category === cat));
            tabs.append(tab);
        }
    }

    function repaintPanel() {
        panel.replaceChildren(panelContent(state.selected, { trigger, onChanged: repaint }));
    }

    function repaintGrid() {
        grid.replaceChildren();
        const list = entries();
        if (state.selected && !list.some(entry => entry.id === state.selected)) state.selected = list[0]?.id ?? null;
        if (!state.selected && list.length) state.selected = list[0].id;
        for (const entry of list) {
            const tile = button(`parts-tile${entry.id === state.selected ? ' is-selected' : ''}`, '', () => { state.selected = entry.id; repaintGrid(); repaintPanel(); });
            tile.setAttribute('role', 'option');
            tile.setAttribute('aria-selected', String(entry.id === state.selected));
            tile.dataset.partId = entry.id;
            tile.append(sampleTile(entry.id));
            const name = el('span', 'parts-tile-name');
            name.append(el('span', 'parts-prefix', 'parts:'), document.createTextNode(entry.name));
            const labels = sampleModelLabels(entry);
            tile.append(name, el('span', 'parts-tile-meta', `${countTags(entry)} tags · ${labels.length ? labels.join(' / ') : text('parts_not_generated', 'not generated')}`));
            tile.addEventListener('dblclick', () => { state.selected = entry.id; choose(); });
            grid.append(tile);
        }
        if (list.length === 0) grid.append(el('div', 'parts-grid-empty', text('parts_grid_empty', 'No part matches.')));
        count.textContent = text('parts_count', '{0} of {1}', list.length, partList().length);
        const lacking = lackingSamples();
        missing.textContent = text('parts_generate_missing', 'Generate missing ({0})', lacking);
        missing.disabled = lacking === 0 || !comfyInterface();
        apply.disabled = !state.selected;
    }

    function repaint() { repaintTabs(); repaintGrid(); repaintPanel(); }

    frame.dialog.addEventListener('keydown', event => {
        if (event.target === search && !['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Enter'].includes(event.key)) return;
        const list = entries();
        const index = list.findIndex(entry => entry.id === state.selected);
        const columns = Math.max(1, Math.floor(grid.clientWidth / 150));
        const move = delta => {
            if (list.length === 0) return;
            state.selected = list[Math.max(0, Math.min(list.length - 1, (index < 0 ? 0 : index) + delta))].id;
            repaintGrid();
            repaintPanel();
            grid.querySelector('.parts-tile.is-selected')?.scrollIntoView({ block: 'nearest' });
        };
        switch (event.key) {
            case 'ArrowRight': event.preventDefault(); move(1); break;
            case 'ArrowLeft': event.preventDefault(); move(-1); break;
            case 'ArrowDown': event.preventDefault(); move(columns); break;
            case 'ArrowUp': event.preventDefault(); move(-columns); break;
            case 'Enter': if (event.target.tagName !== 'BUTTON' || event.target.classList.contains('parts-tile')) { event.preventDefault(); choose(); } break;
            default: break;
        }
    });
    document.addEventListener(PARTS_CHANGED_EVENT, repaint);
    loadParts().then(repaint);
    repaint();
    requestAnimationFrame(() => search.focus());
    return frame;
}

function countTags(entry) {
    return parsePromptToCapsules(entry.tags).length;
}

// ---------------------------------------------------------------- history

export function openPartHistory(id) {
    const entry = getPart(id);
    if (!entry) return null;
    const titleBox = el('span', '');
    titleBox.append(el('span', 'parts-prefix', 'parts:'), document.createTextNode(entry.name));
    const frame = openFrame({ title: titleBox, className: 'parts-history-modal', onClose: () => document.removeEventListener(PARTS_CHANGED_EVENT, repaint) });
    frame.heading.append(el('span', 'parts-title-sub', text('parts_history_sub', 'every sample is kept · pin one as the tile')));
    const grid = el('div', 'parts-history-grid');
    frame.body.append(grid);
    const note = el('span', 'selection-modal-footer-note parts-footer-note', text('parts_history_note', 'Unpinned: the tile is the newest sample for the current model, mannequin first'));
    frame.footer.append(
        button('list-manager-button', text('parts_new_sample', 'New sample'), () => queuePartSample(id, { base: 'mannequin' })),
        note,
        button('selection-modal-cancel', text('parts_back', 'Close'), () => frame.close()),
    );

    function repaint() {
        const current = getPart(id);
        if (!current) { frame.close(); return; }
        grid.replaceChildren();
        const shown = pickSample(current, modelType());
        const samples = [...current.samples].sort((a, b) => (b.created || '').localeCompare(a.created || ''));
        if (samples.length === 0) grid.append(el('div', 'parts-grid-empty', text('parts_no_sample', 'No sample')));
        for (const sample of samples) {
            const pinned = current.pinned === sample.id;
            const item = el('div', `parts-history-item${pinned ? ' is-pinned' : ''}${sample.modelType !== modelType() ? ' is-foreign' : ''}`);
            const holder = el('span', 'parts-history-image is-empty');
            holder.append(el('span', 'parts-tile-empty', '…'));
            sampleImage(id, sample.id).then(url => {
                if (!url) return;
                const image = document.createElement('img');
                image.src = url;
                image.alt = '';
                holder.classList.remove('is-empty');
                holder.replaceChildren(image);
            }).catch(() => {});
            item.append(holder);
            const label = pinned ? text('parts_pinned', 'Pinned · tile') : shown?.id === sample.id ? text('parts_shown', 'Shown as tile') : sample.base === 'character' ? text('parts_base_character_short', 'character') : modelTypeLabel(sample.modelType);
            item.append(el('span', 'parts-history-label', label));
            const when = sample.created ? new Date(sample.created).toLocaleString() : '';
            item.append(el('span', 'parts-history-meta', [modelTypeLabel(sample.modelType), sample.base === 'character' ? (sample.character || 'character') : text('parts_base_mannequin_short', 'mannequin'), `seed ${sample.seed}`, `prompt v${sample.promptVersion}`, when].filter(Boolean).join('\n')));
            const actions = el('span', 'parts-history-actions');
            actions.append(
                button('list-manager-button', pinned ? text('parts_unpin', 'Unpin') : text('parts_pin', 'Pin'), () => applyPartsChange({ action: 'pin', id, sampleId: pinned ? null : sample.id })),
                button('list-manager-button is-danger', text('ui_lists_action_delete', 'Delete'), () => applyPartsChange({ action: 'remove-sample', id, sampleId: sample.id })),
            );
            item.append(actions);
            grid.append(item);
        }
    }
    document.addEventListener(PARTS_CHANGED_EVENT, repaint);
    repaint();
    return frame;
}

// ---------------------------------------------------------------- samples

/**
 * Queue one sample of a part on the generation queue (generate.js attachPartsSampleJob).
 * base = 'mannequin' | 'character' (the first character slot's tags).
 */
export function queuePartSample(id, { base = 'mannequin' } = {}) {
    const entry = getPart(id);
    const attach = attachPartsSampleJob;
    if (!entry) return false;
    if (globalThis.generate?.api_interface?.getValue?.() !== 'ComfyUI') {
        console.warn(CAT, 'samples need the ComfyUI interface');
        return false;
    }
    const type = modelType();
    const character = base === 'character' ? currentCharacterTags() : '';
    // the part as generation sends it: disabled members out, nested parts resolved
    const prompt = samplePrompt({ category: entry.category, tags: expandParts(partToken(entry.name)), modelType: type, character });
    const key = `${partId(id)}:${type}:${prompt.base}`;
    if (partsSampleQueued(key)) return false; // the same sample is already waiting
    const meta = {
        modelType: type,
        model: String(globalThis.dropdownList?.model?.getValue?.() ?? ''),
        base: prompt.base,
        character: character ? String(globalThis.characterList?.getKey?.()?.[0] ?? '') : '',
        seed: SAMPLE_SEED,
        width: SAMPLE_SIZE.width,
        height: SAMPLE_SIZE.height,
        promptVersion: prompt.promptVersion,
    };
    return attach({
        label: text('parts_sample_job', 'Sample: parts:{0}', entry.name),
        key,
        positive: prompt.positive,
        negative: prompt.negative,
        seed: SAMPLE_SEED,
        width: SAMPLE_SIZE.width,
        height: SAMPLE_SIZE.height,
        ...SAMPLE_GENERATION[type],
        onImage: async image => {
            if (!image) return;
            const doc = await addPartSample(id, meta, image);
            if (!doc) console.warn(CAT, 'sample not stored for', id);
        },
    });
}

/** Every part without a sample of the current model type gets one queued. */
export function generateMissing() {
    let queued = 0;
    for (const entry of partList()) {
        const sample = pickSample(entry, modelType());
        if (sample && !sample.foreign) continue;
        if (queuePartSample(entry.id, { base: 'mannequin' })) queued += 1;
    }
    return queued;
}

// ---------------------------------------------------------------- setup

export function setupPartsUi() {
    const api = {
        openPicker: openPartsPicker,
        pickerTab: partsPickerTab,
        openCard: openPartCard,
        openEditor: openPartEditor,
        openHistory: openPartHistory,
        saveFromSelection: savePartFromSelection,
        expandChip: expandPartChip,
        swapChip: swapPartChip,
        insert: insertPart,
        queueSample: queuePartSample,
        generateMissing,
        rowsUsing,
        available: partsAvailable,
        list: partList,
        get: getPart,
    };
    globalThis.partsUi = api;
    return api;
}
