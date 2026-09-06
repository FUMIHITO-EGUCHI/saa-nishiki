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

export async function callback_api_model_select(index, selectedValue) {
    const value = selectedValue[0];    

    const SETTINGS = globalThis.globalSettings;
    if (SETTINGS.api_model_type === 'Checkpoint') {
        globalThis.globalSettings.api_model_file_select = value;
    } else {
        globalThis.globalSettings.api_model_file_diffusion_select = value;
    }
}

export async function callback_api_model_type(index, selectedValue) {
    const SETTINGS = globalThis.globalSettings;
    const LANG = globalThis.cachedFiles.language[SETTINGS.language];

    const value = selectedValue[0];
    console.log('Selected model type:', value);
    globalThis.globalSettings.api_model_type = value; 

    if (value === 'Checkpoint') {
        globalThis.dropdownList.model.setValue(LANG.api_model_file_select, globalThis.cachedFiles.modelList);
        globalThis.dropdownList.model.setTitle(LANG.api_model_file_select);
        globalThis.dropdownList.model.updateDefaults(SETTINGS.api_model_file_select);

        globalThis.generate.regionalCondition.setEnable(true);
        globalThis.generate.regionalCondition_dummy.setEnable(true);

        globalThis.generate.refiner.setEnable(true);

        globalThis.generate.controlnet.setEnable(true);

        //globalThis.generate.adetailer.setEnable(true);
    } else {
        globalThis.dropdownList.model.setValue(LANG.api_diffusion_model, globalThis.cachedFiles.diffusionList);
        globalThis.dropdownList.model.setTitle(LANG.api_diffusion_model);
        globalThis.dropdownList.model.updateDefaults(SETTINGS.api_model_file_diffusion_select);

        globalThis.generate.refiner.setValue(false);
        globalThis.generate.refiner.setEnable(false);

        globalThis.generate.controlnet.setValue(false);
        globalThis.generate.controlnet.setEnable(false);

        //globalThis.generate.adetailer.setValue(false);
        //globalThis.generate.adetailer.setEnable(false);
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
    globalThis.dropdownList.model.updateDefaults(currentModelSelect);

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

        if(modelType !== 'Checkpoint') {
            globalThis.dropdownList.model_type.updateDefaults('Checkpoint');
            callback_api_model_type(0, ['Checkpoint']);
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
}

// The Prompts card swaps the regional characters as data; refresh the thumbs then.
if (typeof document !== 'undefined') {
    document.addEventListener('saa:regional-characters-changed', () => { callback_myCharacterList_updateThumb(); });
}

export async function callback_myCharacterList_updateThumb(){
    if(globalThis.globalSettings.regional_condition) {
        const L = globalThis.characterListRegional.getKey()[0];
        const R = globalThis.characterListRegional.getKey()[1];

        const iL = await decodeThumb(L);
        const iR = await decodeThumb(R);
        const imgData = [];

        if (iR !== null) imgData.push(iR);
        if (iL !== null) imgData.push(iL);                

        globalThis.thumbGallery.update(imgData);

        globalThis.globalSettings.character_left = L;
        globalThis.globalSettings.character_right = R;
        // the Prompts card lists each side's character
        globalThis.prompt?.fieldManager?.renderList?.();
    } else {
        const keys = globalThis.characterList.getKey();
        const slots = globalThis.characterList.getSlots?.() ??
            keys.map((key, index) => ({ key, weight: globalThis.characterList.getTextValue(index) }));

        // latest slot first (an original character has no stored thumb and is skipped)
        const imgData = [];
        for (let index = slots.length - 1; index >= 0; index--) {
            const image = await decodeThumb(keys[index]);
            if (image !== null) imgData.push(image);
        }
        globalThis.thumbGallery.update(imgData);

        globalThis.globalSettings.character_slots = slots;
        // read-only mirrors of slots 0-2 for pre-slot readers
        globalThis.globalSettings.character1 = slots[0]?.key ?? 'None';
        globalThis.globalSettings.character2 = slots[1]?.key ?? 'None';
        globalThis.globalSettings.character3 = slots[2]?.key ?? 'None';
    }
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

export function callback_regional_condition(trigger, dummy = false) {
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

    const dropdown1 = document.querySelector('.dropdown-character');
    const dropdown2 = document.querySelector('.dropdown-character-regional');
    // fields that only exist while Regional is on
    const sideFields = ['.prompt-positive-right', '.prompt-negative-left', '.prompt-negative-right']
        .map(selector => document.querySelector(selector)).filter(Boolean);

    if (trigger) {
        dropdown1.style.display = 'none';
        dropdown2.style.display = 'flex';
        for (const field of sideFields) field.style.display = 'block';

        globalThis.prompt.common.setTitle(LANG.regional_custom_prompt);
        globalThis.prompt.positive.setTitle(LANG.regional_api_prompt);

        globalThis.prompt.positive_right.setValue(SETTINGS.api_prompt_right);
    } else {
        dropdown1.style.display = 'flex';
        dropdown2.style.display = 'none';
        for (const field of sideFields) field.style.display = 'none';

        globalThis.prompt.common.setTitle(LANG.custom_prompt);
        globalThis.prompt.positive.setTitle(LANG.api_prompt);
    }
    // the field list mirrors the container's visibility: re-render it so
    // "Positive (right)" appears / disappears with the switch
    globalThis.prompt.fieldManager?.refresh?.();
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
    globalThis.characterList.setSlots(SETTINGS.character_slots);


    // Regional Condition
    setDropdownLanguage('dropdown-character-regional', [LANG.regional_character_left, LANG.regional_character_right]);
    globalThis.characterListRegional.setValueOnly(globalThis.globalSettings.language === 'en-US');
    globalThis.characterListRegional.updateDefaults(SETTINGS.character_left, SETTINGS.character_right);
    globalThis.characterListRegional.setTextValue(0, SETTINGS.weights4dropdownlist[7]);
    globalThis.characterListRegional.setTextValue(1, SETTINGS.weights4dropdownlist[8]);

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
