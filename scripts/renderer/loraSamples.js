// The samples of a LoRA (loraUi.js): queueing them like the Parts' samples
// (generate.attachPartsSampleJob: six images on the current model, behind the user's own
// jobs), the viewer that shows them - all six side by side when it opens, one large once
// one is picked - and the Retake dialog where the prompt they are made with is written,
// for this LoRA alone or as the default every LoRA without its own shares.

import { LORA_CHANGED_EVENT, addLoraSample, changeLora, loraCatalog, loraEntry, loraSampleImage } from './loraClient.js';
import {
    DEFAULT_SAMPLE_BODY, LORA_SAMPLE_GENERATION, LORA_SAMPLE_SEED, LORA_SAMPLE_SIZE, LORA_WORDS_TOKEN,
    cleanSamplePrompt, expandLoraWords, loraSamplePrompt, loraWords, promptTags, resolveSamplePrompt, sampleNegative, sampleWeights, samplesForModel,
} from '../shared/loraCatalog.js';
import { attachPartsSampleJob, partsSampleQueued } from './generate.js';
import { openTagPicker } from './tagSelectionModal.js';
import { iconElement } from '../shared/iconSet.js';

function lang() {
    const settings = globalThis.globalSettings ?? {};
    return globalThis.cachedFiles?.language?.[settings.language] ?? {};
}

export function text(key, fallback) {
    const value = lang()[key];
    return typeof value === 'string' && value ? value : fallback;
}

export function element(tag, className, content) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (content !== undefined && content !== null) node.textContent = String(content);
    return node;
}

export function button(className, label, onClick) {
    const node = element('button', className, label);
    node.type = 'button';
    node.addEventListener('click', event => {
        event.stopPropagation();
        onClick(event);
    });
    return node;
}

export function number(value) {
    return Number.isFinite(value) ? String(Math.round(value * 100) / 100) : '—';
}

export function modelType() {
    return globalThis.globalSettings?.api_model_type === 'Diffusion' ? 'Diffusion' : 'Checkpoint';
}

export function currentModel() {
    return String(globalThis.dropdownList?.model?.getValue?.() ?? '');
}

export function comfyInterface() {
    return globalThis.generate?.api_interface?.getValue?.() === 'ComfyUI';
}

/** An icon of the set (scripts/shared/iconSet.js), for the icon-only buttons. */
export function icon(name, size = 16) {
    return iconElement(name, size);
}

/** Whether a LoRA has a sample of any model to show. */
export function hasSamples(name) {
    return samplesForModel(loraEntry(name), currentModel()).samples.size > 0;
}

// ------------------------------------------------------------------ queueing

/** Queues the six sample images of a LoRA on the current model; false when it cannot. */
export function queueLoraSamples(name) {
    const entry = loraEntry(name);
    if (!entry || !comfyInterface()) return false;
    const type = modelType();
    const model = currentModel();
    const generation = LORA_SAMPLE_GENERATION[type];
    const prompt = resolveSamplePrompt({ entry, template: loraCatalog().samplePrompt, modelType: type });
    for (const weight of sampleWeights(entry.range)) {
        const key = `lora:${entry.name}:${weight}:${model}`;
        if (partsSampleQueued(key)) continue;
        const { positive, negative, seed } = loraSamplePrompt({ modelType: type, name: entry.name, weight, prompt });
        attachPartsSampleJob({
            label: `LoRA ${entry.label} · ${weight === 0 ? 'off' : number(weight)}`,
            key,
            positive,
            negative,
            seed,
            width: LORA_SAMPLE_SIZE.width,
            height: LORA_SAMPLE_SIZE.height,
            ...generation,
            prefix: 'lora-samples/%date',
            onImage: image => addLoraSample(entry.name, { weight, model, modelType: type, positive, negative, seed }, image),
        });
    }
    return true;
}

// ------------------------------------------------------------------ overlays

