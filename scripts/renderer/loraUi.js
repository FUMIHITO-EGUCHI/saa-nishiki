// The LoRA tab of a row's tag modal (tagSelectionModal.js), and the same tab alone as the
// LoRA card's "+ LoRA" picker: every LoRA as a tile whose picture is its sample grid - the
// LoRA off, then five weights over its range - so what it does shows without words. A
// click on a tile picks it (as a tag is picked) and shows it in the panel, which holds
// what the user decides per LoRA: the weight range the samples span (and Retake, with the
// prompt they are made with), the trigger words kept, the default weight, the tags it is
// suggested for, plus the images made with it and the Civitai lookup. A sample opens the
// sample viewer (loraSamples.js). Apply adds the picked LoRAs to the LoRA slots at their
// default weights and their trigger words to the row.
//
// The LoRAs also meet the prompt where it is written: a tag chip that some LoRA is
// suggested for carries a "LoRA N" badge whose popover shows those LoRAs' grids and adds
// the chosen one; a trigger word that came in with a LoRA of the slots carries a link
// mark; and each LoRA slot row (slots/myLoRASlot.js) lists its trigger words, which
// switch on and off in the prompt.

import { LORA_CHANGED_EVENT, askCivitai, changeLora, loadLoraCatalog, loraCatalog, loraEntry, loraSampleImage, lorasForTag } from './loraClient.js';
import { parsePromptToCapsules, serializeCapsules } from './components/tagCapsuleLogic.js';
import { defaultCell, loraFitsModel, sampleWeights, samplesForModel, tagKey } from '../shared/loraCatalog.js';
import { getPart, partLoras } from './partsClient.js';
import { showDialog } from './components/myDialog.js';
import { createSelectionModal } from './components/selectionModal.js';
import {
    button, comfyInterface, currentModel, element, hasSamples, insideSampleOverlay, modelType, number,
    openRetakeDialog, openSampleViewer, queueLoraSamples, text,
} from './loraSamples.js';

export { queueLoraSamples };

const CATEGORY_COLORS = Object.freeze({
    Composition: '#38bdf8', Character: '#f472b6', Style: '#c084fc', Concept: '#4ade80',
    Pose: '#facc15', Clothing: '#e0a72f', Speed: '#ffb454', Unsorted: '#6b7280',
});

export function baseLabel(base) {
    return { sdxl: 'Illustrious / SDXL', anima: 'Anima' }[base] ?? text('lora_base_unknown', 'Unknown');
}

function categoryLabel(category) {
    return text(`lora_category_${String(category).toLowerCase()}`, category);
}

// ------------------------------------------------------------------ the sample grid

/** Off and five weights, each with its sample (or an empty cell), the default ringed; `onPick(weight)` makes the cells buttons. */
function strengthGrid(entry, { ring = false, onPick = null } = {}) {
    const grid = element('span', `lora-grid${ring ? ' is-large' : ''}`);
    const weights = sampleWeights(entry.range);
    const { samples } = samplesForModel(entry, currentModel());
    const marked = ring ? defaultCell(entry.range) : -1;
    weights.forEach((weight, index) => {
        const cell = element(onPick ? 'button' : 'span', `lora-cell${index === marked ? ' is-default' : ''}`);
        if (onPick) {
            cell.type = 'button';
            cell.setAttribute('aria-label', `${text('lora_weight', 'Weight')} ${index === 0 ? 'off' : number(weight)}`);
            cell.addEventListener('click', event => { event.stopPropagation(); onPick(weight); });
        }
        const frame = element('span', 'lora-cell-frame');
        const sample = samples.get(weight);
        if (sample) {
            const image = element('img', 'lora-cell-image');
            image.alt = '';
            loraSampleImage(entry.name, sample.id).then(dataUrl => { if (dataUrl) image.src = dataUrl; });
            frame.append(image);
        }
        frame.append(element('span', 'lora-cell-weight', index === 0 ? 'off' : number(weight)));
        cell.append(frame);
        grid.append(cell);
    });
    if (samples.size === 0) grid.append(element('span', 'lora-grid-missing', text('lora_no_samples', 'No samples')));
    return grid;
}

