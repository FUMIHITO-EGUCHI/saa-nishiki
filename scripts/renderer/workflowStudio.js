import { openLibrary } from './libraryWindow.js';
import { VIEWER_SELECT_EVENT } from './customGallery.js';
import { button, tr } from './workflowUi.js';

// Desktop viewer actions lead into the Library's own viewer/edit surface.
export function setupWorkflowStudio() {
    if (globalThis.inBrowser || !globalThis.api?.workflowListRuns) return;
    if (globalThis.workflowStudio) return globalThis.workflowStudio;
    const tools = document.querySelector('.gallery-main-header .ui-card-tools');
    const openImage = (dataUrl, name = 'Image', runId) => openLibrary({
        image: {dataUrl,name,runId,key:runId ? 'run:'+runId : 'gallery:'+dataUrl.slice(-100)},
        edit:true,
    });
    const edit = button(tr('部分編集', 'Edit area'), () => {
        const entry = globalThis.mainGallery?.currentEntry?.();
        if (!entry?.image) return;
        const file = entry.record?.path ?? '';
        openLibrary({trigger:edit,edit:true,image:{
            dataUrl:entry.image,name:file.split(/[\\/]/).pop() || tr('表示中の画像','Displayed image'),
            key:file ? 'file:'+file.replaceAll('\\','/').toLowerCase() : 'gallery:'+entry.image.slice(-100),
            records:entry.record,
        }});
    }, 'viewer-edit-current');
    const history = button(tr('履歴','History'), () => openLibrary({trigger:history,view:'runs'}), 'viewer-run-history');
    edit.className = history.className = 'saa-icon-btn is-framed has-label';
    tools?.append(edit,history);
    const update = () => { edit.disabled = !globalThis.mainGallery?.currentEntry?.()?.image; };
    document.addEventListener(VIEWER_SELECT_EVENT,update); update();
    return globalThis.workflowStudio = {openImage};
}
