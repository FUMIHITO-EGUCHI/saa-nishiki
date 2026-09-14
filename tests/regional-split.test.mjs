import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { SPLITS, normalizeSplit, sideLabel, splitFromLabel, splitLabel } from '../scripts/shared/regionalSides.js';
import { DEFAULT_SETTINGS, SECTION_KEYS, normalizeSection } from '../scripts/shared/settingsSections.js';
import { summarizeRegional } from '../scripts/renderer/tools/pipelineSummary.js';
import { LEGACY_V2_REFINE_SYSTEM_PROMPT, REFINE_SYSTEM_PROMPT, resolveRefineSystemPrompt } from '../scripts/aiPromptRefiner.js';

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

test('both ComfyUI regional builders and Forge Couple honour the split', () => {
    const comfy = read('scripts/main/generate_backend_comfyui.js');
    assert.equal(comfy.match(/inputs\.Colum_first = regional\.split !== 'top-bottom'/g)?.length, 2);
    const webui = read('scripts/main/generate_backend_webui.js');
    assert.match(webui, /topBottom \? \[0\.0, 1\.0, from, to, weight\] : \[from, to, 0\.0, 1\.0, weight\]/);
    assert.match(read('scripts/renderer/generate_regional.js'), /return \{info, ratio, split,/);
});

test('Refine keeps an action sentence instead of turning it into tags', () => {
    assert.match(REFINE_SYSTEM_PROMPT, /one plain English sentence/i);
    assert.match(REFINE_SYSTEM_PROMPT, /never split into tags/i);
});

test('a stored schema 2 default, with or without the action-sentence rule, migrates to the current prompt', () => {
    assert.equal(resolveRefineSystemPrompt(LEGACY_V2_REFINE_SYSTEM_PROMPT), REFINE_SYSTEM_PROMPT);
    const withoutRule = LEGACY_V2_REFINE_SYSTEM_PROMPT.split('\n').filter(line => !line.startsWith('11. An editable field')).join('\n');
    assert.notEqual(withoutRule, LEGACY_V2_REFINE_SYSTEM_PROMPT);
    assert.equal(resolveRefineSystemPrompt(withoutRule), REFINE_SYSTEM_PROMPT);
    // a hand-edited prompt stays
    assert.equal(resolveRefineSystemPrompt(`${withoutRule}\nMy own rule.`), `${withoutRule}\nMy own rule.`);
});