function tile(entry) {
    const box = element('span', 'lora-tile-body');
    if (!entry) return box;
    const picture = element('span', 'lora-tile-picture');
    picture.append(strengthGrid(entry));
    if (entry.favorite) picture.append(element('span', 'lora-tile-star', '★'));
    box.append(picture, element('span', 'lora-tile-name', entry.label));
    const meta = element('span', 'lora-tile-meta');
    meta.append(element('span', 'lora-base-badge', baseLabel(entry.base)));
    if (slotLoras({ all: true }).includes(entry.name)) meta.append(element('span', 'lora-base-badge is-in-slots', text('lora_in_slots', 'In slots')));
    meta.append(element('span', `lora-tile-trigger${entry.triggers.length ? '' : ' is-none'}`, entry.triggers.length ? entry.triggers.join(', ') : text('lora_no_trigger', 'no trigger')));
    box.append(meta);
    return box;
}

// ------------------------------------------------------------------ the panel

function setRange(entry, patch) {
    const range = { ...entry.range, ...patch };
    if (!(range.max > range.min)) return;
    range.def = Math.min(range.max, Math.max(range.min, range.def));
    return changeLora({ action: 'set', name: entry.name, patch: { range } });
}

function wordChips(words, { onRemove = null, onAdd = null, addLabel = '' } = {}) {
    const box = element('div', 'lora-words');
    for (const word of words.active) {
        const chip = element('span', 'lora-word');
        chip.append(document.createTextNode(word));
        if (onRemove) {
            const remove = button('lora-word-remove', '×', () => onRemove(word));
            remove.setAttribute('aria-label', `${text('lora_remove', 'Remove')} ${word}`);
            chip.append(remove);
        }
        box.append(chip);
    }
    for (const word of words.offered ?? []) box.append(button('lora-word-offer', `+ ${word}`, () => onAdd?.(word)));
    if (addLabel) box.append(button('lora-word-offer is-ask', addLabel, () => onAdd?.(null)));
    return box;
}

function section(label, content) {
    const box = element('div', 'lora-panel-section');
    box.append(element('span', 'lora-panel-label', label), content);
    return box;
}

async function imagesWith(entry, holder) {
    const api = globalThis.inBrowser ? null : globalThis.api;
    if (!api?.libraryLoraUses) return;
    const uses = await api.libraryLoraUses(entry.label).catch(() => null);
    if (!uses || !holder.isConnected) return;
    holder.querySelector('.lora-uses-count').textContent = String(uses.total);
    const thumbs = holder.querySelector('.lora-uses-thumbs');
    if (uses.recent.length === 0) return;
    const images = await api.libraryThumbs(uses.recent).catch(() => ({}));
    for (const file of uses.recent) {
        const image = element('img', 'lora-uses-thumb');
        image.alt = '';
        if (images?.[file]) image.src = images[file];
        thumbs.append(image);
    }
}

