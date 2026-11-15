// Sequence edit mode (docs/sequence-batch-plan.md D18 / D19 / D25 / D29): one scene of the
// open sequence is on the usual screen. A scene owns its prompts (every field of the
// Prompts card), its LoRA rows and its generation settings (size, steps, CFG, sampler,
// Hires): while the mode runs those ARE the scene's (every edit goes straight into it);
// the screen's own are kept aside and come back when the mode ends. The mode is the run
// bar's Sequence mode (D34, runModes.js): picking Single or Batch ends it. A strip above Prompts
// names the sequence and the scene, ‹ › step through the scenes and the scene button opens
// the Sequence dialog; the viewer's "Save to <scene>" adopts the shown image: its settings,
// a thumbnail and its saved file go into the scene. While the mode runs the viewer shows
// the scene's own images (the trial runs made for it, the adopted one marked and on show
// when the scene opens); the viewer's own images come back when the mode ends. Trial runs
// use slot 1 only and never Regional.
import { element, iconButton } from './dom.js';
import { iconElement } from '../shared/iconSet.js';
import { GALLERY_APPEND_EVENT } from './customGallery.js';
import { addToHistory, applyLegacyTexts, normalizeEditBackup, pathKey, pickSceneSettings } from '../shared/sequenceBatch.js';
import {
    applySceneSettings, captureSceneSettings, currentSequence, onSequenceChange, openSequenceDialog, setEditBackup, updateCurrent,
} from './sequenceBatchUi.js';

const CAT = '[SequenceEdit]';
const THUMB_HEIGHT = 384;
const DONE_MS = 1400;
const CACHE_LIMIT = 120;
const SYNC_MS = 300;

let active = null;          // { sceneId, backup, index }: backup = the screen's own scene settings, index = where the scene sat
let applying = false;       // the mode is putting settings on the screen itself
let poll = null;
let moving = false;         // the mode is moving off a scene that is gone
let syncTimer = null;
let doneUntil = 0;          // "Save to" shows Done until then
// the viewer while the mode shows a scene's images
let viewerSaved = null;     // { entries, index }: the viewer's own images
let arrived = [];           // images that landed while the mode ran; they join the viewer's own at the end
let showToken = 0;
const imageCache = new Map();   // pathKey → { image, seed, tags, info, record }

function text(key, fallback) {
    const value = globalThis.cachedFiles?.language?.[globalThis.globalSettings?.language]?.[key];
    return typeof value === 'string' && value ? value : fallback;
}

const nextFrame = () => new Promise(resolve => requestAnimationFrame(() => resolve()));

// ------------------------------------------------------------------ the scene on the screen

/** Put a scene's settings on the screen; the mode's own write does not count as an edit. */
async function putOnScreen(settings) {
    applying = true;
    try {
        applySceneSettings(settings);
        await nextFrame();
    } finally {
        applying = false;
    }
}

function sceneById(id) {
    return currentSequence().scenes.find(scene => scene.id === id) ?? null;
}

function sceneIndex(id) {
    return currentSequence().scenes.findIndex(scene => scene.id === id);
}

function sceneLabel(id) {
    const index = sceneIndex(id);
    const scene = sceneById(id);
    return scene ? `${String(index + 1).padStart(2, '0')} ${scene.name}` : '';
}

// the screen changed (typing, a chip, a LoRA row, a size, an undo): the scene follows
// a sequence run puts other scenes on the screen for a moment (generate.js): not an edit
const runApplying = () => globalThis.sequenceRunApplying === true;

function syncNow() {
    clearTimeout(syncTimer);
    syncTimer = null;
    if (!active || applying || runApplying()) return;
    const scene = sceneById(active.sceneId);
    const settings = captureSceneSettings();
    if (!scene || !settings || JSON.stringify(scene.settings) === JSON.stringify(settings)) return;
    const sceneId = active.sceneId;
    updateCurrent(current => {
        const entry = current.scenes.find(item => item.id === sceneId);
        if (entry) entry.settings = settings;
    });
}

