import { setBlur, setNormal, showDialog } from './myDialog.js';
import { sendWebSocketMessage } from '../../webserver/front/wsRequest.js';
import { setADetailerModelList } from '../slots/myADetailerSlot.js';
import { addFavorites, delFavorites } from './favoriteCharacters.js';

const CAT = '[myCollapsed]'

export function setupCollapsed(containerId, collapsed = false) {
    const mainItem = document.querySelector(`.${containerId}-main`);
    if (!mainItem) {
        console.error(CAT, 'mainItem not found', `.${containerId}-main`);
        return null;
    }

    const container = document.querySelector(`.${containerId}-container`);
    if (!container) {
        console.error(CAT, 'Container not found', `.${containerId}-container`);
        return null;
    }

    const arrowId = `${containerId}-toggle`;
    const toggleArrow = document.getElementById(arrowId);
    if (!toggleArrow) {
        console.error(CAT, 'Element not found', arrowId);
        return null;
    }
    
    toggleArrow.addEventListener('click', () => {
        setCollapsed(!container.classList.contains('collapsed'));
    });

    setCollapsed(collapsed);

    function setCollapsed(isCollapsed) {
        if (isCollapsed) {
            mainItem.classList.add('collapsed');
            container.classList.add('collapsed');
            toggleArrow.classList.add('collapsed');
        } else {
            mainItem.classList.remove('collapsed');
            container.classList.remove('collapsed');
            toggleArrow.classList.remove('collapsed');
        }
    }

    function getCollapsed() {
        return container.classList.contains('collapsed');
    }

    return {
        setCollapsed,
        getCollapsed
    };
}

export async function setupModelReloadToggle() {
    const refreshButton = document.getElementById('model-refresh-toggle');
    if (!refreshButton) {
        console.error(CAT, '[setupModelReloadToggle] Reload button not found');
        return null;
    }

    refreshButton.addEventListener('click', async () => {
        const currentModelSelect = globalThis.dropdownList.model.getValue();
        await reloadFiles();
        globalThis.dropdownList.model.updateDefaults(currentModelSelect);
        globalThis.lora.reload();
        globalThis.controlnet.reload();
        globalThis.aDetailer.reload();        
    });

    return refreshButton;
}

export async function reloadFiles(){
    const SETTINGS = globalThis.globalSettings;
    const LANG = globalThis.cachedFiles.language[SETTINGS.language];
    const args = [
        globalThis.globalSettings.model_path_comfyui,               // 0
        globalThis.globalSettings.model_path_webui,                 // 1
        globalThis.globalSettings.model_filter_keyword,             // 2
        globalThis.globalSettings.model_filter,                     // 3
        globalThis.globalSettings.search_modelinsubfolder,          // 4
        globalThis.globalSettings.model_filter_keyword_diffusion    // 5   
    ];

    if (globalThis.inBrowser) {
        await sendWebSocketMessage({ type: 'API', method: 'updateModelList', params: [args] });
        await sendWebSocketMessage({ type: 'API', method: 'updateWildcards'});
        await sendWebSocketMessage({ type: 'API', method: 'tagReload'});

        globalThis.cachedFiles.modelList = await sendWebSocketMessage({ type: 'API', method: 'getModelList', params: [SETTINGS.api_interface] });
        globalThis.cachedFiles.modelListAll = await sendWebSocketMessage({ type: 'API', method: 'getModelListAll', params: [SETTINGS.api_interface] });
        globalThis.cachedFiles.vaeList = await sendWebSocketMessage({ type: 'API', method: 'getVAEList', params: [SETTINGS.api_interface] });
        globalThis.cachedFiles.diffusionList = await sendWebSocketMessage({ type: 'API', method: 'getDiffusionModelList', params: [SETTINGS.api_interface] });
        globalThis.cachedFiles.textEncoderList = await sendWebSocketMessage({ type: 'API', method: 'getTextEncoderList', params: [SETTINGS.api_interface] });
        globalThis.cachedFiles.loraList = await sendWebSocketMessage({ type: 'API', method: 'getLoRAList', params: [SETTINGS.api_interface] });
        globalThis.cachedFiles.controlnetList = await sendWebSocketMessage({ type: 'API', method: 'getControlNetList', params: [SETTINGS.api_interface] });
        globalThis.cachedFiles.upscalerList = await sendWebSocketMessage({ type: 'API', method: 'getUpscalerList', params: [SETTINGS.api_interface] });
        globalThis.cachedFiles.aDetailerList = await sendWebSocketMessage({ type: 'API', method: 'getADetailerList', params: [SETTINGS.api_interface] });
        globalThis.cachedFiles.imageTaggerModels = await sendWebSocketMessage({ type: 'API', method: 'getImageTaggerModels' });
        if (SETTINGS.api_interface === 'WebUI')
            await sendWebSocketMessage({ type: 'API', method: 'resetModelListsWebUI'});
    } else {
        await globalThis.api.updateModelList(args);
        await globalThis.api.updateWildcards();
        await globalThis.api.tagReload();

        globalThis.cachedFiles.modelList = await globalThis.api.getModelList(SETTINGS.api_interface);
        globalThis.cachedFiles.modelListAll = await globalThis.api.getModelListAll(SETTINGS.api_interface);
        globalThis.cachedFiles.vaeList = await globalThis.api.getVAEList(SETTINGS.api_interface);
        globalThis.cachedFiles.diffusionList = await globalThis.api.getDiffusionModelList(SETTINGS.api_interface);
        globalThis.cachedFiles.textEncoderList = await globalThis.api.getTextEncoderList(SETTINGS.api_interface);
        globalThis.cachedFiles.loraList = await globalThis.api.getLoRAList(SETTINGS.api_interface);
        globalThis.cachedFiles.controlnetList = await globalThis.api.getControlNetList(SETTINGS.api_interface);
        globalThis.cachedFiles.upscalerList = await globalThis.api.getUpscalerList(SETTINGS.api_interface);
        globalThis.cachedFiles.aDetailerList = await globalThis.api.getADetailerList(SETTINGS.api_interface);
        globalThis.cachedFiles.imageTaggerModels = await globalThis.api.getImageTaggerModels();
        if (SETTINGS.api_interface === 'WebUI') {
            await globalThis.api.resetModelListsWebUI();
        }
    }
        
    if (SETTINGS.api_interface === 'WebUI') {
        // reset few list for Forge Neo
        globalThis.cachedFiles.controlnetProcessorListWebUI = 'none';
        globalThis.cachedFiles.upscalerListWebUI = 'none';
        setADetailerModelList(globalThis.cachedFiles.aDetailerList, true);
    } else {
        setADetailerModelList(globalThis.cachedFiles.aDetailerList);
    }

    if (globalThis.globalSettings.api_model_type === 'Checkpoint') {
        globalThis.dropdownList.model.setValue(LANG.api_model_file_select, globalThis.cachedFiles.modelList);
        globalThis.dropdownList.model.updateDefaults(SETTINGS.api_model_file_select);
    } else {
        globalThis.dropdownList.model.setValue(LANG.api_model_file_select, globalThis.cachedFiles.diffusionList);
        globalThis.dropdownList.model.updateDefaults(SETTINGS.api_model_file_diffusion_select);
    }
    globalThis.dropdownList.vae_unet.setValue(LANG.api_difussion_vae_model, globalThis.cachedFiles.vaeList);
    globalThis.dropdownList.vae_sdxl.setValue(LANG.api_ckpt_vae_model, globalThis.cachedFiles.vaeList);
    globalThis.dropdownList.textencoder.setValue(LANG.api_text_encoder, globalThis.cachedFiles.textEncoderList);

    globalThis.refiner.model.setValue(LANG.api_refiner_model, globalThis.cachedFiles.modelListAll);
}

