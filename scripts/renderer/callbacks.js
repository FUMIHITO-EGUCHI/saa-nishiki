import { decodeThumb } from './customThumbGallery.js';
import { generateImage, startQueue } from './generate.js';
import { generateRegionalImage } from './generate_regional.js';
import { generateMiraITU } from './generate_miraITU.js';
import { doSwap, reloadFiles } from './components/myCollapsed.js';
import { SAMPLER_COMFYUI, SAMPLER_WEBUI, SCHEDULER_COMFYUI, SCHEDULER_WEBUI, 
    updateLanguage, updateSettings, setDropdownLanguage } from './language.js';
import { setBlur, setNormal, showDialog } from './components/myDialog.js';
import { applyTheme } from './theme.js';
import { sendWebSocketMessage } from '../webserver/front/wsRequest.js';
import { myCharacterList, myRegionalCharacterList } from './components/myDropdown.js';
import { flushSlots } from './slots/slotsManager.js';
import { changeFontSize } from './components/myTextbox.js';
import { set_prompt_textBox_Heights } from './components/componentsManager.js';
import { TAG_DICTIONARY_EVENT } from './components/tagDictionaryStatus.js';
import { migrateSlotSides, regionalSlots } from '../shared/characterSides.js';
import { generationFor, rememberGeneration } from '../shared/modelTypeSettings.js';
import { promptsFor, rememberPrompts } from '../shared/modelTypePrompts.js';
import { formatSizeRange, sizeRangeFor } from '../shared/sizeLimits.js';

export async function callback_api_model_select(index, selectedValue) {
    const value = selectedValue[0];    

    const SETTINGS = globalThis.globalSettings;
    if (SETTINGS.api_model_type === 'Checkpoint') {
        globalThis.globalSettings.api_model_file_select = value;
    } else {
        globalThis.globalSettings.api_model_file_diffusion_select = value;
    }
}

// Switching the model type empties the Scene: every prompt text, the View row and
// the per-image weight plans - one undo step. The rows themselves (custom fields,
// their names, sides, polarity, batch and mute state), presets and the AI card stay.
// Switching the model type puts the card the other type was last using back. A type never
// visited has nothing stored, so it still starts from an empty card (promptsFor falls back
// to the cleared patch). The slot controls are pushed the restored values too, since they
// hold their own copy of the slots.
export function applyPromptsForModelType(type) {
    const SETTINGS = globalThis.globalSettings;
    const mutate = () => {
        Object.assign(SETTINGS, promptsFor(SETTINGS.model_type_prompts, type, SETTINGS));
        globalThis.characterList?.setSlots?.(SETTINGS.character_slots);
        // setSlots fires no callback: the regional Left / Right list (what generate_regional.js
        // reads) and character_left / right follow the restored side column here, or they keep
        // the other type's characters
        syncRegionalCharacters();
        globalThis.artistList?.setSlots?.(SETTINGS.artist_slots);
        const prompt = globalThis.prompt;
        prompt?.common?.setValue?.(SETTINGS.custom_prompt);
        prompt?.positive?.setValue?.(SETTINGS.api_prompt);
        prompt?.positive_right?.setValue?.(SETTINGS.api_prompt_right);
        prompt?.negative?.setValue?.(SETTINGS.api_neg_prompt);
        prompt?.negative_left?.setValue?.(SETTINGS.api_neg_prompt_left);
        prompt?.negative_right?.setValue?.(SETTINGS.api_neg_prompt_right);
        prompt?.background?.setValue?.(SETTINGS.prompt_background);
        prompt?.style?.setValue?.(SETTINGS.prompt_style);
        prompt?.exclude?.setValue?.(SETTINGS.prompt_ban);
        globalThis.viewList?.updateDefaults?.(SETTINGS.view_angle, SETTINGS.view_camera);
        // custom field texts and the chip rows follow the settings (language.js updateSettings)
        prompt?.fieldManager?.refresh?.();
        prompt?.tagCapsuleFields?.loadFromSettings?.(SETTINGS);
        prompt?.tagCapsuleFields?.refreshFinalPrompt?.();
    };
    const persistence = globalThis.settingsPersistence;
    if (persistence?.runEditTransaction) return persistence.runEditTransaction({ source: 'model-type-prompts', sections: ['prompt'] }, mutate);
    return mutate();
}

// A width / height the range no longer holds is pulled to the bound by the slider itself.
// What it held is kept here, per model type and for this session only, so raising the limit
// again puts it back - as long as the box still shows the bound the clamp wrote (a size
// edited since is the user's own and wins). A model type switch passes `remember: false`:
// the size trimmed there belongs to the type being left, which keeps it in
// `model_type_generation` anyway, and the type entered must not inherit it.
const trimmedSizes = new Map();