function scheduleSync() {
    if (!active || applying || runApplying()) return;
    clearTimeout(syncTimer);
    syncTimer = setTimeout(syncNow, SYNC_MS);
}

// ------------------------------------------------------------------ the screen

function stripElement() {
    return document.getElementById('sequence-strip');
}

function buildStrip() {
    let strip = stripElement();
    if (!strip) {
        strip = element('div', 'sequence-strip');
        strip.id = 'sequence-strip';
        strip.setAttribute('role', 'toolbar');
        const mark = element('span', 'sequence-strip-mark');
        mark.append(iconElement('pencil', 14));
        const name = element('span', 'sequence-strip-name');
        const prev = iconButton('chevron-left', text('seq_prev', 'Previous scene'), { size: 26, onClick: () => step(-1) });
        prev.classList.add('sequence-strip-prev');
        const current = element('button', 'sequence-strip-current');
        current.type = 'button';
        current.setAttribute('aria-haspopup', 'dialog');
        current.addEventListener('click', () => openSequenceDialog({ page: 'scenes', trigger: current }));
        const next = iconButton('chevron-right', text('seq_next_scene', 'Next scene'), { size: 26, onClick: () => step(1) });
        next.classList.add('sequence-strip-next');
        strip.append(mark, name, prev, current, next);
        document.getElementById('prompt-text-container')?.before(strip);
    }
    const sequence = currentSequence();
    const index = sceneIndex(active.sceneId);
    const scene = sceneById(active.sceneId);
    active.index = index;
    strip.querySelector('.sequence-strip-name').textContent = sequence.name || text('seq_unsaved', 'Unsaved');
    const current = strip.querySelector('.sequence-strip-current');
    current.replaceChildren(
        element('span', 'sequence-strip-no', String(index + 1).padStart(2, '0')),
        element('span', 'sequence-strip-scene', scene?.name ?? ''),
        element('span', 'sequence-strip-count', `${String(index + 1).padStart(2, '0')} / ${sequence.scenes.length}`),
        iconElement('grid', 14),
    );
    current.title = scene?.name ?? '';
    strip.querySelector('.sequence-strip-prev').disabled = index <= 0;
    strip.querySelector('.sequence-strip-next').disabled = index < 0 || index >= sequence.scenes.length - 1;
}

function decorateCharacters() {
    const label = document.querySelector('.characters-card .dropdown-character .character-selection-field .character-selection-label');
    if (label && !label.dataset.sequenceLabel) {
        label.dataset.sequenceLabel = label.textContent;
        label.textContent = text('seq_preview_character', 'Preview character');
    }
}

function undecorateCharacters() {
    const label = document.querySelector('.characters-card [data-sequence-label]');
    if (label) {
        label.textContent = label.dataset.sequenceLabel;
        delete label.dataset.sequenceLabel;
    }
}

function viewerHost() {
    return document.querySelector('.cg-main-image-container');
}

function saveButton() {
    let button = document.getElementById('sequence-save-scene');
    const host = viewerHost();
    if (!button && host) {
        button = element('button', 'sequence-save-scene');
        button.id = 'sequence-save-scene';
        button.type = 'button';
        button.addEventListener('click', saveShownImage);
        host.append(button);
    }
    return button;
}

/** The scene settings of the image on show (its recipe), or null. */
function shownSceneSettings() {
    const entry = globalThis.mainGallery?.currentEntry?.();
    return pickSceneSettings(entry?.record?.recipe?.sections);
}

function refreshSaveButton() {
    if (!active) return;
    const button = saveButton();
    if (!button) return;
    const done = Date.now() < doneUntil;
    const label = done ? text('seq_saved', 'Done') : `${text('seq_save_to', 'Save to')} ${sceneLabel(active.sceneId)}`;
    if (button.dataset.label !== label) {
        button.dataset.label = label;
        button.replaceChildren(iconElement(done ? 'check' : 'put-in', 14), element('span', '', label));
    }
    button.classList.toggle('is-done', done);
    button.disabled = !done && !shownSceneSettings();
    button.hidden = !globalThis.mainGallery?.currentEntry?.();
}