// the viewer and the dialog sit above the tag modal and the chip popover; Escape and the
// arrows are theirs while they are open (a capture listener, ahead of the modal's own)
function overlayFrame(className, label, onKey) {
    const overlay = element('div', className);
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-label', label);
    // a modal opened from inside (the tag search) comes later in the body and is on top:
    // its keys are its own
    const covered = () => [...document.querySelectorAll('.selection-modal')]
        .some(modal => !modal.hidden && overlay.compareDocumentPosition(modal) & 4); // Node.DOCUMENT_POSITION_FOLLOWING
    const keydown = event => {
        if (!overlay.isConnected || event.isComposing || covered()) return;
        if (onKey(event)) {
            event.preventDefault();
            event.stopPropagation();
        }
    };
    document.addEventListener('keydown', keydown, true);
    document.body.append(overlay);
    return {
        overlay,
        remove: () => {
            document.removeEventListener('keydown', keydown, true);
            overlay.remove();
        },
    };
}

/** Whether a node is inside the sample viewer or the Retake dialog (the chip popover stays open for them). */
export function insideSampleOverlay(node) {
    return Boolean(node?.closest?.('.lora-viewer, .lora-retake'));
}

function settingsLine(sample, type) {
    const generation = LORA_SAMPLE_GENERATION[sample?.modelType ?? type] ?? LORA_SAMPLE_GENERATION.Checkpoint;
    const seed = sample?.seed ?? resolveSamplePrompt({ template: loraCatalog().samplePrompt, modelType: type }).seed;
    return `seed ${seed} · ${LORA_SAMPLE_SIZE.width}×${LORA_SAMPLE_SIZE.height} · ${generation.steps} steps · CFG ${generation.cfg} · ${generation.sampler}`;
}

// the prompt without the LoRA line under it
function basePrompt(positive) {
    return String(positive ?? '').split('\n')[0];
}

// ------------------------------------------------------------------ the viewer

let viewer = null;

export function closeSampleViewer() {
    viewer?.close();
    viewer = null;
}

/**
 * The samples of a LoRA, large: all six side by side, then the one picked alone with the
 * prompt it was made with, ‹ › and the strip to move on, "Make default" and Retake.
 */
