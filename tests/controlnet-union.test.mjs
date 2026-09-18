// Union ControlNet models: the per-slot control type travels UI -> settings ->
// generate data -> a SetUnionControlNetType node in the ComfyUI workflow.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
    CONTROL_TYPE_AUTO,
    CONTROL_TYPE_OPTIONS,
    UNION_CONTROL_TYPES,
    controlTypeFromPreprocessor,
    isUnionControlNet,
    normalizeControlType,
    resolveUnionControlType,
} from '../scripts/shared/controlNetUnion.js';
import { withFakeDom } from './helpers/fakeDom.mjs';

// the textbox measures itself on a timer that outlives the fake document
globalThis.getComputedStyle = () => ({ lineHeight: '20px' });

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8').replace(/\r\n/g, '\n');

test('the control type options are ComfyUI SetUnionControlNetType options, auto first', () => {
    assert.deepEqual([...CONTROL_TYPE_OPTIONS], ['auto', 'openpose', 'depth', 'hed/pidi/scribble/ted', 'canny/lineart/anime_lineart/mlsd', 'normal', 'segment', 'tile', 'repaint']);
    assert.equal(normalizeControlType('OpenPose'), 'openpose');
    assert.equal(normalizeControlType('bogus'), CONTROL_TYPE_AUTO);
    assert.equal(normalizeControlType(undefined), CONTROL_TYPE_AUTO);
});

test('pre-processor names map to a union control type', () => {
    const expectations = {
        OpenposePreprocessor: 'openpose',
        DWPreprocessor: 'openpose',
        AnimalPosePreprocessor: 'openpose',
        DensePosePreprocessor: 'openpose',
        dw_openpose_full: 'openpose',
        DepthAnythingV2Preprocessor: 'depth',
        'Zoe_DepthAnythingPreprocessor': 'depth',
        'LeReS-DepthMapPreprocessor': 'depth',
        'MiDaS-DepthMapPreprocessor': 'depth',
        'DSINE-NormalMapPreprocessor': 'normal',
        'MiDaS-NormalMapPreprocessor': 'normal',
        'Metric3D-NormalMapPreprocessor': 'normal',
        HEDPreprocessor: 'hed/pidi/scribble/ted',
        PiDiNetPreprocessor: 'hed/pidi/scribble/ted',
        ScribblePreprocessor: 'hed/pidi/scribble/ted',
        TEEDPreprocessor: 'hed/pidi/scribble/ted',
        CannyEdgePreprocessor: 'canny/lineart/anime_lineart/mlsd',
        LineArtPreprocessor: 'canny/lineart/anime_lineart/mlsd',
        AnimeLineArtPreprocessor: 'canny/lineart/anime_lineart/mlsd',
        Manga2Anime_LineArt_Preprocessor: 'canny/lineart/anime_lineart/mlsd',
        'M-LSDPreprocessor': 'canny/lineart/anime_lineart/mlsd',
        lineart_anime: 'canny/lineart/anime_lineart/mlsd',
        'OneFormer-ADE20K-SemSegPreprocessor': 'segment',
        AnimeFace_SemSegPreprocessor: 'segment',
        TilePreprocessor: 'tile',
        TTPlanet_TileSimple_Preprocessor: 'tile',
        inpaint: 'repaint',
    };
    for (const [name, type] of Object.entries(expectations)) {
        assert.equal(controlTypeFromPreprocessor(name), type, name);
        assert.ok(UNION_CONTROL_TYPES.includes(type));
    }
    assert.equal(controlTypeFromPreprocessor('none'), null);
    assert.equal(controlTypeFromPreprocessor('ShufflePreprocessor'), null);
    assert.equal(controlTypeFromPreprocessor('ip-adapter->CLIP-ViT-H'), null);
});

test('only a union model gets a type in auto; an explicit type is always applied', () => {
    assert.equal(isUnionControlNet('controlnet-union-sdxl-1.0-promax.safetensors'), true);
    assert.equal(isUnionControlNet('xinsir_controlnet_union_sdxl.safetensors'), true);
    assert.equal(isUnionControlNet('control-lora-openposeXL2-rank256.safetensors'), false);
    const openpose = { preModel: 'OpenposePreprocessor', postModel: 'control-lora-openposeXL2-rank256.safetensors' };
    assert.equal(resolveUnionControlType({ ...openpose, controlType: 'auto' }), null, 'a plain model needs no node');
    assert.equal(resolveUnionControlType({ ...openpose, controlType: 'depth' }), 'depth', 'the user overrides');
    const union = { postModel: 'controlnet-union-sdxl-1.0-promax.safetensors', controlType: 'auto' };
    assert.equal(resolveUnionControlType({ ...union, preModel: 'DWPreprocessor' }), 'openpose');
    assert.equal(resolveUnionControlType({ ...union, preModel: 'CannyEdgePreprocessor' }), 'canny/lineart/anime_lineart/mlsd');
    assert.equal(resolveUnionControlType({ ...union, preModel: 'none' }), 'auto', 'a ready-made map: ComfyUI decides');
    assert.equal(resolveUnionControlType({ ...union, preModel: 'ShufflePreprocessor' }), 'auto');
    assert.equal(resolveUnionControlType({}), null);
});

