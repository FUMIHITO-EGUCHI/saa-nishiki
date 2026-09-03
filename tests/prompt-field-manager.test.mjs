import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const read = relativePath => fs.readFileSync(path.join(process.cwd(), relativePath), 'utf8');

test('field manager wires custom fields into the prompt registry and settings', () => {
  const manager = read('scripts/renderer/components/promptFieldManager.js');
  // custom textboxes register under their field id and persist text into settings
  assert.match(manager, /globalThis\.prompt\[field\.id\] = setupTextbox\(containerClass, field\.name/);
  assert.match(manager, /SETTINGS\.prompt_custom_fields = fields\.map\(field => \(\{ \.\.\.field \}\)\)/);
  // stored orders are re-normalized on every persist so deletes never leave stale ids
  assert.match(manager, /SETTINGS\.prompt_positive_order = normalizeOrder\(SETTINGS\.prompt_positive_order, 'positive', fields\)/);
  // DOM display order follows the concatenation order, with positive-right pinned after positive
  assert.match(manager, /if \(id === 'positive'\) \{\s*\n\s*const right = fieldsHost\.querySelector\('\.prompt-positive-right'\);/);
  // presets: setValue does not fire the input callback, so the applied text is written back explicitly
  assert.match(manager, /onApplied\(preset\.text\); \/\/ setValue does not fire the input callback/);
  // background / style built-ins get preset buttons mapped to their settings keys
  assert.match(manager, /background: 'prompt_background',\s*\n\s*style: 'prompt_style',/);
  // no blocking dialogs: rename is an inline input
  assert.doesNotMatch(manager, /window\.prompt|alert\(|confirm\(/);

  const renderer = read('scripts/renderer.js');
  assert.match(renderer, /globalThis\.prompt\.fieldManager = setupPromptFieldManager\(\)/);
});

test('both themes style the field editor and preset panel', () => {
  for (const file of ['html/index_dark.css', 'html/index_light.css']) {
    const css = read(file);
    assert.match(css, /\.prompt-field \{ position: relative; \}/);
    assert.match(css, /\.prompt-field-editor-backdrop \{ position: fixed;/);
    assert.match(css, /\.prompt-preset-panel \{ position: absolute;/);
    // preset button renders inline in the header tool row (not floating over the capsule toggle)
    assert.match(css, /\.prompt-preset-button\.is-inline \{ position: static;/);
    assert.match(css, /\.prompts-card \.prompt-fields \{ gap: 14px; \}/);
  }
});

test('fields render inside Positive / Negative frames and collapse per field', () => {
  const manager = read('scripts/renderer/components/promptFieldManager.js');
  assert.match(manager, /ensureGroup\('positive', 'Positive'\)/);
  assert.match(manager, /ensureGroup\('negative', 'Negative'\)/);
  // exclude and the AI card stay outside the frames
  assert.match(manager, /\['\.prompt-exclude', '\.ai-card'\]/);
  // collapsing is display-only state kept in settings
  assert.match(manager, /SETTINGS\.prompt_field_collapsed = \[\.\.\.set\]/);
  assert.match(manager, /container\.classList\.toggle\('is-collapsed', collapsed\)/);

  const sections = read('scripts/shared/settingsSections.js');
  assert.match(sections, /prompt_field_collapsed: \[\]/);

  for (const file of ['html/index_dark.css', 'html/index_light.css']) {
    const css = read(file);
    assert.match(css, /\.prompt-field\.is-collapsed \.myTextbox-container-relative,/);
    assert.match(css, /\.prompt-group \{ display: flex;/);
  }
});

test('preset button joins the field header tools instead of overlapping them', () => {
  const manager = read('scripts/renderer/components/promptFieldManager.js');
  assert.match(manager, /container\.querySelector\('\.tag-field-tools'\)/);
  assert.match(manager, /tools\.insertBefore\(button, tools\.firstChild\)/);
  assert.match(manager, /button\.classList\.add\('is-inline'\)/);
});
