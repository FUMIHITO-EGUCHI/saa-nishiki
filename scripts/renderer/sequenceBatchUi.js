// The Sequence dialog (docs/sequence-batch-plan.md): page 1 "Sequence" holds what is saved
// (the scene field and the ordered scenes, as thumbnail tiles), page 2 "Run" what is not
// (the characters, the candidates) and Generate. The edit mode in the usual screen is
// sequenceEdit.js; the pure parts are scripts/shared/sequenceBatch.js.
import { createDialogShell } from './components/dialogShell.js';
import { showDialog } from './components/myDialog.js';
import { element, iconButton } from './dom.js';
import { iconElement } from '../shared/iconSet.js';
import { callback_generate_start } from './callbacks.js';
import { createControlNet, generateRandomSeed } from './generate.js';
import { getLocalizedCharacterName } from './characterLocalization.js';
import { decodeThumb } from './customThumbGallery.js';
import { normalizeSelectionKey } from './components/selectionModalLogic.js';
import { isOriginalKey, originalCharacterName, originalKey } from '../shared/characterKeys.js';
import { isFieldMuted, normalizeCustomFields } from '../shared/promptFieldOrder.js';
import { castEnabled, isDiffusionFieldId } from '../shared/castMembers.js';
import {
    MAX_CANDIDATES, expandSequenceRows, makeSceneId, moveScene, normalizeSequence, normalizeSequenceDocument,
    pickRandomCharacters, sequenceRunId, sequenceStartBlockers,
} from '../shared/sequenceBatch.js';

const CAT = '[SequenceBatch]';
const BUILTIN_FIELD_LABELS = { views: 'View', background: 'Background', style: 'Style' };
const BLOCKER_TEXT = {
    'no-characters': ['seq_block_no_characters', 'No characters'],
    'no-scenes': ['seq_block_no_scenes', 'No scenes'],
    'empty-scene': ['seq_block_empty_scene', 'Empty scene'],
    'no-field': ['seq_block_no_field', 'Field missing'],
    'field-muted': ['seq_block_field_muted', 'Field muted'],
    regional: ['seq_block_regional', 'Regional on'],
    controlnet: ['seq_block_controlnet', 'ControlNet on'],
    webui: ['seq_block_webui', 'WebUI'],
    diffusion: ['seq_block_diffusion', 'Anima (Diffusion)'],
};

function text(key, fallback) {
    const value = globalThis.cachedFiles?.language?.[globalThis.globalSettings?.language]?.[key];
    return typeof value === 'string' && value ? value : fallback;
}

const clone = value => JSON.parse(JSON.stringify(value));

// ------------------------------------------------------------------ state

let doc = normalizeSequenceDocument(null);   // settings/sequences.json
let selected = [];                             // the picked character keys, this session only
let page = 'scenes';
let query = '';
let saveTimer = null;
const listeners = new Set();

export function sequenceDoc() {
    return doc;
}

/** The sequence the dialog has open: { name, field, scenes }. */
export function currentSequence() {
    return doc.current;
}

/** Change the open sequence (unsaved until the save button) and write the store soon. */
export function updateCurrent(mutate) {
    const next = clone(doc.current);
    mutate(next);
    doc.current = { name: next.name, ...normalizeSequence(next) };
    persistSoon();
    notify();
}

export function setEditBackup(backup) {
    doc.editBackup = backup ? { fieldKey: backup.fieldKey, text: String(backup.text ?? '') } : null;
    persistNow();
}

export function onSequenceChange(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

function notify() {
    for (const listener of listeners) {
        try { listener(doc); } catch (error) { console.error(CAT, 'listener failed', error); }
    }
    if (shell?.isOpen()) render();
}

function persistSoon() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(persistNow, 400);
}

function persistNow() {
    clearTimeout(saveTimer);
    saveTimer = null;
    const api = globalThis.api;
    if (!api?.sequencesSave) return;
    Promise.resolve(api.sequencesSave(doc)).catch(error => console.error(CAT, 'save failed', error));
}