function panel(entry) {
    const box = element('div', 'lora-panel');
    if (!entry) {
        box.append(element('p', 'lora-panel-empty', loraCatalog().loras.length ? text('lora_panel_pick', 'Pick a LoRA.') : text('lora_panel_none', 'No LoRA files found.')));
        return box;
    }
    const head = element('div', 'lora-panel-head');
    const category = element('select', 'lora-category');
    category.setAttribute('aria-label', text('lora_category', 'Category'));
    for (const value of loraCatalog().categories) category.append(new Option(categoryLabel(value), value));
    category.value = entry.category;
    category.addEventListener('change', () => changeLora({ action: 'set', name: entry.name, patch: { category: category.value } }));
    const sub = element('span', 'lora-panel-sub');
    sub.append(category, document.createTextNode(` · ${baseLabel(entry.base)}`));
    head.append(element('h3', 'lora-panel-name', entry.label), sub);
    box.append(head);

    // the grid: a click opens the samples large (the default is made there, or below)
    box.append(strengthGrid(entry, { ring: true, onPick: () => openSampleViewer(entry.name) }));
    const rangeRow = element('div', 'lora-range');
    const input = (value, label, key) => {
        const field = element('input', 'lora-range-input');
        field.type = 'number';
        field.step = '0.1';
        field.value = String(value);
        field.setAttribute('aria-label', label);
        field.addEventListener('change', () => {
            const parsed = Number(field.value);
            if (Number.isFinite(parsed)) setRange(entry, { [key]: parsed, src: 'custom' });
        });
        return field;
    };
    const rangeLabel = element('label', 'lora-range-label', text('lora_range', 'Range'));
    rangeLabel.append(input(entry.range.min, text('lora_range_min', 'Lowest weight'), 'min'));
    rangeRow.append(rangeLabel, element('span', 'lora-range-dash', '–'), input(entry.range.max, text('lora_range_max', 'Highest weight'), 'max'));
    rangeRow.append(element('span', `lora-range-src is-${entry.range.src}`, entry.range.src === 'Civitai' ? 'Civitai' : entry.range.src === 'custom' ? text('lora_range_custom', 'custom') : text('lora_range_default', 'default')));
    rangeRow.append(element('span', 'lora-spacer'));
    // the prompt the samples are made with is written in the dialog, just before they are taken
    const take = button('lora-button lora-retake-open', samplesForModel(entry, currentModel()).samples.size ? text('lora_retake', 'Retake') : text('lora_take_samples', 'Take samples'), () => openRetakeDialog(entry.name));
    take.disabled = !comfyInterface();
    rangeRow.append(take);
    box.append(rangeRow);

    box.append(section(text('lora_triggers', 'Trigger words'), wordChips({ active: entry.triggers, offered: entry.candidates }, {
        onRemove: word => changeLora({ action: 'set', name: entry.name, patch: { triggers: entry.triggers.filter(item => item !== word) } }),
        onAdd: word => changeLora({ action: 'set', name: entry.name, patch: { triggers: [...entry.triggers, word] } }),
    })));

    const weight = element('div', 'lora-default');
    const weightHead = element('label', 'lora-panel-label lora-default-head', text('lora_default_weight', 'Default weight'));
    const weightValue = element('span', 'lora-default-value', number(entry.range.def));
    weightHead.append(weightValue);
    const slider = element('input', 'lora-default-slider');
    slider.type = 'range';
    slider.min = String(entry.range.min);
    slider.max = String(entry.range.max);
    slider.step = '0.05';
    slider.value = String(entry.range.def);
    slider.setAttribute('aria-label', text('lora_default_weight', 'Default weight'));
    slider.addEventListener('input', () => { weightValue.textContent = number(Number(slider.value)); });
    slider.addEventListener('change', () => setRange(entry, { def: Number(slider.value) }));
    weight.append(weightHead, slider);
    box.append(weight);

    box.append(section(text('lora_suggest_for', 'Suggest for tags'), wordChips({ active: entry.linked }, {
        onRemove: tag => changeLora({ action: 'set', name: entry.name, patch: { linked: entry.linked.filter(item => item !== tag) } }),
        onAdd: async () => {
            const answer = await showDialog('input', { message: text('lora_suggest_ask', 'Suggest this LoRA for the tag:'), defaultValue: '' });
            const tag = tagKey(answer);
            if (tag && !entry.linked.includes(tag)) changeLora({ action: 'set', name: entry.name, patch: { linked: [...entry.linked, tag] } });
        },
        addLabel: text('lora_add_tag', '+ tag'),
    })));

    if (!globalThis.inBrowser) {
        const uses = element('div', 'lora-panel-section lora-uses');
        const usesHead = element('span', 'lora-panel-label lora-uses-head', text('lora_your_images', 'Your images'));
        usesHead.append(element('span', 'lora-uses-count', ''));
        uses.append(usesHead, element('div', 'lora-uses-thumbs'));
        box.append(uses);
        imagesWith(entry, uses);
    }

    const facts = [entry.name];
    if (Number.isFinite(entry.dim)) facts.push(`dim ${number(entry.dim)}${Number.isFinite(entry.alpha) ? ` / alpha ${number(entry.alpha)}` : ''}`);
    box.append(element('p', 'lora-panel-file', facts.join(' · ')));

    // picking happens on the tile (as a tag is picked); the panel only looks things up
    if (!globalThis.inBrowser) {
        const actions = element('div', 'lora-panel-actions');
        const civitai = button('lora-button', 'Civitai', async () => {
            civitai.disabled = true;
            const answer = await askCivitai(entry.name).catch(error => ({ ok: false, message: error?.message ?? String(error) }));
            civitai.disabled = false;
            if (!answer?.ok) showDialog('info', { message: answer?.message ?? 'Civitai' });
        });
        actions.append(civitai);
        box.append(actions);
    }
    return box;
}

// ------------------------------------------------------------------ the tab

function optionFor(entry) {
    return {
        key: `lora:${entry.name}`,
        value: `lora:${entry.name}`,
        label: `${entry.label} ${number(entry.range.def)}`,
        prefix: 'LoRA',
        chipClass: 'is-lora',
        category: entry.category,
        attributes: loraFitsModel(entry.base, modelType()) ? ['fits'] : [],
        keywords: [entry.name, ...entry.triggers, ...entry.linked],
        lora: entry.name,
    };
}

