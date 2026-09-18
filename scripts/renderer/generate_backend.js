import { customCommonOverlay } from './customOverlay.js';
import { formatBackendStatus } from './components/runProgress.js';

export function from_main_updateGallery(base64, seed, tagsString){
    const keepGallery = globalThis.generate.keepGallery.getValue();
    if(!keepGallery)
        globalThis.mainGallery.clearGallery();
    const info = globalThis.generate?.infoBySeed?.get?.(String(seed)) ?? '';
    globalThis.mainGallery.appendImageData(base64, seed, tagsString, keepGallery, globalThis.globalSettings.scroll_to_last, info);
}

export function from_main_updatePreview(base64){
    globalThis.uiShell?.setPreview?.(base64);
    let overlay = document.getElementById('cg-loading-overlay');
    if (!overlay) {
        overlay = customCommonOverlay().createLoadingOverlay();
    }
    const imgElement = overlay.querySelector('img');
    if (imgElement) {
        imgElement.src = base64;
        imgElement.style.maxWidth = '256px';
        imgElement.style.maxHeight = '384px';
        imgElement.style.objectFit = 'contain';
        imgElement.onerror = () => {
            imgElement.src = globalThis.cachedFiles.loadingWait;
            imgElement.style.maxWidth = '192px';
            imgElement.style.maxHeight = '192px';
            imgElement.onerror = null;
        };
    } 
}

// A wait in the main process that is not sampling (a ComfyUI restart for the fast-mode
// launch flags): { key, text, args } or null when it is over. The run bar shows it.
export function from_main_customOverlayStatus(status) {
    if (!globalThis.generate) return;
    const language = globalThis.cachedFiles?.language?.[globalThis.globalSettings?.language] ?? {};
    globalThis.generate.backendStatus = formatBackendStatus(status, language);
}

export function from_main_customOverlayProgress(progress, totalProgress){
    try {
        const loadingMessage = globalThis.generate.loadingMessage.split('<')[0];
        globalThis.generate.loadingMessage = `${loadingMessage} <${progress}/${totalProgress}>`;
    } catch {
        // by pass
    }
}

export function from_renderer_generate_updatePreview(base64) {
    from_main_updatePreview(base64);
}
