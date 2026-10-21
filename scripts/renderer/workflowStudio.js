import { element,button,tr,readFile } from './workflowUi.js';
import { showWorkflowRun } from './workflowRunsView.js';
import { showImageEditor } from './imageEditView.js';

export function setupWorkflowStudio() {
    if(globalThis.inBrowser||!globalThis.api?.workflowListRuns)return;
    if(globalThis.workflowStudio)return globalThis.workflowStudio;
    const api=globalThis.api;
    const dialog=element('dialog','','workflow-studio');dialog.id='workflow-studio';
    const header=element('header');const title=element('h2',tr('画像編集・実行履歴','Image editing & run history'));title.id='workflow-title';dialog.setAttribute('aria-labelledby',title.id);
    const close=button(tr('閉じる','Close'),()=>dialog.close(),'workflow-close');header.append(title,close);
    const message=element('p','','workflow-message');message.setAttribute('role','status');
    const body=element('div','','workflow-body'),sidebar=element('aside'),content=element('section','','workflow-content');body.append(sidebar,content);dialog.append(header,message,body);document.body.append(dialog);
    let lastFocus;
    dialog.addEventListener('close',()=>lastFocus?.focus());
    const guard=async action=>{try{message.textContent='';await action();}catch(error){message.textContent=error.message;}};
    const reveal=()=>{if(!dialog.open){lastFocus=document.activeElement;dialog.showModal();close.focus();}};
    const refreshList=async()=>{
        const [runs,projects,preferences]=await Promise.all([api.workflowListRuns(),api.imageEditList(),api.workflowPreferences()]);
        sidebar.replaceChildren();
        sidebar.append(button(tr('更新','Refresh'),()=>guard(refreshList),'workflow-refresh'));
        sidebar.append(button(tr('保存フォルダーを開く','Open storage folder'),()=>guard(()=>api.openSettingsFolder())));
        const importLabel=element('label',tr('PNGから編集を始める','Start editing a PNG'),'workflow-field');const input=document.createElement('input');input.type='file';input.accept='image/png';input.id='workflow-import';importLabel.append(input);sidebar.append(importLabel);
        input.onchange=()=>guard(async()=>{if(input.files[0])await openImage(await readFile(input.files[0]),input.files[0].name);});
        const captureLabel=element('label',tr('次のrunで段階画像を記録','Capture stages in subsequent runs'),'workflow-capture');const capture=document.createElement('input');capture.type='checkbox';capture.checked=preferences.captureStages;capture.id='workflow-capture';captureLabel.prepend(capture);sidebar.append(captureLabel);
        capture.onchange=()=>guard(()=>api.workflowPreferences({captureStages:capture.checked}));
        sidebar.append(element('h3',tr('画像プロジェクト','Image projects')));
        if(!projects.length)sidebar.append(element('p',tr('まだありません。PNGを選んで開始できます。','No projects yet. Choose a PNG to start.')));
        for(const project of projects)sidebar.append(button(project.name,()=>guard(()=>showImageEditor(content,project.id,guard,refreshList))));
        sidebar.append(element('h3',tr('生成run','Generation runs')));
        if(!runs.length)sidebar.append(element('p',tr('これから生成する画像の実行記録が表示されます。','New generation runs will appear here.')));
        for(const run of runs)sidebar.append(button(`${new Date(run.createdAt).toLocaleTimeString()} · ${run.status}`,()=>guard(()=>showWorkflowRun(content,run.id,openImage,guard))));
    };
    const openImage=async(dataUrl,name='Image',runId)=>{reveal();if(content.dataset.workflowBusy==='true')throw new Error(tr('実行中の編集を待つか中止してください。','Wait for or cancel the current edit.'));const project=await api.imageEditCreate(dataUrl,name,runId);await refreshList();await showImageEditor(content,project.id,guard,refreshList);};
    const toolbar=element('div','','workflow-toolbar');toolbar.append(
        button(tr('実行履歴・画像編集','Runs & image editing'),()=>guard(async()=>{reveal();await refreshList();if(!content.childElementCount)content.append(element('p',tr('左の実行記録または画像プロジェクトを選択してください。','Select a run or image project on the left.')));}), 'workflow-open'),
        button(tr('表示中の画像を部分編集','Edit displayed image'),()=>guard(async()=>{const src=globalThis.mainGallery?.currentImage?.();if(!src)throw new Error(tr('ギャラリーの画像を選んでください。','Select an image in the gallery.'));await openImage(src,tr('ギャラリー画像','Gallery image'));}), 'workflow-edit-current'));
    document.querySelector('.gallery-main-main')?.before(toolbar);
    return globalThis.workflowStudio={openImage:(...args)=>guard(()=>openImage(...args))};
}