function flashDone() {
    doneUntil = Date.now() + DONE_MS;
    refreshSaveButton();
    setTimeout(refreshSaveButton, DONE_MS + 20);
}

function decorate() {
    if (!active) return;
    buildStrip();
    decorateCharacters();
    refreshSaveButton();
}

function undecorate() {
    stripElement()?.remove();
    document.getElementById('sequence-save-scene')?.remove();
    undecorateCharacters();
}

// ------------------------------------------------------------------ the viewer: the scene's images

function cacheEntry(entry) {
    const key = pathKey(entry?.record?.path);
    if (!key) return;
    imageCache.delete(key);
    imageCache.set(key, entry);
    while (imageCache.size > CACHE_LIMIT) imageCache.delete(imageCache.keys().next().value);
}

function parseRecord(value) {
    if (value && typeof value === 'object') return value;
    try { return value ? JSON.parse(value) : null; } catch { return null; }
}

/** One saved image as a viewer entry (the gallery's own copy when it has one, else the file). */
async function loadEntry(file) {
    const key = pathKey(file);
    if (imageCache.has(key)) return imageCache.get(key);
    let loaded = null;
    try { loaded = await globalThis.api?.libraryImage?.(file); } catch (error) { console.warn(CAT, 'image read failed', file, error); }
    if (!loaded?.dataUrl) return null;
    const recipe = parseRecord(loaded.records?.recipe);
    const entry = {
        image: loaded.dataUrl,
        seed: recipe?.run?.seed ?? '',
        tags: '',
        info: '',
        record: { recipe, timing: parseRecord(loaded.records?.timing), path: file, interface: String(recipe?.run?.interface ?? '') },
    };
    cacheEntry(entry);
    return entry;
}

/**
 * Show the scene's images in the viewer: its history with the adopted image marked.
 * `select`: 'adopted' (the adopted image, else the newest), 'latest', or a file to keep on show.
 */
async function showScene(select = 'adopted') {
    const gallery = globalThis.mainGallery;
    if (!active || !gallery?.replaceAll) return;
    const token = ++showToken;
    const scene = sceneById(active.sceneId);
    const files = [...(scene?.history ?? [])];
    if (scene?.image && !files.some(file => pathKey(file) === pathKey(scene.image))) files.unshift(scene.image);
    const entries = [];
    for (const file of files) {
        const entry = await loadEntry(file);
        if (token !== showToken || !active) return;
        if (entry) entries.push(entry);
    }
    const find = file => entries.findIndex(entry => pathKey(entry.record?.path) === pathKey(file));
    let index = entries.length - 1;
    if (select === 'adopted' && scene?.image && find(scene.image) >= 0) index = find(scene.image);
    else if (select && select !== 'latest' && select !== 'adopted' && find(select) >= 0) index = find(select);
    gallery.replaceAll(entries, index);
    gallery.setMarkedPath?.(scene?.image ?? '');
    refreshSaveButton();
}

function openViewer() {
    const gallery = globalThis.mainGallery;
    viewerSaved = gallery?.entries ? { entries: gallery.entries(), index: gallery.currentIndex?.() ?? null } : null;
    arrived = [];
    for (const entry of viewerSaved?.entries ?? []) cacheEntry(entry);
}

function closeViewer() {
    showToken += 1;
    const gallery = globalThis.mainGallery;
    if (!gallery?.replaceAll || !viewerSaved) return;
    const entries = [...viewerSaved.entries, ...arrived];
    gallery.replaceAll(entries, arrived.length ? entries.length - 1 : viewerSaved.index);
    gallery.setMarkedPath?.('');
    viewerSaved = null;
    arrived = [];
}

