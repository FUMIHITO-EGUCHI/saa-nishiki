import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Layout contract for the 2026-08-30 shell (wai-stack/SAA-ui-redesign.md §3):
// header → viewer + info panel on the left; Characters & Views → Prompts (+ AI card) → Pipeline
// with the run bar pinned at the bottom on the right; environment settings in the modal.

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.join(testDirectory, '..');
const read = relativePath => fs.readFileSync(path.join(projectRoot, relativePath), 'utf8');

const sharedBody = read('scripts/html_shared_body.js');
const renderer = read('scripts/renderer.js');
const language = JSON.parse(read('data/language.json'));

const slice = (from, to) => sharedBody.slice(sharedBody.indexOf(from), to ? sharedBody.indexOf(to) : undefined);
const headerMarkup = slice('id="top-header"', 'id="split"');
const leftMarkup = slice('id="left"', 'id="right"');
const rightMarkup = slice('id="right"', 'id="settings-modal"');
const modalMarkup = slice('id="settings-modal"');

test('header holds checkpoint, status pills, swap and settings — profiles moved to per-section presets', () => {
  assert.doesNotMatch(headerMarkup, /settings-select|settings-save-toggle|settings-delete-toggle/);
  assert.match(headerMarkup, /class="model-select"/);
  assert.match(headerMarkup, /id="header-status"/);
  assert.match(headerMarkup, /id="global-settings-swap-layout-toggle"/);
  assert.match(headerMarkup, /id="settings-modal-toggle"/);
  assert.doesNotMatch(headerMarkup, /global-settings-language|global-settings-theme-toggle|class="model-type"|global-refresh-toggle/);
});

test('left pane is viewer + resizable info panel with Info / Characters / AI tabs', () => {
  assert.match(leftMarkup, /class="gallery-main-container ui-card"/);
  assert.match(leftMarkup, /id="left-splitter"/);
  assert.match(leftMarkup, /id="info-panel"/);
  for (const tab of ['info', 'characters', 'ai']) assert.match(leftMarkup, new RegExp(`data-info-tab="${tab}"`));
  assert.match(leftMarkup, /data-info-panel="characters"[^>]*>\s*<div class="gallery-thumb-header" hidden>/);
  assert.doesNotMatch(leftMarkup, /generate-landscape|queue-autostart-generate|generate-tag-assist|generate-wildcard-random|highres-fix-container|regional-condition-container/);
});

