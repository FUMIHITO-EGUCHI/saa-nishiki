// Source-level checks for the sectioned settings wiring (SAA-settings-split.md):
// legacy profile code is gone, every preset section has a host in the DOM, the
// preload exposes the new API, and main.js still reads the merged settings.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { PRESET_SECTIONS } from '../scripts/shared/settingsSections.js';

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.join(testDirectory, '..');
const read = relativePath => fs.readFileSync(path.join(projectRoot, relativePath), 'utf8');

test('legacy whole-file profile code is removed from the renderer', () => {
    const collapsed = read('scripts/renderer/components/myCollapsed.js');
    assert.doesNotMatch(collapsed, /setupSaveSettingsToggle|setupDeleteSettingsToggle|settingList|lastLoadedSettings/);
    assert.doesNotMatch(collapsed, /collapsedTabs\.modelSettings|reloadFiles\(true\)/);
    const callbacks = read('scripts/renderer/callbacks.js');
    assert.doesNotMatch(callbacks, /callback_mySettingList|lastLoadedSettings|loadSettingFile/);
    const renderer = read('scripts/renderer.js');
    assert.doesNotMatch(renderer, /saveSettingFile|getSettingFiles|callback_mySettingList|lastLoadedSettings/);
    assert.match(renderer, /installSettingsProxy\(await globalThis\.api\.getGlobalSettings\(\)\)/);
    assert.match(renderer, /setupSettingsPersistence\(\{ updateSettings, flushSlots, getTextboxHeights: get_prompt_textBox_Heights \}\)/);
    const language = read('scripts/renderer/language.js');
    assert.doesNotMatch(language, /dropdownList\.settings|headerIcon\.save|headerIcon\.delete/);
    assert.match(language, /positive_right\.setValue\(SETTINGS\.api_prompt_right\)/, 'regional_api_prompt_right typo fixed');
});

test('preload exposes the sectioned settings API and nothing of the old one', () => {
    const preload = read('scripts/preload.js');
    for (const name of ['saveSettingsSections', 'saveSettingsSectionsSync', 'listPresets', 'savePreset', 'loadPreset', 'deletePreset', 'openSettingsFolder']) {
        assert.match(preload, new RegExp(`\\b${name}:`), name);
    }
    assert.doesNotMatch(preload, /save-setting-file|load-setting-file|get-all-settings-files/);
    const main = read('scripts/main/globalSettings.js');
    for (const channel of ['save-settings-sections', 'save-settings-sections-sync', 'list-presets', 'save-preset', 'load-preset', 'delete-preset', 'open-settings-folder']) {
        assert.match(main, new RegExp(`'${channel}'`), channel);
    }
    assert.match(main, /createSettingsStore\(/);
    assert.match(main, /stashLegacy\(\)/);
    assert.doesNotMatch(read('scripts/webserver/back/wsService.js'), /loadSettingFile|saveSettingFile|deleteSettingFile|getSettingFiles/);
});

test('every preset section has a host in the shared body and the header lost the profile controls', () => {
    const html = read('scripts/html_shared_body.js');
    for (const section of PRESET_SECTIONS) {
        assert.match(html, new RegExp(`data-preset-host="${section}"`), section);
    }
    assert.doesNotMatch(html, /settings-select|settings-save-toggle|settings-delete-toggle/);
    assert.match(html, /id="run-saved"/);
    assert.match(html, /id="settings-open-folder"/);
});

test('slots participate: ControlNet has flush(), slotsManager restores it, persistence collects all three', () => {
    assert.match(read('scripts/renderer/slots/myControlNetSlot.js'), /flush\(\) \{[\s\S]*controlnet_slot/);
    assert.match(read('scripts/renderer/slots/slotsManager.js'), /globalThis\.controlnet\.flush\(\)/);
    const persistence = read('scripts/renderer/settingsPersistence.js');
    assert.match(persistence, /raw\.lora_slot = globalThis\.lora\.getValues\(\)/);
    assert.match(persistence, /raw\.ad_slot = globalThis\.aDetailer\.getValues\(\)/);
    assert.match(persistence, /raw\.controlnet_slot = globalThis\.controlnet\.getValues\(false\)/);
    assert.match(persistence, /addEventListener\('beforeunload'/);
});

test('language.json carries the preset strings in en-US and zh-CN', () => {
    const language = JSON.parse(read('data/language.json'));
    for (const key of ['ui_preset_placeholder', 'ui_preset_save', 'ui_preset_delete', 'ui_preset_save_title', 'ui_preset_saved', 'ui_preset_delete_title',
        'ui_section_prompt', 'ui_section_generation', 'ui_section_lora', 'ui_section_adetailer', 'ui_section_controlnet', 'ui_saved', 'ui_settings_open_folder']) {
        assert.equal(typeof language['en-US'][key], 'string', `en-US ${key}`);
        assert.equal(typeof language['zh-CN'][key], 'string', `zh-CN ${key}`);
    }
});

test('the theme CSS block styles the preset control', () => {
    for (const file of ['html/index_dark.css', 'html/index_light.css']) {
        const css = read(file);
        assert.match(css, /\.preset-control \{/, file);
        assert.match(css, /\.run-saved \{/, file);
    }
});