// an image landed: a trial run's goes into its scene's history; the viewer keeps showing
// the scene on show only
function onGalleryAppend(event) {
    if (!active) return;
    const detail = event.detail ?? {};
    arrived.push(detail);
    const record = detail.record;
    // Run's images (the whole sequence) stay on show as they land, beside the scene's own
    if (record?.recipe?.run?.sequence) return;
    const sceneId = String(record?.recipe?.run?.sequenceScene ?? '');
    const file = String(record?.path ?? '');
    if (sceneId === active.sceneId && !file) return;   // not saved: it stays on show for now
    if (sceneId && file) {
        cacheEntry(detail);
        updateCurrent(current => {
            const scene = current.scenes.find(item => item.id === sceneId);
            if (scene) scene.history = addToHistory(scene.history, file);
        });
    }
    const shown = globalThis.mainGallery?.currentEntry?.()?.record?.path ?? '';
    showScene(sceneId === active.sceneId ? 'latest' : (shown || 'adopted'));
}

// ------------------------------------------------------------------ actions

async function makeThumb(dataUrl) {
    if (!dataUrl) return '';
    const image = new Image();
    image.src = dataUrl;
    await image.decode();
    const scale = THUMB_HEIGHT / Math.max(1, image.naturalHeight);
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
    canvas.height = THUMB_HEIGHT;
    const context = canvas.getContext('2d');
    context.imageSmoothingQuality = 'high';
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/jpeg', 0.88);
}

/** "Save to <scene>": the scene adopts the shown image (its settings, a thumbnail, its file), and the screen follows. */
async function saveShownImage() {
    if (!active || Date.now() < doneUntil) return;
    const settings = shownSceneSettings();
    if (!settings) return;
    const entry = globalThis.mainGallery?.currentEntry?.();
    const file = String(entry?.record?.path ?? '');
    let thumb = '';
    try { thumb = await makeThumb(entry?.image); } catch (error) { console.warn(CAT, 'thumbnail failed', error); }
    const sceneId = active.sceneId;
    clearTimeout(syncTimer);
    await putOnScreen(settings);
    // the screen's form of those settings (what the next edit compares with)
    const stored = captureSceneSettings() ?? settings;
    updateCurrent(current => {
        const scene = current.scenes.find(item => item.id === sceneId);
        if (!scene) return;
        scene.settings = stored;
        if (thumb) scene.thumb = thumb;
        if (file) {
            scene.image = file;
            scene.history = addToHistory(scene.history, file);
        }
    });
    if (file) globalThis.mainGallery?.setMarkedPath?.(file);
    flashDone();
}

function step(delta) {
    if (!active) return;
    const scenes = currentSequence().scenes;
    const target = scenes[sceneIndex(active.sceneId) + delta];
    if (target) switchTo(target.id);
}

// the backup names the scene on the screen: closing the app keeps the mode (resumeEditMode)
function storeBackup() {
    if (!active) return;
    setEditBackup({ settings: active.backup, sceneId: active.sceneId });
    globalThis.sequenceBatch?.setLastScene?.(active.sceneId);
}

async function switchTo(sceneId) {
    const scene = sceneById(sceneId);
    if (!active || !scene) return;
    syncNow();
    active.sceneId = sceneId;
    storeBackup();
    await takeScene(scene);
    decorate();
    await showScene('adopted');
}

// the scene goes on the screen; a scene without settings yet takes the screen's
async function takeScene(scene) {
    if (scene.settings) {
        await putOnScreen(scene.settings);
        return;
    }
    const settings = captureSceneSettings();
    updateCurrent(current => {
        const entry = current.scenes.find(item => item.id === scene.id);
        if (entry) entry.settings = settings;
    });
}

/** Start editing one scene (or switch to it while the mode runs). */
export async function enterEditMode(sceneId) {
    const scene = sceneById(sceneId);
    if (!scene) return;
    if (active) {
        if (active.sceneId !== sceneId) await switchTo(sceneId);
        return;
    }
    const backup = captureSceneSettings();
    if (!backup) return;
    active = { sceneId, backup, index: sceneIndex(sceneId) };
    storeBackup();
    document.body.classList.add('sequence-editing');
    await takeScene(scene);
    startMode();
}

