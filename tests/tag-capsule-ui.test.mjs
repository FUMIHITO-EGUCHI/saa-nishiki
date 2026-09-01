import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { TAG_UI_DEFAULTS, createTextResolver, formatText } from '../scripts/renderer/components/tagUiText.js';

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.join(testDirectory, '..');
const read = relativePath => fs.readFileSync(path.join(projectRoot, relativePath), 'utf8');

const field = read('scripts/renderer/components/tagCapsuleField.js');
const chip = read('scripts/renderer/components/tagCapsuleChip.js');
const popover = read('scripts/renderer/components/weightPopover.js');
const batchDialog = read('scripts/renderer/components/batchWeightDialog.js');
const shell = read('scripts/renderer/components/dialogShell.js');
const finalPrompt = read('scripts/renderer/components/finalPromptDisclosure.js');
const selectionModal = read('scripts/renderer/components/selectionModal.js');
const renderer = read('scripts/renderer.js');
const darkTheme = read('html/index_dark.css');
const lightTheme = read('html/index_light.css');
const language = JSON.parse(read('data/language.json'));

test('the capsule prototype is replaced by the field / chip / popover / dialog / disclosure split', () => {
  assert.equal(fs.existsSync(path.join(projectRoot, 'scripts/renderer/components/tagCapsuleEditor.js')), false);
  assert.match(renderer, /setupTagCapsuleFields\(/);
  assert.match(renderer, /finalPromptContainer: document\.querySelector\('#prompt-text-container \.prompt-fields'\)/);
  assert.match(renderer, /applyExclude: \(prompt, exclude\) => filterPrompts\(/);
  for (const key of ['common', 'positive', 'positive_right', 'negative', 'exclude']) {
    assert.match(renderer, new RegExp(`globalThis\\.prompt\\.${key}`), `${key} gets a capsule field`);
  }
  // dependency direction: logic ← chip ← field ← (popover, dialog); DOM never flows back into logic
  assert.doesNotMatch(read('scripts/renderer/components/tagCapsuleLogic.js'), /document\.|window\./);
  assert.match(chip, /from '\.\/tagCapsuleLogic\.js'/);
  assert.match(field, /from '\.\/tagCapsuleChip\.js'/);
  assert.match(field, /from '\.\/weightPopover\.js'/);
  assert.match(field, /from '\.\/batchWeightDialog\.js'/);
  assert.match(batchDialog, /from '\.\/dialogShell\.js'/);
});

test('field header integrates Choose tags + Text/Capsules toggle and keeps the textarea as source of truth', () => {
  assert.match(field, /tag-field-header/);
  assert.match(field, /\.tag-selection-trigger/);
  assert.match(field, /\.tag-filter-control/);
  assert.match(field, /setAttribute\('role', 'radiogroup'\)/);
  assert.match(field, /textbox\.addEventListener\('input'/);
  assert.match(field, /mytextbox-value-set/);
  assert.match(field, /textboxControl\.setValue\(value\)/);
  assert.match(field, /imageIndex: 0/, 'string mode writes image #1 values back');
  assert.match(field, /tag-capsule-badge/, 'string mode shows the variable badge');
  assert.doesNotMatch(field, /capture: true/, 'Choose tags no longer forces string mode');
  assert.match(field, /MutationObserver/, 'label follows setTitle');
});

test('chip row implements roving tabindex, keyboard reducer actions, drag reorder, and the add-tag slot', () => {
  assert.match(field, /handleChipKey\(state, event\.key/);
  for (const action of ['open', 'add', 'type', 'delete', 'move-left', 'move-right', 'weight-up', 'weight-down', 'exit']) {
    assert.match(field, new RegExp(`case '${action}'`), `${action} handled`);
  }
  assert.match(field, /chip\.tabIndex = index === focusIndex \? 0 : -1/);
  assert.match(field, /addEventListener\('dragstart'/);
  assert.match(field, /addEventListener\('drop'/);
  assert.match(field, /function openTagModal/, 'add-tag routes to the tag selection modal');
  assert.match(field, /chooseButton\.click\(\)/, 'add-tag reuses the Choose tags trigger');
  assert.doesNotMatch(field, /tag-capsule-add-input/, 'inline add input removed');
  assert.match(field, /event\.isComposing \|\| event\.keyCode === 229/);
  assert.match(chip, /draggable = true/);
  assert.match(chip, /setAttribute\('aria-label'/);
  assert.match(chip, /is-excluded/);
  assert.match(chip, /function renderChips/);
  assert.match(chip, /dataset\.signature/, 'keyed diff avoids full re-render');
  assert.match(field, /batchButton\.hidden = summary\.variable === 0/, 'Batch weights… hidden without plans');
});

test('weight popover is 336px, fixed-position, focus-trapped, and only writes on Apply', () => {
  assert.match(popover, /POPOVER_WIDTH = 336/);
  assert.match(popover, /setAttribute\('role', 'dialog'\)/);
  assert.match(popover, /setAttribute\('role', 'tablist'\)/);
  assert.match(popover, /setAttribute\('role', 'radiogroup'\)/);
  assert.match(popover, /document\.addEventListener\('scroll', onScroll, true\)/, 'closes on scroll');
  assert.match(popover, /rect\.top - height - 4/, 'flips above when no room below');
  assert.match(popover, /rect\.right - POPOVER_WIDTH/, 'right-aligns when overflowing');
  assert.match(popover, /function trapTab/);
  assert.match(popover, /event\.shiftKey \? 2 : 1/, 'Shift doubles the nudge');
  assert.match(popover, /if \(apply\) current\.onApply\?\.\(resultPlan\(\)\)/);
  assert.match(popover, /target\?\.focus\?\.\(\)/, 'focus returns to the chip');
  assert.match(popover, /WEIGHT_PRESETS/);
  assert.match(popover, /tag_ui_follow_seed/);
  assert.doesNotMatch(popover, /candidates?List|tag-weight-cands/, 'no candidate column in the plan tab');
});

test('batch dialog reuses the selection-modal skeleton and previews terminal / random rows', () => {
  assert.match(shell, /selection-modal-dialog/);
  assert.match(shell, /event\.key === 'Escape'/);
  assert.match(shell, /lastTrigger/);
  assert.match(batchDialog, /tag_ui_expand_per_image/);
  assert.match(batchDialog, /tag_ui_end_reached/);
  assert.match(batchDialog, /tag_ui_random_badge/);
  assert.match(batchDialog, /tag_ui_comfy_note/);
  assert.match(batchDialog, /navigator\.clipboard\?\.writeText/);
  assert.match(batchDialog, /event\.key\.toLowerCase\(\) !== 'c'/);
  assert.match(batchDialog, /tag_ui_unapplied/);
  assert.match(batchDialog, /current\.onApply\?\.\(\{ enabled: draft\.enabled, count: draft\.count \}, draft\.seed\)/);
});

test('final prompt disclosure is read-only, paged per image, and rendered without innerHTML', () => {
  assert.match(finalPrompt, /setAttribute\('aria-expanded'/);
  assert.match(finalPrompt, /aria-controls/);
  assert.match(finalPrompt, /el\('output'/);
  assert.match(finalPrompt, /tag_ui_image_n/);
  assert.doesNotMatch(finalPrompt, /innerHTML/);
  assert.match(finalPrompt, /requestAnimationFrame/);
});

test('selection modal shows Apply (n), a keyboard hint, and the weights note without gaining weight UI', () => {
  assert.match(selectionModal, /tag_ui_apply_count/);
  assert.match(selectionModal, /tag_ui_modal_hint/);
  assert.match(selectionModal, /tag_ui_modal_note/);
  assert.doesNotMatch(selectionModal, /weightPlan|tag-weight/);
});

test('every tag UI string has an English default and a language.json entry (en-US, zh-CN)', () => {
  const keys = Object.keys(TAG_UI_DEFAULTS);
  assert.ok(keys.length > 60);
  for (const key of keys) {
    assert.equal(typeof language['en-US'][key], 'string', `en-US ${key}`);
    assert.equal(typeof language['zh-CN'][key], 'string', `zh-CN ${key}`);
  }
  for (const source of [field, popover, batchDialog, finalPrompt, selectionModal]) {
    for (const key of source.matchAll(/'(tag_ui_[a-z_]+)'/g)) {
      assert.ok(keys.includes(key[1]), `${key[1]} is declared`);
    }
  }
  assert.equal(formatText('{0} × {1}', [8, 'batch_size=1']), '8 × batch_size=1');
  const text = createTextResolver(() => ({ tag_ui_apply: '適用' }));
  assert.equal(text('tag_ui_apply'), '適用');
  assert.equal(text('tag_ui_cancel'), 'Cancel');
});

test('both themes style header, chips, popover, dialog and final prompt with a visible focus ring', () => {
  for (const theme of [darkTheme, lightTheme]) {
    for (const selector of ['.tag-field-header', '.tag-view-button', '.tag-capsule-view', '.tag-capsule-chip', '.tag-capsule-add', '.tag-weight-popover', '.tag-batch-grid', '.final-prompt-disclosure', '.tag-capsule-badge']) {
      assert.match(theme, new RegExp(selector.replace('.', '\\.')), `${selector} styled`);
    }
    assert.match(theme, /\.tag-capsule-chip:focus-visible/);
    assert.match(theme, /width: 336px/);
    assert.match(theme, /max-width: 260px/);
    assert.doesNotMatch(theme, /\.tag-capsule-toolbar/, 'legacy toolbar CSS removed');
  }
});