export function openSampleViewer(name) {
    closeSampleViewer();
    const first = loraEntry(name);
    if (!first) return null;
    const state = { mode: 'all', index: 0 };
    const frame = overlayFrame('lora-viewer', text('lora_samples', 'Samples'), event => {
        if (event.key === 'Escape') {
            if (state.mode === 'one') show('all'); else closeSampleViewer();
            return true;
        }
        if (state.mode === 'one' && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
            step(event.key === 'ArrowRight' ? 1 : -1);
            return true;
        }
        return false;
    });
    const { overlay } = frame;
    overlay.addEventListener('click', event => { if (event.target === overlay) closeSampleViewer(); });
    const box = element('div', 'lora-viewer-box');
    overlay.append(box);

    const cells = () => {
        const entry = loraEntry(name) ?? first;
        const { samples } = samplesForModel(entry, currentModel());
        return sampleWeights(entry.range).map(weight => ({ weight, sample: samples.get(weight) ?? null, isDefault: weight > 0 && weight === entry.range.def }));
    };
    const image = (sample, className) => {
        const node = element('img', className);
        node.alt = '';
        if (sample) loraSampleImage(name, sample.id).then(dataUrl => { if (dataUrl && node.isConnected) node.src = dataUrl; });
        return node;
    };
    const weightLabel = weight => (weight === 0 ? 'off' : number(weight));
    const show = mode => { state.mode = mode; paint(); };
    const step = delta => {
        const count = cells().length;
        state.index = (state.index + delta + count) % count;
        paint();
    };

    function header(entry) {
        const head = element('div', 'lora-viewer-head');
        if (state.mode === 'one') {
            const back = button('lora-viewer-round lora-viewer-back', '', () => show('all'));
            back.append(icon('arrow-left'));
            back.setAttribute('aria-label', text('lora_samples_all', 'All samples'));
            head.append(back);
        }
        head.append(element('span', 'lora-viewer-name', entry.label), element('span', 'lora-viewer-model', currentModel()));
        head.append(element('span', 'lora-spacer'));
        const close = button('lora-viewer-round', '', () => closeSampleViewer());
        close.append(icon('close', 14));
        close.setAttribute('aria-label', text('tag_ui_close', 'Close'));
        head.append(close);
        return head;
    }

    function promptBox(positive, className = '') {
        const node = element('div', `lora-viewer-prompt ${className}`.trim());
        const [base, ...rest] = String(positive ?? '').split('\n');
        node.append(document.createTextNode(base));
        if (rest.length) node.append(element('span', 'lora-viewer-prompt-tag', rest.join('\n')));
        return node;
    }

    function computed(weight) {
        const entry = loraEntry(name) ?? first;
        const type = modelType();
        const prompt = resolveSamplePrompt({ entry, template: loraCatalog().samplePrompt, modelType: type });
        return loraSamplePrompt({ modelType: type, name: entry.name, weight, prompt }).positive;
    }

    function paintAll(entry) {
        const list = cells();
        const row = element('div', 'lora-viewer-all');
        list.forEach((cell, index) => {
            const card = element('div', 'lora-viewer-card');
            const pick = button(`lora-viewer-big${cell.isDefault ? ' is-default' : ''}${cell.sample ? '' : ' is-empty'}`, '', () => {
                state.index = index;
                show('one');
            });
            pick.setAttribute('aria-label', `${text('lora_weight', 'Weight')} ${weightLabel(cell.weight)}`);
            pick.disabled = !cell.sample;
            pick.append(image(cell.sample, 'lora-viewer-image'));
            card.append(pick, element('span', 'lora-viewer-card-weight', weightLabel(cell.weight)));
            row.append(card);
        });
        const shown = list.find(cell => cell.sample?.positive)?.sample ?? list.find(cell => cell.sample)?.sample ?? null;
        const strip = element('div', 'lora-viewer-strip');
        strip.append(element('span', 'lora-viewer-label', text('lora_prompt', 'Prompt')));
        strip.append(promptBox(shown?.positive ? basePrompt(shown.positive) : basePrompt(computed(0)), 'is-flat'));
        strip.append(element('span', 'lora-viewer-settings', settingsLine(shown, modelType())));
        box.append(header(entry), row, strip);
    }

    function paintOne(entry) {
        const list = cells();
        state.index = Math.min(state.index, list.length - 1);
        const cell = list[state.index];
        const main = element('div', 'lora-viewer-one');
        const prev = button('lora-viewer-round lora-viewer-step', '', () => step(-1));
        prev.append(icon('chevron-left', 18));
        prev.setAttribute('aria-label', text('lora_weight_lower', 'Lower weight'));
        const next = button('lora-viewer-round lora-viewer-step', '', () => step(1));
        next.append(icon('chevron-right', 18));
        next.setAttribute('aria-label', text('lora_weight_higher', 'Higher weight'));
        const frameBox = element('div', 'lora-viewer-large');
        frameBox.append(image(cell.sample, 'lora-viewer-image'));
        const info = element('div', 'lora-viewer-info');
        const head = element('div', 'lora-viewer-weight');
        head.append(element('span', 'lora-viewer-weight-value', weightLabel(cell.weight)));
        if (cell.isDefault) head.append(element('span', 'lora-viewer-pill', text('lora_default', 'Default')));
        info.append(head);
        const prompt = element('div', 'lora-viewer-section');
        prompt.append(element('span', 'lora-viewer-label', text('lora_prompt', 'Prompt')));
        prompt.append(promptBox(cell.sample?.positive ?? computed(cell.weight)));
        prompt.append(element('span', 'lora-viewer-settings', settingsLine(cell.sample, modelType())));
        info.append(prompt);
        const actions = element('div', 'lora-viewer-actions');
        const makeDefault = button('viewer-primary-button', text('lora_make_default', 'Make default'), () => {
            const range = { ...entry.range, def: cell.weight };
            changeLora({ action: 'set', name: entry.name, patch: { range } });
        });
        makeDefault.disabled = cell.weight <= 0 || cell.isDefault || cell.weight < entry.range.min || cell.weight > entry.range.max;
        const retake = button('lora-button lora-viewer-retake', text('lora_retake', 'Retake'), () => openRetakeDialog(entry.name));
        retake.disabled = !comfyInterface();
        actions.append(makeDefault, retake);
        info.append(actions);
        main.append(prev, frameBox, next, info);

        const film = element('div', 'lora-viewer-film');
        list.forEach((item, index) => {
            const thumb = button(`lora-viewer-thumb${index === state.index ? ' is-on' : ''}`, '', () => { state.index = index; paint(); });
            thumb.setAttribute('aria-label', `${text('lora_weight', 'Weight')} ${weightLabel(item.weight)}`);
            thumb.setAttribute('aria-pressed', String(index === state.index));
            thumb.append(image(item.sample, 'lora-viewer-image'), element('span', 'lora-cell-weight', weightLabel(item.weight)));
            film.append(thumb);
        });
        box.append(header(entry), main, film);
    }

    function paint() {
        const entry = loraEntry(name) ?? first;
        box.replaceChildren();
        box.classList.toggle('is-one', state.mode === 'one');
        if (state.mode === 'one') paintOne(entry); else paintAll(entry);
    }

    // new samples (a retake) and a new default come in while it is open
    const repaint = () => { if (overlay.isConnected) paint(); };
    document.addEventListener(LORA_CHANGED_EVENT, repaint);
    viewer = {
        close: () => {
            document.removeEventListener(LORA_CHANGED_EVENT, repaint);
            frame.remove();
        },
    };
    paint();
    return viewer;
}

