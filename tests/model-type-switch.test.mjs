import test from 'node:test';
import assert from 'node:assert/strict';

import { withFakeDom } from './helpers/fakeDom.mjs';
import { DEFAULT_SETTINGS } from '../scripts/shared/settingsSections.js';
import { installSettingsProxy, setupSettingsPersistence } from '../scripts/renderer/settingsPersistence.js';
import { callback_api_interface, callback_api_model_type } from '../scripts/renderer/callbacks.js';

// The model type switch driven through the real callbacks, settings proxy and edit history;
// the controls are stubs that record what they were given.

// A value that accepts any property read or call (the controls a test does not look at).
function anything() {
    const proxy = new Proxy(function () {}, {
        get: (target, key) => (key === 'then' ? undefined : key === Symbol.toPrimitive ? () => '' : proxy),
        apply: () => proxy,
    });
    return proxy;
}

function checkbox(value = false) {
    return {
        value, enabled: true,
        setValue(next) { this.value = next; },
        getValue() { return this.value; },
        setEnable(next) { this.enabled = next; },
        setTitle() {},
    };
}

function dropdown(value = '') {
    return {
        value, calls: [],
        setValue() {}, setTitle() {},
        updateDefaults(next) { this.calls.push(next); this.value = next; return this; },
        getValue() { return this.value; },
    };
}

const flush = async () => { for (let index = 0; index < 5; index++) await Promise.resolve(); };

const GLOBALS = ['api', 'addEventListener', 'globalSettings', 'settingsAutosave', 'settingsPersistence', 'editHistory', 'cachedFiles',
    'dropdownList', 'generate', 'hifix', 'refiner', 'prompt', 'custom_message', 'overlay', 'uiShell', 'inBrowser',
    'lora', 'controlnet', 'jsonlist', 'aDetailer', 'characterList', 'characterListRegional', 'thumbGallery'];

async function withSwitchHarness(initial, body) {
    const saved = Object.fromEntries(GLOBALS.map(key => [key, globalThis[key]]));
    try {
        await withFakeDom(async () => {
            const stub = anything();
            globalThis.api = new Proxy({
                saveSettingsSections: async () => true,
                saveSettingsSectionsSync: () => true,
            }, { get: (target, key) => (key in target ? target[key] : key === 'then' ? undefined : async () => stub) });
            globalThis.addEventListener = () => {};
            globalThis.inBrowser = false;
            globalThis.custom_message = {};
            globalThis.overlay = stub;
            globalThis.controlnet = stub; globalThis.jsonlist = stub; globalThis.aDetailer = stub;
            globalThis.refiner = stub;
            // LoRA is not swapped by a type switch, so its history has to survive one
            globalThis.lora = { getValues: () => (globalThis.globalSettings?.lora_slot ?? []).map(row => [...row]), reload: () => {}, clear: () => {} };
            globalThis.cachedFiles = { language: { 'en-US': {} }, characterList: {}, characterThumb: {}, modelList: ['checkpoint.safetensors'], diffusionList: ['anima.safetensors'] };
            const controls = {
                model: dropdown(), modelType: dropdown(),
                refiner: checkbox(), controlnet: checkbox(), regional: checkbox(),
                pipelineRefreshes: 0,
            };
            globalThis.dropdownList = new Proxy({ model: controls.model, model_type: controls.modelType }, {
                get: (target, key) => (key in target ? target[key] : stub),
            });
            const settings = installSettingsProxy({ ...structuredClone(DEFAULT_SETTINGS), ...structuredClone(initial) });
            controls.modelType.value = settings.api_model_type;
            controls.refiner.value = settings.api_refiner_enable;
            controls.controlnet.value = settings.api_controlnet_enable;
            controls.regional.value = settings.regional_condition;
            globalThis.generate = new Proxy({
                regionalCondition: controls.regional,
                regionalCondition_dummy: controls.regional,
                refiner: controls.refiner,
                controlnet: controls.controlnet,
                api_interface: { getValue: () => globalThis.globalSettings.api_interface },
            }, { get: (target, key) => (key in target ? target[key] : stub) });
            globalThis.hifix = stub;
            globalThis.prompt = stub;
            // the Characters slots and the thumb strip drawn from them
            controls.slots = structuredClone(settings.character_slots ?? [{ key: 'None', weight: 1 }]);
            controls.thumbUpdates = 0;
            globalThis.characterList = {
                getSlots: () => structuredClone(controls.slots),
                setSlots: slots => { controls.slots = structuredClone(Array.isArray(slots) && slots.length ? slots : [{ key: 'None', weight: 1 }]); },
                getTextValue: () => 1,
            };
            globalThis.characterListRegional = { updateDefaults: () => {}, setTextValue: () => {} };
            globalThis.thumbGallery = { update: () => { controls.thumbUpdates += 1; } };
            globalThis.uiShell = { pipeline: { refresh: () => { controls.pipelineRefreshes += 1; } } };
            const persistence = setupSettingsPersistence({ updateSettings: () => {}, flushSlots: () => {} });
            try {
                await body({ settings, history: persistence.history, controls });
            } finally {
                await persistence.flush();
            }
        });
    } finally {
        Object.assign(globalThis, saved);
    }
}