/** The LoRA tab for a row's modal, or (`fieldKey` null) for the LoRA card's own picker. */
export function loraPickerTab({ fieldKey = null } = {}) {
    const matching = query => {
        const needle = String(query ?? '').trim().toLowerCase();
        if (!needle) return 0;
        return loraCatalog().loras.filter(entry => entry.name.toLowerCase().includes(needle) || entry.triggers.some(word => word.includes(needle)) || entry.linked.some(tag => tag.includes(needle))).length;
    };
    const labelOf = item => String(item?.label ?? '');
    return {
        id: 'lora',
        label: 'LoRA',
        view: 'grid',
        rail: true,
        categories: loraCatalog().categories.map(category => ({ value: category, label: categoryLabel(category), color: CATEGORY_COLORS[category] ?? '' })),
        categoryLabel: text('lora_category', 'Category'),
        categoryAll: text('parts_category_all', 'All'),
        attributes: [{ value: 'fits', label: text('lora_fits_model', 'Fits model') }],
        attributeLabel: text('lora_base', 'Base'),
        attributeAll: text('lora_all_bases', 'All bases'),
        defaultAttribute: 'fits',
        favorites: {
            isFavorite: key => loraEntry(String(key ?? '').replace(/^lora:/, ''))?.favorite === true,
            toggle: option => {
                const entry = loraEntry(option?.lora);
                if (entry) changeLora({ action: 'set', name: entry.name, patch: { favorite: !entry.favorite } });
            },
        },
        // a click picks the tile and shows it in the panel, as on the tag list
        clickPreviews: false,
        sorts: [
            { value: 'name', label: text('parts_sort_name', 'Name'), compare: (a, b) => labelOf(a).localeCompare(labelOf(b)) },
            { value: 'newest', label: text('lora_sort_newest', 'Newest file'), compare: (a, b) => (loraEntry(b.lora)?.mtime ?? 0) - (loraEntry(a.lora)?.mtime ?? 0) || labelOf(a).localeCompare(labelOf(b)) },
        ],
        tileSizes: [
            { value: 's', label: 'S', px: 150, title: text('parts_tile_size_s', 'Small tiles') },
            { value: 'm', label: 'M', px: 200, default: true, title: text('parts_tile_size_m', 'Medium tiles') },
            { value: 'l', label: 'L', px: 260, title: text('parts_tile_size_l', 'Large tiles') },
        ],
        optionLimit: Number.MAX_SAFE_INTEGER,
        emptyMessage: text('lora_grid_empty', 'No LoRA matches.'),
        searchPrompt: text('lora_panel_none', 'No LoRA files found.'),
        refreshEvent: LORA_CHANGED_EVENT,
        loadOptions: async () => {
            await loadLoraCatalog();
            return loraCatalog().loras.map(optionFor);
        },
        renderOption: item => tile(loraEntry(item.lora)),
        panel: item => panel(item ? loraEntry(item.lora) : null),
        actions: [],
        peek: matching,
        peekLabel: count => text('lora_tab_peek', '{0} LoRAs match → LoRA').replace('{0}', String(count)),
        fieldKey,
    };
}

const nextFrame = () => new Promise(resolve => requestAnimationFrame(() => resolve()));

/**
 * Adds the LoRAs to the LoRA slots at their default weights (a LoRA already in a slot
 * stays as it is) and returns their trigger words, for the row the modal belongs to.
 */
export async function addLorasToSlots(names) {
    const entries = names.map(loraEntry).filter(Boolean);
    if (entries.length === 0) return [];
    const add = async () => {
        const SETTINGS = globalThis.globalSettings;
        const rows = (globalThis.lora?.getValues?.() ?? SETTINGS.lora_slot ?? []).filter(row => Array.isArray(row) && row[0] && String(row[0]).toLowerCase() !== 'none');
        for (const entry of entries) {
            if (rows.some(row => row[0] === entry.name)) continue;
            rows.push([entry.name, number(entry.range.def), number(entry.range.def), 'ALL']);
        }
        SETTINGS.lora_slot = rows;
        globalThis.lora?.flush?.();
        globalThis.collapsedTabs?.lora?.setCollapsed?.(false);
        await nextFrame();
        await nextFrame();
    };
    const persistence = globalThis.settingsPersistence;
    if (persistence?.runEditTransaction) await persistence.runEditTransaction({ source: 'lora-catalog', sections: ['lora'] }, add);
    else await add();
    document.dispatchEvent(new CustomEvent(LORA_CHANGED_EVENT));
    return [...new Set(entries.flatMap(entry => entry.triggers))];
}

