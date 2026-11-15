// The Sequence dialog (docs/sequence-batch-plan.md): two tabs, "Scenes" what is saved (the
// ordered scenes as thumbnail tiles; each scene owns its prompts, LoRA rows and generation
// settings) and "Characters" who the next run is for. It makes nothing itself: the run bar's
// Generate runs the sequence in its Sequence mode (runModes.js), with the run bar's count as
// the patterns per character and scene. The edit mode in the usual screen is sequenceEdit.js; the pure parts are
// scripts/shared/sequenceBatch.js.
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
import {
    MAX_CANDIDATES, SCENE_SECTIONS, applyLegacyTexts, expandSequenceRows, makeSceneId, moveScene, normalizeEditBackup,
    normalizeSequence, normalizeSequenceDocument, pickRandomCharacters, pickSceneSettings, sequenceRunId, sequenceStartBlockers,
} from '../shared/sequenceBatch.js';

const CAT = '[SequenceBatch]';
const BLOCKER_TEXT = {
    'no-characters': ['seq_block_no_characters', 'No characters'],
    'no-scenes': ['seq_block_no_scenes', 'No scenes'],
    'empty-scene': ['seq_block_empty_scene', 'Empty scene'],
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
let selected = [];                             // the picked character keys (kept in sequence_run.characters)
let page = 'scenes';
let query = '';
let saveTimer = null;
const listeners = new Set();
const closeListeners = new Set();

export function sequenceDoc() {
    return doc;
}

/** The sequence the dialog has open: { name, scenes }. */
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

/** The screen's own scene settings while edit mode runs ({ settings }), or null. */
export function setEditBackup(backup) {
    doc.editBackup = normalizeEditBackup(backup);
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
    const characters = Array.isArray(stored.characters) ? stored.characters.filter(key => typeof key === 'string' && key) : [];
    // the scene edited last: Sequence mode opens on it (runModes.js)
    const scene = typeof stored.scene === 'string' ? stored.scene : '';
    return { count, candidates, characters, scene };
}

/** The picked characters change: kept for the next start, and the run bar told. */
function setSelected(next) {
    selected = [...next];
    setBatchSettings({ characters: selected });
    for (const listener of listeners) {
        try { listener(doc); } catch (error) { console.error(CAT, 'listener failed', error); }
    }
    render();
}

/** The patterns per character and scene (the run bar's count in Sequence mode). */
export function setCandidates(value) {
    const candidates = Math.max(1, Math.min(MAX_CANDIDATES, Math.floor(Number(value) || 1)));
    setBatchSettings({ candidates });
    if (shell?.isOpen()) renderTabs();
}

/** Images the sequence makes now: scenes x characters x patterns. */
export function sequenceTotal() {
    return selected.length * doc.current.scenes.length * batchSettings().candidates;
}

/** Why the sequence cannot start now, as text for Generate's tooltip ([] = it can). */
export function sequenceBlockerTexts() {
    return runBlockers().map(reason => {
        const [key, fallback] = BLOCKER_TEXT[reason] ?? [reason, reason];
        return text(key, fallback);
    });
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

// ------------------------------------------------------------------ the screen

/** The screen's scene settings now (SCENE_KEYS of its prompt, generation and lora sections), or null. */
export function captureSceneSettings() {
    const persistence = globalThis.settingsPersistence;
    if (!persistence?.collectSection) return null;
    return pickSceneSettings(Object.fromEntries(SCENE_SECTIONS.map(section => [section, persistence.collectSection(section)])));
}

/**
 * Put scene settings on the screen. Not an undo step: the undo history of those sections
 * is dropped instead (it holds another scene's values, an undo would carry them over).
 */
export function applySceneSettings(settings, { dropHistory = true } = {}) {
    const persistence = globalThis.settingsPersistence;
    const picked = pickSceneSettings(settings);
    if (!persistence?.applySectionsData || !picked) return false;
    const done = persistence.applySectionsData(picked, { mergeLayout: false });
    if (dropHistory) persistence.history?.clear?.([...SCENE_SECTIONS]);
    return done;
}

// ------------------------------------------------------------------ the dialog

let shell = null;
let ui = null;

function build() {
    shell = createDialogShell({ className: 'sequence-dialog', onClose: notifyClose });
    const { body, footer } = shell;
    shell.dialog.classList.add('sequence-dialog-frame');

    // the tabs: Scenes (page 'scenes') and Characters (page 'run'), each with its count
    const tabs = element('div', 'sequence-tabs');
    tabs.setAttribute('role', 'tablist');
    const tabButton = (name, label) => {
        const button = element('button', 'sequence-tab');
        button.type = 'button';
        button.dataset.page = name;
        button.setAttribute('role', 'tab');
        const count = element('span', 'sequence-tab-count');
        button.append(element('span', '', label), count);
        button.addEventListener('click', () => showPage(name));
        return { button, count };
    };
    const scenesTab = tabButton('scenes', text('seq_scenes_page', 'Scenes'));
    const charactersTab = tabButton('run', text('seq_characters', 'Characters'));
    const formula = element('span', 'sequence-formula');
    tabs.append(scenesTab.button, charactersTab.button, element('span', 'sequence-fill'), formula);
    tabs.addEventListener('keydown', event => {
        if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
        event.preventDefault();
        const next = page === 'scenes' ? 'run' : 'scenes';
        showPage(next);
        (next === 'scenes' ? scenesTab : charactersTab).button.focus();
    });

    // the Scenes tab: the saved sequence
    const scenesPage = element('section', 'sequence-page sequence-page-scenes');
    scenesPage.setAttribute('role', 'tabpanel');
    const toolbar = element('div', 'sequence-toolbar');
    const nameSelect = element('select', 'sequence-select');
    nameSelect.setAttribute('aria-label', 'Sequence');
    const saveButton = iconButton('save', text('seq_save', 'Save sequence'), { size: 26 });
    const deleteButton = iconButton('trash', text('seq_delete', 'Delete sequence'), { size: 26 });
    toolbar.append(nameSelect, saveButton, deleteButton);
    const grid = element('div', 'sequence-grid');
    const gridScroll = element('div', 'sequence-grid-scroll');
    gridScroll.append(grid);
    scenesPage.append(toolbar, gridScroll);

    // the Characters tab: who this run is for
    const runPage = element('section', 'sequence-page sequence-page-run');
    runPage.setAttribute('role', 'tabpanel');
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
    runPage.append(columns);
    body.classList.add('sequence-body');
    body.append(tabs, scenesPage, runPage);

    // footer: Done (every change is kept as it is made; Single / Batch on the run bar end the edit mode)
    const doneButton = element('button', 'selection-modal-apply sequence-done', text('seq_done', 'Done'));
    doneButton.type = 'button';
    footer.classList.add('sequence-footer');
    footer.append(doneButton);

    ui = {
        scenesTab, charactersTab, formula, scenesPage, runPage, nameSelect, saveButton, deleteButton, grid,
        search, poolList, addAll, randomButton, randomCount, chosenList, chosenCount, clearButton,
        doneButton,
    };

    nameSelect.addEventListener('change', () => loadNamed(nameSelect.value));
    saveButton.addEventListener('click', saveNamed);
    deleteButton.addEventListener('click', deleteNamed);
    search.addEventListener('input', () => { query = search.value; renderPool(); });
    addAll.addEventListener('click', () => setSelected(favoritePool().map(entry => entry.key)));
    randomButton.addEventListener('click', () => {
        setSelected(pickRandomCharacters(favoritePool().map(entry => entry.key), batchSettings().count, cryptoRandom));
    });
    randomCount.addEventListener('change', () => {
        const value = Math.max(1, Math.floor(Number(randomCount.value) || 1));
        setBatchSettings({ count: value });
        randomCount.value = String(value);
    });
    clearButton.addEventListener('click', () => setSelected([]));
    doneButton.addEventListener('click', () => shell.close());
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
    // the edit mode moves to the loaded sequence's first scene (sequenceEdit.js follows the change)
    globalThis.sequenceEdit?.detach?.();
    const saved = doc.sequences[name];
    doc.current = saved ? { name, ...normalizeSequence(clone(saved)) } : { name: '', scenes: [] };
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

// the adopted image's Library thumbnail (sharper than the stored one); '' when the file is gone
const fileThumbs = new Map();
function paintTileImage(node, scene) {
    if (scene.thumb) node.style.backgroundImage = `url("${scene.thumb}")`;
    else node.classList.add('is-blank');
    const file = scene.image;
    if (!file || !globalThis.api?.libraryThumbs) return;
    const apply = url => {
        if (!url) return;
        node.classList.remove('is-blank');
        node.style.backgroundImage = `url("${url}")`;
    };
    if (fileThumbs.has(file)) { apply(fileThumbs.get(file)); return; }
    Promise.resolve(globalThis.api.libraryThumbs([file]))
        .then(result => { const url = result?.[file] ?? ''; fileThumbs.set(file, url); apply(url); })
        .catch(() => fileThumbs.set(file, ''));
}

function sceneTile(scene, index) {
    const editingId = globalThis.sequenceEdit?.isActive?.() ? globalThis.sequenceEdit.sceneId() : null;
    const tile = element('div', 'sequence-tile');
    tile.draggable = true;
    tile.dataset.sceneId = scene.id;
    const empty = !scene.settings;
    tile.classList.toggle('is-empty', empty);
    tile.classList.toggle('is-editing', scene.id === editingId);
    const image = element('div', 'sequence-tile-image');
    paintTileImage(image, scene);
    image.append(element('span', 'sequence-tile-no', String(index + 1).padStart(2, '0')));
    if (empty) image.append(element('span', 'sequence-tile-empty', text('seq_empty', 'Empty')));
    if (scene.id === editingId) image.append(element('span', 'sequence-tile-editing', text('seq_editing', 'Editing')));
    const tools = element('div', 'sequence-tile-tools');
    tools.append(iconButton('trash', text('seq_delete_scene', 'Delete scene'), { onClick: event => { event.stopPropagation(); deleteScene(scene); } }));
    image.append(tools);
    // the picture opens the scene in the prompts (edit mode)
    image.setAttribute('role', 'button');
    image.tabIndex = 0;
    image.setAttribute('aria-label', `${text('seq_edit', 'Edit in prompts')}: ${scene.name}`);
    image.addEventListener('click', () => editScene(scene.id));
    image.addEventListener('keydown', event => {
        if (event.target === image && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); editScene(scene.id); }
    });
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
    // the scene on the screen gone: the edit mode moves to its neighbour (sequenceEdit.js)
    updateCurrent(current => { current.scenes = current.scenes.filter(item => item.id !== scene.id); });
}

// a new scene starts as the screen is now (its prompts, LoRA rows and generation settings)
function addScene() {
    const id = makeSceneId();
    const settings = captureSceneSettings();
    updateCurrent(current => { current.scenes.push({ id, name: `Scene ${current.scenes.length + 1}`, settings, thumb: '', image: '', history: [] }); });
    const tile = ui.grid.querySelector(`[data-scene-id="${id}"]`);
    const scene = doc.current.scenes.find(item => item.id === id);
    if (tile && scene) startRename(tile, scene);
}

// a tile: that scene on the screen (Sequence mode, runModes.js); queued before the close so
// the close does not first put the scene touched last there
function editScene(sceneId) {
    globalThis.runModes?.editScene?.(sceneId);
    shell.close();
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
        row.addEventListener('click', () => { if (!selected.includes(entry.key)) setSelected([...selected, entry.key]); });
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
        const remove = iconButton('close', text('seq_remove', 'Remove'), { onClick: () => setSelected(selected.filter(item => item !== key)) });
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
            setSelected(moveScene(selected, from, index));
        });
        return row;
    }));
}