function startMode() {
    poll = setInterval(refreshSaveButton, 400);
    decorate();
    openViewer();
    return showScene('adopted');
}

/**
 * On start, after the app was closed in edit mode: the mode comes back on the scene it had.
 * The screen is that scene (its settings were saved with the screen), and the newest of
 * the two: an edit made just before closing may not have reached the scene yet.
 * False when the backup names no scene of the open sequence.
 */
export async function resumeEditMode(backup) {
    const normalized = normalizeEditBackup(backup);
    const scene = normalized?.settings && normalized.sceneId ? sceneById(normalized.sceneId) : null;
    if (!scene || active) return false;
    active = { sceneId: scene.id, backup: normalized.settings, index: sceneIndex(scene.id) };
    document.body.classList.add('sequence-editing');
    const settings = captureSceneSettings();
    if (settings) {
        updateCurrent(current => {
            const entry = current.scenes.find(item => item.id === scene.id);
            if (entry) entry.settings = settings;
        });
    }
    globalThis.settingsPersistence?.history?.clear?.(['prompt', 'generation', 'lora']);
    await startMode();
    console.log(CAT, `back in edit mode on ${sceneLabel(scene.id)}`);
    return true;
}

/** End the mode: the screen gets its own settings back. */
export async function exitEditMode() {
    if (!active) return;
    syncNow();
    const { backup } = active;
    clearInterval(poll);
    poll = null;
    undecorate();
    document.body.classList.remove('sequence-editing');
    active = null;
    closeViewer();
    await putOnScreen(backup);
    setEditBackup(null);
}

/**
 * Another sequence is about to be loaded: the scene on the screen is not one of it, even
 * when it shares an id (a copy saved under another name). Nothing goes into it any more,
 * and the change that follows puts the loaded sequence's first scene on the screen.
 */
export function detachEditMode() {
    if (!active) return;
    clearTimeout(syncTimer);
    syncTimer = null;
    active.sceneId = '';
    active.index = 0;
}

/** After a crash in edit mode: the screen's own settings, kept in sequences.json, go back. */
export async function recoverEditBackup(backup) {
    const normalized = normalizeEditBackup(backup);
    if (!normalized) return;
    const settings = normalized.settings ?? applyLegacyTexts(captureSceneSettings() ?? {}, normalized.texts);
    await putOnScreen(settings);
    setEditBackup(null);
    console.log(CAT, 'restored the screen after an edit mode that did not end');
}

export function setupSequenceEdit() {
    for (const type of ['input', 'change', 'click', 'mytextbox-value-set']) document.addEventListener(type, scheduleSync, true);
    for (const type of ['saa-edit-history-changed', 'saa-settings-applied']) document.addEventListener(type, scheduleSync);
    document.addEventListener(GALLERY_APPEND_EVENT, onGalleryAppend);
    // the scene on the screen was deleted, or another sequence was loaded: the mode moves to
    // the scene now where it sat (the last one when it sat further), and ends with no scene left
    onSequenceChange(async () => {
        if (!active || moving) return;
        if (sceneById(active.sceneId)) { decorate(); return; }
        const scenes = currentSequence().scenes;
        if (!scenes.length) { await exitEditMode(); return; }
        moving = true;
        try {
            const target = scenes[Math.min(Math.max(0, active.index ?? 0), scenes.length - 1)];
            await switchTo(target.id);
        } finally {
            moving = false;
        }
    });
    // closing the app: the last edit goes into the scene now, not after the debounce
    globalThis.addEventListener('beforeunload', () => syncNow());
    globalThis.sequenceEdit = {
        isActive: () => Boolean(active),
        sceneId: () => active?.sceneId ?? null,
        enter: enterEditMode,
        exit: exitEditMode,
        detach: detachEditMode,
        recover: recoverEditBackup,
        resume: resumeEditMode,
    };
}
