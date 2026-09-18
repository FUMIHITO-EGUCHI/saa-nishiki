import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { SPLITS, normalizeSplit, sideLabel, splitFromLabel, splitLabel } from '../scripts/shared/regionalSides.js';
import { DEFAULT_SETTINGS, SECTION_KEYS, normalizeSection } from '../scripts/shared/settingsSections.js';
import { summarizeRegional } from '../scripts/renderer/tools/pipelineSummary.js';
import { LEGACY_V2_REFINE_SYSTEM_PROMPT, REFINE_SYSTEM_PROMPT, previousRefineSystemPromptDefaults, resolveRefineSystemPrompt } from '../scripts/aiPromptRefiner.js';

const projectRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = relativePath => fs.readFileSync(path.join(projectRoot, relativePath), 'utf8');

test('split values normalize to left-right unless top-bottom', () => {
    assert.deepEqual([...SPLITS], ['left-right', 'top-bottom']);
    assert.equal(normalizeSplit('top-bottom'), 'top-bottom');
    assert.equal(normalizeSplit('up-down'), 'left-right');
    assert.equal(normalizeSplit(undefined), 'left-right');
});

test('side labels follow the split; the side ids do not change', () => {
    assert.equal(sideLabel('both', 'top-bottom'), 'BOTH SIDES');
    assert.equal(sideLabel('left', 'left-right'), 'LEFT');
    assert.equal(sideLabel('right', 'left-right'), 'RIGHT');
    assert.equal(sideLabel('left', 'top-bottom'), 'TOP');
    assert.equal(sideLabel('right', 'top-bottom'), 'BOTTOM');
});

test('the dropdown labels round-trip to the stored value', () => {
    for (const split of SPLITS) assert.equal(splitFromLabel(splitLabel(split)), split);
    assert.equal(splitFromLabel('nonsense'), 'left-right');
});

test('regional_split is a stored setting that defaults to left-right', () => {
    assert.equal(DEFAULT_SETTINGS.regional_split, 'left-right');
    const section = Object.keys(SECTION_KEYS).find(name => SECTION_KEYS[name].includes('regional_split'));
    assert.ok(section, 'regional_split belongs to a settings section');
    assert.equal(normalizeSection(section, { regional_split: 'top-bottom' }).regional_split, 'top-bottom');
});

test('the pipeline summary says T/B for a top-bottom split', () => {
    assert.equal(summarizeRegional({ regional_image_ratio: 50, regional_split: 'top-bottom' }), 'T/B 50');
    assert.equal(summarizeRegional({ regional_image_ratio: 50 }), 'L/R 50');
});

test('both ComfyUI regional builders and Forge Couple honour the split', async () => {
    // the ComfyUI builders load electron; their one split line is checked in the source
    const comfy = read('scripts/main/generate_backend_comfyui.js');
    assert.equal(comfy.match(/inputs\.Colum_first = regional\.split !== 'top-bottom'/g)?.length, 2);
    // Forge Couple: the mapping the WebUI backend really sends is read off the request in
    // tests/webui-generation.test.mjs; here it is the mapping itself, columns or rows by the split
    const { forgeCoupleMapping } = await import('../scripts/shared/regionalGeneration.js');
    const regional = { ratio: '0.6,0.4', str_left: 1.2, str_right: '0.8' };
    assert.deepEqual(forgeCoupleMapping({ ...regional, split: 'left-right' }), [[0, 0.6, 0, 1, 1.2], [0.4, 1, 0, 1, 0.8]]);
    assert.deepEqual(forgeCoupleMapping({ ...regional, split: 'top-bottom' }), [[0, 1, 0, 0.6, 1.2], [0, 1, 0.4, 1, 0.8]]);
    // the renderer hands the split to both backends
    globalThis.globalSettings = { regional_split: 'top-bottom', css_style: 'dark' };
    globalThis.regional = {
        overlap_ratio: { getValue: () => 20 }, image_ratio: { getValue: () => 50 },
        str_left: { getFloat: () => 1 }, str_right: { getFloat: () => 1 },
        option_left: { getValue: () => 'default' }, option_right: { getValue: () => 'mask bounds' },
    };
    const { createRegional } = await import('../scripts/renderer/generate_regional.js');
    for (const apiInterface of ['ComfyUI', 'WebUI']) assert.equal(createRegional(apiInterface).split, 'top-bottom', apiInterface);
});

test('Refine keeps an action sentence instead of turning it into tags', () => {
    assert.match(REFINE_SYSTEM_PROMPT, /one plain English sentence/i);
    assert.match(REFINE_SYSTEM_PROMPT, /never split into tags/i);
    // the tag-only rule names the exception instead of contradicting rule 13
    assert.match(REFINE_SYSTEM_PROMPT, /comma-separated tags; the one exception is an action sentence \(rule 13\)\./);
    assert.match(REFINE_SYSTEM_PROMPT, /^13\. An editable field may hold one plain English sentence/m);
});

test('every Refine default that shipped, schema 2 or 3, migrates to the current prompt', () => {
    const sha256 = text => createHash('sha256').update(text).digest('hex');
    // REFINE_SYSTEM_PROMPT as it shipped: schema 2 with the action-sentence rule (1ca6d95),
    // schema 2 before it (146e229), schema 3 before it (6e9f8e2), schema 3 with it but
    // without the exception in the tag rule (a7a4250), and schema 3 before the
    // locked-field rule 14
    assert.equal(sha256(LEGACY_V2_REFINE_SYSTEM_PROMPT), '3485416640322fd384806b41775503010eddb9b7ccbcb78084f281f72ae17397');
    const previous = previousRefineSystemPromptDefaults();
    assert.deepEqual(previous.map(sha256).sort(), [
        'a633a5e1f9fb6e65437800ec4176c802258156b0a931b0c263e20c340d7aaacd',
        '89e88acf188600dc7b4c97c9c5f4df119e2c07a1b7a8b5cdd1d69372acefa1c9',
        'abf7fba65817214b76e0950d64e3dfdc37267002a22619bb146d7f387c154cba',
        'fbf60c1fb3d0d061a3f43e16662b0013afeaa2465e4a935998eed2e2c57690b6',
    ].sort());
    for (const prompt of [LEGACY_V2_REFINE_SYSTEM_PROMPT, ...previous]) {
        assert.equal(resolveRefineSystemPrompt(prompt), REFINE_SYSTEM_PROMPT);
        // a hand-edited prompt stays
        assert.equal(resolveRefineSystemPrompt(`${prompt}\nMy own rule.`), `${prompt}\nMy own rule.`);
    }
});
