import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8').replace(/\r\n/g, '\n');

test('shared body keeps every container the renderer looks up, in the new places', () => {
  const html = read('scripts/html_shared_body.js');
  for (const cls of ['dropdown-character', 'dropdown-character-regional', 'dropdown-view', 'regional-condition-trigger-dummy', 'regional-condition-swap',
    'prompt-common', 'prompt-positive', 'prompt-positive-right', 'prompt-negative', 'prompt-exclude', 'prompt-ai', 'system-settings-ai-select', 'system-settings-ai-preview',
    'system-settings-ai-interface', 'system-settings-ai-local-prompt-mode', 'generate-hires-fix', 'generate-refiner', 'generate-adetailer', 'generate-controlnet',
    'hires-fix-model', 'hires-fix-scale', 'hires-fix-color-transfer', 'hires-fix-denoise', 'hires-fix-steps', 'hires-fix-random-seed', 'hires-fix-resolution',
    'refiner-model', 'refiner-vpred', 'refiner-ratio', 'refiner-addnoise', 'adetailer-main', 'controlnet-main', 'add-lora-main', 'jsonlist-main', 'queue-main',
    'generate-random-seed', 'generate-width', 'generate-height', 'generate-landscape', 'generate-step', 'generate-cfg', 'generate-sampler', 'generate-scheduler', 'generate-batch',
    'generate-button-single', 'generate-button-batch', 'generate-button-same', 'generate-button-skip', 'generate-button-cancel', 'queue-autostart-generate',
    'gallery-main-main', 'gallery-main-latest', 'gallery-main-keep', 'image-infobox-main', 'gallery-thumb-main', 'generate-tag-assist', 'generate-wildcard-random',
    'model-select', 'model-type', 'global-settings-language', 'model-vpred', 'thumb-select', 'vae-sdxl', 'vae-override', 'vae-unet', 'text-encoder',
    'system-settings-api-interface', 'system-settings-api-address', 'system-settings-ai-local-address', 'system-settings-ai-refine-sysprompt', 'prompt-textbox-autoresize', 'prompt-textbox-fontsize']) {
    assert.match(html, new RegExp(`class="[^"]*\\b${cls}\\b`), `container .${cls} present`);
  }
  for (const id of ['highres-fix-toggle', 'refiner-toggle', 'adetailer-toggle', 'controlnet-toggle', 'add-lora-toggle', 'jsonlist-toggle', 'queue-toggle', 'regional-condition-toggle',
    'gallery-main-toggle', 'image-infobox-toggle', 'gallery-thumb-toggle', 'run-bar', 'run-progress', 'generate-buttons-2', 'queue-drawer', 'header-status', 'left-splitter', 'info-panel', 'ai-mode-segment', 'settings-page-advanced']) {
    assert.match(html, new RegExp(`id="${id}"`), `#${id} present`);
  }
  // duplicates are gone: only the Regional switch keeps the historical "-dummy" class name
  assert.doesNotMatch(html, /generate-hires-fix-dummy|generate-refiner-dummy|queue-autostart-generate-dummy/);
  // settings pages
  for (const page of ['general', 'backend', 'model', 'ai', 'prompt-editing', 'advanced']) assert.match(html, new RegExp(`data-settings-page="${page}"`));
  assert.match(html, /data-when-api="WebUI"/);
  assert.match(html, /data-when-model-type="Diffusion"/);
  assert.match(html, /data-when-ai="Local"/);
  assert.match(html, /data-when-ai="Remote"/);
});

test('renderer / language / callbacks no longer create or sync the duplicate controls', () => {
  const renderer = read('scripts/renderer.js');
  assert.doesNotMatch(renderer, /hifix_dummy|refiner_dummy|queueAutostart_dummy/);
  assert.match(renderer, /setupUiShell\(\)/);
  assert.match(renderer, /finalPromptContainer: document\.querySelector\('#prompt-text-container \.prompt-fields'\)/);
  const language = read('scripts/renderer/language.js');
  assert.doesNotMatch(language, /hifix_dummy|refiner_dummy|queueAutostart_dummy/);
  assert.match(language, /globalThis\.uiShell\?\.updateLanguage\?\.\(\)/);
  assert.match(language, /'prompt-editing': LANG\.ui_settings_prompt_editing/);
  const callbacks = read('scripts/renderer/callbacks.js');
  assert.doesNotMatch(callbacks, /queueAutostart_dummy\.setValue/);
  assert.match(callbacks, /regionalContainer\.hidden = !trigger/);
  const overlay = read('scripts/renderer/customOverlay.js');
  assert.match(overlay, /if \(!globalThis\.SAA_LEGACY_BUTTON_OVERLAY\) \{\n\s*return \{ reload: \(\) => \{\} \};/);
});

test('AI result and preview are routed to the info panel / viewer instead of overlays', () => {
  const generate = read('scripts/renderer/generate.js');
  assert.match(generate, /globalThis\.infoPanel\.showAiResult\(aiResultText, \{ focus: Boolean\(globalThis\.globalSettings\.ai_prompt_preview\) \}\)/);
  assert.match(read('scripts/renderer/generate_backend.js'), /globalThis\.uiShell\?\.setPreview\?\.\(base64\)/);
  const settings = read('scripts/renderer/settingsModal.js');
  assert.match(settings, /function applyConditions\(\)/);
  assert.match(settings, /applyConditions\n\s*\};/);
});

test('language.json carries the ui_* keys in en-US and zh-CN', () => {
  const language = JSON.parse(fs.readFileSync(path.join(root, 'data/language.json'), 'utf8'));
  for (const key of ['ui_characters_title', 'ui_ai_mode_refine', 'ui_run_expand_weights', 'ui_settings_backend', 'ui_field_exclude', 'ui_status_no_answer']) {
    assert.equal(typeof language['en-US'][key], 'string', `en-US ${key}`);
    assert.equal(typeof language['zh-CN'][key], 'string', `zh-CN ${key}`);
  }
});

test('both theme files carry the generated UI shell block with the same selectors', () => {
  const dark = read('html/index_dark.css');
  const light = read('html/index_light.css');
  for (const css of [dark, light]) {
    assert.match(css, /=== UI shell \(generated by design\/saa-ui-redesign\/ui-css\.mjs\) ===/);
    assert.match(css, /#cg-loading-overlay \{ display: none !important; \}/);
    assert.match(css, /\.run-number \[class\^="mySlider-"\]\[class\*="-bar"\] \{ display: none; \}/);
    assert.match(css, /\.ui-switch \[class\^="myCheckbox-"\]\[class\*="-input"\] \{ appearance: none;/);
  }
  const selectors = css => [...css.matchAll(/^([^\n{@}][^{]*)\{/gm)].map(m => m[1].trim());
  const block = css => css.slice(css.indexOf('=== UI shell'), css.indexOf('=== /UI shell ===')).replace(/\/\*[\s\S]*?\*\//g, '');
  assert.deepEqual(selectors(block(light)), selectors(block(dark)));
  assert.notEqual(block(dark).match(/--saa-bg-app: [^;]+/)[0], block(light).match(/--saa-bg-app: [^;]+/)[0]);
});
