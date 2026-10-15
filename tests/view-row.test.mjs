// The View row: the Angle / Camera dropdowns became one chip row (view_tags), a prompt
// field like Background - parts: chips, weights, mute - read on both generation paths and
// handed to Prose as `view`. Old selections are read into it once.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { normalizeSection, DEFAULT_SETTINGS, SECTION_KEYS } from '../scripts/shared/settingsSections.js';
import { PROMPT_TEXT_KEYS, PROMPT_PLAN_KEYS, clearedPromptPatch } from '../scripts/shared/promptReset.js';
import { PROMPT_STATE_KEYS } from '../scripts/shared/modelTypePrompts.js';
import { STRUCTURAL_UNITS, POSITIVE_BUILTIN_ORDER } from '../scripts/shared/promptFieldOrder.js';
import { buildProseFields } from '../scripts/shared/prosePrompt.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

test('an Angle / Camera selection of an older version is read into the View row once, weights kept', () => {
    const prompt = normalizeSection('prompt', {
        view_angle: 'From Above', view_camera: 'Upper Body',
        weights4dropdownlist: [1.2, 1, 1, 1, 1, 1, 1, 1, 1],
    });
    assert.equal(prompt.view_tags, '(from above:1.2), upper body');
    assert.equal(prompt.view_angle, 'None', 'the old key is cleared');
    assert.equal(prompt.view_camera, 'None');
    assert.deepEqual(prompt.weights4dropdownlist.slice(0, 2), [1, 1], 'the column weights are retired');
    // a second pass is a no-op: nothing is added twice
    const again = normalizeSection('prompt', prompt);
    assert.equal(again.view_tags, '(from above:1.2), upper body');
});

test('None and an empty selection add nothing; Random stays a tag; existing View text is kept in front', () => {
    assert.equal(normalizeSection('prompt', { view_angle: 'None', view_camera: '' }).view_tags, '');
    assert.equal(normalizeSection('prompt', { view_angle: 'Random' }).view_tags, 'random');
    const prompt = normalizeSection('prompt', { view_tags: 'parts:bird view', view_camera: 'cowboy shot' });
    assert.equal(prompt.view_tags, 'parts:bird view, cowboy shot');
    assert.equal(normalizeSection('prompt', { view_angle: 'dutch angle (tilted)' }).view_tags, 'dutch angle \\(tilted\\)', 'parentheses are escaped as the dropdown did');
});

test('view_tags is a prompt text of the card: cleared with the others, part of a model-type snapshot, with its plans and batch', () => {
    assert.ok(PROMPT_TEXT_KEYS.includes('view_tags'));
    assert.ok(PROMPT_PLAN_KEYS.includes('views_weight_plans'));
    assert.ok(PROMPT_STATE_KEYS.includes('view_tags'));
    assert.ok(!PROMPT_STATE_KEYS.includes('view_angle'), 'the dropdown keys are not snapshotted any more');
    assert.equal(DEFAULT_SETTINGS.view_tags, '');
    assert.deepEqual(DEFAULT_SETTINGS.views_batch, { enabled: false, count: 4 });
    for (const key of ['view_tags', 'views_weight_plans', 'views_batch']) assert.ok(SECTION_KEYS.prompt.includes(key), key);
    const patch = clearedPromptPatch({ view_tags: 'from above' });
    assert.equal(patch.view_tags, '');
    assert.equal(patch.view_angle, undefined, 'nothing to reset on the retired keys');
});

test('the View row is an ordinary chain unit: movable, with its own container, tag modal, capsules and Parts tab', () => {
    assert.ok(!STRUCTURAL_UNITS.has('views'), 'not structural any more');
    assert.deepEqual(POSITIVE_BUILTIN_ORDER.slice(0, 3), ['common', 'views', 'background'], 'still right after Common by default');
    const body = read('scripts/html_shared_body.js');
    assert.match(body, /class="prompt-view prompt-field" data-stripe="view"/);
    assert.doesNotMatch(body, /dropdown-view/, 'the two dropdowns are gone from the Characters card');
    const renderer = read('scripts/renderer.js');
    assert.match(renderer, /views: setupTextbox\('prompt-view', LANG\.prompt_view/);
    assert.match(renderer, /\['common', 'views', 'background', 'style', 'positive', 'positive_right', 'negative', 'negative_left', 'negative_right', 'exclude'\]\);/, 'the row has a tag modal');
    assert.match(renderer, /keys: \['common', 'views', 'background'/, 'and capsules');
    assert.doesNotMatch(renderer, /myViewsList/);
    const manager = read('scripts/renderer/components/promptFieldManager.js');
    assert.match(manager, /views: '\.prompt-view'/);
    assert.match(manager, /views: 'view_tags'/, 'a preset can replace the View text');
    assert.doesNotMatch(manager, /ensureViewsRow|dropdown-view/);
    const modal = read('scripts/renderer/tagSelectionModal.js');
    assert.match(modal, /NO_PARTS_FIELDS = new Set\(\['characters'\]\)/, 'the View row modal carries the Parts tab');
    assert.match(read('scripts/renderer/partsUi.js'), /fieldKey === 'views' && PART_CATEGORIES\.includes\('camera'\) \? 'camera' : ''/, 'opened on the camera parts');
    const language = JSON.parse(read('data/language.json'));
    for (const lang of ['en-US', 'zh-CN']) assert.ok(language[lang].prompt_view, `${lang} names the row`);
});

test('generation reads the View row like every other row, on both paths, and Prose gets it as view', async () => {
    const generate = read('scripts/renderer/generate.js');
    assert.match(generate, /readPromptValue\('views'\)/, 'the normal path reads the field (parts expanded, ~tags out, muted = nothing)');
    assert.doesNotMatch(generate, /globalThis\.viewList/);
    assert.match(read('scripts/renderer/generate_regional.js'), /getViewTags\(seed, false\)/, 'the regional path takes the same text');
    assert.doesNotMatch(read('scripts/renderer/callbacks.js'), /viewList|view_angle/);
    assert.doesNotMatch(read('scripts/renderer/language.js'), /viewList|dropdown-view/);
    // the chain unit "views" is what Prose describes as the view
    const fields = buildProseFields({ chain: [{ id: 'common', text: 'masterpiece' }, { id: 'views', text: 'from above, wide shot' }, { id: 'positive', text: 'smile' }] });
    assert.equal(fields.view, 'from above, wide shot');
    assert.equal(fields.common, 'masterpiece');
});

test('a selection-modal tab may open on one of its categories, and the main tab never does', async () => {
    const modal = read('scripts/renderer/components/selectionModal.js');
    assert.match(modal, /defaultCategory: typeof tab\.defaultCategory === 'string' \? tab\.defaultCategory : ''/);
    assert.match(modal, /categorySelect\.value = preset && !activeConfig\.rail \? activeConfig\.defaultCategory : '';/);
    assert.match(modal, /railCategory = preset && activeConfig\.rail \? activeConfig\.defaultCategory : '';/, 'a tab with the category rail opens the rail on it');
});
