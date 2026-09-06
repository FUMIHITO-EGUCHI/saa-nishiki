import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { migrateRegionalSwap, normalizeSide, sideOf, sideOrder, swapSidesPatch, REGIONAL_ONLY_FIELDS } from '../scripts/shared/regionalSides.js';
import { normalizeCustomFields } from '../scripts/shared/promptFieldOrder.js';
import { DEFAULT_SETTINGS, SECTION_KEYS, normalizeSection } from '../scripts/shared/settingsSections.js';
import { WORKFLOW_REGIONAL, WORKFLOW_REIONAL_UNET, REGIONAL_NEGATIVE_RIGHT_NODE, REGIONAL_APPEND_INDEX } from '../scripts/main/comfyui_workflow.js';

const projectRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = relativePath => fs.readFileSync(path.join(projectRoot, relativePath), 'utf8');

const customs = [
    { id: 'cf_light', name: 'Lighting', polarity: 'positive', text: 'rim light' },
    { id: 'cf_outfit', name: 'Outfit', polarity: 'positive', text: 'armor', side: 'right' },
    { id: 'cf_hands', name: 'Hands', polarity: 'negative', text: 'bad hands', side: 'left' },
];

test('a custom field carries its regional side compactly; built-ins have fixed sides', () => {
    const fields = normalizeCustomFields([...customs, { id: 'cf_bogus', name: 'x', side: 'up' }]);
    assert.equal(fields[0].side, undefined, 'both = absent');
    assert.equal(fields[1].side, 'right');
    assert.equal(fields[3].side, undefined, 'unknown side falls back to both');
    assert.equal(normalizeSide('left'), 'left');
    assert.equal(normalizeSide('nope'), 'both');
    for (const [id, side] of [['common', 'both'], ['background', 'both'], ['style', 'both'], ['negative', 'both'],
        ['positive', 'left'], ['negative_left', 'left'], ['positive_right', 'right'], ['negative_right', 'right'],
        ['cf_light', 'both'], ['cf_outfit', 'right'], ['cf_hands', 'left'], ['exclude', 'both']]) {
        assert.equal(sideOf(id, customs), side, id);
    }
    assert.deepEqual([...REGIONAL_ONLY_FIELDS], ['positive_right', 'negative_left', 'negative_right']);
});

test('sideOrder expands a chain into one side, side fields following their shared counterpart', () => {
    const positive = ['common', 'views', 'background', 'style', 'ai', 'characters', 'positive', 'cf_light', 'cf_outfit'];
    assert.deepEqual(sideOrder(positive, 'left', customs), ['common', 'views', 'background', 'style', 'ai', 'characters', 'positive', 'cf_light']);
    assert.deepEqual(sideOrder(positive, 'right', customs), ['common', 'views', 'background', 'style', 'ai', 'characters', 'positive_right', 'cf_light', 'cf_outfit']);
    assert.deepEqual(sideOrder(positive, 'both', customs), ['common', 'views', 'background', 'style', 'ai', 'characters', 'cf_light']);
    const negative = ['negative', 'cf_hands'];
    assert.deepEqual(sideOrder(negative, 'left', customs), ['negative', 'negative_left', 'cf_hands']);
    assert.deepEqual(sideOrder(negative, 'right', customs), ['negative', 'negative_right']);
    assert.deepEqual(sideOrder(negative, 'both', customs), ['negative']);
    assert.deepEqual(sideOrder(null, 'left', customs), []);
});