test('undo after a type switch cannot bring the other type\'s settings into this one', async () => {
    await withSwitchHarness({ api_model_type: 'Checkpoint', api_model_sampler: 'euler_ancestral', step: 28, cfg: 7, api_prompt: 'checkpoint tags' }, async ({ settings, history }) => {
        settings.step = 20;
        settings.api_prompt = 'checkpoint tags, smile';
        await flush();
        assert.ok(history.canUndo(), 'edits before the switch are recorded');

        await callback_api_model_type(0, ['Diffusion']);
        assert.equal(settings.api_model_type, 'Diffusion');
        assert.equal(settings.api_model_sampler, 'er_sde');
        assert.equal(settings.step, 30);
        // the history recorded under the Checkpoint is gone: Ctrl+Z has nothing to rewind
        assert.equal(history.undoCount(), 0);
        assert.equal(history.canRedo(), false);
        assert.equal(await history.undo(), false);
        assert.equal(settings.api_model_sampler, 'er_sde');
        assert.equal(settings.step, 30);
        assert.equal(settings.api_prompt, '', 'a first visit starts from an empty card');

        // edits after the switch are recorded and undone within the type
        settings.cfg = 5;
        await flush();
        assert.equal(history.undoCount(), 1);
        await history.undo();
        assert.equal(settings.cfg, 4.5);
        assert.equal(settings.api_model_sampler, 'er_sde');

        // back on the Checkpoint: its own values, and the Diffusion ones stored untouched
        await callback_api_model_type(0, ['Checkpoint']);
        assert.equal(history.undoCount(), 0);
        assert.equal(settings.api_model_sampler, 'euler_ancestral');
        assert.equal(settings.step, 20);
        assert.equal(settings.api_prompt, 'checkpoint tags, smile');
        assert.equal(settings.model_type_generation.Diffusion.api_model_sampler, 'er_sde');
        assert.equal(settings.model_type_generation.Diffusion.cfg, 4.5);
    });
});

test('the boot-time apply of the stored type keeps the history', async () => {
    await withSwitchHarness({ api_model_type: 'Diffusion' }, async ({ settings, history }) => {
        settings.cfg = 6;
        await flush();
        await callback_api_model_type(0, ['Diffusion']);
        assert.equal(history.undoCount(), 1);
    });
});