export function setupFuctionKeys() {
    const refreshButton = document.getElementById('global-refresh-toggle');
    if (!refreshButton) {
        console.error(CAT, '[setupFuctionKeys] Refresh button not found');
        return null;
    }

    // Refresh
    refreshButton.addEventListener('click', () => {
        location.reload(); 
    });

    document.addEventListener('keydown', (event) => {
        const key = event.key.toLowerCase();

        // Refresh
        if (event.key === 'F5') {
            event.preventDefault(); 
            location.reload(); 
            return;
        }

        // Add to favorite list (Alt + D)
        if (event.altKey && !event.ctrlKey && !event.metaKey && key === 'd') {
            event.preventDefault();
            const c1 = globalThis.characterList.getValue()[0];
            const oc = globalThis.characterList.getKey()[3];

            addFavorites(c1);
            addFavorites(oc);
            return;
        }

        // Remove from favorite list (Alt + R)
        if (event.altKey && !event.ctrlKey && !event.metaKey && key === 'q') {
            event.preventDefault();
            const c3 = globalThis.characterList.getValue()[2];
            const oc = globalThis.characterList.getKey()[3];

            delFavorites(c3);
            delFavorites(oc);
        }
    });

    return refreshButton;
}

export function doSwap(rightToLeft) {
    const left = document.getElementById('left');
    const right = document.getElementById('right');

    if (rightToLeft) {
        right.before(left);
        left.style.marginLeft = '10px';
        left.style.marginRight = '5px';
        right.style.marginLeft = '5px';
        right.style.marginRight = '10px';
    } else {
        left.before(right);
        left.style.marginLeft = '5px';
        left.style.marginRight = '10px';
        right.style.marginLeft = '10px';
        right.style.marginRight = '5px';
    }
}

export function setupSwapToggle(){
    const swapButton = document.getElementById('global-settings-swap-layout-toggle');
    if (!swapButton) {
        console.error(CAT, '[setupSwapToggle] Swap button not found');
        return null;
    }
    
    swapButton.addEventListener('click', () => {
        globalThis.globalSettings.rightToleft = !globalThis.globalSettings.rightToleft;
        doSwap(globalThis.globalSettings.rightToleft);
    });    

    return swapButton;
}