test('swapSidesPatch exchanges every left / right pair and flips custom field sides', () => {
    const settings = {
        api_prompt: 'L', api_prompt_right: 'R',
        api_neg_prompt_left: 'nl', api_neg_prompt_right: 'nr',
        positive_weight_plans: [{ id: 'a#0' }], positive_right_weight_plans: [],
        positive_batch: { enabled: true, count: 3 }, positive_right_batch: { enabled: false, count: 4 },
        negative_left_weight_plans: [], negative_right_weight_plans: [{ id: 'b#0' }],
        negative_left_batch: { enabled: false, count: 4 }, negative_right_batch: { enabled: false, count: 2 },
        character_left: 'miku', character_right: 'rin',
        regional_str_left: 1, regional_str_right: 1.2,
        regional_option_left: 'default', regional_option_right: 'mask bounds',
        prompt_custom_fields: customs,
        api_neg_prompt: 'shared',
    };
    const patch = swapSidesPatch(settings);
    assert.equal(patch.api_prompt, 'R');
    assert.equal(patch.api_prompt_right, 'L');
    assert.equal(patch.api_neg_prompt_left, 'nr');
    assert.equal(patch.api_neg_prompt_right, 'nl');
    assert.deepEqual(patch.positive_weight_plans, []);
    assert.deepEqual(patch.positive_right_weight_plans, [{ id: 'a#0' }]);
    assert.deepEqual(patch.positive_batch, { enabled: false, count: 4 });
    assert.deepEqual(patch.negative_left_weight_plans, [{ id: 'b#0' }]);
    assert.deepEqual(patch.negative_right_batch, { enabled: false, count: 4 });
    assert.equal(patch.character_left, 'rin');
    assert.equal(patch.character_right, 'miku');
    assert.equal(patch.regional_str_left, 1.2);
    assert.equal(patch.regional_option_left, 'mask bounds');
    assert.deepEqual(patch.prompt_custom_fields.map(f => f.side), [undefined, 'left', 'right']);
    assert.equal(Object.hasOwn(patch, 'api_neg_prompt'), false, 'shared keys stay put');
    assert.notEqual(patch.positive_right_weight_plans, settings.positive_weight_plans, 'values are cloned');
});

test('the retired regional_swap flag is applied once as a data swap', () => {
    const settings = { regional_swap: true, api_prompt: 'L', api_prompt_right: 'R', character_left: 'a', character_right: 'b' };
    assert.equal(migrateRegionalSwap(settings), true);
    assert.deepEqual(settings, { regional_swap: false, api_prompt: 'R', api_prompt_right: 'L', character_left: 'b', character_right: 'a' });
    assert.equal(migrateRegionalSwap(settings), false, 'idempotent');
    assert.equal(migrateRegionalSwap(null), false);
});

test('the prompt section carries the per-side negatives and their plan / batch keys', () => {
    for (const key of ['api_neg_prompt_left', 'api_neg_prompt_right']) {
        assert.equal(DEFAULT_SETTINGS[key], '');
        assert.ok(SECTION_KEYS.prompt.includes(key), key);
    }
    for (const key of ['negative_left', 'negative_right']) {
        assert.deepEqual(DEFAULT_SETTINGS[`${key}_weight_plans`], []);
        assert.deepEqual(DEFAULT_SETTINGS[`${key}_batch`], { enabled: false, count: 4 });
        assert.ok(SECTION_KEYS.prompt.includes(`${key}_weight_plans`) && SECTION_KEYS.prompt.includes(`${key}_batch`), key);
    }
    const section = normalizeSection('prompt', { api_neg_prompt_right: 'hat', prompt_custom_fields: [{ id: 'cf_x', name: 'X', side: 'right', text: 't' }] });
    assert.equal(section.api_neg_prompt_right, 'hat');
    assert.equal(section.prompt_custom_fields[0].side, 'right');
});

