// Sequence edit mode (docs/sequence-batch-plan.md D18 / D19 / D25): one scene of the open
// sequence sits in its prompt field in the usual screen. The field's text IS the scene's
// text while the mode runs (every edit goes straight into the scene); the field's own text
// is kept aside and comes back when the mode ends. A strip above Prompts names the
// sequence and the scene, ‹ › step through the scenes and the scene button opens the
// Sequence dialog; the viewer's "Save to <scene>" takes the shown image's text and a
// thumbnail into the scene. Trial runs use slot 1 only and never Regional.
import { element, iconButton } from './dom.js';
import { iconElement } from '../shared/iconSet.js';
import { builtinSceneSetting, readSceneText } from '../shared/sequenceBatch.js';
import { currentSequence, onSequenceChange, openSequenceDialog, sceneFieldLabel, setEditBackup, updateCurrent } from './sequenceBatchUi.js';
import { loraPromptTags, openLoraPicker } from './loraUi.js';

const CAT = '[SequenceEdit]';
const BUILTIN_CONTAINERS = { views: '.prompt-view', background: '.prompt-background', style: '.prompt-style' };
const THUMB_HEIGHT = 128;

let active = null;          // { sceneId, fieldKey, backupText }
let applying = false;       // the mode is writing the field itself
let observer = null;
let poll = null;
let syncTimer = null;
let decorateQueued = false;

function text(key, fallback) {
    const value = globalThis.cachedFiles?.language?.[globalThis.globalSettings?.language]?.[key];
    return typeof value === 'string' && value ? value : fallback;
}

// ------------------------------------------------------------------ the scene field

function fieldContainer(fieldKey) {
    if (BUILTIN_CONTAINERS[fieldKey]) return document.querySelector(BUILTIN_CONTAINERS[fieldKey]);
    return document.querySelector(`.prompt-fields [data-field-id="${CSS.escape(fieldKey)}"]`);
}

function readFieldText(fieldKey) {
    const control = globalThis.prompt?.[fieldKey];
    if (control?.getValue) return String(control.getValue() ?? '');
    const SETTINGS = globalThis.globalSettings ?? {};
    return readSceneText(SETTINGS, fieldKey) ?? '';
}

function transaction(source, mutate) {
    const run = globalThis.settingsPersistence?.runEditTransaction;
    return run ? run({ source, sections: ['prompt'] }, mutate) : mutate();
}