// ---- the run

function runBlockers() {
    const SETTINGS = globalThis.globalSettings ?? {};
    return sequenceStartBlockers({
        characters: selected.length,
        scenes: doc.current.scenes,
        regional: Boolean(SETTINGS.regional_condition),
        controlNet: createControlNet().length,
        backend: globalThis.generate?.api_interface?.getValue?.() ?? SETTINGS.api_interface,
        modelType: SETTINGS.api_model_type,
    });
}

function showPage(name) {
    if (page === name) return;
    page = name;
    render();
}

// the tabs: which one is open, how many scenes and characters, and what they multiply to
function renderTabs() {
    const scenes = doc.current.scenes.length;
    const characters = selected.length;
    for (const [tab, name, count] of [[ui.scenesTab, 'scenes', scenes], [ui.charactersTab, 'run', characters]]) {
        const open = page === name;
        tab.button.setAttribute('aria-selected', String(open));
        tab.button.tabIndex = open ? 0 : -1;
        tab.count.textContent = String(count);
        tab.count.classList.toggle('is-zero', count === 0);
    }
    ui.formula.textContent = `${scenes} × ${characters} × ${batchSettings().candidates}`;
}

function renderFooter() {
    renderTabs();
}

function notifyClose() {
    for (const listener of closeListeners) {
        try { listener(); } catch (error) { console.error(CAT, 'close listener failed', error); }
    }
}