test('the ComfyUI workflow gets a SetUnionControlNetType node between the loader and Apply ControlNet', () => {
    const backend = read('scripts/main/generate_backend_comfyui.js');
    const helper = backend.slice(backend.indexOf('function applyUnionControlType('), backend.indexOf('function applyControlnet('));
    assert.match(helper, /"class_type": "SetUnionControlNetType"/);
    assert.match(helper, /"type": controlType/);
    assert.match(helper, /"control_net": \[\s*`\$\{loaderIndex\}`,\s*0\s*\]/);
    assert.match(helper, /if \(!controlType\) return \{ controlNetIndex: loaderIndex, nextIndex: loaderIndex \+ 1 \};/, 'no node for a plain model');
    const apply = backend.slice(backend.indexOf('function applyControlnet('), backend.indexOf('function applyADetailer('));
    assert.equal((apply.match(/applyUnionControlType\(workflow, index \+ [12], slot\)/g) ?? []).length, 2, 'both the pre+post and the post-only branch');
    assert.equal((apply.match(/"control_net": \[\s*`\$\{controlNetIndex\}`,\s*0\s*\]/g) ?? []).length, 4, 'base and refiner Apply ControlNet of both branches');
    assert.doesNotMatch(apply, /`\$\{index-[34]\+1\}`/, 'no hard-coded loader offsets are left');
    assert.match(apply, /"image": \[\s*`\$\{preprocessedIndex\}`,\s*0\s*\]/, 'the refiner reads the pre-processed image too');
});

// The trip a chosen control type makes: a slot row -> the saved settings -> the row
// rebuilt from them -> the generate data the backend is given.
test('a control type chosen on a row survives a settings round trip and reaches generate data', async () => {
    await withFakeDom(async document => {
        const models = ['controlnet-union-sdxl-1.0-promax.safetensors'];
        globalThis.globalSettings = { language: 'en-US', css_style: 'dark', api_interface: 'ComfyUI', api_controlnet_enable: true };
        globalThis.cachedFiles = { controlnetList: models, language: { 'en-US': {} } };
        globalThis.generate = { api_interface: { getValue: () => 'ComfyUI' } };
        globalThis.overlay = { custom: { createCustomOverlay() {} } };
        globalThis.api = {};

        const container = document.createElement('div');
        container.className = 'add-controlnet-main';
        document.body.appendChild(container);
        const { setupControlNet } = await import('../scripts/renderer/slots/myControlNetSlot.js');
        const { installSettingsProxy, collectSection } = await import('../scripts/renderer/settingsPersistence.js');
        const manager = setupControlNet('add-controlnet-main');
        globalThis.controlnet = manager;
        installSettingsProxy(globalThis.globalSettings);

        const parameters = ['DWPreprocessor', '1024', 'On', models[0], '0.8', '0', '1'];
        manager.AddControlNetSlot([[...parameters, 'SRC', 'MAP', null, null, 'depth']]);
        await new Promise(resolve => setTimeout(resolve, 0));
        assert.equal(manager.getValues()[0][11], 'depth', 'the row reports it at index 11');

        const saved = collectSection('controlnet').controlnet_slot;
        assert.deepEqual(saved, [[...parameters, null, null, null, null, 'depth']], 'saved without the images');

        manager.flush();   // as a settings load does
        await new Promise(resolve => setTimeout(resolve, 0));
        assert.equal(manager.getValues()[0][11], 'depth', 'and comes back on the rebuilt row');

        const { createControlNet } = await import('../scripts/renderer/generate.js');
        assert.equal(createControlNet()[0].controlType, 'depth', 'which is what the backend is told');

        const language = JSON.parse(read('data/language.json'));
        for (const locale of ['en-US', 'zh-CN']) assert.equal(typeof language[locale].api_controlnet_control_type, 'string', locale);
    }, {
        localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
        getComputedStyle: () => ({ lineHeight: '20px' }),
    });
});