test('Refiner and ControlNet boxes show their settings again when the Checkpoint comes back', async () => {
    await withSwitchHarness({ api_model_type: 'Checkpoint', api_refiner_enable: true, api_controlnet_enable: true }, async ({ settings, controls }) => {
        await callback_api_model_type(0, ['Diffusion']);
        assert.equal(controls.refiner.value, false);
        assert.equal(controls.controlnet.value, false);
        assert.equal(controls.controlnet.enabled, false);
        assert.equal(settings.api_controlnet_enable, true, 'the checkpoint\'s choice is kept, not sent (generate.js sends ControlNet for a checkpoint only)');

        await callback_api_model_type(0, ['Checkpoint']);
        // generate.js sends ControlNet when api_controlnet_enable is on: the box must say so
        assert.equal(controls.controlnet.value, true);
        assert.equal(controls.controlnet.enabled, true);
        assert.equal(controls.refiner.value, true);
        assert.equal(controls.refiner.value, settings.api_refiner_enable);
    });
});

test('the pipeline card is redrawn after each switch (Hires / Refiner / ControlNet summaries)', async () => {
    await withSwitchHarness({ api_model_type: 'Checkpoint', api_hf_enable: true }, async ({ settings, controls }) => {
        await callback_api_model_type(0, ['Diffusion']);
        assert.equal(settings.api_hf_enable, false, 'a first visit starts with Hires off');
        assert.equal(controls.pipelineRefreshes, 1);
        await callback_api_model_type(0, ['Checkpoint']);
        assert.equal(settings.api_hf_enable, true);
        assert.equal(controls.pipelineRefreshes, 2);
    });
});

test('a switch forced by the interface keeps the Scene and leaves the stored Checkpoint card alone', async () => {
    const stored = { Checkpoint: { api_prompt: 'checkpoint card', api_neg_prompt: 'checkpoint negative' } };
    await withSwitchHarness({ api_model_type: 'Diffusion', api_prompt: 'diffusion card', api_neg_prompt: '', model_type_prompts: stored }, async ({ settings }) => {
        await callback_api_model_type(0, ['Checkpoint'], { clearPrompts: false });
        // the user changed the backend, not the card: what is on screen stays there
        assert.equal(settings.api_prompt, 'diffusion card');
        assert.equal(settings.model_type_prompts.Checkpoint.api_prompt, 'checkpoint card', 'the stored Checkpoint card is untouched');
        assert.equal(settings.model_type_prompt_owner, 'Diffusion', 'the card still belongs to the type it was written under');

        // an edit made while the forced Checkpoint is on belongs to that card too
        settings.api_prompt = 'diffusion card, smile';
        await callback_api_model_type(0, ['Diffusion']);
        assert.equal(settings.model_type_prompts.Checkpoint.api_prompt, 'checkpoint card', 'never stored over the Checkpoint card');
        assert.equal(settings.model_type_prompts.Diffusion.api_prompt, 'diffusion card, smile');
        assert.equal(settings.api_prompt, 'diffusion card, smile');
        assert.equal(settings.model_type_prompt_owner, '');

        // and the Checkpoint's own card is still there for a switch by hand
        await callback_api_model_type(0, ['Checkpoint']);
        assert.equal(settings.api_prompt, 'checkpoint card');
    });
});

test('a switch forced by the interface keeps the prompt history and ends only the generation one', async () => {
    await withSwitchHarness({ api_model_type: 'Diffusion', api_prompt: 'diffusion card', cfg: 4.5 }, async ({ settings, history }) => {
        settings.api_prompt = 'diffusion card, smile';   // prompt section
        await flush();
        settings.cfg = 5;                                // generation section
        await flush();
        assert.equal(history.undoCount(), 2);

        await callback_api_model_type(0, ['Checkpoint'], { clearPrompts: false });
        await flush();
        // the Scene is still the one the prompt entry describes, so Ctrl+Z still reaches it
        assert.equal(history.undoCount(), 1);
        assert.equal(await history.undo(), true);
        assert.equal(settings.api_prompt, 'diffusion card');
    });
});