function batchSettings() {
    const stored = globalThis.globalSettings?.sequence_run ?? {};
    const count = Math.max(1, Math.floor(Number(stored.count) || 3));
    const candidates = Math.max(1, Math.min(MAX_CANDIDATES, Math.floor(Number(stored.candidates) || 1)));
    return { count, candidates };
}

function setBatchSettings(patch) {
    globalThis.globalSettings.sequence_run = { ...batchSettings(), ...patch };
}

// ------------------------------------------------------------------ characters

/** The favorites as pickable characters: [{ key, label, original }], unknown names left out. */
export function favoritePool() {
    const FILES = globalThis.cachedFiles ?? {};
    const SETTINGS = globalThis.globalSettings ?? {};
    const known = new Map();
    for (const key of Object.keys(FILES.characterList ?? {})) known.set(normalizeSelectionKey(key), key);
    for (const name of Object.keys(FILES.ocList ?? {})) known.set(normalizeSelectionKey(originalKey(name)), originalKey(name));
    const pool = [];
    const seen = new Set();
    for (const entry of Array.isArray(SETTINGS.fav_characters) ? SETTINGS.fav_characters : []) {
        const key = known.get(normalizeSelectionKey(entry));
        if (!key || seen.has(key)) continue;
        seen.add(key);
        pool.push({ key, label: characterLabel(key), original: isOriginalKey(key) });
    }
    return pool;
}

export function characterLabel(key) {
    const FILES = globalThis.cachedFiles ?? {};
    if (isOriginalKey(key)) return originalCharacterName(key);
    return getLocalizedCharacterName({
        key, tag: FILES.characterList?.[key] ?? '', language: globalThis.globalSettings?.language, characterNames: FILES.characterNames,
    }) || key;
}

const thumbCache = new Map();
function paintAvatar(node, key, label) {
    node.textContent = String(label ?? '?').trim().charAt(0).toUpperCase();
    if (isOriginalKey(key)) return;
    const cached = thumbCache.get(key);
    const apply = url => { if (url) { node.textContent = ''; node.style.backgroundImage = `url("${url}")`; } };
    if (cached !== undefined) { apply(cached); return; }
    decodeThumb(key).then(url => { thumbCache.set(key, url ?? null); apply(url); }).catch(() => thumbCache.set(key, null));
}

// ------------------------------------------------------------------ fields

/** The prompt fields a scene can hold: View, Background, Style and the positive custom fields. */
export function sceneFieldOptions() {
    const SETTINGS = globalThis.globalSettings ?? {};
    const cast = castEnabled(SETTINGS);
    const options = Object.entries(BUILTIN_FIELD_LABELS).map(([key, label]) => ({ key, label }));
    for (const field of normalizeCustomFields(SETTINGS.prompt_custom_fields)) {
        if (field.polarity === 'negative') continue;
        if (!cast && isDiffusionFieldId(field.id)) continue;
        options.push({ key: field.id, label: field.name || field.id });
    }
    return options;
}

export function sceneFieldLabel(fieldKey) {
    return sceneFieldOptions().find(option => option.key === fieldKey)?.label ?? fieldKey;
}

// ------------------------------------------------------------------ the dialog

let shell = null;
let ui = null;