test('the ComfyUI regional graphs mask a negative per side with the positives\' rectangles', () => {
    for (const [name, workflow, samplers] of [['checkpoint', WORKFLOW_REGIONAL, ['36', '37', '20']], ['unet', WORKFLOW_REIONAL_UNET, ['36', '20']]]) {
        assert.equal(workflow[REGIONAL_NEGATIVE_RIGHT_NODE].class_type, 'TextBoxMira', name);
        assert.equal(workflow['71'].class_type, 'CLIPTextEncode');
        assert.deepEqual(workflow['71'].inputs.text, [REGIONAL_NEGATIVE_RIGHT_NODE, 0]);
        assert.deepEqual(workflow['72'].inputs.mask, ['48', 0], `${name}: left negative uses the left rectangle`);
        assert.deepEqual(workflow['73'].inputs.mask, ['49', 0], `${name}: right negative uses the right rectangle`);
        assert.equal(workflow['74'].class_type, 'ConditioningCombine');
        for (const id of samplers) {
            const negative = workflow[id].inputs.negative;
            assert.ok(['74', '78'].includes(negative[0]), `${name}: sampler ${id} takes the combined negative (got ${negative[0]})`);
        }
        const maxId = Math.max(...Object.keys(workflow).map(Number));
        assert.ok(maxId < REGIONAL_APPEND_INDEX, `${name}: ControlNet / ADetailer append after every template node`);
    }
    // checkpoint: first pass encodes with the base clip, refiner / hires with the refiner clip
    assert.deepEqual(WORKFLOW_REGIONAL['71'].inputs.clip, ['34', 1]);
    assert.deepEqual(WORKFLOW_REGIONAL['75'].inputs.clip, ['39', 1]);
    assert.deepEqual(WORKFLOW_REGIONAL['72'].inputs.conditioning, ['3', 0]);
    assert.deepEqual(WORKFLOW_REGIONAL['76'].inputs.conditioning, ['40', 0]);
    assert.deepEqual(WORKFLOW_REGIONAL['36'].inputs.negative, ['74', 0]);
    assert.deepEqual(WORKFLOW_REGIONAL['37'].inputs.negative, ['78', 0]);
    assert.deepEqual(WORKFLOW_REGIONAL['20'].inputs.negative, ['78', 0]);
    assert.deepEqual(WORKFLOW_REIONAL_UNET['72'].inputs.conditioning, ['40', 0]);
});

test('the regional builders write both negatives and append ControlNet / ADetailer after the new nodes', () => {
    const backend = read('scripts/main/generate_backend_comfyui.js');
    const checkpoint = backend.slice(backend.indexOf('  createWorkflowRegional(generateData) {'), backend.indexOf('  createWorkflowRegionalUnet(generateData) {'));
    assert.match(checkpoint, /const negative_left = generateData\.negative_left \?\? negative;/);
    assert.match(checkpoint, /workflow\["33"\]\.inputs\.text = negative_left;/);
    assert.match(checkpoint, /workflow\[REGIONAL_NEGATIVE_RIGHT_NODE\]\.inputs\.text = negative_right;/);
    assert.match(checkpoint, /startIndex: REGIONAL_APPEND_INDEX,/);
    assert.match(checkpoint, /now_neg:\s*Number\(REGIONAL_NEGATIVE_FIRST_PASS_NODE\)/);
    assert.match(checkpoint, /ref_neg:\s*Number\(REGIONAL_NEGATIVE_REFINER_NODE\)/);
    const unet = backend.slice(backend.indexOf('  createWorkflowRegionalUnet(generateData) {'), backend.indexOf('  createWorkflowControlnet(generateData){'));
    assert.match(unet, /workflow\["33"\]\.inputs\.text = negative_left;/);
    assert.match(unet, /workflow\[REGIONAL_NEGATIVE_RIGHT_NODE\]\.inputs\.text = negative_right;/);
    assert.match(unet, /startIndex: REGIONAL_APPEND_INDEX,/);
});