test('a switch by hand ends the history of the sections it swaps and leaves the others', async () => {
    await withSwitchHarness({ api_model_type: 'Checkpoint', lora_slot: [] }, async ({ settings, history }) => {
        settings.lora_slot = [['lora.safetensors', 1, 'On']];
        await flush();
        settings.cfg = 6;
        await flush();
        assert.equal(history.undoCount(), 2);

        await callback_api_model_type(0, ['Diffusion']);
        await flush();
        assert.equal(history.undoCount(), 1, 'LoRA is not swapped by the type, so its entry stays');
        await history.undo();
        assert.deepEqual(settings.lora_slot, [], 'and it still undoes what it recorded');
    });
});

test('the thumb strip follows the cast the switch restored', async () => {
    const stored = { Diffusion: { character_slots: [{ key: 'Alice', weight: 1 }] } };
    await withSwitchHarness({ api_model_type: 'Checkpoint', character_slots: [{ key: 'Bob', weight: 1 }], model_type_prompts: stored },
        async ({ settings, controls }) => {
            await callback_api_model_type(0, ['Diffusion']);
            await new Promise(resolve => setTimeout(resolve, 0));
            assert.deepEqual(settings.character_slots.map(slot => slot.key), ['Alice'], 'the stored cast is back');
            assert.equal(settings.character1, 'Alice', 'the slot mirrors follow');
            assert.ok(controls.thumbUpdates >= 1, 'and the thumb strip was redrawn');
        });
});

test('a switch forced by the interface keeps the Scene when the Checkpoint has no card yet', async () => {
    await withSwitchHarness({ api_model_type: 'Diffusion', api_prompt: 'diffusion card', model_type_prompts: {} }, async ({ settings }) => {
        await callback_api_model_type(0, ['Checkpoint'], { clearPrompts: false });
        assert.equal(settings.api_prompt, 'diffusion card');
    });
});

test('a type switched while the interface change reloads the lists is judged after the reload', async () => {
    await withSwitchHarness({ api_model_type: 'Checkpoint', api_interface: 'ComfyUI', api_model_file_select: 'checkpoint.safetensors', api_model_file_diffusion_select: 'anima.safetensors' }, async ({ settings, controls }) => {
        controls.model.value = 'checkpoint.safetensors';
        let switched = false;
        // the user picks Diffusion while reloadFiles waits for the model lists
        globalThis.api.updateModelList = async () => {
            if (switched) return;
            switched = true;
            await callback_api_model_type(0, ['Diffusion']);
        };
        await callback_api_interface(0, ['WebUI']);
        assert.equal(switched, true, 'the switch happened inside the reload');
        // WebUI has no diffusion route: the type switched during the reload is still forced back
        assert.equal(settings.api_model_type, 'Checkpoint');
        // and the checkpoint name read before the reload never lands in the diffusion list
        assert.equal(controls.model.calls.at(-1), 'checkpoint.safetensors');
        assert.ok(!controls.model.calls.slice(controls.model.calls.indexOf('anima.safetensors')).slice(0, -1).includes('checkpoint.safetensors'),
            'no checkpoint name pushed while the diffusion list was up');
    });
});

test('the regional pair waiting in the settings is not poured into the cast of a switch', async () => {
    // the Checkpoint's stored Regional setting comes back with the type; the pair kept from
    // the Checkpoint (character_left / right) must not join the Diffusion cast on screen
    await withSwitchHarness({
        api_model_type: 'Diffusion', regional_condition: false,
        character_slots: [{ key: 'C', weight: 1 }, { key: 'D', weight: 1 }],
        character_left: 'A', character_right: 'B',
        model_type_generation: { Checkpoint: { regional_condition: true } },
    }, async ({ settings, controls }) => {
        await callback_api_model_type(0, ['Checkpoint'], { clearPrompts: false });
        assert.equal(settings.regional_condition, true, 'the type brought its Regional setting back');
        assert.deepEqual(settings.character_slots.map(slot => slot.key), ['C', 'D'], 'the cast on screen is untouched');
        assert.deepEqual(controls.slots.map(slot => slot.key), ['C', 'D']);
        assert.deepEqual([settings.character_left, settings.character_right], ['A', 'B'], 'the pair still waits');
    });
});