function build() {
    shell = createDialogShell({ className: 'sequence-dialog' });
    const { body, footer } = shell;
    shell.dialog.classList.add('sequence-dialog-frame');

    // page 1: the saved sequence
    const scenesPage = element('section', 'sequence-page sequence-page-scenes');
    const toolbar = element('div', 'sequence-toolbar');
    const nameSelect = element('select', 'sequence-select');
    nameSelect.setAttribute('aria-label', 'Sequence');
    const saveButton = iconButton('save', text('seq_save', 'Save sequence'), { size: 26 });
    const deleteButton = iconButton('trash', text('seq_delete', 'Delete sequence'), { size: 26 });
    const sep = element('span', 'sequence-toolbar-sep');
    const fieldLabel = element('label', 'sequence-label', text('seq_field', 'Field'));
    const fieldSelect = element('select', 'sequence-select is-field');
    fieldSelect.id = 'sequence-field-select';
    fieldLabel.htmlFor = fieldSelect.id;
    const count = element('span', 'sequence-count');
    toolbar.append(nameSelect, saveButton, deleteButton, sep, fieldLabel, fieldSelect, element('span', 'sequence-fill'), count);
    const grid = element('div', 'sequence-grid');
    const gridScroll = element('div', 'sequence-grid-scroll');
    gridScroll.append(grid);
    scenesPage.append(toolbar, gridScroll);

    // page 2: the run
    const runPage = element('section', 'sequence-page sequence-page-run');
    const runHead = element('div', 'sequence-run-head');
    const runTitle = element('span', 'sequence-run-title', text('seq_characters', 'Characters'));
    const runContext = element('span', 'sequence-run-context');
    runHead.append(runTitle, element('span', 'sequence-fill'), runContext);
    const columns = element('div', 'sequence-columns');
    const left = element('div', 'sequence-column');
    const search = element('input', 'sequence-search');
    search.type = 'search';
    search.placeholder = text('seq_search', 'Search favorites');
    search.setAttribute('aria-label', search.placeholder);
    const poolList = element('div', 'sequence-list');
    const leftFoot = element('div', 'sequence-column-foot');
    const addAll = element('button', 'sequence-button', text('seq_add_all', 'Add all'));
    addAll.type = 'button';
    const randomButton = element('button', 'sequence-button');
    randomButton.type = 'button';
    randomButton.append(iconElement('dice', 14), element('span', '', text('seq_random', 'Random')));
    const randomCount = element('input', 'sequence-number');
    randomCount.type = 'number';
    randomCount.min = '1';
    randomCount.setAttribute('aria-label', text('seq_random_count', 'How many'));
    leftFoot.append(addAll, randomButton, randomCount);
    left.append(search, poolList, leftFoot);
    const right = element('div', 'sequence-column is-chosen');
    const rightHead = element('div', 'sequence-column-head');
    const chosenTitle = element('span', 'sequence-run-title', text('seq_selected', 'Selected'));
    const chosenCount = element('span', 'sequence-count');
    rightHead.append(chosenTitle, chosenCount);
    const chosenList = element('div', 'sequence-list');
    const rightFoot = element('div', 'sequence-column-foot');
    const clearButton = element('button', 'sequence-button', text('seq_clear', 'Clear'));
    clearButton.type = 'button';
    rightFoot.append(element('span', 'sequence-fill'), clearButton);
    right.append(rightHead, chosenList, rightFoot);
    columns.append(left, right);
    runPage.append(runHead, columns);
    body.classList.add('sequence-body');
    body.append(scenesPage, runPage);

    // footer
    const leftButton = element('button', 'selection-modal-cancel');
    leftButton.type = 'button';
    const rightGroup = element('div', 'sequence-foot-actions');
    const blockers = element('div', 'sequence-blockers');
    const candidatesLabel = element('label', 'sequence-label', text('seq_candidates', 'Candidates'));
    const candidates = element('input', 'sequence-number');
    candidates.type = 'number';
    candidates.min = '1';
    candidates.max = String(MAX_CANDIDATES);
    candidates.id = 'sequence-candidates';
    candidatesLabel.htmlFor = candidates.id;
    const nextButton = element('button', 'selection-modal-apply', text('seq_next', 'Next'));
    nextButton.type = 'button';
    const generateButton = element('button', 'selection-modal-apply sequence-generate');
    generateButton.type = 'button';
    rightGroup.append(blockers, candidatesLabel, candidates, nextButton, generateButton);
    footer.classList.add('sequence-footer');
    footer.append(leftButton, rightGroup);

    ui = {
        scenesPage, runPage, nameSelect, saveButton, deleteButton, fieldSelect, count, grid, runContext,
        search, poolList, addAll, randomButton, randomCount, chosenList, chosenCount, clearButton,
        leftButton, blockers, candidatesLabel, candidates, nextButton, generateButton,
    };

    nameSelect.addEventListener('change', () => loadNamed(nameSelect.value));
    saveButton.addEventListener('click', saveNamed);
    deleteButton.addEventListener('click', deleteNamed);
    fieldSelect.addEventListener('change', () => updateCurrent(current => { current.field = fieldSelect.value; }));
    search.addEventListener('input', () => { query = search.value; renderPool(); });
    addAll.addEventListener('click', () => { selected = favoritePool().map(entry => entry.key); render(); });
    randomButton.addEventListener('click', () => {
        selected = pickRandomCharacters(favoritePool().map(entry => entry.key), batchSettings().count, cryptoRandom);
        render();
    });
    randomCount.addEventListener('change', () => {
        const value = Math.max(1, Math.floor(Number(randomCount.value) || 1));
        setBatchSettings({ count: value });
        randomCount.value = String(value);
    });
    clearButton.addEventListener('click', () => { selected = []; render(); });
    candidates.addEventListener('change', () => {
        const value = Math.max(1, Math.min(MAX_CANDIDATES, Math.floor(Number(candidates.value) || 1)));
        setBatchSettings({ candidates: value });
        candidates.value = String(value);
        renderFooter();
    });
    leftButton.addEventListener('click', () => {
        if (page === 'run') { page = 'scenes'; render(); return; }
        if (globalThis.sequenceEdit?.isActive?.()) { Promise.resolve(globalThis.sequenceEdit.exit()).then(render); return; }
        shell.close();
    });
    nextButton.addEventListener('click', () => { page = 'run'; render(); });
    generateButton.addEventListener('click', startRun);
}

