// The LoRA slots, the LoRA card of the Pipeline: one row per LoRA - a switch, the name,
// its trigger words (on or off in the prompt), a weight slider marked at the weights its
// samples were taken at, the weight, and a fold with the pass it runs in, the CLIP
// strength (it follows the weight until a value of its own is typed; ↺ puts it back) and
// the button that opens the samples. "+ LoRA" opens the LoRA picker (loraUi.js). The
// LoRA's words, range and samples come from globalThis.loraUi when it is set up.
//
// Kept as before: settings.lora_slot rows [name, model, clip, mode], mode ALL, Base, HiFix
// or OFF (an OFF row keeps its strengths and its pass comes back as All).

import { LORA_CHANGED_EVENT } from '../loraClient.js';
import { loraLabel } from '../../shared/loraCatalog.js';

let instanceSlotManager = null;

export function generateGUID() {
    const template = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx';
    let result = template;
    // one random byte per placeholder: with fewer, the reads past the end are undefined,
    // "NaN" lands in the middle of the id and the tail keeps its "x"es (the class a slot
    // row is looked up by then never matches, and its textbox is never built)
    const randomValues = new Uint8Array(template.replaceAll('-', '').length);
    crypto.getRandomValues(randomValues);
    let randomIndex = 0;
    for (let i = 0; i < template.length; i++) {
        const c = template[i];
        if (c === 'x' || c === 'y') {
            const r = randomValues[randomIndex++] % 16;
            const v = c === 'x' ? r : (r & 0x3) | 0x8;
            result = result.substring(0, i) + v.toString(16) + result.substring(i + 1);
        }
    }
    return result;
}