let picker = null;

/**
 * The LoRA card's "+ LoRA": the tag modal's LoRA tab on its own (titled LoRA, no other
 * tab), the picked LoRAs added to the slots and their trigger words to the Positive row.
 */
export function openLoraPicker({ trigger = null } = {}) {
    if (!picker) {
        picker = createSelectionModal({
            mode: 'multiple',
            fitWindow: true,
            onApply: async selected => {
                const names = selected.map(option => option.lora).filter(Boolean);
                if (names.length === 0) return;
                addWordsToRow('positive', await addLorasToSlots(names));
                notifySlots();
            },
        });
    }
    picker.open({
        trigger,
        modalTitle: 'LoRA',
        tabs: [loraPickerTab()],
        tab: 'lora',
        soleTab: true,
        applyLabel: count => (count > 0 ? `${text('lora_add', 'Add')} (${count})` : text('lora_add', 'Add')),
    });
    return picker;
}

// ------------------------------------------------------------------ the prompt side

// the rows a LoRA's words belong in: not the negative ones, not Exclude, not the cast list
const NOT_POSITIVE = new Set(['characters', 'negative', 'negative_left', 'negative_right', 'exclude']);

function positiveRow(fieldKey) {
    if (!fieldKey || NOT_POSITIVE.has(fieldKey)) return false;
    const fields = globalThis.globalSettings?.prompt_custom_fields;
    return !(Array.isArray(fields) && fields.some(field => field?.id === fieldKey && field.polarity === 'negative'));
}

// the LoRAs of the slots that run (OFF rows do not), or with `all` every row's
function slotLoras({ all = false } = {}) {
    const rows = globalThis.lora?.getValues?.() ?? globalThis.globalSettings?.lora_slot ?? [];
    return rows.filter(row => Array.isArray(row) && row[0] && (all || row[3] !== 'OFF')).map(row => String(row[0]));
}

/**
 * A chip's LoRA marks for its row (tagCapsuleField.js): how many LoRAs not yet in the
 * slots are suggested for the tag, and whether it is a trigger word of a LoRA that is.
 */
export function chipInfo(value, fieldKey) {
    if (!positiveRow(fieldKey)) return null;
    const key = tagKey(value);
    if (!key) return null;
    const inSlots = new Set(slotLoras());
    const suggest = lorasForTag(key).filter(entry => !inSlots.has(entry.name)).length;
    const from = [...inSlots].some(name => loraEntry(name)?.triggers.includes(key));
    return suggest || from ? { suggest, from } : null;
}

// whether a part's LoRA goes with it on the model in use
function partLoraRuns(part, lora) {
    if (part?.otherBase === 'use') return true;
    const entry = loraEntry(lora.name);
    return !entry || loraFitsModel(entry.base, modelType());
}

/** The trigger words a part adds when it is expanded (partsClient.js). */
export function partTriggers(part) {
    const words = [];
    for (const lora of part?.loras ?? []) {
        if (!partLoraRuns(part, lora)) continue;
        for (const word of loraEntry(lora.name)?.triggers ?? []) if (!words.includes(word)) words.push(word);
    }
    return words;
}

function fieldMuted(id) {
    const settings = globalThis.globalSettings ?? {};
    const custom = (settings.prompt_custom_fields ?? []).find(field => field?.id === id);
    if (custom) return custom.muted === true;
    return Array.isArray(settings.prompt_field_muted) && settings.prompt_field_muted.includes(id);
}

/**
 * The LoRAs the parts in the positive rows bring to a run, as LoRA rows: those not in a
 * slot already, and only on a model of their base unless the part says otherwise.
 */
export function partLorasForPrompt() {
    const inSlots = new Set((globalThis.lora?.getValues?.() ?? []).map(row => String(row?.[0] ?? '')));
    const found = new Map();
    for (const { id, control } of positiveControls()) {
        if (fieldMuted(id)) continue;
        for (const lora of partLoras(String(control.getValue() ?? ''))) {
            if (inSlots.has(lora.name) || found.has(lora.name)) continue;
            const part = getPart(lora.part);
            if (partLoraRuns(part, lora)) found.set(lora.name, lora);
        }
    }
    return [...found.values()];
}