function cryptoRandom() {
    const values = new Uint32Array(1);
    crypto.getRandomValues(values);
    return values[0] / 4294967296;
}

function savedNames() {
    return Object.keys(doc.sequences).sort((a, b) => a.localeCompare(b));
}

function isDirty() {
    const name = doc.current.name;
    if (!name || !doc.sequences[name]) return doc.current.scenes.length > 0;
    return JSON.stringify(normalizeSequence(doc.current)) !== JSON.stringify(normalizeSequence(doc.sequences[name]));
}

async function loadNamed(name) {
    if (name === doc.current.name) return;
    if (isDirty()) {
        const ok = await showDialog('confirm', {
            message: text('seq_discard', 'Discard the changes to "{0}"?').replace('{0}', doc.current.name || text('seq_unsaved', 'Unsaved')),
            yesText: text('seq_discard_yes', 'Discard'), noText: text('setup_no', 'No'),
        });
        if (!ok) { render(); return; }
    }
    if (globalThis.sequenceEdit?.isActive?.()) globalThis.sequenceEdit.exit();
    const saved = doc.sequences[name];
    doc.current = saved ? { name, ...normalizeSequence(clone(saved)) } : { name: '', field: doc.current.field, scenes: [] };
    persistNow();
    notify();
}

async function saveNamed() {
    const input = await showDialog('input', {
        message: text('seq_save_title', 'Save sequence\nName:'),
        placeholder: 'Sequence',
        defaultValue: doc.current.name || '',
    });
    const name = String(input ?? '').trim();
    if (!name) return;
    if (doc.sequences[name] && name !== doc.current.name) {
        const ok = await showDialog('confirm', {
            message: text('seq_overwrite', 'Replace the saved sequence "{0}"?').replace('{0}', name),
            yesText: text('setup_yes', 'Yes'), noText: text('setup_no', 'No'),
        });
        if (!ok) return;
    }
    doc.current = { ...doc.current, name };
    doc.sequences[name] = normalizeSequence(clone(doc.current));
    persistNow();
    notify();
}

