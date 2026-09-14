import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Boot-time restore of a Diffusion setup. These pin source text: the renderer needs a DOM,
// so the regressions are caught by what the boot path is allowed to say.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8').replace(/\r\n/g, '\n');

test('the model type is only ever Checkpoint or Diffusion in the boot path', () => {
    const language = read('scripts/renderer/language.js');
    assert.equal(language.includes("'Stable Diffusion'"), false, 'a stale type name made every branch fall through to the Diffusion side');
    // the diffusion file name is never pushed into the checkpoint list (applyModelType swaps the list first)
    assert.match(language, /if \(globalThis\.globalSettings\.api_model_type === 'Checkpoint'\) \{\s*globalThis\.dropdownList\.model\.updateDefaults\(SETTINGS\.api_model_file_select\);\s*\}/);
    assert.equal(language.includes('updateDefaults(SETTINGS.api_model_file_diffusion_select)'), false, 'language.js leaves the diffusion selection to applyModelType');
});

test('a model reload in Diffusion keeps the Diffusion title and selection', () => {
    const collapsed = read('scripts/renderer/components/myCollapsed.js');
    assert.match(collapsed, /setValue\(LANG\.api_diffusion_model, globalThis\.cachedFiles\.diffusionList\);\s*globalThis\.dropdownList\.model\.setTitle\(LANG\.api_diffusion_model\);\s*globalThis\.dropdownList\.model\.updateDefaults\(SETTINGS\.api_model_file_diffusion_select\)/);
});

test('the boot diffusion list uses the same filter as a reload', () => {
    const modelList = read('scripts/main/modelList.js');
    assert.match(modelList, /updateDiffusionModelList\(\s*settings\.model_path_comfyui,\s*settings\.search_modelinsubfolder,\s*settings\.model_filter_keyword_diffusion,\s*settings\.model_filter\s*\)/);
});

test('a character key the current pack cannot resolve survives the prompt autosave', () => {
    const control = read('scripts/renderer/components/characterSelectionModal.js');
    assert.match(control, /const pending = Array\(dropdownCount\)\.fill\(''\);/);
    assert.match(control, /pending\[index\] = \(option \|\| wanted === 'None'\) \? '' : String\(wanted\);/);
    assert.match(control, /getPendingKey\(index\)/);
    assert.match(control, /const key = resolved === 'None' \? \(control\?\.getPendingKey\?\.\(index\) \|\| 'None'\) : resolved;/, 'getSlots persists the stored key, not None');
    assert.match(control, /pending\[activeIndex\] = '';/, 'a pick clears the pending key');
});

test('applying the model type refreshes the settings modal conditions', () => {
    const callbacks = read('scripts/renderer/callbacks.js');
    assert.match(callbacks, /globalThis\.uiShell\?\.settingsConditions\?\.\(\);/);
});
