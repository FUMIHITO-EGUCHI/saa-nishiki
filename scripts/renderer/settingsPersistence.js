// Renderer glue for the sectioned settings (SAA-settings-split.md):
//   - wraps globalThis.globalSettings in a Proxy so every write marks its section dirty,
//   - autosaves app.json / state.json through the preload API (debounced, flushed on unload),
//   - mounts one preset control per preset section and applies loaded presets to the UI.
// UI refresh functions are injected from renderer.js to keep this module free of the
// language.js / callbacks.js import tangle.
import { PRESET_SECTIONS, SECTION_KEYS, clone, pickSection, sectionOf } from '../shared/settingsSections.js';
import { createAutosave, createSettingsProxy } from './tools/settingsAutosave.js';
import { createPresetControl } from './components/presetControl.js';
import { showDialog } from './components/myDialog.js';

const CAT = '[SettingsPersistence]';
const SLOT_CONTAINERS = { lora: '.add-lora-main', adetailer: '.adetailer-main', controlnet: '.controlnet-main' };
const SECTION_LABEL_KEYS = { prompt: 'ui_section_prompt', generation: 'ui_section_generation', lora: 'ui_section_lora', adetailer: 'ui_section_adetailer', controlnet: 'ui_section_controlnet' };
const SECTION_LABEL_FALLBACK = { prompt: 'Prompt', generation: 'Generation', lora: 'LoRA', adetailer: 'ADetailer', controlnet: 'ControlNet' };

let raw = null;          // the plain object behind the proxy
let autosave = null;
let hooks = {};
let controls = new Map();
let savedTimer = null;

function lang() {
    return globalThis.cachedFiles?.language?.[globalThis.globalSettings?.language] ?? {};
}

function uiText(key, fallback) {
    const value = lang()[key];
    return typeof value === 'string' && value ? value : fallback;
}

/** Call once, right after `globalThis.globalSettings` is loaded from main. */
export function installSettingsProxy(settings) {
    raw = settings && typeof settings === 'object' ? settings : {};
    autosave = createAutosave({
        sectionOf,
        collect: collectSection,
        save: async payload => Boolean(await globalThis.api?.saveSettingsSections?.(payload)),
        saveSync: payload => Boolean(globalThis.api?.saveSettingsSectionsSync?.(payload)),
        onSaved: showSaved,
        onError: (error, sections) => console.warn(CAT, 'autosave failed for', sections, error?.message ?? error),
    });
    const proxy = createSettingsProxy(raw, key => autosave.markDirty(key));
    globalThis.globalSettings = proxy;
    globalThis.settingsAutosave = autosave;
    return proxy;
}

function weightsFromLists() {
    const view = globalThis.viewList;
    const chars = globalThis.characterList;
    const regional = globalThis.characterListRegional;
    const number = value => { const parsed = Number.parseFloat(value); return Number.isFinite(parsed) ? parsed : 1; };
    if (!view?.getTextValue || !chars?.getTextValue || !regional?.getTextValue) return null;
    try {
        // Slots 2-3 belonged to the retired Background / Style dropdown columns; kept as 1
        // so the stored array shape stays compatible.
        return [
            number(view.getTextValue(0)), number(view.getTextValue(1)), 1, 1,
            number(chars.getTextValue(0)), number(chars.getTextValue(1)), number(chars.getTextValue(2)),
            number(regional.getTextValue(0)), number(regional.getTextValue(1)),
        ];
    } catch {
        return null;
    }
}

/** Current data of one section, refreshing the keys that live outside globalSettings (slots, list weights, heights). */
export function collectSection(section) {
    if (!raw) return {};
    try {
        if (section === 'lora' && globalThis.lora?.getValues) raw.lora_slot = globalThis.lora.getValues();
        if (section === 'adetailer' && globalThis.aDetailer?.getValues) raw.ad_slot = globalThis.aDetailer.getValues();
        if (section === 'controlnet' && globalThis.controlnet?.getValues) {
            raw.controlnet_slot = globalThis.controlnet.getValues(false).map(row => [...row.slice(0, 7), null]);
        }
        if (section === 'prompt') {
            const weights = weightsFromLists();
            if (weights) raw.weights4dropdownlist = weights;
        }
        if (section === 'app' && typeof hooks.getTextboxHeights === 'function' && globalThis.prompt) {
            const heights = hooks.getTextboxHeights();
            if (Array.isArray(heights)) raw.ptompt_textbox_heights = heights;
        }
    } catch (error) {
        console.warn(CAT, `collect ${section}:`, error);
    }
    return pickSection(raw, section, { warn: message => console.warn(CAT, message) });
}

/** Write a section's data into globalSettings and refresh the UI that shows it. */
export function applySectionData(section, data) {
    if (!raw || !SECTION_KEYS[section]) return false;
    for (const key of SECTION_KEYS[section]) {
        if (Object.hasOwn(data ?? {}, key)) raw[key] = clone(data[key]);
    }
    autosave?.markDirty(section);
    try {
        if (section === 'prompt' || section === 'generation') hooks.updateSettings?.();
        if (section === 'lora' || section === 'adetailer') hooks.flushSlots?.();
        if (section === 'adetailer') globalThis.generate?.adetailer?.setValue?.(raw.api_adetailer_enable);
        if (section === 'controlnet') {
            globalThis.controlnet?.flush?.();
            globalThis.generate?.controlnet?.setValue?.(raw.api_controlnet_enable);
        }
    } catch (error) {
        console.error(CAT, `apply ${section}: UI refresh failed`, error);
    }
    document.dispatchEvent(new CustomEvent('saa-settings-applied', { detail: { section } }));
    return true;
}