async function deleteNamed() {
    const name = doc.current.name;
    if (!name || !doc.sequences[name]) return;
    const ok = await showDialog('confirm', {
        message: text('seq_delete_title', 'Delete the sequence "{0}"?').replace('{0}', name),
        yesText: text('setup_yes', 'Yes'), noText: text('setup_no', 'No'),
    });
    if (!ok) return;
    delete doc.sequences[name];
    doc.current = { ...doc.current, name: '' };
    persistNow();
    notify();
}

// ---- page 1

let dragFrom = null;

function sceneTile(scene, index) {
    const editingId = globalThis.sequenceEdit?.isActive?.() ? globalThis.sequenceEdit.sceneId() : null;
    const tile = element('div', 'sequence-tile');
    tile.draggable = true;
    tile.dataset.sceneId = scene.id;
    const empty = !scene.text.trim();
    tile.classList.toggle('is-empty', empty);
    tile.classList.toggle('is-editing', scene.id === editingId);
    const image = element('div', 'sequence-tile-image');
    if (scene.thumb) image.style.backgroundImage = `url("${scene.thumb}")`;
    else image.classList.add('is-blank');
    image.append(element('span', 'sequence-tile-no', String(index + 1).padStart(2, '0')));
    if (empty) image.append(element('span', 'sequence-tile-empty', text('seq_empty', 'Empty')));
    if (scene.id === editingId) image.append(element('span', 'sequence-tile-editing', text('seq_editing', 'Editing')));
    const tools = element('div', 'sequence-tile-tools');
    tools.append(
        iconButton('pencil', text('seq_edit', 'Edit in prompts'), { onClick: event => { event.stopPropagation(); editScene(scene.id); } }),
        iconButton('trash', text('seq_delete_scene', 'Delete scene'), { onClick: event => { event.stopPropagation(); deleteScene(scene); } }),
    );
    image.append(tools);
    const name = element('button', 'sequence-tile-name', scene.name);
    name.type = 'button';
    name.title = scene.name;
    name.addEventListener('click', () => startRename(tile, scene));
    tile.append(image, name);

    tile.addEventListener('dragstart', event => {
        dragFrom = index;
        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData('text/plain', scene.id);
        tile.classList.add('is-dragging');
    });
    tile.addEventListener('dragend', () => { dragFrom = null; clearDropMarks(); tile.classList.remove('is-dragging'); });
    tile.addEventListener('dragover', event => {
        if (dragFrom === null) return;
        event.preventDefault();
        const after = event.offsetX > tile.clientWidth / 2;
        clearDropMarks();
        tile.classList.add(after ? 'is-drop-after' : 'is-drop-before');
    });
    tile.addEventListener('drop', event => {
        if (dragFrom === null) return;
        event.preventDefault();
        const after = tile.classList.contains('is-drop-after');
        const from = dragFrom;
        dragFrom = null;
        clearDropMarks();
        updateCurrent(current => { current.scenes = moveScene(current.scenes, from, index + (after ? 1 : 0)); });
    });
    return tile;
}

function clearDropMarks() {
    for (const node of ui.grid.querySelectorAll('.is-drop-before, .is-drop-after')) node.classList.remove('is-drop-before', 'is-drop-after');
}

function startRename(tile, scene) {
    const name = tile.querySelector('.sequence-tile-name');
    const input = element('input', 'sequence-tile-input');
    input.value = scene.name;
    input.setAttribute('aria-label', text('seq_scene_name', 'Scene name'));
    let done = false;
    const finish = commit => {
        if (done) return;
        done = true;
        const value = input.value.trim();
        if (commit && value && value !== scene.name) updateCurrent(current => { const entry = current.scenes.find(item => item.id === scene.id); if (entry) entry.name = value; });
        else render();
    };
    input.addEventListener('keydown', event => {
        if (event.key === 'Enter') { event.preventDefault(); finish(true); }
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); finish(false); }
    });
    input.addEventListener('blur', () => finish(true));
    name.replaceWith(input);
    input.focus();
    input.select();
}