function rememberTrimmedSize(type, before, SETTINGS) {
    const memory = { ...trimmedSizes.get(type) };
    for (const axis of ['width', 'height']) {
        const now = Number(SETTINGS[axis]);
        if (!Number.isFinite(before[axis]) || !Number.isFinite(now)) continue;
        if (now < before[axis]) memory[axis] = { value: before[axis], bound: now };
        else if (memory[axis] && memory[axis].bound !== now) delete memory[axis];
    }
    if (memory.width || memory.height) trimmedSizes.set(type, memory);
    else trimmedSizes.delete(type);
}

// Narrows the run bar's Size boxes to the model type's range (scripts/shared/sizeLimits.js)
// and writes it beside the label (with the red flash on a clamp).
export function applySizeRange({ remember = true } = {}) {
    const SETTINGS = globalThis.globalSettings ?? {};
    const generate = globalThis.generate ?? {};
    const range = sizeRangeFor(SETTINGS);
    const type = SETTINGS.api_model_type === 'Diffusion' ? 'Diffusion' : 'Checkpoint';
    const memory = remember ? trimmedSizes.get(type) : null;
    const before = { width: Number(SETTINGS.width), height: Number(SETTINGS.height) };
    const apply = () => {
        for (const axis of ['width', 'height']) {
            generate[axis]?.setRange?.(range);
            const kept = memory?.[axis];
            // the size the range took away comes back once the range holds it again
            if (kept && kept.bound === before[axis] && kept.value >= range.min && kept.value <= range.max) {
                generate[axis]?.setValue?.(kept.value);
            }
        }
        if (remember) rememberTrimmedSize(type, before, SETTINGS);
    };
    // the clamp is not an edit of its own: it follows the limit setting (which is not
    // undoable) and undoing it would only put back a size the range clamps again at once
    const history = globalThis.editHistory;
    if (history?.suspendRecording && !history.isRecordingSuspended?.()) {
        history.suspendRecording(apply).catch(error => console.error('[callbacks] size range:', error));
    } else {
        apply();
    }
    const label = document.getElementById('run-size-range');
    if (label) {
        const text = formatSizeRange(range);
        if (label.textContent !== text) label.textContent = text;
    }
    return range;
}

// Writes a set of generation settings (scripts/shared/modelTypeSettings.js
// GENERATION_KEYS) and pushes them to the run bar and Hires controls.
export function applyGenerationSettings(values = {}) {
    const SETTINGS = globalThis.globalSettings;
    const generate = globalThis.generate ?? {};
    const hifix = globalThis.hifix ?? {};
    for (const [key, value] of Object.entries(values)) SETTINGS[key] = value;
    if ('api_model_sampler' in values) generate.sampler?.updateDefaults?.(values.api_model_sampler);
    if ('api_model_scheduler' in values) generate.scheduler?.updateDefaults?.(values.api_model_scheduler);
    if ('step' in values) generate.step?.setValue?.(values.step);
    if ('cfg' in values) generate.cfg?.setValue?.(values.cfg);
    if ('width' in values) generate.width?.setValue?.(values.width);
    if ('height' in values) generate.height?.setValue?.(values.height);
    if ('api_image_landscape' in values) generate.landscape?.setValue?.(values.api_image_landscape);
    if ('api_hf_enable' in values) generate.hifix?.setValue?.(values.api_hf_enable);
    if ('api_hf_scale' in values) hifix.scale?.setValue?.(values.api_hf_scale);
    if ('api_hf_denoise' in values) hifix.denoise?.setValue?.(values.api_hf_denoise);
    if ('api_hf_steps' in values) hifix.steps?.setValue?.(values.api_hf_steps);
    if ('api_hf_upscaler_selected' in values) hifix.model?.updateDefaults?.(values.api_hf_upscaler_selected);
    if ('regional_condition' in values) {
        generate.regionalCondition?.setValue?.(values.regional_condition);
        // the cast on screen still belongs to the type being left here (the restored card
        // follows below), so the stored regional pair is not taken into it now
        callback_regional_condition(Boolean(values.regional_condition), false, { refreshScene: false, adoptStored: false });
    }
    globalThis.uiShell?.runBar?.refresh?.();
}

export async function callback_api_model_type(index, selectedValue, { clearPrompts = true } = {}) {
    const SETTINGS = globalThis.globalSettings;
    const value = selectedValue[0];
    const previous = SETTINGS.api_model_type;
    const run = () => applyModelType(value, previous, { clearPrompts });
    // a type switch is not an undo step: the type itself is not undoable, so what follows
    // from it (the settings swap, Regional, the cleared Scene) must not be either
    if (previous && previous !== value && globalThis.editHistory?.suspendRecording) {
        // the entries recorded before the switch hold the other type's snapshots of the
        // sections this switch swaps (sampler, size, Hires, and the Scene): undone after the
        // switch they would land in this type and be stored as its own at the next switch,
        // so those sections' history ends here. A switch forced by the interface leaves the
        // Scene on screen, so its prompt entries still describe what is there and stay.
        const swapped = clearPrompts ? ['generation', 'prompt'] : ['generation'];
        return globalThis.editHistory.suspendRecording(run).finally(() => globalThis.editHistory.clear?.(swapped));
    }
    return run();
}

