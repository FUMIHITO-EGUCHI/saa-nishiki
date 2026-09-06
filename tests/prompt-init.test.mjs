// Prompts card initialisation on preset load / Regional switch / field editor, the
// Final prompt preview following the real chain, and Refine rebuilding around it.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { expandAll, parsePromptToCapsules } from '../scripts/renderer/components/tagCapsuleLogic.js';
import { composeNormalRefinePrompt, composeRegionalRefinePrompt } from '../scripts/renderer/tools/refinePromptComposition.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

test('a capsule plan write-back during a settings reload cannot restore the previous field set', () => {
    const manager = read('scripts/renderer/components/promptFieldManager.js');
    assert.match(manager, /setFieldExtras: \(id, extras\) => \{[\s\S]*?const current = normalizeCustomFields\(SETTINGS\.prompt_custom_fields\);[\s\S]*?fields = setCustomFieldExtras\(current, id, extras\);/);
    const language = read('scripts/renderer/language.js');
    const refreshAt = language.indexOf('globalThis.prompt.fieldManager?.refresh?.();');
    const loadAt = language.indexOf('globalThis.prompt.tagCapsuleFields?.loadFromSettings?.(SETTINGS);');
    assert.ok(refreshAt > 0 && loadAt > refreshAt, 'the field set is synced before the capsule plans are reloaded');
});

test('Regional off falls back to Positive when a side field was selected, and refreshes the Final prompt', () => {
    const manager = read('scripts/renderer/components/promptFieldManager.js');
    assert.match(manager, /if \(!isAvailable\(unitContainer\(selectedField\)\)\) selectedField = 'positive';/);
    assert.match(manager, /renderEditorLists\(\); \/\/ the field editor, when open, follows/);
    assert.match(manager, /if \(container !== target\) container\.querySelector\('\.prompt-side-badge'\)\?\.remove\(\);/, 'no stale side badge on other fields');
    const callbacks = read('scripts/renderer/callbacks.js');
    assert.match(callbacks, /globalThis\.prompt\.fieldManager\?\.refresh\?\.\(\);\s*\/\/[^\n]*\n\s*globalThis\.prompt\.tagCapsuleFields\?\.refreshFinalPrompt\?\.\(\);/);
    const language = read('scripts/renderer/language.js');
    assert.match(language, /if \(globalThis\.globalSettings\.regional_condition\) \{\s*globalThis\.prompt\.common\.setTitle\(LANG\.regional_custom_prompt\);\s*globalThis\.prompt\.positive\.setTitle\(LANG\.regional_api_prompt\);/, 'a language switch keeps the Regional titles');
});

test('the field editor offers sides only while Regional is on', () => {
    const manager = read('scripts/renderer/components/promptFieldManager.js');
    assert.match(manager, /const regional = isRegional\(\);\s*const sideSelect = panel\.querySelector\('\.prompt-field-editor-side-select'\);\s*if \(sideSelect\) \{ sideSelect\.hidden = !regional;/);
    assert.match(manager, /if \(sideNote\) sideNote\.hidden = !regional;/);
    assert.match(manager, /if \(regional && !custom && !STRUCTURAL_UNITS\.has\(id\)\)/);
    assert.match(manager, /if \(custom\) \{\s*if \(regional\) \{\s*\/\/ Both \/ Left \/ Right/);
    assert.match(manager, /const side = isRegional\(\) \? normalizeSide\(panel\.querySelector\('\.prompt-field-editor-side-select'\)\?\.value\) : 'both';/);
});

const caps = text => parsePromptToCapsules(text);
const FIELDS = [
    { key: 'common', capsules: caps('masterpiece') },
    { key: 'background', capsules: caps('beach') },
    { key: 'style', capsules: caps('sketch') },
    { key: 'positive', capsules: caps('smile') },
    { key: 'positive_right', capsules: caps('frown') },
    { key: 'negative', capsules: caps('lowres') },
    { key: 'negative_left', capsules: caps('blurry') },
    { key: 'negative_right', capsules: caps('jpeg') },
    { key: 'cf_both', capsules: caps('hat') },
    { key: 'cf_left', capsules: caps('sword') },
    { key: 'cf_right', capsules: caps('shield') },
];

test('the Final prompt preview follows the single chain with Regional off', () => {
    const [row] = expandAll(FIELDS, 1, 1, {
        chain: {
            positive: ['common', 'views', 'background', 'style', 'ai', 'characters', 'positive', 'cf_both', 'cf_left', 'cf_right'],
            positiveRight: null,
            negative: ['negative'],
        },
    });
    assert.equal(row.positive, 'masterpiece, beach, sketch, smile, hat, sword, shield');
    assert.equal(row.positiveRight, '');
    assert.equal(row.negative, 'lowres');
    assert.equal(row.fields.negative_left, 'blurry', 'every field still expands under its key');
});

test('the Final prompt preview puts "both" units on both sides and side units on theirs', () => {
    const [row] = expandAll(FIELDS, 1, 1, {
        chain: {
            positive: ['common', 'views', 'background', 'style', 'ai', 'characters', 'positive', 'cf_both', 'cf_left'],
            positiveRight: ['common', 'views', 'background', 'style', 'ai', 'characters', 'positive_right', 'cf_both', 'cf_right'],
            negative: ['negative', 'negative_left', 'negative_right'],
        },
    });
    assert.equal(row.positive, 'masterpiece, beach, sketch, smile, hat, sword');
    assert.equal(row.positiveRight, 'masterpiece, beach, sketch, frown, hat, shield');
    assert.equal(row.negative, 'lowres, blurry, jpeg');
});

test('without a chain the preview keeps the legacy common + positive shape', () => {
    const [row] = expandAll(FIELDS, 1, 1);
    assert.equal(row.positive, 'masterpiece, smile');
    assert.equal(row.positiveRight, 'masterpiece, frown');
    assert.equal(row.negative, 'lowres');
});

test('the capsule field set derives the chain from the settings', () => {
    const source = read('scripts/renderer/components/tagCapsuleField.js');
    assert.match(source, /export function chainFromSettings\(stored = \{\}\)/);
    assert.match(source, /if \(!stored\?\.regional_condition\) return \{ positive, positiveRight: null, negative \};/);
    assert.match(source, /positive: sideOrder\(positive, 'left', customs\),\s*positiveRight: sideOrder\(positive, 'right', customs\),/);
    assert.match(source, /getChain = \(\) => chainFromSettings\(settings\(\)\),/);
    assert.match(source, /chain: getChain\(\) \}\);/);
});

test('structured Refine rebuilds the normal prompt around the assembled chain', async () => {
    const result = await composeNormalRefinePrompt({
        editorFields: { common: 'edited common', positive: 'edited positive', positiveRight: '', negative: '' },
        fixedContext: {
            beforePrompts: '',
            afterPrompts: 'after, ',
            chain: [
                { id: 'common', text: 'old common, ' },
                { id: 'views', text: 'from above, ' },
                { id: 'background', text: 'beach, ' },
                { id: 'style', text: '' },
                { id: 'ai', text: '__AI__, ' },
                { id: 'characters', text: 'boc, alice, eoc, ' },
                { id: 'positive', text: 'old positive, ' },
                { id: 'cf_both', text: 'hat, ' },
            ],
            exclude: '',
            slotLora: '',
        },
    });
    assert.equal(result.positive, 'edited common, from above, beach, boc, alice, eoc, edited positive, hat, after');
});

test('structured Refine rebuilds each regional side around its own chain', async () => {
    const result = await composeRegionalRefinePrompt({
        editorFields: { common: 'C', positive: 'L', positiveRight: 'R', negative: '' },
        fixedContext: {
            left: { beforePrompts: '', afterPrompts: '', chain: [{ id: 'common', text: 'c, ' }, { id: 'background', text: 'beach, ' }, { id: 'characters', text: 'alice, ' }, { id: 'positive', text: 'l, ' }, { id: 'cf_both', text: 'hat, ' }, { id: 'cf_left', text: 'sword, ' }] },
            right: { beforePrompts: '', afterPrompts: '', chain: [{ id: 'common', text: 'c, ' }, { id: 'background', text: 'beach, ' }, { id: 'characters', text: 'bob, ' }, { id: 'positive_right', text: 'r, ' }, { id: 'cf_both', text: 'hat, ' }, { id: 'cf_right', text: 'shield, ' }] },
            characterNegative: '',
            exclude: '',
            slotLora: '',
        },
    });
    assert.equal(result.positive, 'C, beach, alice, L, hat, sword');
    assert.equal(result.positiveRight, 'C, beach, bob, R, hat, shield');
});

test('generation hands the assembled chains to the Refine context', () => {
    const standard = read('scripts/renderer/generate.js');
    assert.match(standard, /const chain = order\.map\(id => \(\{ id, text: units\[id\]\?\.text \?\? '' \}\)\);/);
    assert.match(standard, /slotLora: loraPromot,\s*chain,/);
    const regional = read('scripts/renderer/generate_regional.js');
    assert.match(regional, /chain\.push\(\{ id, text: part\.text \|\| '' \}\);/);
    assert.match(regional, /afterPrompts: EOPL,\s*chain: left\.chain,/);
    assert.match(regional, /afterPrompts: EOPR,\s*chain: right\.chain,/);
});

test('a queue item without an AI request skips the Refine parse instead of failing it', () => {
    const generate = read('scripts/renderer/generate.js');
    assert.match(generate, /const promptMode = aiRequest\.source === 'none' \? 'Expand' : queueManager\.aiOptions\?\.promptMode;/);
    assert.match(generate, /const queuedRefineOriginals = promptMode === 'Refine'/);
    assert.match(generate, /mode: promptMode,\s*content: aiPrompt,/);
    assert.match(generate, /if \(!promptResult\.ok && promptMode === 'Refine'\)/);
    const remote = read('scripts/renderer/remoteAI.js');
    assert.match(remote, /if \(currentInterface\.toLowerCase\(\) === 'none'\) \{\s*return \{ content: '', fresh: false, source: 'none' \};/);
});