function presetText(section) {
    const sectionLabel = uiText(SECTION_LABEL_KEYS[section], SECTION_LABEL_FALLBACK[section]);
    return {
        sectionLabel,
        placeholder: uiText('ui_preset_placeholder', 'Preset…'),
        save: uiText('ui_preset_save', 'Save preset'),
        delete: uiText('ui_preset_delete', 'Delete preset'),
        saveTitle: uiText('ui_preset_save_title', 'Save {0} preset\nName:'),
        saved: uiText('ui_preset_saved', '{0} preset "{1}" saved'),
        saveFailed: uiText('ui_preset_save_failed', 'Failed to save {0} preset "{1}"'),
        deleteTitle: uiText('ui_preset_delete_title', 'Delete {0} preset "{1}"?'),
        deleted: uiText('ui_preset_deleted', '{0} preset "{1}" deleted'),
        deleteFailed: uiText('ui_preset_delete_failed', 'Failed to delete {0} preset "{1}"'),
        loadFailed: uiText('ui_preset_load_failed', 'Failed to load {0} preset "{1}"'),
        yes: uiText('setup_yes', 'Yes'),
        no: uiText('setup_no', 'No'),
    };
}

function mountPresetControls() {
    const api = globalThis.api;
    if (!api?.listPresets) return;
    for (const section of PRESET_SECTIONS) {
        const host = document.querySelector(`[data-preset-host="${section}"]`);
        if (!host) { console.warn(CAT, `no preset host for ${section}`); continue; }
        const control = createPresetControl({
            section,
            host,
            text: () => presetText(section),
            list: () => api.listPresets(section),
            save: (name, data) => api.savePreset(section, name, data),
            load: name => api.loadPreset(section, name),
            remove: name => api.deletePreset(section, name),
            getCurrent: () => globalThis.globalSettings?.preset_current?.[section] ?? '',
            setCurrent: name => {
                globalThis.globalSettings.preset_current = { ...(raw.preset_current ?? {}), [section]: name ?? '' };
            },
            collect: () => collectSection(section),
            apply: data => applySectionData(section, data),
            dialog: {
                input: options => showDialog('input', options),
                confirm: options => showDialog('confirm', options),
                info: options => showDialog('info', options),
            },
        });
        if (control) controls.set(section, control);
    }
}

function watchSlots() {
    for (const [section, selector] of Object.entries(SLOT_CONTAINERS)) {
        const container = document.querySelector(selector);
        if (!container) continue;
        const mark = () => autosave?.markDirty(section);
        for (const type of ['input', 'change', 'click']) container.addEventListener(type, mark);
        new MutationObserver(mark).observe(container, { childList: true, subtree: true });
    }
    for (const selector of ['.dropdown-view', '.dropdown-character', '.dropdown-character-regional']) {
        const container = document.querySelector(selector);
        if (!container) continue;
        const mark = () => autosave?.markDirty('prompt');
        container.addEventListener('change', mark);
        container.addEventListener('input', mark);
    }
    if (typeof hooks.getTextboxHeights === 'function') {
        document.addEventListener('pointerup', () => {
            if (!globalThis.prompt) return;
            try {
                const heights = hooks.getTextboxHeights();
                const stored = raw.ptompt_textbox_heights;
                if (Array.isArray(heights) && JSON.stringify(heights) !== JSON.stringify(stored)) globalThis.globalSettings.ptompt_textbox_heights = heights;
            } catch { /* ignore */ }
        });
    }
}

function showSaved() {
    const element = document.getElementById('run-saved');
    if (!element) return;
    const stamp = new Date();
    const hh = String(stamp.getHours()).padStart(2, '0');
    const mm = String(stamp.getMinutes()).padStart(2, '0');
    const ss = String(stamp.getSeconds()).padStart(2, '0');
    element.textContent = `${uiText('ui_saved', 'Saved')} · ${hh}:${mm}:${ss}`;
    element.hidden = false;
    if (savedTimer) clearTimeout(savedTimer);
    savedTimer = setTimeout(() => { element.hidden = true; }, 2000);
}

/**
 * Call after the whole UI exists. `uiHooks`: { updateSettings, flushSlots, getTextboxHeights }.
 */
export function setupSettingsPersistence(uiHooks = {}) {
    hooks = uiHooks;
    if (!autosave) throw new Error('installSettingsProxy() must run before setupSettingsPersistence()');
    mountPresetControls();
    watchSlots();
    document.getElementById('settings-open-folder')?.addEventListener('click', () => globalThis.api?.openSettingsFolder?.());
    globalThis.addEventListener('beforeunload', () => { autosave.flushSync(); });
    autosave.enable(true);
    globalThis.settingsPersistence = { flush: () => autosave.flush(), collectSection, applySectionData, updateLanguage, controls };
    return globalThis.settingsPersistence;
}

export function updateLanguage() {
    for (const control of controls.values()) control.updateLanguage();
}
