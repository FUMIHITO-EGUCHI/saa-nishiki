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
  assert.match(manager, /if \(id === 'positive'\) sequence\.push\(fieldsHost\.querySelector\('\.prompt-positive-right'\)\)/);
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
  }
});