const STAGES = Object.freeze([['ALL', 'All'], ['Base', 'Base'], ['HiFix', 'Hires']]);
const MODES = new Set(['ALL', 'Base', 'HiFix', 'OFF']);
const SVG_NS = 'http://www.w3.org/2000/svg';
const ICONS = Object.freeze({
    down: 'M4 6l4 4 4-4',
    close: 'M4 4l8 8M12 4l-8 8',
    relink: ['M3.5 8a4.5 4.5 0 108-2.8', 'M11.8 2.2v3.2H8.6'],
    image: ['M2.5 3.5h11v9h-11z', 'M2.5 11.5l3.5-3.5 2.5 2.5 2-2 3 3'],
    plus: ['M8 3v10', 'M3 8h10'],
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

function icon(paths, size = 14) {
    const svg = document.createElementNS(SVG_NS, 'svg');
    for (const [key, value] of Object.entries({ width: size, height: size, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.8, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' })) {
        svg.setAttribute(key, String(value));
    }
    for (const d of [paths].flat()) {
        const path = document.createElementNS(SVG_NS, 'path');
        path.setAttribute('d', d);
        svg.append(path);
    }
    return svg;
}

function iconButton(className, label, paths, onClick) {
    const node = element('button', className);
    node.type = 'button';
    node.setAttribute('aria-label', label);
    node.title = label;
    node.append(icon(paths));
    node.addEventListener('click', onClick);
    return node;
}

const strength = value => {
    const number = Number.parseFloat(value);
    return Number.isFinite(number) ? number : 0;
};
const formatted = value => String(Math.round(value * 100) / 100);

function lorasListed() {
    const list = globalThis.cachedFiles?.loraList;
    return Array.isArray(list) ? list : [];
}

// a name the list does not hold (the list read and not empty): the row is kept by name, off
function missing(name) {
    const list = lorasListed();
    return name !== '' && list.length > 0 && !list.includes(name);
}

/** "<lora:a:0.6:0.4:0:0>…" (a prompt's LoRA tags) as slot rows, one mode per pair. */
export function rowsFromLoraTags(loraString) {
    const rows = [];
    for (const match of String(loraString ?? '').matchAll(/<lora:([^>]+)>/g)) {
        const parts = match[1].split(':');
        const name = parts[0];
        const values = parts.slice(1).map(v => Number.parseFloat(v) || 0);
        // a list not read yet (empty) says nothing about the file: the row is kept as written
        if (missing(name)) {
            rows.push([name, '0', '0', 'OFF']);
            continue;
        }
        if (values.length <= 2) {
            const model = values[0]?.toString() || '0';
            const clip = values[1]?.toString() || '0';
            rows.push([name, model, clip, (Number.parseFloat(model) !== 0 || Number.parseFloat(clip) !== 0) ? 'ALL' : 'OFF']);
        } else if (values.length === 4) {
            const base = [values[0], values[1]];
            const hires = [values[2], values[3]];
            const baseOn = base.some(v => v !== 0);
            const hiresOn = hires.some(v => v !== 0);
            if (baseOn && base[0] === hires[0] && base[1] === hires[1]) rows.push([name, String(base[0]), String(base[1]), 'ALL']);
            else {
                if (baseOn) rows.push([name, String(base[0]), String(base[1]), 'Base']);
                if (hiresOn) rows.push([name, String(hires[0]), String(hires[1]), 'HiFix']);
                if (!baseOn && !hiresOn) rows.push([name, '0', '0', 'OFF']);
            }
        }
    }
    return rows;
}

class SlotManager {
    constructor(containerSelector) {
        this.container = document.querySelector(`.${containerSelector}`);
        this.rows = [];
        this.list = element('div', 'lora-slots');
        const addRow = element('div', 'lora-slot-add-row');
        this.addButton = element('button', 'lora-slot-add');
        this.addButton.type = 'button';
        this.addButton.append(icon(ICONS.plus), document.createTextNode('LoRA'));
        this.addButton.addEventListener('click', () => globalThis.loraUi?.openPicker?.({ trigger: this.addButton }));
        addRow.append(this.addButton);
        this.container?.append(this.list, addRow);
        // the catalog read (ranges, trigger words, samples) or changed: the rows follow
        document.addEventListener(LORA_CHANGED_EVENT, () => this.refreshAll());
    }

    // ------------------------------------------------------------ the rows

    rowFromValues([name, model, clip, mode] = []) {
        const known = MODES.has(mode) ? mode : 'OFF';
        const absent = missing(String(name ?? ''));
        if (absent) console.warn(`LoRA "${name}" is not in the model folder: the row is kept by name and switched off`);
        const modelText = String(model ?? '0') || '0';
        const clipText = String(clip ?? modelText) || modelText;
        return {
            id: `slot-${generateGUID()}`,
            name: String(name ?? ''),
            model: modelText,
            clip: clipText,
            linked: strength(clipText) === strength(modelText),
            stage: known === 'OFF' ? 'ALL' : known,
            on: known !== 'OFF' && !absent,
            missing: absent,
            open: false,
            el: null,
        };
    }

    setRows(values) {
        this.rows = (Array.isArray(values) ? values : []).filter(row => Array.isArray(row) && row[0] && String(row[0]).toLowerCase() !== 'none').map(row => this.rowFromValues(row));
        this.render();
    }

    render() {
        this.list.replaceChildren(...this.rows.map(row => this.renderRow(row)));
        this.container?.dispatchEvent(new Event('change', { bubbles: true }));
    }

    refreshAll() {
        for (const row of this.rows) if (row.el?.isConnected) this.renderRow(row);
    }

    /** Repaints the trigger words of every row (a word typed in a prompt row). */
    refreshWords() {
        for (const row of this.rows) if (row.el?.isConnected) this.paintWords(row);
    }

    renderRow(row) {
        const node = row.el ?? element('div', 'lora-slot');
        row.el = node;
        node.dataset.slot = row.id;
        node.classList.toggle('is-off', !row.on);
        node.classList.toggle('is-missing', row.missing);
        node.classList.toggle('is-open', row.open);
        node.replaceChildren(this.renderLine(row));
        if (row.open) node.append(this.renderFold(row));
        return node;
    }

    renderLine(row) {
        const line = element('div', 'lora-slot-line');
        const toggle = element('button', 'lora-slot-switch');
        toggle.type = 'button';
        toggle.setAttribute('role', 'switch');
        toggle.setAttribute('aria-checked', String(row.on));
        toggle.setAttribute('aria-label', text('lora_slot_on', 'On'));
        toggle.disabled = row.missing;
        toggle.append(element('span', 'lora-slot-knob'));
        toggle.addEventListener('click', () => {
            row.on = !row.on;
            this.renderRow(row);
        });

        const main = element('div', 'lora-slot-main');
        const name = element('div', 'lora-slot-name', loraLabel(row.name) || row.name);
        name.title = row.missing ? `${row.name} · ${text('lora_slot_missing', 'not in the LoRA folder')}` : row.name;
        const words = element('div', 'lora-slot-words');
        main.append(name, words);

        const weight = element('div', 'lora-slot-weight');
        const slider = element('input', 'lora-slot-slider');
        slider.type = 'range';
        slider.step = '0.05';
        slider.setAttribute('aria-label', text('lora_weight', 'Weight'));
        const ticks = element('div', 'lora-slot-ticks');
        weight.append(slider, ticks);
        const value = element('input', 'lora-slot-value');
        value.type = 'number';
        value.step = '0.05';
        value.setAttribute('aria-label', text('lora_model_strength', 'Model strength'));

        const fold = iconButton('lora-slot-icon lora-slot-fold', text('lora_slot_details', 'Details'), ICONS.down, () => {
            row.open = !row.open;
            this.renderRow(row);
        });
        fold.setAttribute('aria-expanded', String(row.open));
        const remove = iconButton('lora-slot-icon lora-slot-remove', text('lora_remove', 'Remove'), ICONS.close, () => this.removeRow(row));

        // the weight: the slider and the field are the same value (CLIP too while it follows)
        const show = () => {
            const current = strength(row.model);
            const range = globalThis.loraUi?.slotRange?.(row.name) ?? { min: 0, max: 1, ticks: [] };
            const min = Math.min(0, range.min, current);
            const max = Math.max(range.max, current, min + 0.05);
            slider.min = String(min);
            slider.max = String(max);
            slider.value = String(current);
            ticks.replaceChildren(...(range.ticks ?? []).filter(tick => tick >= min && tick <= max).map(tick => {
                const mark = element('span', 'lora-slot-tick');
                mark.style.left = `calc(7px + (100% - 14px) * ${((tick - min) / (max - min)).toFixed(4)})`;
                return mark;
            }));
            if (document.activeElement !== value) value.value = row.model;
        };
        const setModel = (text, { exact = false } = {}) => {
            row.model = exact ? text : formatted(strength(text));
            if (row.linked) row.clip = row.model;
            const clip = row.el?.querySelector('.lora-slot-clip');
            if (clip && document.activeElement !== clip) clip.value = row.clip;
        };
        slider.addEventListener('input', () => {
            setModel(slider.value);
            value.value = row.model;
        });
        value.addEventListener('input', () => {
            if (value.value === '' || !Number.isFinite(Number(value.value))) return;
            setModel(value.value, { exact: true });
            show();
        });
        value.addEventListener('change', () => {
            setModel(value.value === '' ? '0' : value.value);
            value.value = row.model;
            show();
        });
        show();
        line.append(toggle, main, weight, value, fold, remove);
        this.paintWords(row, words);
        return line;
    }

    paintWords(row, holder = row.el?.querySelector('.lora-slot-words')) {
        if (!holder) return;
        holder.replaceChildren();
        if (row.stage !== 'ALL') holder.append(element('span', 'lora-slot-stage', row.stage === 'Base' ? text('lora_stage_base_only', 'Base only') : text('lora_stage_hires_only', 'Hires only')));
        const { words = [], origin = '' } = globalThis.loraUi?.slotWords?.(row.name) ?? {};
        if (origin) holder.append(element('span', 'lora-slot-origin', `tag: ${origin}`));
        for (const { word, on } of words) {
            const chip = element('button', `lora-slot-trigger${on ? ' is-on' : ''}`, on ? `${word} ✓` : `+ ${word}`);
            chip.type = 'button';
            chip.setAttribute('aria-pressed', String(on));
            chip.addEventListener('click', () => globalThis.loraUi?.switchWord?.(word, !on));
            holder.append(chip);
        }
        holder.hidden = holder.childElementCount === 0;
    }

    renderFold(row) {
        const fold = element('div', 'lora-slot-more');

        const stage = element('div', 'lora-slot-field');
        stage.append(element('span', 'lora-slot-label', text('lora_stage', 'Stage')));
        const segment = element('div', 'lora-segment');
        segment.setAttribute('role', 'group');
        for (const [mode, label] of STAGES) {
            const option = element('button', row.stage === mode ? 'is-on' : '', text(`lora_stage_${label.toLowerCase()}`, label));
            option.type = 'button';
            option.setAttribute('aria-pressed', String(row.stage === mode));
            option.addEventListener('click', () => {
                row.stage = mode;
                this.renderRow(row);
            });
            segment.append(option);
        }
        stage.append(segment);

        const clipField = element('div', 'lora-slot-field');
        clipField.append(element('span', 'lora-slot-label', 'CLIP'));
        const clipLine = element('div', 'lora-slot-clip-line');
        const clip = element('input', `lora-slot-value lora-slot-clip${row.linked ? '' : ' is-own'}`);
        clip.type = 'number';
        clip.step = '0.05';
        clip.value = row.clip;
        clip.setAttribute('aria-label', text('lora_clip_strength', 'CLIP strength'));
        // WebUI takes one strength: the CLIP one is ComfyUI's
        clip.disabled = globalThis.generate?.api_interface?.getValue?.() !== 'ComfyUI';
        clip.addEventListener('input', () => {
            if (clip.value === '' || !Number.isFinite(Number(clip.value))) return;
            row.clip = clip.value;
            if (row.linked) {
                row.linked = false;
                clip.classList.add('is-own');
                clipLine.append(relink);
            }
        });
        clip.addEventListener('change', () => {
            row.clip = formatted(strength(clip.value));
            clip.value = row.clip;
        });
        const relink = iconButton('lora-slot-icon lora-slot-relink', text('lora_clip_follow', 'Same as the weight'), ICONS.relink, () => {
            row.linked = true;
            row.clip = row.model;
            this.renderRow(row);
        });
        clipLine.append(clip);
        if (!row.linked) clipLine.append(relink);
        clipField.append(clipLine);

        const range = element('div', 'lora-slot-field');
        const span = globalThis.loraUi?.slotRange?.(row.name);
        range.append(element('span', 'lora-slot-label', text('lora_range', 'Range')), element('span', 'lora-slot-range', span ? `${formatted(span.min)} – ${formatted(span.max)}` : '—'));

        const actions = element('div', 'lora-slot-actions');
        const samples = element('button', 'lora-button lora-slot-samples');
        samples.type = 'button';
        samples.append(icon(ICONS.image), document.createTextNode(text('lora_samples', 'Samples')));
        samples.disabled = !globalThis.loraUi?.hasSamples?.(row.name);
        samples.addEventListener('click', () => globalThis.loraUi?.openSamples?.(row.name));
        actions.append(samples);

        fold.append(stage, clipField, range, actions);
        return fold;
    }

    removeRow(row) {
        this.rows = this.rows.filter(item => item !== row);
        row.el?.remove();
        this.container?.dispatchEvent(new Event('change', { bubbles: true }));
    }

    // ------------------------------------------------------------ the old API

    getSlots() {
        return this.rows.map(row => row.id);
    }

    getValues() {
        return this.rows.map(row => [row.name, row.model, row.linked ? row.model : row.clip, row.on ? row.stage : 'OFF']);
    }

    clear() {
        this.rows = [];
        this.list.replaceChildren();
    }

    /** The rows saved in the settings. */
    flush() {
        this.setRows(globalThis.globalSettings?.lora_slot ?? []);
    }

    /** The rows a prompt's LoRA tags name (the image info's Send, the right-click menu). */
    flushSlot(loraString) {
        this.setRows(rowsFromLoraTags(loraString));
    }

    /** The same rows again (the LoRA list, the language or the backend changed). */
    reload() {
        this.setRows(this.getValues());
    }
}

export function setupLoRA(containerID) {
    if (!instanceSlotManager) {
        instanceSlotManager = new SlotManager(containerID);
    }
    return instanceSlotManager;
}