test('the regional renderer path assembles per side and no longer swaps at generation time', () => {
    const regional = read('scripts/renderer/generate_regional.js');
    assert.match(regional, /sideOrder\(order, side, customs\)/, 'positive chain follows the side order');
    assert.match(regional, /export function getNegativePrompts\(/);
    assert.match(regional, /negative_tags_left, negative_tags_right/);
    assert.match(regional, /negative_left: createPromptResult\.negativePromptLeft,\s*negative_right: createPromptResult\.negativePromptRight,/);
    assert.match(regional, /positive_left: createPromptResult\.positivePromptLeft,\s*positive_right: createPromptResult\.positivePromptRight,/);
    assert.doesNotMatch(regional, /globalThis\.regional\.swap/);
    assert.match(regional, /regionalSwap: false/);
    const renderer = read('scripts/renderer.js');
    assert.match(renderer, /migrateRegionalSwap\(globalThis\.globalSettings\)/);
    assert.doesNotMatch(renderer, /regional-condition-swap/, 'the Swap Character checkbox is gone');
    for (const key of ['negative_left', 'negative_right']) {
        assert.match(renderer, new RegExp(`${key}: setupTextbox\\('prompt-${key.replace('_', '-')}'`), `${key} textbox`);
        assert.match(renderer, new RegExp(`globalThis\\.prompt\\.${key},`), `${key} joins the capsule fields`);
    }
    const html = read('scripts/html_shared_body.js');
    assert.match(html, /class="prompt-negative-left prompt-field" data-stripe="negative"/);
    assert.match(html, /class="prompt-negative-right prompt-field" data-stripe="negative"/);
    const callbacks = read('scripts/renderer/callbacks.js');
    assert.match(callbacks, /'\.prompt-positive-right', '\.prompt-negative-left', '\.prompt-negative-right'/, 'side fields follow the Regional switch');
    assert.match(callbacks, /saa:regional-characters-changed/);
});

test('the Prompts card lists BOTH SIDES / LEFT / RIGHT with swap, collapse and character rows while Regional is on', () => {
    const manager = read('scripts/renderer/components/promptFieldManager.js');
    assert.match(manager, /if \(isRegional\(\)\) return regionalEntries\(options\);/);
    assert.match(manager, /entries\.push\(\{ section: 'BOTH SIDES', stripe: 'common' \}\);/);
    assert.match(manager, /entries\.push\(\{ swapRow: true \}\);/);
    assert.match(manager, /entries\.push\(\{ sideHead: side, fields: own \}\);\s*entries\.push\(\{ character: side \}\);/);
    assert.match(manager, /if \(sideCollapsed\[side\] && !includeCollapsed\) continue;/);
    assert.match(manager, /entries\.push\(\{ section: 'ALL', stripe: 'exclude' \}\);/);
    // the plain list is untouched with Regional off
    assert.match(manager, /entries\.push\(\{ section: 'POSITIVE', stripe: 'positive' \}\);/);
    // swap = one undo step through the settings transaction
    assert.match(manager, /runEditTransaction\(\{ source: 'regional-swap', sections: \['prompt', 'generation'\] \}, mutate\)/);
    assert.match(manager, /list\.updateDefaults\(keys\[1\], keys\[0\]\);/, 'one slot per side, an OC may sit on either');
    // character rows open the Characters card's picker for that slot
    assert.match(manager, /sideCharacterTriggers\(side\)\[0\]\?\.click\(\)/);
    assert.match(manager, /localStorage\.setItem\(SIDE_COLLAPSE_KEY/);
    // editor: side per custom field, defaults to both
    assert.match(manager, /prompt-field-editor-side-select/);
    assert.match(manager, /if \(side === 'both'\) delete custom\.side; else custom\.side = side;/);
    assert.match(manager, /negative_left: '\.prompt-negative-left',\s*negative_right: '\.prompt-negative-right',/);
    for (const theme of ['html/index_dark.css', 'html/index_light.css']) {
        const css = read(theme);
        for (const cls of ['.prompt-side-swap', '.prompt-side-block.is-left', '.prompt-side-head', '.prompt-side-character', '.prompt-side-badge.is-right', '.prompt-field-editor-side']) {
            assert.match(css, new RegExp(cls.replace(/[.]/g, '\\.')), `${theme} styles ${cls}`);
        }
        assert.match(css, /\.regional-condition-swap \{ display: none !important; \}/);
    }
    const favorites = read('scripts/renderer/components/favoriteTags.js');
    assert.match(favorites, /fieldKey === 'negative_left' \|\| fieldKey === 'negative_right'/, 'side negatives use the negative favorites');
});
