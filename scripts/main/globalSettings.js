// Main-process settings glue: owns the SettingsStore (settings/app.json, state.json, presets/)
// and exposes it over IPC. The flat `globalSettings` object other main modules read
// (backendStatus, comfyRelease, modelList, wsService) is the merge of app + state.
// Defaults, sections and normalization live in ../shared/settingsSections.js.
import { app, ipcMain, shell } from 'electron';
import path from 'node:path';
import * as fs from 'node:fs';
import { loadJSONFile } from './fileHandlers.js';
import { createSettingsStore } from './settingsStore.js';
import { resolveRefineSystemPrompt } from '../aiPromptRefiner.js';

const CAT = '[GlobalSettings]';
const appPath = app.isPackaged ? path.join(path.dirname(app.getPath('exe')), 'resources', 'app') : app.getAppPath();
const settingsRoot = path.join(appPath, 'settings');

let store = null;
let globalSettings = null;

function refreshMerged() {
    globalSettings = store.getMerged();
    globalSettings.ai_refine_system_prompt = resolveRefineSystemPrompt(globalSettings.ai_refine_system_prompt);
    return globalSettings;
}

function setupGlobalSettings() {
    store = createSettingsStore({ rootDir: settingsRoot, saaVersion: app.getVersion?.() ?? undefined, log: console });
    const stashed = store.stashLegacy();
    if (stashed.length) console.log(CAT, `Pre-split settings moved to settings/legacy: ${stashed.join(', ')}`);
    refreshMerged();

    ipcMain.handle('get-global-settings', async () => getGlobalSettings());

    // { app?: {...}, prompt?: {...}, generation?: {...}, lora?: {...}, adetailer?: {...}, controlnet?: {...} }
    ipcMain.handle('save-settings-sections', async (event, sections) => saveSections(sections));
    ipcMain.on('save-settings-sections-sync', (event, sections) => {
        event.returnValue = saveSections(sections);
    });

    ipcMain.handle('list-presets', async (event, section) => store.listPresets(section));
    ipcMain.handle('save-preset', async (event, section, name, data) => store.savePreset(section, name, data));
    ipcMain.handle('load-preset', async (event, section, name) => store.loadPreset(section, name));
    ipcMain.handle('delete-preset', async (event, section, name) => store.deletePreset(section, name));
    ipcMain.handle('open-settings-folder', async () => {
        fs.mkdirSync(settingsRoot, { recursive: true });
        const result = await shell.openPath(settingsRoot);
        return result === '';
    });

    ipcMain.handle('update-all-miraitu-setting-files', async () => updateMiraITUSettingFiles());
    ipcMain.handle('load-miraitu-setting-file', async (event, fineName) => loadMiraITUSettings(fineName));
    ipcMain.handle('save-miraitu-setting-file', async (event, fineName, settings) => saveMiraITUSettings(fineName, settings));

    return globalSettings;
}

function saveSections(sections) {
    if (!sections || typeof sections !== 'object') {
        console.error(CAT, 'save-settings-sections: payload must be an object');
        return false;
    }
    try {
        store.saveSections(sections);
        refreshMerged();
        return true;
    } catch (error) {
        console.error(CAT, `save-settings-sections failed: ${error.message}`);
        return false;
    }
}

function getGlobalSettings() {
    return globalSettings;
}

function getSettingsStore() {
    return store;
}

// ---------------------------------------------------------------- MiraITU (separate file family, unchanged)

function updateMiraITUSettingFiles() {
    const miraSettingsDir = path.join(settingsRoot, 'MiraITU');
    let jsonFiles = [];

    try {
        if (!fs.existsSync(miraSettingsDir)) {
            fs.mkdirSync(miraSettingsDir, { recursive: true });
            console.log(CAT, `Created MiraITU settings directory: ${miraSettingsDir}`);
        }
        const files = fs.readdirSync(miraSettingsDir);
        jsonFiles = files.filter(file => file.toLowerCase().endsWith('.json'));
    } catch (err) {
        console.error(CAT, `Failed to enumerate MiraITU settings directory: ${miraSettingsDir}`, err);
    }
    return jsonFiles;
}

function loadMiraITUSettings(fineName) {
    const miraSettingsDir = path.join(settingsRoot, 'MiraITU', fineName);
    console.log(CAT, `Loading MiraITU settings from ${miraSettingsDir}`);
    const mySettings = loadJSONFile(miraSettingsDir);
    if (mySettings) {
        return mySettings;
    }

    console.error(CAT, `Failed to load MiraITU settings directory: ${miraSettingsDir}`);
    return null;
}

function saveMiraITUSettings(fineName, settings) {
    if (!fineName || typeof fineName !== 'string' || !fineName.toLowerCase().endsWith('.json')) {
        console.error(CAT, `Invalid filename: "${fineName}". Must be a non-empty string ending with .json`);
        return false;
    }
    if (!settings || typeof settings !== 'object') {
        console.error(CAT, `Invalid settings: must be a non-null object`);
        return false;
    }
    const miraSettingsDir = path.join(settingsRoot, 'MiraITU', fineName.replaceAll(/[/|\\:*?"<>]/g, " "));
    const miraSettingsParentDir = path.join(settingsRoot, 'MiraITU');
    try {
        if (!fs.existsSync(miraSettingsParentDir)) {
            fs.mkdirSync(miraSettingsParentDir, { recursive: true });
            console.log(CAT, `Created MiraITU settings directory: ${miraSettingsParentDir}`);
        }
        if (fs.existsSync(miraSettingsDir)) {
            fs.unlinkSync(miraSettingsDir);
            console.log(CAT, `Deleted existing file: ${miraSettingsDir}`);
        }
        const settingsJson = JSON.stringify(settings, null, 2);
        fs.writeFileSync(miraSettingsDir, settingsJson, 'utf8');
        console.log(CAT, `Successfully saved MiraITU settings to: ${miraSettingsDir}`);
        return true;
    } catch (err) {
        console.error(CAT, `Failed to save MiraITU settings to ${miraSettingsDir}: ${err.message}`);
        return false;
    }
}

export {
    setupGlobalSettings,
    getGlobalSettings,
    getSettingsStore,
    saveSections,
    updateMiraITUSettingFiles,
    loadMiraITUSettings,
    saveMiraITUSettings,
};