/** The scene edited last (Sequence mode opens on it), '' when none is known. */
export function lastScene() {
    return batchSettings().scene;
}

export function setLastScene(sceneId) {
    const scene = String(sceneId ?? '');
    if (batchSettings().scene === scene) return;
    setBatchSettings({ scene });
    globalThis.settingsAutosave?.markDirty?.('app');
}

function render() {
    if (!shell) return;
    shell.heading.textContent = text('seq_title', 'Sequence');
    ui.scenesPage.hidden = page !== 'scenes';
    ui.runPage.hidden = page !== 'run';
    if (page === 'scenes') renderScenes();
    else {
        ui.randomCount.value = String(batchSettings().count);
        ui.randomCount.max = String(Math.max(1, favoritePool().length));
        renderPool();
        renderChosen();
    }
    renderFooter();
}

/** Run the open sequence for the picked characters (the run bar's Generate in Sequence mode). */
export async function runSequence() {
    const reasons = runBlockers();
    if (reasons.length) return false;
    const { candidates } = batchSettings();
    const scenes = doc.current.scenes;
    const total = selected.length * scenes.length * candidates;
    const threshold = Math.max(0, Math.floor(Number(globalThis.globalSettings?.sequence_confirm_threshold ?? 100)));
    if (threshold > 0 && total >= threshold) {
        const ok = await showDialog('confirm', {
            message: text('seq_confirm_total', 'Queue {0} images?').replace('{0}', String(total)),
            yesText: text('setup_yes', 'Yes'), noText: text('setup_no', 'No'),
        });
        if (!ok) return false;
    }
    const slider = Number(globalThis.generate?.seed?.getValue?.() ?? -1);
    const baseSeed = Number.isFinite(slider) && slider >= 0 ? slider : generateRandomSeed();
    const rows = expandSequenceRows({ characters: [...selected], scenes, candidates, baseSeed });
    const sequence = {
        runId: sequenceRunId(), name: doc.current.name, candidates, rows,
        scenes: scenes.map(scene => ({ id: scene.id, name: scene.name, settings: clone(scene.settings) })),
    };
    if (shell?.isOpen()) shell.close();
    await callback_generate_start('normal', { loops: 1, sequence });
    return true;
}