async function applyModelType(value, previous, { clearPrompts }) {
    const SETTINGS = globalThis.globalSettings;
    const LANG = globalThis.cachedFiles.language[SETTINGS.language];

    console.log('Selected model type:', value);
    globalThis.globalSettings.api_model_type = value;
    // each type keeps its own sampler / steps / CFG / size / Hires / Regional: store the ones
    // being left, bring back the ones stored for the type entered (Anima defaults the first time)
    const switching = Boolean(previous) && previous !== value;
    // the card on screen belongs to the type it was written under: the type being left,
    // unless a switch forced by the interface parked it here (model_type_prompt_owner)
    const cardOwner = SETTINGS.model_type_prompt_owner || previous;
    // store the size being left before the range moves (the range clamp must not
    // rewrite the other type's remembered size) ...
    if (switching) SETTINGS.model_type_generation = rememberGeneration(SETTINGS.model_type_generation, previous, SETTINGS);
    // the Prompts card is remembered the same way, under the type it belongs to
    if (switching) SETTINGS.model_type_prompts = rememberPrompts(SETTINGS.model_type_prompts, cardOwner, SETTINGS);
    // ... then the Size boxes follow the type entered, so the size stored for it is
    // judged against its own range, not the range of the type left
    applySizeRange({ remember: false });
    if (switching) applyGenerationSettings(generationFor(SETTINGS.model_type_generation, value, SETTINGS));

    if (value === 'Checkpoint') {
        globalThis.dropdownList.model.setValue(LANG.api_model_file_select, globalThis.cachedFiles.modelList);
        globalThis.dropdownList.model.setTitle(LANG.api_model_file_select);
        globalThis.dropdownList.model.updateDefaults(SETTINGS.api_model_file_select);

        globalThis.generate.regionalCondition.setEnable(true);
        globalThis.generate.regionalCondition_dummy.setEnable(true);

        // the Diffusion branch unticks Refiner / ControlNet without touching their settings,
        // so the boxes show those settings again: an unticked ControlNet box whose setting
        // stayed on still sent ControlNet (generate.js reads the setting)
        globalThis.generate.refiner.setEnable(true);
        globalThis.generate.refiner.setValue(Boolean(SETTINGS.api_refiner_enable));

        globalThis.generate.controlnet.setEnable(true);
        globalThis.generate.controlnet.setValue(Boolean(SETTINGS.api_controlnet_enable));

        //globalThis.generate.adetailer.setEnable(true);
    } else {
        globalThis.dropdownList.model.setValue(LANG.api_diffusion_model, globalThis.cachedFiles.diffusionList);
        globalThis.dropdownList.model.setTitle(LANG.api_diffusion_model);
        globalThis.dropdownList.model.updateDefaults(SETTINGS.api_model_file_diffusion_select);

        globalThis.generate.refiner.setValue(false);
        globalThis.generate.refiner.setEnable(false);

        globalThis.generate.controlnet.setValue(false);
        globalThis.generate.controlnet.setEnable(false);

        // Regional masking is built on the SDXL checkpoint route; a language-model encoder
        // takes "who does what to whom" from the sentence instead (Prose on the AI card).
        if (globalThis.generate.regionalCondition.getValue()) {
            globalThis.generate.regionalCondition.setValue(false);
            // the Scene is laid out once, below, after the cast mode is set
            callback_regional_condition(false, false, { refreshScene: false });
        }
        globalThis.generate.regionalCondition.setEnable(false);
        globalThis.generate.regionalCondition_dummy.setEnable(false);

        //globalThis.generate.adetailer.setValue(false);
        //globalThis.generate.adetailer.setEnable(false);
    }
    // the AI card shows its Prose switch only for Diffusion; the chip marks (unknown tag /
    // sentence) mean nothing for a language-model encoder and are re-rendered off
    globalThis.uiShell?.aiCard?.render?.();
    document.dispatchEvent(new CustomEvent(TAG_DICTIONARY_EVENT));
    // the cast (alias per slot, one "@alias" prompt row each), the Prose card and the
    // Cast / Scene wording exist for Diffusion only (uiShell.js setupModelTypeUi)
    document.body.classList.toggle('cast-mode', value !== 'Checkpoint');
    globalThis.uiShell?.modelTypeUi?.render?.();
    globalThis.uiShell?.proseCard?.render?.();
    globalThis.uiShell?.fastToggle?.render?.(); // its tooltip names the type's fast set
    globalThis.prompt?.fieldManager?.refresh?.();
    // the settings modal's Checkpoint / Diffusion groups follow the type at once (they used
    // to be re-evaluated only when the modal was next opened)
    globalThis.uiShell?.settingsConditions?.();
    // the pipeline card summarises Hires / Refiner / ControlNet from the settings just swapped
    globalThis.uiShell?.pipeline?.refresh?.();
    // a real switch (not the boot-time apply of the stored type) brings back the card the
    // type entered was last using, or an empty one the first time it is entered
    if (!switching) return;
    if (clearPrompts) {
        applyPromptsForModelType(value);
        // the card on screen is the entered type's own again
        if (SETTINGS.model_type_prompt_owner) SETTINGS.model_type_prompt_owner = '';
        // the thumb strip is drawn from the slots and setSlots fires no callback of its own:
        // the restored cast has to replace the thumbs of the type left. Everything it writes
        // runs before it awaits the thumbs, so it writes inside this switch's own suspension;
        // it is not awaited here, since reading the thumbs must not hold the switch up.
        callback_myCharacterList_updateThumb().catch(error => console.error('[callbacks] thumbs after a model type switch:', error));
    } else if (SETTINGS.model_type_prompt_owner !== cardOwner) {
        // forced by the interface (WebUI has no diffusion route), not chosen: the user
        // changed the backend, not the card. The Scene stays as it is and goes on belonging
        // to the type it was written under, so the next switch stores it there instead of
        // over the card the type entered has of its own.
        SETTINGS.model_type_prompt_owner = cardOwner;
    }
}

