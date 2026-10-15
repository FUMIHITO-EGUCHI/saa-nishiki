// The refiner's "Default" is the base checkpoint. Until 2026-10-15 the refiner list held
// only the model files, so a stored "Default" ran the first file of the list: a second
// checkpoint nobody chose, read from disk again for every image.
import assert from 'node:assert/strict';
import test from 'node:test';

import { REFINER_SAME_AS_BASE, refinerModelOptions, resolveRefinerModel } from '../scripts/shared/refinerModel.js';

test('the refiner list starts with "Default", once', () => {
    assert.equal(REFINER_SAME_AS_BASE, 'Default', 'the default of api_refiner_model');
    assert.deepEqual(refinerModelOptions(['waiIllustriousSDXL_v160.safetensors', 'waiIllustriousSDXL_v170.safetensors']),
        ['Default', 'waiIllustriousSDXL_v160.safetensors', 'waiIllustriousSDXL_v170.safetensors']);
    assert.deepEqual(refinerModelOptions(['Default']), ['Default'], 'the model list of an empty folder');
    assert.deepEqual(refinerModelOptions(undefined), ['Default']);
});

test('"Default" refines with the base checkpoint, a file name with that file', () => {
    assert.equal(resolveRefinerModel('Default', 'waiIllustriousSDXL_v170.safetensors'), 'waiIllustriousSDXL_v170.safetensors');
    assert.equal(resolveRefinerModel('', 'base.safetensors'), 'base.safetensors');
    assert.equal(resolveRefinerModel(undefined, 'base.safetensors'), 'base.safetensors');
    assert.equal(resolveRefinerModel('waiIllustriousSDXL_v160.safetensors', 'waiIllustriousSDXL_v170.safetensors'), 'waiIllustriousSDXL_v160.safetensors');
});