/** Open the dialog; `page` 'scenes' (the edit strip) or 'run' (Characters), else the tab it was closed on. */
export function openSequenceDialog({ page: wanted = null, trigger = null } = {}) {
    if (!shell) build();
    if (wanted) page = wanted;
    query = '';
    ui.search.value = '';
    render();
    shell.open({ trigger, title: shell.heading.textContent, initialFocus: () => (page === 'run' ? ui.search : ui.nameSelect) });
}

/** Load the store and give back the scene field's text a crashed edit mode left in it. */
export async function setupSequenceBatch() {
    if (globalThis.inBrowser || !globalThis.api?.sequencesGet) return;
    try {
        doc = normalizeSequenceDocument(await globalThis.api.sequencesGet());
    } catch (error) {
        console.error(CAT, 'load failed', error);
    }
    // the characters picked last time, those still among the favorites
    const known = new Set(favoritePool().map(entry => entry.key));
    selected = batchSettings().characters.filter(key => known.has(key));
    globalThis.sequenceBatch = {
        open: openSequenceDialog, current: currentSequence, update: updateCurrent, onChange: onSequenceChange, setEditBackup, doc: sequenceDoc,
        captureScene: captureSceneSettings, applyScene: applySceneSettings,
        run: runSequence, total: sequenceTotal, blockers: sequenceBlockerTexts,
        candidates: () => batchSettings().candidates, setCandidates, selected: () => [...selected],
        isOpen: () => Boolean(shell?.isOpen()), onClose: listener => { closeListeners.add(listener); return () => closeListeners.delete(listener); },
        lastScene, setLastScene,
    };
    mountThresholdSetting();
    // closing the app writes the store now (an edit mode's last edit included, sequenceEdit.js)
    globalThis.addEventListener('beforeunload', persistNow);
    // the app was closed in edit mode: back on that scene, else the screen gets its own back
    const backup = doc.editBackup;
    const resumable = Boolean(backup?.settings && backup.sceneId && doc.current.scenes.some(scene => scene.id === backup.sceneId));
    if (resumable) {
        carryOverTextScenes();
        await globalThis.sequenceEdit?.resume?.(backup);
        return;
    }
    if (backup) await globalThis.sequenceEdit?.recover?.(backup);
    carryOverTextScenes();
}

// Scenes from before scenes held their own settings were the text of a few fields: they
// become the screen's settings with those texts written in, once.
function carryOverTextScenes() {
    const base = captureSceneSettings();
    if (!base) return;
    let changed = false;
    const carry = scenes => scenes.map(scene => {
        if (scene.settings || !scene.texts) return scene;
        changed = true;
        const { texts, ...rest } = scene;
        return { ...rest, settings: applyLegacyTexts(base, texts) };
    });
    doc.current = { ...doc.current, scenes: carry(doc.current.scenes) };
    for (const name of Object.keys(doc.sequences)) doc.sequences[name] = { ...doc.sequences[name], scenes: carry(doc.sequences[name].scenes) };
    if (changed) {
        console.log(CAT, 'scenes of the field kind now hold their own settings');
        persistNow();
    }
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