// where a slot's LoRA came from, for its row ("tag: multiple views"); this session only
const origins = new Map();

function notifySlots() {
    document.dispatchEvent(new CustomEvent(LORA_CHANGED_EVENT));
}

// a row's prompt control (built-in by its key, a custom field by its id)
function rowControl(fieldKey) {
    return globalThis.prompt?.[fieldKey] ?? null;
}

function addWordsToRow(fieldKey, words) {
    const control = rowControl(fieldKey);
    if (!control?.getValue || !control.commitValue || words.length === 0) return;
    const text = String(control.getValue() ?? '');
    const present = new Set(parsePromptToCapsules(text).map(capsule => tagKey(capsule.value)));
    const missing = words.filter(word => !present.has(tagKey(word)));
    if (missing.length === 0) return;
    const trimmed = text.replace(/[\s,]+$/, '');
    control.commitValue(trimmed ? `${trimmed}, ${missing.join(', ')}` : missing.join(', '));
}

let popover = null;

function closePopover() {
    popover?.remove();
    popover = null;
    document.removeEventListener('pointerdown', outsidePopover, true);
    document.removeEventListener('keydown', popoverKey, true);
}

function outsidePopover(event) {
    if (popover && !popover.contains(event.target) && !insideSampleOverlay(event.target)) closePopover();
}

function popoverKey(event) {
    if (event.key === 'Escape' && !document.querySelector('.lora-viewer, .lora-retake')) {
        event.preventDefault();
        closePopover();
    }
}

/** The popover under a chip's "LoRA N" badge: the LoRAs suggested for `tag`, one picked to add. */
export function openTagPopover({ tag, anchor, fieldKey }) {
    closePopover();
    const inSlots = new Set(slotLoras());
    const entries = lorasForTag(tag).filter(entry => !inSlots.has(entry.name));
    if (entries.length === 0) return;
    let picked = entries[0].name;
    const box = element('div', 'lora-popover');
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-label', `${text('lora_popover_title', 'LoRAs that know')} ${tag}`);
    box.append(element('span', 'lora-popover-title', `“${tag}”`));
    const body = element('div', 'lora-popover-body');
    const list = element('div', 'lora-popover-list');
    list.setAttribute('role', 'radiogroup');
    const gridHolder = element('div', 'lora-popover-grid');
    const add = button('viewer-primary-button lora-popover-add', '', async () => {
        const entry = loraEntry(picked);
        if (!entry) return;
        closePopover();
        const words = await addLorasToSlots([entry.name]);
        origins.set(entry.name, tag);
        addWordsToRow(fieldKey, words);
        notifySlots();
    });
    const paint = () => {
        for (const row of list.querySelectorAll('.lora-popover-option')) {
            const on = row.dataset.name === picked;
            row.classList.toggle('is-on', on);
            row.querySelector('input').checked = on;
        }
        const entry = loraEntry(picked);
        gridHolder.replaceChildren(strengthGrid(entry, { ring: true, onPick: () => openSampleViewer(entry.name) }));
        if (samplesForModel(entry, currentModel()).samples.size === 0 && comfyInterface()) {
            gridHolder.append(button('lora-button lora-popover-take', text('lora_take_samples', 'Take samples'), () => openRetakeDialog(entry.name)));
        }
        add.textContent = `${text('lora_add', 'Add')} ${entry.label} · ${number(entry.range.def)}`;
    };
    for (const entry of entries) {
        const row = element('label', 'lora-popover-option');
        row.dataset.name = entry.name;
        const radio = element('input');
        radio.type = 'radio';
        radio.name = 'lora-popover-pick';
        const names = element('span', 'lora-popover-names');
        names.append(element('span', 'lora-popover-name', entry.label), element('span', 'lora-popover-note', [entry.triggers.join(', ') || text('lora_no_trigger', 'no trigger'), number(entry.range.def)].join(' · ')));
        row.append(radio, names, element('span', 'lora-popover-star', entry.favorite ? '★' : ''));
        row.addEventListener('click', () => { picked = entry.name; paint(); });
        list.append(row);
    }
    body.append(list, gridHolder);
    box.append(body, add);
    document.body.append(box);
    const rect = anchor?.getBoundingClientRect?.() ?? { left: 40, bottom: 40 };
    const width = Math.min(660, window.innerWidth - 32);
    box.style.left = `${Math.max(16, Math.min(rect.left, window.innerWidth - width - 16))}px`;
    box.style.top = `${Math.min(rect.bottom + 6, window.innerHeight - 40)}px`;
    box.style.width = `${width}px`;
    popover = box;
    paint();
    // the catalog may change while it is open (new samples): the grid follows
    const repaint = () => { if (popover === box && box.isConnected) paint(); else document.removeEventListener(LORA_CHANGED_EVENT, repaint); };
    document.addEventListener(LORA_CHANGED_EVENT, repaint);
    setTimeout(() => {
        document.addEventListener('pointerdown', outsidePopover, true);
        document.addEventListener('keydown', popoverKey, true);
    }, 0);
}