async function deleteScene(scene) {
    const index = doc.current.scenes.findIndex(item => item.id === scene.id);
    const ok = await showDialog('confirm', {
        message: text('seq_delete_scene_title', 'Delete the scene "{0}"?').replace('{0}', `${String(index + 1).padStart(2, '0')} ${scene.name}`),
        yesText: text('seq_delete_yes', 'Delete'), noText: text('setup_no', 'No'),
    });
    if (!ok) return;
    if (globalThis.sequenceEdit?.isActive?.() && globalThis.sequenceEdit.sceneId() === scene.id) globalThis.sequenceEdit.exit();
    updateCurrent(current => { current.scenes = current.scenes.filter(item => item.id !== scene.id); });
}

function addScene() {
    const id = makeSceneId();
    updateCurrent(current => { current.scenes.push({ id, name: `Scene ${current.scenes.length + 1}`, text: '', thumb: '' }); });
    const tile = ui.grid.querySelector(`[data-scene-id="${id}"]`);
    const scene = doc.current.scenes.find(item => item.id === id);
    if (tile && scene) startRename(tile, scene);
}

function editScene(sceneId) {
    if (!doc.current.field || !sceneFieldOptions().some(option => option.key === doc.current.field)) {
        showDialog('info', { message: text('seq_pick_field', 'Pick the field the scenes go into first.') });
        return;
    }
    shell.close();
    globalThis.sequenceEdit?.enter(sceneId);
}

function renderScenes() {
    const names = savedNames();
    ui.nameSelect.replaceChildren();
    if (!doc.current.name || !doc.sequences[doc.current.name]) {
        const option = element('option', '', text('seq_unsaved', 'Unsaved'));
        option.value = doc.current.name || '';
        ui.nameSelect.append(option);
    }
    for (const name of names) {
        const option = element('option', '', name);
        option.value = name;
        ui.nameSelect.append(option);
    }
    ui.nameSelect.value = doc.current.name || '';
    ui.deleteButton.disabled = !doc.current.name || !doc.sequences[doc.current.name];

    const options = sceneFieldOptions();
    ui.fieldSelect.replaceChildren();
    if (!options.some(option => option.key === doc.current.field)) {
        const option = element('option', '', doc.current.field ? `${doc.current.field} ?` : '—');
        option.value = doc.current.field;
        ui.fieldSelect.append(option);
    }
    for (const option of options) {
        const node = element('option', '', option.label);
        node.value = option.key;
        ui.fieldSelect.append(node);
    }
    ui.fieldSelect.value = doc.current.field;
    ui.fieldSelect.disabled = Boolean(globalThis.sequenceEdit?.isActive?.());
    ui.count.textContent = `${doc.current.scenes.length} ${text('seq_scenes', 'scenes')}`;

    ui.grid.replaceChildren(...doc.current.scenes.map(sceneTile));
    const add = element('button', 'sequence-tile-add');
    add.type = 'button';
    add.append(iconElement('plus', 16), element('span', '', text('seq_scene', 'Scene')));
    add.addEventListener('click', addScene);
    ui.grid.append(add);
}

// ---- page 2

function renderPool() {
    const pool = favoritePool();
    const q = query.trim().toLowerCase();
    ui.poolList.replaceChildren(...pool.map(entry => {
        const chosen = selected.includes(entry.key);
        const row = element('button', 'sequence-row');
        row.type = 'button';
        row.classList.toggle('is-chosen', chosen);
        row.classList.toggle('is-filtered', Boolean(q) && !entry.label.toLowerCase().includes(q) && !entry.key.toLowerCase().includes(q));
        const avatar = element('span', 'sequence-avatar');
        paintAvatar(avatar, entry.key, entry.label);
        row.append(avatar, element('span', 'sequence-row-name', entry.label), element('span', 'sequence-row-mark', chosen ? '✓' : '+'));
        row.title = entry.label;
        row.addEventListener('click', () => { if (!selected.includes(entry.key)) { selected = [...selected, entry.key]; render(); } });
        return row;
    }));
}

