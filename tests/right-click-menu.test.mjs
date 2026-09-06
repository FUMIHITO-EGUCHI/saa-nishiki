import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const projectRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = relativePath => fs.readFileSync(path.join(projectRoot, relativePath), 'utf8');

const menu = read('scripts/renderer/components/myRightClickMenu.js');
const field = read('scripts/renderer/components/tagCapsuleField.js');
const manager = read('scripts/renderer/components/promptFieldManager.js');
const language = JSON.parse(read('data/language.json'));

test('every entry is scoped; the always-on gallery clear and password hash are gone', () => {
    assert.doesNotMatch(menu, /bcryptHash/);
    assert.doesNotMatch(menu, /showDialog/);
    assert.match(menu, /rc\.append\('clear_gallery', LANG\.right_menu_clear_gallery, \{\s*selector: '\.gallery-main-main'/);
    // no unscoped (function) handlers remain
    assert.doesNotMatch(menu, /rc\.append\('[a-z_]+', LANG\.[a-z_]+, (async )?\(\) =>/);
    assert.doesNotMatch(menu, /rc\.append\('[a-z_]+', null, null\)/);
});

test('tag capsule entries: weight, toggle, related, move/copy to field, copy text, remove', () => {
    for (const index of ['tag_edit_weight', 'tag_toggle', 'tag_related', 'tag_move_to', 'tag_copy_to', 'tag_copy_text', 'tag_remove']) {
        assert.match(menu, new RegExp(`rc\\.append\\('${index}',[^{]*\\{\\s*selector: '\\.tag-capsule-chip'`), `${index} scoped to a chip`);
    }
    assert.match(menu, /fieldSet\(\)\?\.transfer\(key, capsule\?\.id, targetId, \{ copy: false \}\)/);
    assert.match(menu, /fieldSet\(\)\?\.transfer\(key, capsule\?\.id, targetId, \{ copy: true \}\)/);
    assert.match(menu, /label: chip => \(chip\.classList\.contains\('is-disabled'\)/, 'toggle label follows the chip state');
});

test('prompt field entries work for every field through data-field-key (custom fields included)', () => {
    assert.match(menu, /const FIELD = '\[data-field-key\]'/);
    for (const index of ['field_move_selection', 'field_copy_selection', 'field_enable_all', 'field_disable_all', 'field_lora_to_slot', 'field_copy_text', 'field_clear']) {
        assert.match(menu, new RegExp(`rc\\.append\\('${index}',[^{]*\\{\\s*selector: FIELD`), `${index} scoped to a field`);
    }
    assert.match(field, /textbox\.dataset\.fieldKey = key/);
    assert.match(field, /chips\.dataset\.fieldKey = key/);
    assert.match(menu, /PROMPT_TEXTAREA = \/\(\^\|\\s\)myTextbox-prompt-\[\\w-\]\+-textarea/, 'spellcheck word lookup covers custom prompt textareas');
    assert.match(manager, /listFields: \(\) => listEntries\(\{ includeCollapsed: true \}\)/, 'move targets follow the chain order');
});

test('submenus render as an in-place accordion (the menu box clips flyouts)', () => {
    assert.match(menu, /typeof handler\.items === 'function'/);
    assert.match(menu, /submenu\.className = 'menu-submenu'/);
    assert.match(menu, /submenu\.hidden = !submenu\.hidden/);
    for (const theme of ['html/index_dark.css', 'html/index_light.css']) {
        const css = read(theme);
        assert.match(css, /\.right-click-menu \.menu-submenu/, `${theme} styles the submenu`);
        assert.match(css, /\.tag-capsule-chips\.is-drop-target/, `${theme} styles the drop target`);
    }
});

test('cross-field drag-and-drop carries its own MIME type and Ctrl/Alt copies', () => {
    assert.match(field, /CAPSULE_MIME = 'application\/x-saa-capsule'/);
    assert.match(field, /event\.dataTransfer\.effectAllowed = 'copyMove'/);
    assert.match(field, /onExternalDrop\?\.\(payload, at, \{ copy: event\.ctrlKey \|\| event\.altKey \}\)/);
    assert.match(field, /onExternalDrop: \(payload, at, \{ copy \}\) => set\.transfer\(payload\.field, payload\.id, key, \{ at, copy \}\)/);
});

test('menu labels exist in every language table', () => {
    const keys = [
        'right_menu_edit_weight', 'right_menu_enable_tag', 'right_menu_disable_tag', 'right_menu_move_to', 'right_menu_copy_to',
        'right_menu_copy_tag', 'right_menu_remove_tag', 'right_menu_related_tags', 'right_menu_enable_all', 'right_menu_disable_all',
        'right_menu_move_selection_to', 'right_menu_copy_selection_to', 'right_menu_copy_field', 'right_menu_clear_field', 'right_menu_no_target',
    ];
    for (const key of keys) {
        assert.equal(typeof language['en-US'][key], 'string', `${key} en`);
        assert.equal(typeof language['zh-CN'][key], 'string', `${key} zh`);
        assert.match(menu, new RegExp(key), `${key} used by the menu`);
    }
});

test('every early exit of the contextmenu handler resets the press state (#1)', () => {
    const handler = menu.slice(menu.indexOf("document.addEventListener('contextmenu'"), menu.indexOf("document.addEventListener('click'"));
    assert.match(handler, /menuBox\.style\.display !== 'none'\) \{\s*e\.preventDefault\(\);\s*resetPressState\(\);\s*return;/, 'menu-already-open path resets');
    assert.match(handler, /if \(!menuConfig\.length\) \{\s*resetPressState\(\);\s*return;/, 'no-config path resets');
    assert.match(handler, /isMoved\) \{\s*resetPressState\(\);\s*return;/, 'suppressed path resets');
    assert.equal((handler.match(/return;/g) ?? []).length, 3, 'no other early exits');
    assert.doesNotMatch(handler, /allowMenu = false;/, 'no inline resets remain');
    assert.match(menu, /function resetPressState\(\) \{\s*rightClickStartX = undefined;\s*rightClickStartY = undefined;\s*rightClickStartTime = undefined;\s*allowMenu = false;\s*isMoved = false;/);
});
