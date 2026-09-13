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
  // Scene order follows the concatenation order, with positive-right pinned after positive (Regional)
  assert.match(manager, /if \(id === 'positive' && regional\) put\('positive_right', 'right'\);/);
  // presets: setValue does not fire the input callback, so the applied text is written back explicitly
  assert.match(manager, /onApplied\(preset\.text\); \/\/ setValue does not fire the input callback/);
  // background / style built-ins get preset buttons mapped to their settings keys
  assert.match(manager, /background: 'prompt_background',\s*\n\s*style: 'prompt_style',/);
  // no blocking dialogs: rename is an inline input
  assert.doesNotMatch(manager, /window\.prompt|alert\(|confirm\(/);

  const renderer = read('scripts/renderer.js');
  assert.match(renderer, /globalThis\.prompt\.fieldManager = setupPromptFieldManager\(\)/);
});

test('both themes style the preset panel; the retired Fields editor and field list are gone', () => {
  for (const file of ['html/index_dark.css', 'html/index_light.css']) {
    const css = read(file);
    assert.match(css, /\.prompt-field \{ position: relative; \}/);
    assert.match(css, /\.prompt-preset-panel \{ position: absolute;/);
    // preset button renders inline in the header tool row (not floating over the capsule toggle)
    assert.match(css, /\.prompt-preset-button\.is-inline \{ position: static;/);
    assert.match(css, /\.prompts-card \.prompt-fields \{ gap: 14px; \}/);
    assert.doesNotMatch(css, /\.prompt-field-editor|\.prompt-field-list|\.prompt-layout|\.prompt-editor-host/);
    // the Regional settings keep their layout inside the Scene's block
    assert.match(css, /\.scene-regional \.regional-condition-settings-2 \{ display: grid;/);
  }
});

test('Scene: every unit is a row edited in place (drag, rename, mute, add), Regional is a block of side boxes', () => {
  const manager = read('scripts/renderer/components/promptFieldManager.js');
  // every unit of both chains plus exclude is laid out; side units go into the block's boxes
  assert.match(manager, /sequence\.push\(\{ id: 'exclude' \}\);/);
  assert.match(manager, /if \(regional && side !== 'both'\) \{[\s\S]*?boxes\[side\]\.push\(id\);/);
  // a row's chrome: grip (drag), chevron (collapse), ● (mute)
  assert.match(manager, /grip\.addEventListener\('mousedown', \(\) => armDrag\(container\)\);/);
  assert.match(manager, /chevron\.addEventListener\('click', \(\) => toggleCollapsed\(id\)\);/);
  assert.match(manager, /mute\.addEventListener\('click', \(\) => setMuted\(id, !isMuted\(id\)\)\);/);
  assert.match(manager, /SETTINGS\.prompt_field_collapsed = \[\.\.\.collapsed\]/);
  // mute keeps the text and tells the capsule set (preview / batch) and the generator (settings)
  assert.match(manager, /const patch = setFieldMuted\(SETTINGS, id, muted\);/);
  assert.match(manager, /globalThis\.prompt\?\.tagCapsuleFields\?\.setMuted\?\.\(id, muted\);/);
  // rename in place on double-click, no modal
  assert.match(manager, /label\.addEventListener\('dblclick', event => \{ event\.preventDefault\(\); startRename\(container, id\); \}\);/);
  assert.doesNotMatch(manager, /prompt-field-editor-backdrop|Fields ⇅/);
  // "+ Add field" opens a popover with the name and the chain
  assert.match(manager, /function openAddPopover\(anchor, side\)/);
  assert.match(manager, /const options = \[\['positive', [^\]]*\], \['negative', [^\]]*\]\];/);
  // the regional toggle's inline display decides what is available
  assert.match(manager, /container\.style\.display !== 'none'/);
  // the Regional switch and settings move into the Scene
  assert.match(manager, /const regionalSwitch = document\.querySelector\('\.regional-condition-trigger-dummy'\);\s*if \(regionalSwitch\) toolsHost\.insertBefore\(regionalSwitch, toolsHost\.firstChild\);/);
  assert.match(manager, /const regionalContainer = document\.querySelector\('\.regional-condition-container'\);\s*if \(regionalContainer\) settings\.appendChild\(regionalContainer\);/);

  const css = read('html/index.css');
  assert.match(css, /\.prompt-scene \.prompt-field > \.myTextbox-wrapper \{\s*display: grid;/);
  assert.match(css, /\.prompt-field\.is-muted \.tag-capsule-chip \{\s*border-style: dashed;/);
  assert.match(css, /\.scene-side\.is-right \{\s*border-left-color: var\(--saa-warn, #e0a458\);/);
  assert.match(css, /\.cast-mode \.regional-condition-trigger-dummy,\s*\.cast-mode \.scene-regional,/);
});

test('muted units leave the prompt but keep their text', () => {
  const order = read('scripts/shared/promptFieldOrder.js');
  assert.match(order, /if \(entry\.muted === true\) field\.muted = true;/);
  assert.match(order, /export function isFieldMuted\(settings, id\)/);
  const expansion = read('scripts/renderer/tools/promptBatchExpansion.js');
  assert.match(expansion, /if \(isFieldMuted\(globalThis\.globalSettings, key\)\) return '';/);
  const generate = read('scripts/renderer/generate.js');
  assert.match(generate, /if \(field\.muted === true\) return '';/);
  assert.match(generate, /const viewsMuted = isFieldMuted\(globalThis\.globalSettings, 'views'\);/);
  const capsules = read('scripts/renderer/components/tagCapsuleField.js');
  assert.match(capsules, /capsules: mutedKeys\.has\(field\.key\) \? \[\] : field\.getCapsules\(\)/);
  const sections = read('scripts/shared/settingsSections.js');
  assert.match(sections, /prompt_field_muted: \[\],/);
});

test('preset button joins the field header tools instead of overlapping them', () => {
  const manager = read('scripts/renderer/components/promptFieldManager.js');
  assert.match(manager, /container\.querySelector\('\.tag-field-tools'\)/);
  assert.match(manager, /tools\.insertBefore\(button, tools\.firstChild\)/);
  assert.match(manager, /button\.classList\.add\('is-inline'\)/);
});