test('right pane order: Characters & Views → Prompts (+ AI card) → Pipeline → run bar', () => {
  const positions = ['class="ui-card characters-card"', 'id="prompt-text-container"', 'id="ai-card"', 'id="pipeline-card"', 'id="run-bar"'].map(marker => rightMarkup.indexOf(marker));
  assert.ok(positions.every(p => p >= 0), 'every zone exists');
  assert.deepEqual([...positions].sort((a, b) => a - b), positions, 'zones appear in the designed order');
  // Regional lives inside the characters card, AI mode controls inside the AI card
  const charactersCard = rightMarkup.slice(positions[0], positions[1]);
  assert.match(charactersCard, /regional-condition-trigger-dummy ui-switch/);
  assert.match(charactersCard, /regional-condition-container/);
  const aiCard = rightMarkup.slice(positions[2], positions[3]);
  assert.match(aiCard, /id="ai-mode-segment"/);
  assert.match(aiCard, /system-settings-ai-select ai-role/);
  assert.match(aiCard, /prompt-ai prompt-field/);
  assert.match(aiCard, /system-settings-ai-preview ui-switch/);
  assert.match(aiCard, /system-settings-ai-interface" hidden/);
  assert.match(aiCard, /system-settings-ai-local-prompt-mode" hidden/);
});

test('pipeline rows: one switch or count per feature, no duplicate enable checkboxes anywhere', () => {
  const pipeline = rightMarkup.slice(rightMarkup.indexOf('id="pipeline-card"'), rightMarkup.indexOf('id="run-bar"'));
  const order = ['data-pipe="hires"', 'data-pipe="refiner"', 'data-pipe="adetailer"', 'data-pipe="controlnet"', 'data-pipe="lora"', 'data-pipe="json"'].map(m => pipeline.indexOf(m));
  assert.deepEqual([...order].sort((a, b) => a - b), order);
  for (const cls of ['generate-hires-fix', 'generate-refiner', 'generate-adetailer', 'generate-controlnet', 'queue-autostart-generate', 'regional-condition-trigger-dummy']) {
    const count = (sharedBody.match(new RegExp(`class="${cls}\\b`, 'g')) ?? []).length;
    assert.equal(count, 1, `.${cls} appears exactly once`);
  }
  assert.match(pipeline, /data-pipe-count="lora"/);
  assert.match(pipeline, /data-pipe-count="json"/);
  assert.doesNotMatch(renderer, /generate-hires-fix-dummy|generate-refiner-dummy|queue-autostart-generate-dummy/);
});

test('run bar carries seed / size / steps·cfg / sampler / batch, the run buttons and the queue drawer', () => {
  const runBar = rightMarkup.slice(rightMarkup.indexOf('id="run-bar"'));
  for (const cls of ['generate-random-seed', 'generate-width', 'generate-height', 'generate-landscape', 'generate-step', 'generate-cfg', 'generate-sampler', 'generate-scheduler', 'generate-batch',
    'generate-button-single', 'generate-button-batch', 'generate-button-same', 'generate-button-skip', 'generate-button-cancel', 'queue-autostart-generate', 'queue-main']) {
    assert.match(runBar, new RegExp(`class="${cls}\\b`), `.${cls} in run bar`);
  }
  assert.match(runBar, /id="seed-random-button"/);
  assert.match(runBar, /id="generate-batch-menu-list"/);
  assert.match(runBar, /id="queue-drawer" hidden/);
  assert.match(runBar, /id="run-progress"/);
});

test('settings modal: six pages, environment-only controls, conditional blocks', () => {
  const page = id => {
    const start = modalMarkup.indexOf(`id="${id}"`);
    const sectionStart = modalMarkup.lastIndexOf('<section', start);
    const next = modalMarkup.indexOf('<section', sectionStart + 1);
    return modalMarkup.slice(sectionStart, next === -1 ? undefined : next);
  };
  assert.match(page('settings-page-general'), /global-settings-language|global-settings-theme-toggle|prompt-textbox-autoresize|prompt-textbox-fontsize/);
  assert.match(page('settings-page-backend'), /system-settings-api-interface|system-settings-api-address|system-settings-api-comfyui/);
  assert.match(page('settings-page-backend'), /data-when-api="WebUI"/);
  assert.match(page('settings-page-model'), /class="model-type"|model-vpred|thumb-select|vae-sdxl/);
  assert.match(page('settings-page-model'), /data-when-model-type="Diffusion"/);
  assert.match(page('settings-page-ai'), /system-settings-ai-local-address|system-settings-ai-refine-sysprompt/);
  assert.doesNotMatch(page('settings-page-ai'), /system-settings-ai-interface|system-settings-ai-select|system-settings-ai-local-prompt-mode|system-settings-ai-preview/);
  assert.match(page('settings-page-prompt-editing'), /generate-tag-assist|generate-wildcard-random/);
  assert.match(page('settings-page-advanced'), /global-refresh-toggle/);
  assert.doesNotMatch(modalMarkup, /settings-save-toggle|settings-delete-toggle|class="settings-select"/);
  assert.match(renderer, /setupSettingsModal/);
});

test('settings page labels resolve in every language (ui_* with legacy fallback)', () => {
  for (const [code, labels] of Object.entries(language)) {
    assert.equal(typeof labels.system_settings, 'string', `${code} modal title`);
    for (const key of ['ui_settings_general', 'ui_settings_backend', 'ui_settings_model', 'ui_settings_ai', 'ui_settings_prompt_editing', 'ui_settings_advanced']) {
      assert.equal(typeof labels[key], 'string', `${code} ${key}`);
    }
  }
});

test('theme stylesheets style the shell through the generated token block', () => {
  for (const theme of ['html/index_dark.css', 'html/index_light.css']) {
    const stylesheet = read(theme);
    for (const selector of ['.ui-card', '.pipeline-card .pipe-row-head', '#run-bar', '.ai-mode-segment', '.status-pill', '#info-panel', '.left-splitter', '.settings-grid']) {
      assert.ok(stylesheet.includes(selector), `${theme} styles ${selector}`);
    }
    assert.match(stylesheet, /#settings-modal-dialog/);
    assert.match(stylesheet, /\.settings-modal-nav/);
  }
  const base = read('html/index.css');
  assert.match(base, /#top-header\{[\s\S]*grid-template-columns: auto minmax\(0, 1fr\) auto/);
});
