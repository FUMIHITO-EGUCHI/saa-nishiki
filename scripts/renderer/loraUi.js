// The LoRA tab of a row's tag modal (tagSelectionModal.js): every LoRA as a tile whose
// picture is its sample grid - the LoRA off, then five weights over its range - so what
// it does shows without words. The panel beside the grid holds what the user decides per
// LoRA: the weight range the samples span (and Retake), the trigger words kept, the
// default weight, the tags it is suggested for, plus the images made with it and the
// Civitai lookup. A picked LoRA joins the modal's Selected row; Apply adds it to the LoRA
// slots at its default weight and its trigger words to the row.
//
// Samples are queued like the Parts' (generate.attachPartsSampleJob): six images per
// LoRA on the current model, behind the user's own jobs.

import { LORA_CHANGED_EVENT, addLoraSample, askCivitai, changeLora, loadLoraCatalog, loraCatalog, loraEntry, loraSampleImage } from './loraClient.js';
import { LORA_SAMPLE_GENERATION, LORA_SAMPLE_SEED, LORA_SAMPLE_SIZE, defaultCell, loraFitsModel, loraSamplePrompt, sampleWeights, samplesForModel, tagKey } from '../shared/loraCatalog.js';
import { attachPartsSampleJob, partsSampleQueued } from './generate.js';
import { showDialog } from './components/myDialog.js';

const CATEGORY_COLORS = Object.freeze({
    Composition: '#38bdf8', Character: '#f472b6', Style: '#c084fc', Concept: '#4ade80',
    Pose: '#facc15', Clothing: '#e0a72f', Speed: '#ffb454', Unsorted: '#6b7280',
});

function lang() {
    const settings = globalThis.globalSettings ?? {};
    return globalThis.cachedFiles?.language?.[settings.language] ?? {};
}

function text(key, fallback) {
    const value = lang()[key];
    return typeof value === 'string' && value ? value : fallback;
}

function element(tag, className, content) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (content !== undefined && content !== null) node.textContent = String(content);
    return node;
}

function button(className, label, onClick) {
    const node = element('button', className, label);
    node.type = 'button';
    node.addEventListener('click', event => {
        event.stopPropagation();
        onClick(event);
    });
    return node;
}

function number(value) {
    return Number.isFinite(value) ? String(Math.round(value * 100) / 100) : '—';
}

function modelType() {
    return globalThis.globalSettings?.api_model_type === 'Diffusion' ? 'Diffusion' : 'Checkpoint';
}

function currentModel() {
    return String(globalThis.dropdownList?.model?.getValue?.() ?? '');
}

function comfyInterface() {
    return globalThis.generate?.api_interface?.getValue?.() === 'ComfyUI';
}

export function baseLabel(base) {
    return { sdxl: 'Illustrious / SDXL', anima: 'Anima' }[base] ?? text('lora_base_unknown', 'Unknown');
}

function categoryLabel(category) {
    return text(`lora_category_${String(category).toLowerCase()}`, category);
}

// ------------------------------------------------------------------ the sample grid

/** Off and five weights, each with its sample (or an empty cell), the default ringed. */
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
    meta.append(element('span', `lora-tile-trigger${entry.triggers.length ? '' : ' is-none'}`, entry.triggers.length ? entry.triggers.join(', ') : text('lora_no_trigger', 'no trigger')));
    box.append(meta);
    return box;
}

// ------------------------------------------------------------------ samples

/** Queues the six sample images of a LoRA on the current model; false when it cannot. */
export function queueLoraSamples(name) {
    const entry = loraEntry(name);
    if (!entry || !comfyInterface()) return false;
    const type = modelType();
    const model = currentModel();
    const generation = LORA_SAMPLE_GENERATION[type];
    for (const weight of sampleWeights(entry.range)) {
        const key = `lora:${entry.name}:${weight}:${model}`;
        if (partsSampleQueued(key)) continue;
        const { positive, negative } = loraSamplePrompt({ modelType: type, name: entry.name, triggers: entry.triggers, linked: entry.linked, weight });
        attachPartsSampleJob({
            label: `LoRA ${entry.label} · ${weight === 0 ? 'off' : number(weight)}`,
            key,
            positive,
            negative,
            seed: LORA_SAMPLE_SEED,
            width: LORA_SAMPLE_SIZE.width,
            height: LORA_SAMPLE_SIZE.height,
            ...generation,
            prefix: 'lora-samples/%date',
            onImage: image => addLoraSample(entry.name, { weight, model, modelType: type }, image),
        });
    }
    return true;
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

function panel(entry, api, option) {
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

    // the grid: a click on a weight makes it the default
    box.append(strengthGrid(entry, { ring: true, onPick: weight => { if (weight > 0) setRange(entry, { def: weight }); } }));
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
    const take = button('lora-button', samplesForModel(entry, currentModel()).samples.size ? text('lora_retake', 'Retake') : text('lora_take_samples', 'Take samples'), () => queueLoraSamples(entry.name));
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

    const actions = element('div', 'lora-panel-actions');
    const selected = Boolean(option && api?.isSelected?.(option));
    const add = button(`viewer-primary-button lora-add${selected ? ' is-selected' : ''}`, selected ? text('lora_remove_from_selection', 'Remove from selection') : text('lora_add_to_slots', 'Add to LoRA slots'), () => { if (option) api?.toggle?.(option); });
    actions.append(add);
    if (!globalThis.inBrowser) {
        const civitai = button('lora-button', 'Civitai', async () => {
            civitai.disabled = true;
            const answer = await askCivitai(entry.name).catch(error => ({ ok: false, message: error?.message ?? String(error) }));
            civitai.disabled = false;
            if (!answer?.ok) showDialog('info', { message: answer?.message ?? 'Civitai' });
        });
        actions.append(civitai);
    }
    box.append(actions);
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

/** The LoRA tab for a row's modal; null for a browser client without the catalog. */
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
        clickPreviews: true,
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
        panel: (item, api) => {
            const entry = item ? loraEntry(item.lora) : null;
            return panel(entry, api, entry ? optionFor(entry) : null);
        },
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
    return [...new Set(entries.flatMap(entry => entry.triggers))];
}

export function setupLoraUi() {
    const api = {
        pickerTab: loraPickerTab,
        addToSlots: addLorasToSlots,
        queueSamples: queueLoraSamples,
        reload: () => loadLoraCatalog({ force: true }),
    };
    globalThis.loraUi = api;
    loadLoraCatalog();
    return api;
}