// ------------------------------------------------------------------ the Retake dialog

const sameDraft = (a, b) => a.tags.join(', ') === b.tags.join(', ') && a.negative === b.negative && a.seed === b.seed;
const samePrompt = (a, b) => (a === null || b === null ? a === b : a.body === b.body && (a.negative ?? null) === (b.negative ?? null) && (a.seed ?? null) === (b.seed ?? null));
const asPrompt = draft => ({ body: draft.tags.join(', '), negative: draft.negative, seed: draft.seed });

let retake = null;

export function closeRetakeDialog() {
    retake?.remove();
    retake = null;
}

/**
 * The prompt a LoRA's samples are made with, written before they are taken: This LoRA
 * (its own) or Default for all (the template, `{lora}` = each LoRA's words), the quality
 * words of the model type fixed in front, the negative folded, the seed; "Take samples"
 * keeps what changed and queues the six images.
 */
export function openRetakeDialog(name) {
    closeRetakeDialog();
    const entry = loraEntry(name);
    if (!entry) return null;
    const type = modelType();
    const words = loraWords(entry);
    const builtIn = { tags: promptTags(DEFAULT_SAMPLE_BODY), negative: sampleNegative(type), seed: LORA_SAMPLE_SEED };
    const storedTemplate = cleanSamplePrompt(loraCatalog().samplePrompt);
    const storedOwn = cleanSamplePrompt(entry.samplePrompt);
    const drafts = {
        all: storedTemplate
            ? { tags: promptTags(storedTemplate.body), negative: storedTemplate.negative ?? builtIn.negative, seed: storedTemplate.seed ?? builtIn.seed }
            : { ...builtIn, tags: [...builtIn.tags] },
    };
    const expanded = draft => ({ tags: promptTags(expandLoraWords(draft.tags.join(', '), words)), negative: draft.negative, seed: draft.seed });
    drafts.lora = storedOwn
        ? { tags: promptTags(expandLoraWords(storedOwn.body, words)), negative: storedOwn.negative ?? drafts.all.negative, seed: storedOwn.seed ?? drafts.all.seed }
        : expanded(drafts.all);
    // loraTouched: this LoRA's prompt was written here (else it follows the default's edits)
    const state = { scope: 'lora', negativeOpen: false, loraTouched: Boolean(storedOwn) };
    const touched = () => { if (state.scope === 'lora') state.loraTouched = true; };

    const frame = overlayFrame('lora-retake', text('lora_retake', 'Retake'), event => {
        if (event.key === 'Escape') {
            closeRetakeDialog();
            return true;
        }
        return false;
    });
    retake = frame;
    const { overlay } = frame;
    overlay.addEventListener('click', event => { if (event.target === overlay) closeRetakeDialog(); });
    const dialog = element('div', 'lora-retake-dialog');
    overlay.append(dialog);

    const head = element('div', 'lora-retake-head');
    const hasAny = samplesForModel(entry, currentModel()).samples.size > 0;
    head.append(element('span', 'lora-retake-title', hasAny ? text('lora_retake', 'Retake') : text('lora_take_samples', 'Take samples')), element('span', 'lora-retake-name', entry.label));
    const close = button('lora-viewer-round', '', () => closeRetakeDialog());
    close.append(icon('close', 14));
    close.setAttribute('aria-label', text('tag_ui_close', 'Close'));
    head.append(close);

    const body = element('div', 'lora-retake-body');
    const scopes = element('div', 'lora-segment lora-retake-scope');
    scopes.setAttribute('role', 'group');
    const chips = element('div', 'lora-retake-chips');
    const add = element('input', 'lora-retake-add');
    add.type = 'text';
    add.placeholder = text('lora_add_tag_placeholder', '+ Tag');
    add.setAttribute('aria-label', text('lora_add_tag', 'Add tag'));
    const tools = element('div', 'lora-retake-tools');
    const seedLabel = element('label', 'lora-retake-seed');
    const seed = element('input', 'lora-range-input');
    seed.type = 'number';
    seed.min = '0';
    seed.step = '1';
    seedLabel.append(element('span', 'lora-panel-label', 'Seed'), seed);
    const negativeToggle = element('button', 'lora-retake-negative-toggle');
    negativeToggle.type = 'button';
    const negative = element('textarea', 'lora-retake-negative');
    negative.rows = 3;
    negative.setAttribute('aria-label', text('lora_negative', 'Negative'));
    const searchButton = onClick => {
        const search = button('lora-retake-search', '', () => onClick(search));
        search.append(icon('search', 14));
        search.title = text('lora_search_tags', 'Search tags');
        search.setAttribute('aria-label', search.title);
        return search;
    };
    // the tag search of the prompt rows (Choose tags): the tags picked join the chips, by
    // way of a textarea the modal writes into
    const searchTags = searchButton(trigger => {
        const proxy = document.createElement('textarea');
        proxy.value = draft().tags.filter(tag => tag !== LORA_WORDS_TOKEN).join(', ');
        proxy.addEventListener('input', () => addTags(proxy.value));
        openTagPicker(proxy, { favGroup: 'positive', trigger });
    });
    // and on the negative, which it writes into as it does into a prompt row
    const searchNegative = searchButton(trigger => {
        if (!state.negativeOpen) {
            state.negativeOpen = true;
            paintNegative();
        }
        negative.setSelectionRange(negative.value.length, negative.value.length);
        openTagPicker(negative, { favGroup: 'negative', trigger });
    });
    const negativeHead = element('div', 'lora-retake-negative-head');
    negativeHead.append(negativeToggle, searchNegative);

    const draft = () => drafts[state.scope];
    const isWord = tag => tag === LORA_WORDS_TOKEN || words.includes(tag);

    function paintScopes() {
        scopes.replaceChildren();
        for (const [id, label] of [['lora', text('lora_scope_this', 'This LoRA')], ['all', text('lora_scope_all', 'Default for all')]]) {
            const on = state.scope === id;
            const option = button(on ? 'is-on' : '', label, () => {
                state.scope = id;
                // the default changed under this LoRA's untouched prompt: it follows
                if (id === 'lora' && !state.loraTouched) drafts.lora = expanded(drafts.all);
                paint();
            });
            option.setAttribute('aria-pressed', String(on));
            scopes.append(option);
        }
    }

    function paintChips() {
        chips.replaceChildren();
        chips.append(element('span', 'lora-retake-chip is-fixed', `Quality · ${type === 'Diffusion' ? 'Anima' : 'Illustrious'}`));
        draft().tags.forEach((tag, index) => {
            const chip = element('span', `lora-retake-chip${isWord(tag) ? ' is-lora' : ''}`, tag === LORA_WORDS_TOKEN ? text('lora_words', 'LoRA words') : tag);
            const remove = button('lora-retake-chip-remove', '×', () => {
                draft().tags.splice(index, 1);
                touched();
                paintChips();
            });
            remove.setAttribute('aria-label', `${text('lora_remove', 'Remove')} ${tag}`);
            chip.append(remove);
            chips.append(chip);
        });
        chips.append(add, searchTags);
    }

    function paintNegative() {
        negativeToggle.replaceChildren(icon(state.negativeOpen ? 'chevron-down' : 'chevron-right', 12), element('span', 'lora-retake-negative-label', text('lora_negative', 'Negative')));
        if (!state.negativeOpen) negativeToggle.append(element('span', 'lora-retake-negative-preview', draft().negative));
        negativeToggle.setAttribute('aria-expanded', String(state.negativeOpen));
        negative.hidden = !state.negativeOpen;
        negative.value = draft().negative;
    }

    function paint() {
        paintScopes();
        paintChips();
        seed.value = String(draft().seed);
        paintNegative();
        reset.disabled = sameDraft(draft(), state.scope === 'all' ? builtIn : expanded(drafts.all));
    }

    const addTags = value => {
        const tags = promptTags(value);
        if (tags.length === 0) return;
        for (const tag of tags) if (!draft().tags.includes(tag)) draft().tags.push(tag);
        touched();
        paintChips();
        add.focus();
    };
    add.addEventListener('keydown', event => {
        if (event.isComposing) return;
        if (event.key === 'Enter' || event.key === ',') {
            event.preventDefault();
            const value = add.value;
            add.value = '';
            addTags(value);
        } else if (event.key === 'Backspace' && add.value === '' && draft().tags.length > 0) {
            draft().tags.pop();
            touched();
            paintChips();
            add.focus();
        }
    });
    add.addEventListener('blur', () => {
        if (!add.value.trim()) return;
        const value = add.value;
        add.value = '';
        addTags(value);
    });
    seed.addEventListener('change', () => {
        const value = Number(seed.value);
        if (Number.isInteger(value) && value >= 0) {
            draft().seed = value;
            touched();
        } else {
            seed.value = String(draft().seed);
        }
        paint();
    });
    negative.addEventListener('input', () => {
        draft().negative = negative.value.trim();
        touched();
    });
    negativeToggle.addEventListener('click', () => {
        state.negativeOpen = !state.negativeOpen;
        paintNegative();
        if (state.negativeOpen) negative.focus();
    });

    const fromPrompt = button('lora-button', text('lora_current_prompt', 'Current prompt'), () => {
        const tags = promptTags(globalThis.loraUi?.currentPromptText?.() ?? '');
        if (tags.length === 0) return;
        const needed = state.scope === 'all' ? [LORA_WORDS_TOKEN] : words;
        draft().tags = [...tags, ...needed.filter(word => !tags.includes(word))];
        touched();
        paint();
    });
    const reset = button('lora-button', text('lora_reset', 'Reset'), () => {
        drafts[state.scope] = state.scope === 'all' ? { ...builtIn, tags: [...builtIn.tags] } : expanded(drafts.all);
        if (state.scope === 'lora') state.loraTouched = false;
        paint();
    });
    tools.append(fromPrompt, reset, element('span', 'lora-spacer'), seedLabel);
    body.append(scopes, chips, tools, negativeHead, negative);

    const foot = element('div', 'lora-retake-foot');
    const cancel = button('selection-modal-cancel', text('tag_ui_cancel', 'Cancel'), () => closeRetakeDialog());
    const take = button('selection-modal-apply', text('lora_take_samples', 'Take samples'), async () => {
        take.disabled = true;
        const templatePrompt = sameDraft(drafts.all, builtIn) ? null : asPrompt(drafts.all);
        if (!samePrompt(templatePrompt, storedTemplate)) await changeLora({ action: 'sample-template', patch: templatePrompt });
        // a prompt the same as the default's (with this LoRA's words) follows the default
        const ownPrompt = sameDraft(drafts.lora, expanded(drafts.all)) ? null : asPrompt(drafts.lora);
        if (!samePrompt(ownPrompt, storedOwn)) await changeLora({ action: 'set', name: entry.name, patch: { samplePrompt: ownPrompt } });
        closeRetakeDialog();
        queueLoraSamples(entry.name);
    });
    take.disabled = !comfyInterface();
    foot.append(cancel, take);
    dialog.append(head, body, foot);
    paint();
    requestAnimationFrame(() => add.focus());
    return frame;
}