// ------------------------------------------------------------------ the slot rows

// the positive rows' controls with their texts, for finding a trigger word
function positiveControls() {
    const ids = ['common', 'views', 'background', 'style', 'positive', 'positive_right'];
    for (const field of globalThis.globalSettings?.prompt_custom_fields ?? []) if (field?.polarity !== 'negative' && field?.id) ids.push(field.id);
    return ids.map(id => ({ id, control: rowControl(id) })).filter(item => item.control?.getValue);
}

function rowsWithWord(word) {
    const key = tagKey(word);
    return positiveControls().filter(({ control }) => parsePromptToCapsules(String(control.getValue() ?? '')).some(capsule => tagKey(capsule.value) === key));
}

/** Puts a trigger word in the Positive row, or takes it out of every positive row. */
export function switchWord(word, on) {
    if (on) addWordsToRow('positive', [word]);
    else {
        const key = tagKey(word);
        for (const { control } of rowsWithWord(word)) {
            // the rest of the row goes back as the chips write it (weights and disabled marks kept)
            const kept = parsePromptToCapsules(String(control.getValue() ?? '')).filter(capsule => tagKey(capsule.value) !== key);
            control.commitValue(serializeCapsules(kept));
        }
    }
    notifySlots();
}

/** A slot row's trigger words, each on (in a positive row) or off, and where the LoRA came from. */
export function slotWords(name) {
    const entry = loraEntry(name);
    if (!entry) return { words: [], origin: '' };
    return { origin: origins.get(entry.name) ?? '', words: entry.triggers.map(word => ({ word, on: rowsWithWord(word).length > 0 })) };
}

/** What a slot row's slider spans: the LoRA's range (the catalog default without one) and the sample weights on it. */
export function slotRange(name) {
    const range = loraEntry(name)?.range ?? loraCatalog().defaults;
    return { min: range.min, max: range.max, def: range.def, ticks: [...new Set(sampleWeights(range))] };
}

/** The positive rows' tags as one text, the LoRA tags left out (the Retake dialog's "Current prompt"). */
export function currentPromptText() {
    const tags = [];
    for (const { id, control } of positiveControls()) {
        if (fieldMuted(id)) continue;
        for (const capsule of parsePromptToCapsules(String(control.getValue() ?? ''))) {
            const value = String(capsule.value ?? '').trim();
            if (!value || capsule.disabled || /^<lora:/i.test(value) || tags.includes(value)) continue;
            tags.push(value);
        }
    }
    return tags.join(', ');
}

// a trigger word typed or removed in a row turns its chip in the slot row on or off
function watchPrompt() {
    let timer = null;
    const later = () => {
        clearTimeout(timer);
        timer = setTimeout(() => globalThis.lora?.refreshWords?.(), 120);
    };
    document.addEventListener(LORA_CHANGED_EVENT, later);
    document.addEventListener('input', event => { if (event.target?.closest?.('.prompt-fields, .myTextbox-wrapper')) later(); }, true);
}

export function setupLoraUi() {
    const api = {
        pickerTab: loraPickerTab,
        openPicker: openLoraPicker,
        addToSlots: addLorasToSlots,
        queueSamples: queueLoraSamples,
        openSamples: openSampleViewer,
        hasSamples,
        reload: () => loadLoraCatalog({ force: true }),
        chipInfo,
        openTagPopover,
        slotWords,
        slotRange,
        switchWord,
        currentPromptText,
        partTriggers,
        partLorasForPrompt,
    };
    globalThis.loraUi = api;
    loadLoraCatalog();
    watchPrompt();
    return api;
}