export async function callback_api_interface(index, selectedValue){
    globalThis.globalSettings.api_interface = selectedValue[0];

    const SETTINGS = globalThis.globalSettings;
    const LANG = globalThis.cachedFiles.language[SETTINGS.language];
    globalThis.generate.sampler.setValue(LANG.api_model_sampler, (SETTINGS.api_interface==='ComfyUI')?SAMPLER_COMFYUI:SAMPLER_WEBUI);
    globalThis.generate.scheduler.setValue(LANG.api_model_scheduler, (SETTINGS.api_interface==='ComfyUI')?SCHEDULER_COMFYUI:SCHEDULER_WEBUI);    

    const modelType = globalThis.dropdownList.model_type.getValue();
    const currentModelSelect = globalThis.dropdownList.model.getValue();    
    await reloadFiles();
    // the type can be switched while the lists reload: the selection read above belongs to the
    // type it was read under (reloadFiles already put back the stored one for the type now)
    if (SETTINGS.api_model_type === modelType) globalThis.dropdownList.model.updateDefaults(currentModelSelect);

    globalThis.lora.reload();
    globalThis.controlnet.reload();
    globalThis.jsonlist.reload();
    globalThis.aDetailer.clear();

    if(SETTINGS.api_interface === 'ComfyUI') {
        globalThis.hifix.colorTransfer.setValue(LANG.api_hf_colortransfer, ['None', 'Mean', 'Lab']);
        globalThis.hifix.colorTransfer.updateDefaults(SETTINGS.api_hf_colortransfer);

        globalThis.hifix.randomSeed.setEnable(true);
        globalThis.hifix.randomSeed.setValue(SETTINGS.api_hf_random_seed);

        globalThis.refiner.addnoise.setEnable(true);
        globalThis.refiner.addnoise.setValue(SETTINGS.api_refiner_add_noise);
    } else {
        globalThis.hifix.colorTransfer.setValue(LANG.api_hf_colortransfer, ['None']);
        globalThis.hifix.colorTransfer.updateDefaults('None');

        globalThis.hifix.randomSeed.setValue(false);
        globalThis.hifix.randomSeed.setEnable(false);

        globalThis.refiner.addnoise.setValue(false);
        globalThis.refiner.addnoise.setEnable(false);

        // the type as it is now, not as it was before the lists reloaded
        if(SETTINGS.api_model_type !== 'Checkpoint') {
            globalThis.dropdownList.model_type.updateDefaults('Checkpoint');
            // forced by the interface, not chosen: the Scene keeps its contents and its
            // owner, and only the generation history ends here (applyModelType)
            callback_api_model_type(0, ['Checkpoint'], { clearPrompts: false });
        }
    }

    if (globalThis.inBrowser) {
        globalThis.cachedFiles.upscalerList = await sendWebSocketMessage({ type: 'API', method: 'getUpscalerList', params: [SETTINGS.api_interface] });
    } else {
        globalThis.cachedFiles.upscalerList = await globalThis.api.getUpscalerList(SETTINGS.api_interface);
    }

    globalThis.hifix.model.setValue(LANG.api_hf_upscaler_selected, globalThis.cachedFiles.upscalerList);

    // Fast-mode LoRA picker follows the freshly scanned LoRA folder
    const fastLoras = ['None', ...(Array.isArray(globalThis.cachedFiles.loraList) ? globalThis.cachedFiles.loraList : [])];
    globalThis.generate.api_fast_lora?.setValue(LANG.api_fast_lora, fastLoras);
    globalThis.generate.api_fast_lora?.updateDefaults(fastLoras.includes(SETTINGS.api_fast_lora) ? SETTINGS.api_fast_lora : 'None');
    globalThis.generate.api_fast_diff_lora?.setValue(LANG.api_fast_diff_lora, fastLoras);
    globalThis.generate.api_fast_diff_lora?.updateDefaults(fastLoras.includes(SETTINGS.api_fast_diff_lora) ? SETTINGS.api_fast_diff_lora : 'None');
}

