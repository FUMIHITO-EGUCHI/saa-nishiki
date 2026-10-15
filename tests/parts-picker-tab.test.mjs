// The Parts tab of a row's tag modal as designed (Select Modal Resize, 2026-09-28): a
// category rail with colours, a click that previews, Name / Newest sort, S / M / L
// tiles, no Sample box, a tile that says "No sample yet", a panel with Add to
// selection / Edit / Sample; and the "starter" mark a part carries from the bundled set.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { PART_CATEGORIES, cleanPart, mergePartsDefaults, partsDefaultsDoc } from '../scripts/shared/parts.js';

const read = file => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');

test('a part from the bundled starter set is marked as such, a part the user made is not', () => {
    const doc = partsDefaultsDoc({ parts: [{ name: 'from above', category: 'camera', tags: 'from above' }] }, () => '2026-09-28T00:00:00Z');
    assert.equal(doc.parts['from above'].starter, true);
    assert.equal(cleanPart({ name: 'mine', tags: 'a' }).starter, false, 'absent means the user\'s');
    assert.equal(cleanPart({ name: 'mine', tags: 'a', starter: 'yes' }).starter, false, 'only a real true counts');
    assert.equal(cleanPart(doc.parts['from above']).starter, true, 'the mark survives a reload');
    const merged = mergePartsDefaults({ parts: { mine: { name: 'mine', tags: 'a' } } }, { parts: [{ name: 'from above', category: 'camera', tags: 'from above' }] }, () => '2026-09-28T00:00:00Z');
    assert.equal(merged.doc.parts['from above'].starter, true);
    assert.equal(merged.doc.parts.mine.starter, false, 'merging never marks the user\'s part');
});

test('the Parts tab asks the modal for the rail, click-previews, two sort orders, three tile sizes and no Sample box', () => {
    const ui = read('scripts/renderer/partsUi.js');
    const tab = ui.slice(ui.indexOf('export function partsPickerTab('), ui.indexOf('export function openPartsPicker('));
    assert.match(tab, /rail: true,/);
    assert.match(tab, /clickPreviews: true,/);
    assert.match(tab, /attributes: \[\],/, 'no Sample filter: the tile says when a sample is missing');
    assert.match(tab, /color: CATEGORY_COLORS\[category\]/);
    for (const category of PART_CATEGORIES) assert.match(ui, new RegExp(`\\b${category}: '#[0-9a-f]{6}'`), `${category} has a rail colour`);
    assert.match(tab, /\{ value: 'name', label: text\('parts_sort_name', 'Name'\)/);
    assert.match(tab, /\{ value: 'newest', label: text\('parts_sort_newest', 'Newest'\)/);
    assert.match(tab, /\{ value: 's', label: 'S', px: 120/);
    assert.match(tab, /\{ value: 'm', label: 'M', px: 168, default: true/);
    assert.match(tab, /\{ value: 'l', label: 'L', px: 220/);
    assert.match(tab, /renderOption: item => pickerTile\(item\.part\)/);
    assert.match(tab, /panel: \(item, api\) => pickerPanel\(item\?\.part \?\? null, \{ trigger, api, toOption: option/);
    assert.doesNotMatch(tab, /parts_filter_sampled|Model/, 'no model selector: the model in use decides');
});

test('a tile shows the sample of the model in use or says "No sample yet"; the panel names the origin and what the chip sends', () => {
    const ui = read('scripts/renderer/partsUi.js');
    const tile = ui.slice(ui.indexOf('function pickerTile('), ui.indexOf('function pickerPanel('));
    assert.match(tile, /if \(sampleInUse\(entry\)\)/);
    assert.match(tile, /parts-tile-image is-empty is-missing/);
    assert.match(tile, /text\('parts_no_sample_yet', 'No sample yet'\)/);
    assert.match(tile, /'parts-tile-meta parts-tile-tags', entry\.tags/);
    const panel = ui.slice(ui.indexOf('function pickerPanel('), ui.indexOf('// One part\'s tile'));
    assert.match(panel, /entry\.starter \? text\('parts_origin_starter', 'starter'\) : text\('parts_origin_user', 'yours'\)/);
    assert.match(panel, /v\$\{sample\.promptVersion\}/);
    assert.match(panel, /'parts-picker-token', partToken\(entry\.name\)/);
    assert.match(panel, /text\('parts_add_to_selection', 'Add to selection'\)/);
    assert.match(panel, /text\('parts_remove_from_selection', 'Remove from selection'\)/);
    assert.match(panel, /openPartEditor\(\{ id, trigger/);
    assert.match(panel, /queuePartSample\(id, \{ base: 'mannequin' \}\)/);
    // a sample of the other model type is not what the picker shows
    const inUse = ui.slice(ui.indexOf('function sampleInUse('), ui.indexOf('function pickerTile('));
    assert.match(inUse, /sample && !sample\.foreign \? sample : null/);
});

test('the row\'s modal is the window-sized one, and every new label has its en and zh text', () => {
    assert.match(read('scripts/renderer/tagSelectionModal.js'), /fitWindow: true,/);
    const language = JSON.parse(read('data/language.json'));
    const keys = [
        'tag_ui_selected', 'tag_ui_selected_all', 'tag_ui_selected_none', 'tag_ui_clear_selection', 'tag_ui_fit_window', 'tag_ui_sort', 'tag_ui_tile_size',
        'parts_no_sample_yet', 'parts_sort_name', 'parts_sort_newest', 'parts_tile_size_s', 'parts_tile_size_m', 'parts_tile_size_l',
        'parts_sends_as', 'parts_add_to_selection', 'parts_remove_from_selection', 'parts_origin_starter', 'parts_origin_user', 'parts_edit_short', 'parts_sample_short',
    ];
    for (const key of keys) {
        assert.equal(typeof language['en-US'][key], 'string', `${key} in en-US`);
        assert.equal(typeof language['zh-CN'][key], 'string', `${key} in zh-CN`);
    }
});