/** Put `value` into the scene field: the settings first (the source of truth), then the textbox. */
function writeFieldText(fieldKey, value) {
    const SETTINGS = globalThis.globalSettings;
    const setting = builtinSceneSetting(fieldKey);
    applying = true;
    try {
        if (setting) {
            SETTINGS[setting] = value;
        } else {
            SETTINGS.prompt_custom_fields = (Array.isArray(SETTINGS.prompt_custom_fields) ? SETTINGS.prompt_custom_fields : [])
                .map(field => (field?.id === fieldKey ? { ...field, text: value } : field));
            globalThis.prompt?.fieldManager?.refresh?.();
        }
        const control = globalThis.prompt?.[fieldKey];
        if (control?.setValue && String(control.getValue?.() ?? '') !== value) control.setValue(value);
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

// the field changed (typing, a chip, an undo): the scene follows
function scheduleSync() {
    if (!active || applying) return;
    clearTimeout(syncTimer);
    syncTimer = setTimeout(() => {
        if (!active || applying) return;
        const value = readFieldText(active.fieldKey);
        const scene = sceneById(active.sceneId);
        if (scene && scene.text !== value) updateCurrent(current => { const entry = current.scenes.find(item => item.id === active.sceneId); if (entry) entry.text = value; });
    }, 150);
}

function onFieldEvent(event) {
    if (!active) return;
    const container = fieldContainer(active.fieldKey);
    if (container?.contains(event.target)) scheduleSync();
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
        const field = element('span', 'sequence-strip-field');
        const prev = iconButton('chevron-left', text('seq_prev', 'Previous scene'), { size: 26, onClick: () => step(-1) });
        prev.classList.add('sequence-strip-prev');
        const current = element('button', 'sequence-strip-current');
        current.type = 'button';
        current.setAttribute('aria-haspopup', 'dialog');
        current.addEventListener('click', () => openSequenceDialog({ page: 'scenes', trigger: current }));
        const next = iconButton('chevron-right', text('seq_next_scene', 'Next scene'), { size: 26, onClick: () => step(1) });
        next.classList.add('sequence-strip-next');
        strip.append(mark, name, field, prev, current, next);
        document.getElementById('prompt-text-container')?.before(strip);
    }
    const sequence = currentSequence();
    const index = sceneIndex(active.sceneId);
    const scene = sceneById(active.sceneId);
    strip.querySelector('.sequence-strip-name').textContent = sequence.name || text('seq_unsaved', 'Unsaved');
    strip.querySelector('.sequence-strip-field').textContent = sceneFieldLabel(active.fieldKey);
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

function decorateField() {
    document.querySelectorAll('.is-sequence-field').forEach(node => { if (node !== fieldContainer(active.fieldKey)) node.classList.remove('is-sequence-field'); });
    const container = fieldContainer(active.fieldKey);
    if (!container) return;
    container.classList.add('is-sequence-field');
    const header = container.querySelector('.tag-field-header') ?? container.querySelector('div[class*="-header"]');
    let pill = container.querySelector('.sequence-field-pill');
    if (header && !pill) {
        pill = element('span', 'sequence-field-pill');
        header.append(element('span', 'sequence-field-break'), pill);
    }
    if (pill && pill.textContent !== sceneLabel(active.sceneId)) pill.textContent = sceneLabel(active.sceneId);
    // "+ LoRA" next to the scene's name: the scene's own LoRA goes into its text
    if (header && !container.querySelector('.sequence-lora-add')) {
        const add = element('button', 'sequence-lora-add');
        add.type = 'button';
        add.append(iconElement('plus', 12), element('span', '', 'LoRA'));
        add.setAttribute('aria-label', 'LoRA');
        add.addEventListener('click', event => { event.stopPropagation(); addSceneLora(add); });
        header.append(add);
    }
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

/** The scene field's text in the image on show (its recipe), or null. */
function shownSceneText() {
    const entry = globalThis.mainGallery?.currentEntry?.();
    const prompt = entry?.record?.recipe?.sections?.prompt;
    return readSceneText(prompt, active?.fieldKey);
}

function refreshSaveButton() {
    if (!active) return;
    const button = saveButton();
    if (!button) return;
    const label = `${text('seq_save_to', 'Save to')} ${sceneLabel(active.sceneId)}`;
    if (button.dataset.label !== label) {
        button.dataset.label = label;
        button.replaceChildren(iconElement('put-in', 14), element('span', '', label));
    }
    button.disabled = shownSceneText() === null;
    button.hidden = !globalThis.mainGallery?.currentEntry?.();
}

function decorate() {
    if (!active) return;
    decorateQueued = false;
    observer?.disconnect();
    try {
        buildStrip();
        decorateField();
        decorateCharacters();
        refreshSaveButton();
    } finally {
        const card = document.getElementById('prompt-text-container');
        if (card) observer?.observe(card, { childList: true, subtree: true });
    }
}

function queueDecorate() {
    if (decorateQueued) return;
    decorateQueued = true;
    requestAnimationFrame(decorate);
}

function undecorate() {
    stripElement()?.remove();
    document.querySelectorAll('.is-sequence-field').forEach(node => node.classList.remove('is-sequence-field'));
    document.querySelectorAll('.sequence-field-pill, .sequence-field-break, .sequence-lora-add').forEach(node => node.remove());
    document.getElementById('sequence-save-scene')?.remove();
    undecorateCharacters();
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
    canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/jpeg', 0.8);
}

/** "Save to <scene>": the shown image's scene text and a thumbnail go into the scene, and the field follows. */
async function saveShownImage() {
    if (!active) return;
    const value = shownSceneText();
    if (value === null) return;
    const entry = globalThis.mainGallery?.currentEntry?.();
    let thumb = '';
    try { thumb = await makeThumb(entry?.image); } catch (error) { console.warn(CAT, 'thumbnail failed', error); }
    const sceneId = active.sceneId;
    updateCurrent(current => {
        const scene = current.scenes.find(item => item.id === sceneId);
        if (!scene) return;
        scene.text = value;
        if (thumb) scene.thumb = thumb;
    });
    if (readFieldText(active.fieldKey) !== value) await transaction('sequence-save-to-scene', () => writeFieldText(active.fieldKey, value));
}

function addSceneLora(trigger) {
    openLoraPicker({
        trigger,
        onPick: async names => {
            if (!active) return;
            const { tags, triggers } = loraPromptTags(names);
            const current = readFieldText(active.fieldKey).trim().replace(/,\s*$/, '');
            const additions = [...triggers, ...tags].filter(item => !current.includes(item));
            if (!additions.length) return;
            const value = [current, ...additions].filter(Boolean).join(', ');
            await transaction('sequence-scene-lora', () => writeFieldText(active.fieldKey, value));
            scheduleSync();
        },
    });
}

function step(delta) {
    if (!active) return;
    const scenes = currentSequence().scenes;
    const target = scenes[sceneIndex(active.sceneId) + delta];
    if (target) switchTo(target.id);
}

async function switchTo(sceneId) {
    const scene = sceneById(sceneId);
    if (!active || !scene) return;
    active.sceneId = sceneId;
    await transaction('sequence-edit', () => writeFieldText(active.fieldKey, scene.text));
    decorate();
}

/** Start editing one scene (or switch to it while the mode runs). */
export async function enterEditMode(sceneId) {
    const sequence = currentSequence();
    const scene = sceneById(sceneId);
    if (!scene || !sequence.field) return;
    if (active) {
        if (active.fieldKey === sequence.field) { await switchTo(sceneId); return; }
        await exitEditMode();
    }
    const backupText = readFieldText(sequence.field);
    setEditBackup({ fieldKey: sequence.field, text: backupText });
    active = { sceneId, fieldKey: sequence.field, backupText };
    document.body.classList.add('sequence-editing');
    await transaction('sequence-edit', () => writeFieldText(active.fieldKey, scene.text));
    observer = new MutationObserver(queueDecorate);
    poll = setInterval(refreshSaveButton, 400);
    decorate();
}

/** End the mode: the field gets its own text back. */
export async function exitEditMode() {
    if (!active) return;
    const { fieldKey, backupText } = active;
    clearTimeout(syncTimer);
    observer?.disconnect();
    observer = null;
    clearInterval(poll);
    poll = null;
    undecorate();
    document.body.classList.remove('sequence-editing');
    active = null;
    await transaction('sequence-edit', () => writeFieldText(fieldKey, backupText));
    setEditBackup(null);
}

/** After a crash in edit mode: the field's own text, kept in sequences.json, goes back. */
export async function recoverEditBackup(backup) {
    if (!backup?.fieldKey) return;
    await transaction('sequence-edit', () => writeFieldText(backup.fieldKey, backup.text ?? ''));
    setEditBackup(null);
    console.log(CAT, `restored ${backup.fieldKey} after an edit mode that did not end`);
}

export function setupSequenceEdit() {
    document.addEventListener('input', onFieldEvent, true);
    document.addEventListener('mytextbox-value-set', onFieldEvent, true);
    onSequenceChange(() => {
        if (!active) return;
        if (!sceneById(active.sceneId) || currentSequence().field !== active.fieldKey) { exitEditMode(); return; }
        decorate();
    });
    globalThis.sequenceEdit = {
        isActive: () => Boolean(active),
        sceneId: () => active?.sceneId ?? null,
        enter: enterEditMode,
        exit: exitEditMode,
        recover: recoverEditBackup,
    };
}