// The Scene swaps the regional characters as data; refresh the thumbs then.
// The side column's letters follow the split (L / R or T / B).
if (typeof document !== 'undefined') {
    document.addEventListener('saa:regional-characters-changed', () => { callback_myCharacterList_updateThumb(); });
    document.addEventListener('saa:regional-split-changed', () => { globalThis.characterList?.refreshSideLabels?.(); });
}

// The Characters slots are the one list. The regional Left / Right list (read by
// generate_regional.js and the stored weights) mirrors the slots that carry a side.
export function syncRegionalCharacters({ sidesCleared = false } = {}) {
    const SETTINGS = globalThis.globalSettings;
    const { left, right } = regionalSlots(SETTINGS.character_slots);
    // While Regional is off the side column is hidden and nothing but this mirror reads
    // character_left / right, so settings written before the side column keep their two
    // characters instead of being overwritten with None: migrateSlotSides leaves them
    // alone with Regional off, and adoptRegionalCharacters takes them into slots when
    // Regional is switched on. A slot that does carry a side is still what wins, and an
    // edit that took the last side off the slots (`sidesCleared`) says the pair is gone.
    const keepStored = !SETTINGS.regional_condition && !left && !right && !sidesCleared;
    if (!keepStored) {
        SETTINGS.character_left = left?.key ?? 'None';
        SETTINGS.character_right = right?.key ?? 'None';
    }
    const list = globalThis.characterListRegional;
    if (!list?.updateDefaults) return;
    list.updateDefaults(SETTINGS.character_left, SETTINGS.character_right);
    list.setTextValue(0, left?.weight ?? 1);
    list.setTextValue(1, right?.weight ?? 1);
}

// Regional was switched on: character_left / right kept from settings written before the
// side column become slot sides now (with Regional off they were left where they were, so
// the ordinary prompt would not draw two more characters). A list that already carries a
// side is returned untouched by migrateSlotSides, so this is a no-op on every later flip.
export function adoptRegionalCharacters() {
    const SETTINGS = globalThis.globalSettings;
    const slots = migrateSlotSides(SETTINGS.character_slots, SETTINGS.character_left, SETTINGS.character_right,
        { weights: [SETTINGS.weights4dropdownlist?.[7], SETTINGS.weights4dropdownlist?.[8]], regional: true });
    SETTINGS.character_slots = slots;
    globalThis.characterList?.setSlots?.(slots);
    syncRegionalCharacters();
}

export async function callback_myCharacterList_updateThumb(){
    const SETTINGS = globalThis.globalSettings;
    const list = globalThis.characterList;
    const slots = list.getSlots?.() ??
        list.getKey().map((key, index) => ({ key, weight: list.getTextValue(index) }));
    // a side the card carried before this edit: dropping the last one is the user saying
    // the regional pair is gone, so the stored character_left / right go with it
    const before = regionalSlots(SETTINGS.character_slots);
    SETTINGS.character_slots = slots;
    // read-only mirrors of slots 0-2 for pre-slot readers
    SETTINGS.character1 = slots[0]?.key ?? 'None';
    SETTINGS.character2 = slots[1]?.key ?? 'None';
    SETTINGS.character3 = slots[2]?.key ?? 'None';
    syncRegionalCharacters({ sidesCleared: Boolean(before.left || before.right) });

    const imgData = [];
    if (SETTINGS.regional_condition) {
        // the two regions' characters, right first
        const iL = await decodeThumb(SETTINGS.character_left);
        const iR = await decodeThumb(SETTINGS.character_right);
        if (iR !== null) imgData.push(iR);
        if (iL !== null) imgData.push(iL);
    } else {
        // latest slot first (an original character has no stored thumb and is skipped)
        for (let index = slots.length - 1; index >= 0; index--) {
            const image = await decodeThumb(slots[index].key);
            if (image !== null) imgData.push(image);
        }
    }
    globalThis.thumbGallery.update(imgData);
    // the "@alias" prompt rows and the Regional boxes follow the slots
    globalThis.prompt?.fieldManager?.refresh?.();
}

export function callback_myViewList_Update(){
    const v1 = globalThis.viewList.getValue()[0];
    const v2 = globalThis.viewList.getValue()[1];

    globalThis.globalSettings.view_angle = v1;
    globalThis.globalSettings.view_camera = v2;
}