let rowDragFrom = null;

function renderChosen() {
    ui.chosenCount.textContent = String(selected.length);
    ui.chosenList.replaceChildren(...selected.map((key, index) => {
        const label = characterLabel(key);
        const row = element('div', 'sequence-row is-chosen-row');
        row.draggable = true;
        const avatar = element('span', 'sequence-avatar');
        paintAvatar(avatar, key, label);
        const remove = iconButton('close', text('seq_remove', 'Remove'), { onClick: () => { selected = selected.filter(item => item !== key); render(); } });
        const grip = element('span', 'sequence-row-grip');
        grip.append(iconElement('grip', 12));
        row.append(grip, element('span', 'sequence-row-no', String(index + 1)), avatar, element('span', 'sequence-row-name', label), remove);
        row.title = label;
        row.addEventListener('dragstart', event => { rowDragFrom = index; event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', key); });
        row.addEventListener('dragend', () => { rowDragFrom = null; });
        row.addEventListener('dragover', event => { if (rowDragFrom !== null) { event.preventDefault(); row.classList.add('is-drop-before'); } });
        row.addEventListener('dragleave', () => row.classList.remove('is-drop-before'));
        row.addEventListener('drop', event => {
            if (rowDragFrom === null) return;
            event.preventDefault();
            const from = rowDragFrom;
            rowDragFrom = null;
            selected = moveScene(selected, from, index);
            render();
        });
        return row;
    }));
}

// ---- footer and the run

function runBlockers() {
    const SETTINGS = globalThis.globalSettings ?? {};
    const field = doc.current.field;
    return sequenceStartBlockers({
        characters: selected.length,
        scenes: doc.current.scenes,
        fieldExists: Boolean(field) && sceneFieldOptions().some(option => option.key === field),
        fieldMuted: Boolean(field) && isFieldMuted(SETTINGS, field),
        regional: Boolean(SETTINGS.regional_condition),
        controlNet: createControlNet().length,
        backend: globalThis.generate?.api_interface?.getValue?.() ?? SETTINGS.api_interface,
        modelType: SETTINGS.api_model_type,
    });
}

function renderFooter() {
    const { candidates } = batchSettings();
    const total = selected.length * doc.current.scenes.length * candidates;
    const onRun = page === 'run';
    ui.leftButton.textContent = onRun ? `← ${text('seq_scenes_page', 'Scenes')}` : (globalThis.sequenceEdit?.isActive?.() ? text('seq_back', 'Back') : text('ui_cancel', 'Cancel'));
    ui.nextButton.hidden = onRun;
    for (const node of [ui.blockers, ui.candidatesLabel, ui.candidates, ui.generateButton]) node.hidden = !onRun;
    ui.candidates.value = String(candidates);
    ui.generateButton.textContent = `${text('seq_generate', 'Generate')} (${total})`;
    const reasons = onRun ? runBlockers() : [];
    ui.blockers.replaceChildren(...reasons.map(reason => {
        const [key, fallback] = BLOCKER_TEXT[reason] ?? [reason, reason];
        const pill = element('span', 'sequence-blocker');
        pill.append(element('i'), document.createTextNode(text(key, fallback)));
        return pill;
    }));
    ui.generateButton.disabled = reasons.length > 0 || total === 0;
}

function render() {
    if (!shell) return;
    shell.heading.textContent = page === 'run' ? `${text('seq_title', 'Sequence')} › ${text('seq_run', 'Run')}` : text('seq_title', 'Sequence');
    ui.scenesPage.hidden = page !== 'scenes';
    ui.runPage.hidden = page !== 'run';
    if (page === 'scenes') renderScenes();
    else {
        ui.runContext.textContent = `${doc.current.name || text('seq_unsaved', 'Unsaved')} · ${doc.current.scenes.length} ${text('seq_scenes', 'scenes')}`;
        ui.randomCount.value = String(batchSettings().count);
        ui.randomCount.max = String(Math.max(1, favoritePool().length));
        renderPool();
        renderChosen();
    }
    renderFooter();
}

async function startRun() {
    const reasons = runBlockers();
    if (reasons.length) { renderFooter(); return; }
    const { candidates } = batchSettings();
    const scenes = doc.current.scenes;
    const total = selected.length * scenes.length * candidates;
    const threshold = Math.max(0, Math.floor(Number(globalThis.globalSettings?.sequence_confirm_threshold ?? 100)));
    if (threshold > 0 && total >= threshold) {
        const ok = await showDialog('confirm', {
            message: text('seq_confirm_total', 'Queue {0} images?').replace('{0}', String(total)),
            yesText: text('setup_yes', 'Yes'), noText: text('setup_no', 'No'),
        });
        if (!ok) return;
    }
    const slider = Number(globalThis.generate?.seed?.getValue?.() ?? -1);
    const baseSeed = Number.isFinite(slider) && slider >= 0 ? slider : generateRandomSeed();
    const rows = expandSequenceRows({ characters: [...selected], scenes, candidates, baseSeed });
    const sequence = { runId: sequenceRunId(), name: doc.current.name, field: doc.current.field, candidates, rows };
    shell.close();
    await callback_generate_start('normal', { loops: 1, runSame: false, sequence });
}

/** Open the dialog; `page` 'scenes' (the edit strip) or the page it was closed on. */
export function openSequenceDialog({ page: wanted = null, trigger = null } = {}) {
    if (!shell) build();
    if (wanted) page = wanted;
    // a new sequence starts on the first custom field (else Background)
    if (!doc.current.field) {
        const options = sceneFieldOptions();
        const field = options.find(option => !BUILTIN_FIELD_LABELS[option.key]) ?? options.find(option => option.key === 'background');
        if (field) updateCurrent(current => { current.field = field.key; });
    }
    query = '';
    ui.search.value = '';
    render();
    shell.open({ trigger, title: shell.heading.textContent, initialFocus: () => (page === 'run' ? ui.generateButton : ui.nameSelect) });
}

/** Load the store and give back the scene field's text a crashed edit mode left in it. */
export async function setupSequenceBatch() {
    if (globalThis.inBrowser || !globalThis.api?.sequencesGet) return;
    try {
        doc = normalizeSequenceDocument(await globalThis.api.sequencesGet());
    } catch (error) {
        console.error(CAT, 'load failed', error);
    }
    globalThis.sequenceBatch = { open: openSequenceDialog, current: currentSequence, update: updateCurrent, onChange: onSequenceChange, setEditBackup, doc: sequenceDoc };
    mountThresholdSetting();
    if (doc.editBackup) await globalThis.sequenceEdit?.recover?.(doc.editBackup);
}

// Settings › General: how many images a run may queue before Generate asks first (0 = never)
function mountThresholdSetting() {
    const grid = document.querySelector('#settings-page-general .settings-grid');
    if (!grid || grid.querySelector('.sequence-threshold-setting')) return;
    const row = element('label', 'sequence-threshold-setting');
    const caption = element('span', 'sequence-label', text('seq_confirm_threshold', 'Sequence: ask before queuing this many images (0 = never)'));
    const input = element('input', 'sequence-number');
    input.type = 'number';
    input.min = '0';
    input.step = '10';
    input.value = String(globalThis.globalSettings?.sequence_confirm_threshold ?? 100);
    input.addEventListener('change', () => {
        const value = Math.max(0, Math.floor(Number(input.value) || 0));
        globalThis.globalSettings.sequence_confirm_threshold = value;
        input.value = String(value);
    });
    document.addEventListener('saa-settings-applied', () => { input.value = String(globalThis.globalSettings?.sequence_confirm_threshold ?? 100); });
    row.append(caption, input);
    grid.append(row);
}
