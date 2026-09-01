import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { classifyHistoryInput, historyShortcut } from '../scripts/renderer/editHistoryUi.js';

const read = path => fs.readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('historyShortcut supports platform undo/redo keys and ignores IME or unrelated chords', () => {
  assert.equal(historyShortcut({ key: 'z', ctrlKey: true }), 'undo');
  assert.equal(historyShortcut({ key: 'Z', metaKey: true, shiftKey: true }), 'redo');
  assert.equal(historyShortcut({ key: 'y', ctrlKey: true }), 'redo');
  assert.equal(historyShortcut({ key: 'z', ctrlKey: true, altKey: true }), null);
  assert.equal(historyShortcut({ key: 'z', ctrlKey: true, isComposing: true }), null);
  assert.equal(historyShortcut({ key: 'z', ctrlKey: true, keyCode: 229 }), null);
  assert.equal(historyShortcut({ key: 'x', ctrlKey: true }), null);
});

test('input classification separates typing, deletion, paste, drop, and IME composition', () => {
  assert.equal(classifyHistoryInput('insertText'), 'typing');
  assert.equal(classifyHistoryInput('deleteContentBackward'), 'delete');
  assert.equal(classifyHistoryInput('insertFromPaste'), 'paste');
  assert.equal(classifyHistoryInput('insertFromDrop'), 'drop');
  assert.equal(classifyHistoryInput('insertCompositionText', true), 'composition');
  assert.equal(classifyHistoryInput('historyUndo'), 'history');
});

test('renderer wires global history controls, managed prompt input, focus restore, and localization', () => {
  const html = read('scripts/html_shared_body.js');
  assert.match(html, /id="edit-history-undo"/);
  assert.match(html, /id="edit-history-redo"/);
  assert.match(html, /id="edit-history-status"[^>]*aria-live="polite"/);

  const renderer = read('scripts/renderer.js');
  assert.match(renderer, /setupEditHistoryUi/);
  assert.match(renderer, /setupSettingsPersistence[\s\S]*setupEditHistoryUi\(\)/);

  const ui = read('scripts/renderer/editHistoryUi.js');
  assert.match(ui, /addEventListener\('beforeinput'/);
  assert.match(ui, /historyUndo/);
  assert.match(ui, /isNativeEditor/);
  assert.match(ui, /globalThis\.editHistoryFocus/);

  const language = JSON.parse(read('data/language.json'));
  for (const locale of ['en-US', 'zh-CN']) {
    for (const key of ['ui_history_undo', 'ui_history_redo', 'ui_history_undone', 'ui_history_redone']) {
      assert.equal(typeof language[locale][key], 'string', `${locale} ${key}`);
    }
  }
  for (const file of ['html/index_dark.css', 'html/index_light.css']) {
    assert.match(read(file), /\.edit-history-button \{/);
    assert.match(read(file), /\.edit-history-button:focus-visible/);
  }
});