export async function callback_generate_start(runType='normal', dataPack=null){    
    globalThis.generate.generate_single.setClickable(false);
    globalThis.generate.generate_batch.setClickable(false);
    globalThis.generate.generate_same.setClickable(false);

    globalThis.generate.skipClicked = false;
    globalThis.generate.cancelClicked = false;
    globalThis.generate.generate_skip.setClickable(true);
    globalThis.generate.generate_cancel.setClickable(true);

    // A previous backend failure switches queue auto-start off so the failed slot can be retried; an explicit
    // generate click means "try again now", so turn it back on. A deliberate user choice (flag not set) is kept.
    if (globalThis.generate.autoStartDisabledByError && !globalThis.globalSettings.generate_auto_start) {
        globalThis.generate.autoStartDisabledByError = false;
        console.log('[Generate] Re-enabling queue auto-start after an earlier backend error.');
        setQueueAutoStart(true);
    }

    try {
        if (runType === 'normal') {
            if(globalThis.globalSettings.regional_condition) {
                await generateRegionalImage(dataPack);
            } else {
                await generateImage(dataPack);
            }    
        } else if (runType === 'MiraITU') {
            await generateMiraITU(dataPack);
        }
    } catch (error) {
        // Last line of defence: never leave the generate buttons disabled or the busy flag set.
        console.error('[Generate] Unhandled generation error:', error);
        const LANG = globalThis.cachedFiles?.language?.[globalThis.globalSettings?.language] ?? {};
        const message = (LANG.gr_error_creating_image ?? 'Error: {0} ({1})')
            .replace('{0}', error?.message ?? String(error))
            .replace('{1}', globalThis.generate?.api_interface?.getValue?.() ?? '');
        globalThis.inGenerating = false;
        globalThis.queueManager?.removeAll?.();
        globalThis.mainGallery?.hideLoading?.(message, error?.stack ?? String(error));
    } finally {
        globalThis.generate.generate_single.setClickable(true);
        globalThis.generate.generate_batch.setClickable(true);
        globalThis.generate.generate_same.setClickable(true);
        if ((globalThis.queueManager?.getSlotsCount?.() ?? 0) === 0 && !globalThis.inGenerating) {
            globalThis.generate.showCancelButtons(false);
        }
    }
}

export function callback_generate_skip() {
    globalThis.generate.generate_skip.setClickable(false);
    globalThis.generate.skipClicked = true;

    const bak_autoStart = globalThis.globalSettings.generate_auto_start;
    setQueueAutoStart(false);
    globalThis.queueManager.removeFollowings();
    setQueueAutoStart(bak_autoStart);
}

export async function callback_generate_cancel() {
    globalThis.generate.generate_skip.setClickable(false);
    globalThis.generate.generate_cancel.setClickable(false);
    globalThis.generate.cancelClicked = true;
    globalThis.queueManager.removeAll();
    globalThis.generate.showCancelButtons(false);
    // Nothing running (the jobs were only queued): no loop will clear the
    // "Creating prompts…" label or the loading overlay, so do it here.
    // hideLoading('success') closes it without an error overlay (any other text is shown
    // as an error). The generate buttons are left alone: a click that is still building
    // prompts re-enables them when it ends, and enabling them now would let a new click
    // reset cancelClicked and revive the batch being cancelled.
    if (!globalThis.inGenerating) {
        globalThis.generate.loadingMessage = '';
        if (globalThis.mainGallery?.isLoading) globalThis.mainGallery.hideLoading('success', '');
        return;
    }

    if (globalThis.inBrowser) {        
        const apiInterface = globalThis.generate.nowAPI;
        if(apiInterface === 'ComfyUI') {
            await sendWebSocketMessage({ type: 'API', method: 'cancelComfyUI' });
        } else if(apiInterface === 'WebUI') {
            await sendWebSocketMessage({ type: 'API', method: 'cancelWebUI' });
        }
    } else {
        const apiInterface = globalThis.generate.nowAPI;
        if(apiInterface === 'ComfyUI') {
            await globalThis.api.cancelComfyUI();
        } else if(apiInterface === 'WebUI') {
            await globalThis.api.cancelWebUI();
        }
    }
}

export function callback_keep_gallery(keepGallery) {
    if(!keepGallery) {
        globalThis.mainGallery.clearGallery();
    }

    globalThis.globalSettings.keep_gallery = keepGallery;
}

