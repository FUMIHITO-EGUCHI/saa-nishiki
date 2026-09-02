import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.join(testDirectory, '..');
const read = relativePath => fs.readFileSync(path.join(projectRoot, relativePath), 'utf8');

const modal = read('scripts/renderer/components/selectionModal.js');
const modalLogic = read('scripts/renderer/components/selectionModalLogic.js');
const characterModal = read('scripts/renderer/components/characterSelectionModal.js');
const tagModal = read('scripts/renderer/tagSelectionModal.js');
const dropdown = read('scripts/renderer/components/myDropdown.js');
const renderer = read('scripts/renderer.js');
const language = read('scripts/renderer/language.js');

test('selection modal exposes a dialog, live result status, and multi-select semantics', () => {
  assert.match(modal, /setAttribute\('role', 'dialog'\)/);
  assert.match(modal, /setAttribute\('aria-modal', 'true'\)/);
  assert.match(modal, /setAttribute\('aria-labelledby'/);
  assert.match(modal, /setAttribute\('role', 'listbox'\)/);
  assert.match(modal, /setAttribute\('aria-activedescendant'/);
  assert.match(modal, /setAttribute\('aria-multiselectable', 'true'\)/);
  assert.match(modal, /setAttribute\('aria-live', 'polite'\)/);
  assert.match(modal, /searchInput\.focus\(\)/);
  assert.match(modal, /restoreFocus/);
});

test('selection modal keyboard handling accounts for IME Escape and list navigation', () => {
  assert.match(modal, /event\.isComposing/);
  assert.match(modal, /event\.keyCode === 229/);
  assert.match(modal, /event\.key === 'ArrowDown'/);
  assert.match(modal, /event\.key === 'ArrowUp'/);
  assert.match(modal, /event\.key === 'Home'/);
  assert.match(modal, /event\.key === 'End'/);
  assert.match(modal, /event\.key === 'Enter' \|\| event\.key === ' '/);
  assert.match(modal, /event\.key === 'Tab'/);
  assert.doesNotMatch(modal, /backdrop\.addEventListener\('click'/);
});

test('selection modal debounces dynamic tag searches and ignores stale responses', () => {
  assert.match(modal, /setTimeout\(.*120\)/s);
  assert.match(modal, /let requestGeneration = 0/);
  assert.match(modal, /generation !== requestGeneration \|\| !isOpen\(\)/);
  assert.match(tagModal, /dynamicLoadOptions:/);
  assert.match(tagModal, /tagGet/);
});

test('character controls use single-selection modal adapters while keeping the legacy list API', () => {
  assert.match(characterModal, /mode: 'single'/);
  assert.match(characterModal, /categoryOptions/);
  assert.match(characterModal, /attributes:/);
  assert.match(characterModal, /__characterSelectionControl\?\.cleanup/);
  for (const method of ['getKey', 'getValue', 'getTextValue', 'updateDefaults', 'setTextValue', 'isValueOnly', 'setValueOnly', 'setTitle', 'cleanup']) {
    assert.match(characterModal, new RegExp(`${method}`), `${method} should remain available`);
  }
  // R4: the standard list uses the variable-slot wrapper; regional stays fixed
  assert.match(dropdown, /myVariableCharacterList/);
  assert.match(characterModal, /export function myVariableCharacterList/);
  assert.match(characterModal, /getSlotCount/);
  assert.match(dropdown, /export function myCharacterList/);
  assert.match(dropdown, /export function myRegionalCharacterList/);
});

test('character modal keeps the hover thumbnail preview behavior', () => {
  assert.match(modal, /onOptionHover/);
  assert.match(modal, /onOptionLeave/);
  assert.match(characterModal, /decodeThumb/);
  assert.match(characterModal, /updateThumbOverlay/);
  assert.match(characterModal, /onOptionHover:/);
});

test('tag modal applies changes through the textbox input pipeline and preserves cursor zero', () => {
  assert.match(tagModal, /setRangeText/);
  assert.match(tagModal, /new InputEvent\('input'/);
  assert.match(tagModal, /Number\.isFinite\(parsed\)/);
  assert.match(tagModal, /storedCursor\(textbox, 'tagModalStart'/);
  assert.match(tagModal, /storedCursor\(textbox, 'tagModalEnd'/);
  assert.match(modalLogic, /normalize\('NFKC'\)/);
});

test('renderer installs tag modals for editable prompt fields and localization updates character titles', () => {
  assert.match(renderer, /setupTagSelectionModal\(\[/);
  for (const field of ['common', 'positive', 'positive_right', 'negative', 'exclude']) {
    assert.match(renderer, new RegExp(`globalThis\.prompt\.${field}`), `${field} should have tag selection`);
  }
  assert.doesNotMatch(renderer, /globalThis\.prompt\.ai,\s*\]/);
  assert.match(language, /globalThis\.characterList\?\.setTitle/);
  assert.match(language, /globalThis\.characterListRegional\?\.setTitle/);
});