// `adoptStored`: a Regional switched on by hand (or by the settings just loaded) takes an
// old character_left / right into the slots. A type switch restoring its stored Regional
// setting must not, since the cast on screen is still the one the type being left had.
export function callback_regional_condition(trigger, dummy = false, { refreshScene = true, adoptStored = true } = {}) {
    const SETTINGS = globalThis.globalSettings;
    const FILES = globalThis.cachedFiles;
    const LANG = FILES.language[SETTINGS.language];

    const apiInterface = globalThis.generate.api_interface.getValue();    
    if(apiInterface !== 'ComfyUI' && trigger && !globalThis.custom_message.regional_forge_neo) {
        globalThis.overlay.custom.createErrorOverlay(LANG.regional_forge_neo, LANG.regional_forge_neo_link);
        globalThis.custom_message.regional_forge_neo = true;
    }

    if (dummy) {
        globalThis.generate.regionalCondition.setValue(globalThis.generate.regionalCondition_dummy.getValue());
    }
    globalThis.globalSettings.regional_condition = trigger;

    // Regional settings live inside the Characters & Views card; show them only while Regional is on.
    const regionalContainer = document.querySelector('.regional-condition-container');
    if (regionalContainer) regionalContainer.hidden = !trigger;
    globalThis.collapsedTabs?.regional?.setCollapsed(!trigger);

    // the Characters slots show their side column (L / R / ·) while Regional is on
    document.body.classList.toggle('regional-on', Boolean(trigger));
    // fields that only exist while Regional is on
    const sideFields = ['.prompt-positive-right', '.prompt-negative-left', '.prompt-negative-right']
        .map(selector => document.querySelector(selector)).filter(Boolean);

    if (trigger) {
        // the two characters an old settings file kept out of the slots join them now
        if (adoptStored) adoptRegionalCharacters();

        for (const field of sideFields) field.style.display = 'block';

        globalThis.prompt.common.setTitle(LANG.regional_custom_prompt);
        globalThis.prompt.positive.setTitle(LANG.regional_api_prompt);

        globalThis.prompt.positive_right.setValue(SETTINGS.api_prompt_right);
    } else {
        for (const field of sideFields) field.style.display = 'none';

        globalThis.prompt.common.setTitle(LANG.custom_prompt);
        globalThis.prompt.positive.setTitle(LANG.api_prompt);
    }
    // the Scene mirrors the container's visibility: re-lay it out so the Regional
    // block appears / disappears with the switch (the model type callback lays out once itself)
    if (refreshScene) globalThis.prompt.fieldManager?.refresh?.();
    // the Final prompt preview gains / loses its right side with the switch
    globalThis.prompt.tagCapsuleFields?.refreshFinalPrompt?.();
}

// The Artist card changed a slot. The control has already written the slots through the
// settings proxy, which marks the section dirty, so this only redraws the preview.
export function callback_artistList_changed() {
    globalThis.prompt?.tagCapsuleFields?.refreshFinalPrompt?.();
}

export function callback_controlnet(trigger)  {                
    const SETTINGS = globalThis.globalSettings;
    const FILES = globalThis.cachedFiles;
    const LANG = FILES.language[SETTINGS.language];
    const apiInterface = globalThis.generate.api_interface.getValue();

    globalThis.globalSettings.api_controlnet_enable = trigger; 

    if(globalThis.custom_message.controlnet)
        return;
    
    if(trigger && apiInterface === 'ComfyUI') {
        globalThis.overlay.custom.createErrorOverlay(LANG.message_controlnet_comfyui , LANG.message_controlnet_comfyui_link);
    }

    globalThis.custom_message.controlnet = true;
}

export function callback_adetailer(trigger)  {                
    const SETTINGS = globalThis.globalSettings;
    const FILES = globalThis.cachedFiles;
    const LANG = FILES.language[SETTINGS.language];
    const apiInterface = globalThis.generate.api_interface.getValue();

    globalThis.globalSettings.api_adetailer_enable = trigger; 

    if(globalThis.custom_message.adetailer)
        return;

    if(trigger && apiInterface === 'ComfyUI') {        
        globalThis.overlay.custom.createErrorOverlay(LANG.message_adetailer_comfyui, LANG.message_adetailer_comfyui_link);
    }    
    if(trigger && apiInterface === 'WebUI') {
        globalThis.overlay.custom.createErrorOverlay(LANG.message_adetailer_webui , LANG.message_adetailer_webui_link);
    }
    globalThis.custom_message.adetailer = true;
}

export async function callback_queue_autostart(trigger, isDummy=false) {
    const SETTINGS = globalThis.globalSettings;
    const FILES = globalThis.cachedFiles;
    const LANG = FILES.language[SETTINGS.language];

    if (isDummy) {
        globalThis.generate.queueAutostart.setValue(trigger);
    }

    if(trigger) {
        globalThis.generate.skipClicked = false;
        globalThis.generate.cancelClicked = false;
        globalThis.generate.generate_skip.setClickable(true);
        globalThis.generate.generate_cancel.setClickable(true);
        globalThis.generate.generate_single.setTitle(LANG.run_button);
    } else {
        globalThis.generate.generate_single.setTitle(LANG.run_button_paused);
    }

    globalThis.globalSettings.generate_auto_start = trigger;
    globalThis.overlay.buttons.reload();
    globalThis.uiShell?.runBar?.refresh?.();
    if(trigger && globalThis.queueManager.getSlotsCount()>0) {
        await startQueue();
    }
}

export function setQueueAutoStart(trigger) {
    const SETTINGS = globalThis.globalSettings;
    const FILES = globalThis.cachedFiles;
    const LANG = FILES.language[SETTINGS.language];

    if(trigger)
        globalThis.generate.generate_single.setTitle(LANG.run_button);
    else 
        globalThis.generate.generate_single.setTitle(LANG.run_button_paused);

    globalThis.globalSettings.generate_auto_start=trigger;
    globalThis.generate.queueAutostart.setValue(trigger);
    globalThis.overlay.buttons.reload();
    // the run bar's "Queue n · auto-start on/off" has no poll: an error that pauses the
    // queue (the failed job stays, so the queue rows do not change) must redraw it
    globalThis.uiShell?.runBar?.refresh?.();
}

export async function callback_thumb_select(index, selectedValue) {
    const value = selectedValue[0];
    if(value === globalThis.globalSettings.thumb_select ) {
        console.log('Thumbnail selection unchanged:', value);
        return;
    }

    setBlur();
    await update_thumb_select(value);
    setNormal();
}

async function update_thumb_select(value) {
    const bak_thumb_select = globalThis.globalSettings.thumb_select;    
    globalThis.globalSettings.thumb_select = value;
    console.log('Selected thumbnail:', globalThis.globalSettings.thumb_select);

    // load new thumbnail files
    let success;
    if (globalThis.inBrowser) {
        success = await sendWebSocketMessage({ type: 'API', method: 'updateCharacterThumb', params: [globalThis.globalSettings.thumb_select] });
    } else {
        success = await globalThis.api.updateCachedCharacterThumb(globalThis.globalSettings.thumb_select);
    }
    if (!success) {
        console.error('Failed to load thumbnail files for selection:', globalThis.globalSettings.thumb_select);
        globalThis.globalSettings.thumb_select = bak_thumb_select;
        return;
    }        

    // update globalThis.cachedFiles with the new results
    let cachedFiles
    if (globalThis.inBrowser) {
        cachedFiles = await sendWebSocketMessage({ type: 'API', method: 'getCachedFiles'});
    } else {
        cachedFiles = await globalThis.api.getCachedFiles();
    }
    globalThis.cachedFiles.characterThumb = cachedFiles.characterThumb;
    globalThis.cachedFiles.characterList = cachedFiles.characters;
    globalThis.cachedFiles.tagAssist = cachedFiles.tagAssist;

    const SETTINGS = globalThis.globalSettings;
    const FILES = globalThis.cachedFiles;
    const LANG = FILES.language[SETTINGS.language];
    globalThis.cachedFiles.characterListArray = Object.entries(FILES.characterList);    

    // Character and OC List
    globalThis.characterList = myCharacterList('dropdown-character', FILES.characterList, FILES.ocList);
    globalThis.characterListRegional = myRegionalCharacterList('dropdown-character-regional', FILES.characterList, FILES.ocList);
        
    // Character List (variable slots; labels come from the wrapper's labelsFor)
    globalThis.characterList.setValueOnly(globalThis.globalSettings.language === 'en-US');
    // settings from before the side column: the regional characters become slot sides
    // (new slots only while Regional is on, as on the load path - language.js)
    SETTINGS.character_slots = migrateSlotSides(SETTINGS.character_slots, SETTINGS.character_left, SETTINGS.character_right,
        { weights: [SETTINGS.weights4dropdownlist?.[7], SETTINGS.weights4dropdownlist?.[8]], regional: Boolean(SETTINGS.regional_condition) });
    globalThis.characterList.setSlots(SETTINGS.character_slots);

    // Regional Condition: the Left / Right list mirrors the slots' side column
    setDropdownLanguage('dropdown-character-regional', [LANG.regional_character_left, LANG.regional_character_right]);
    globalThis.characterListRegional.setValueOnly(globalThis.globalSettings.language === 'en-US');
    syncRegionalCharacters();

    console.log('Thumbnail files loaded successfully.', FILES.characterListArray.length, 'characters available.');
}

export function callback_ptompt_textbox_autoresize(value) {    
    globalThis.globalSettings.ptompt_textbox_autoresize = value

    globalThis.prompt.common.setAutoResize(value);
    globalThis.prompt.positive.setAutoResize(value);
    globalThis.prompt.positive_right.setAutoResize(value);
    globalThis.prompt.negative.setAutoResize(value);
    globalThis.prompt.ai.setAutoResize(value);
    globalThis.prompt.exclude.setAutoResize(value);

    if (value === false) {
        // set to manual hight
        set_prompt_textBox_Heights();
    }
}

export function callback_ptompt_textbox_fontsize(value) { 
    globalThis.globalSettings.ptompt_textbox_fontsize=value; 

    changeFontSize(value);
}
