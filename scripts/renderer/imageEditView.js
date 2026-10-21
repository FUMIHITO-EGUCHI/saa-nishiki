import { createMaskCanvas } from './imageEditCanvas.js';
import { element,button,field,select,number,tr,readFile } from './workflowUi.js';

export async function showImageEditor(container,projectId,guard,refreshList) {
    const api=globalThis.api;
    let project=await api.imageEditGet(projectId),candidate=null,permissionChecked=false,busy=false,previewing=false,capabilitiesReady=false;
    const parent=()=>project.revisions.find(r=>r.id===project.currentRevision);
    container.replaceChildren(element('h3',project.name));
    const history=element('div','','workflow-actions');container.append(history);
    const surface=element('div','','edit-canvas-scroll');
    const tools=element('div','','workflow-actions');container.append(tools,surface);
    const status=element('p',tr('緑：編集範囲　黄：Lock。原画は変更されません。','Green: editable. Yellow: Lock. The parent stays unchanged.'),'workflow-edit-status');status.setAttribute('role','status');container.append(status);
    const parentUrl=()=>api.workflowImage('projects',project.id,parent().asset);
    const comparisonParentUrl=()=>api.workflowImage('projects',project.id,project.revisions.find(r=>r.id===(candidate?.parentId??project.currentRevision)).asset);
    const mask=await createMaskCanvas(surface,await parentUrl(),project.width,project.height,()=>{permissionChecked=false;});
    const tool=select([{value:'edit',label:tr('編集','Edit')},{value:'lock',label:'Lock'},{value:'eraseEdit',label:tr('編集範囲を消す','Erase edit')},{value:'eraseLock',label:tr('Lockを消す','Erase Lock')}]);
    tool.id='edit-tool';field(tools,tr('ブラシ','Brush'),tool);tool.onchange=()=>mask.setTool(tool.value);
    const brush=number(tools,tr('太さ（原画px）','Size (original px)'),32,1,512);brush.oninput=()=>mask.setBrush(Number(brush.value));
    const zoom=number(tools,tr('表示倍率 %','Zoom %'),Math.round(Math.min(1,640/project.width)*100),10,300);zoom.oninput=()=>mask.zoom(Number(zoom.value)/100);
    tools.append(button(tr('編集をクリア','Clear edit'),()=>mask.clear('edit')),button(tr('Lockをクリア','Clear Lock'),()=>mask.clear('lock')));
    const visible=document.createElement('input');visible.type='checkbox';visible.checked=true;field(tools,tr('マスク表示','Show masks'),visible);visible.onchange=()=>mask.showMasks(visible.checked);
    for(const [name,apply] of [['edit',mask.importEdit],['lock',mask.importLock]]){
        const input=document.createElement('input');input.type='file';input.accept='image/png';input.id=`edit-import-${name}`;
        field(tools,name==='edit'?tr('編集マスク読込','Import edit mask'):tr('Lock読込','Import Lock'),input);
        input.onchange=()=>guard(async()=>{if(input.files[0])await apply(await readFile(input.files[0]));});
    }
    const form=element('div','','workflow-edit-settings');container.append(form);
    const positive=field(form,tr('編集後の内容','Describe the edited area'),element('textarea'));positive.id='edit-positive';positive.rows=3;
    const negative=field(form,tr('避けたい内容','Negative prompt'),element('textarea'));negative.id='edit-negative';negative.rows=2;
    const advanced=element('details');advanced.open=true;advanced.append(element('summary',tr('生成設定（Checkpoint・ローカル）','Generation settings (Checkpoint · local)')));form.append(advanced);
    const settingsGrid=element('div','','workflow-edit-grid');advanced.append(settingsGrid);
    const model=field(settingsGrid,tr('モデル','Model'),select([]));model.id='edit-model';
    const sampler=field(settingsGrid,'Sampler',select([])),scheduler=field(settingsGrid,'Scheduler',select([]));
    const seed=number(settingsGrid,'Seed',Math.floor(Math.random()*4294967295),0,4294967295);
    const steps=number(settingsGrid,'Steps',20,1,100),cfg=number(settingsGrid,'CFG',5,0,30,0.1),denoise=number(settingsGrid,'Denoise',0.6,0.01,1,0.01);
    const padding=number(settingsGrid,tr('周辺余白 px','Context padding px'),32,0,512),feather=number(settingsGrid,tr('境界ぼかし px','Feather px'),4,0,64);
    const guideSize=number(settingsGrid,tr('処理の基準サイズ px','Processing guide size px'),512,128,1024);
    const maxSize=number(settingsGrid,tr('処理の最大サイズ px','Maximum processing size px'),1024,128,1536);
    guideSize.id='edit-guide-size';maxSize.id='edit-max-size';
    padding.onchange=feather.onchange=()=>{permissionChecked=false;};
    const actions=element('div','','workflow-actions');container.append(actions);
    const compare=select([{value:'parent',label:tr('親画像','Parent')},{value:'candidate-full',label:tr('生成候補（合成前）','Candidate before masking')},{value:'composite',label:tr('合成結果','Composite')}],'parent');
    compare.id='edit-compare';field(actions,tr('同じ座標で比較','Compare at the same coordinates'),compare);
    compare.onchange=()=>guard(async()=>{if(compare.value==='parent')await mask.setImage(await comparisonParentUrl());else if(candidate)await mask.setImage(await api.workflowImage('projects',project.id,`${candidate.id}-${compare.value}.png`));toggleBusy();});
    const request=()=>({projectId:project.id,parentId:project.currentRevision,...mask.masks(),padding:Number(padding.value),feather:Number(feather.value),settings:{model:model.value,sampler:sampler.value,scheduler:scheduler.value,seed:Number(seed.value),steps:Number(steps.value),cfg:Number(cfg.value),denoise:Number(denoise.value),positive:positive.value,negative:negative.value,guideSize:Number(guideSize.value),maxSize:Number(maxSize.value)}});
    const preview=button(tr('変わる範囲を確認','Preview permitted area'),()=>guard(async()=>{
        previewing=true;permissionChecked=false;toggleBusy();
        try {
            const plan=await api.imageEditPreview(request());await mask.permission(plan.alpha);permissionChecked=!plan.empty;
            status.textContent=plan.empty?tr('編集可能な範囲がありません。','No editable pixels.'):tr('緑の範囲だけが合成対象です。Lockは優先されます。','Only the green area can change. Lock takes precedence.');
        } finally {previewing=false;toggleBusy();}
    }),'edit-preview');
    const generate=button(tr('候補を生成','Generate candidate'),()=>guard(async()=>{
        if(!permissionChecked){status.textContent=tr('先に「変わる範囲を確認」を押してください。','Preview the permitted area first.');return;}
        busy=true;toggleBusy();status.textContent=tr('生成中。親画像は保持しています。','Generating. The parent is preserved.');
        const started=Date.now();
        const ticker=setInterval(()=>{status.textContent=`${tr('生成中。親画像は保持しています。','Generating. The parent is preserved.')} ${Math.floor((Date.now()-started)/1000)}s`;},1000);
        try{candidate=await api.imageEditGenerate(request());
            if(candidate.status==='no-change'){status.textContent=tr('変更なし。現在版はそのままです。','No changes. Current revision is unchanged.');return;}
            project=await api.imageEditGet(project.id);await showCandidate(candidate);
        }catch(error){status.textContent=error.message;throw error;}
        finally{clearInterval(ticker);busy=false;await refreshHistory();toggleBusy();await refreshList();}
    }),'edit-generate');
    const cancel=button(tr('中止','Cancel'),()=>guard(()=>api.imageEditCancel()),'edit-cancel');cancel.disabled=true;
    const accept=button(tr('採用','Accept'),()=>guard(async()=>{
        project=await api.imageEditAccept(project.id,candidate.id);await mask.setImage(await parentUrl());mask.clear('edit');compare.value='parent';
        status.textContent=tr('採用しました。次の編集はこの版から始まります。','Accepted. The next edit starts from this revision.');
        candidate=null;await refreshHistory();toggleBusy();await refreshList();
    }),'edit-accept');
    const discard=button(tr('破棄','Discard'),()=>guard(async()=>{project=await api.imageEditDiscard(project.id,candidate.id);candidate=null;compare.value='parent';await mask.setImage(await parentUrl());status.textContent=tr('破棄しました。現在版は変更されていません。','Discarded. Current revision is unchanged.');await refreshHistory();toggleBusy();}),'edit-discard');
    actions.append(preview,generate,cancel,accept,discard);
    async function showCandidate(attempt){candidate=attempt;compare.value='composite';await mask.setImage(await api.workflowImage('projects',project.id,`${attempt.id}-composite.png`));status.textContent=`${tr('保持領域の変更画素','Changed protected pixels')}: ${attempt.verification.protectedChangedPixels} · ${tr('変更画素','Changed pixels')}: ${attempt.verification.changedPixels} · ${tr('候補はまだ採用されていません。','Candidate is not yet accepted.')}`;}
    function toggleBusy(){
        const staleParent=candidate&&candidate.parentId!==project.currentRevision;
        const waiting=busy||previewing;
        container.dataset.workflowBusy=String(waiting);
        for(const control of container.closest('.workflow-studio')?.querySelectorAll('aside input,aside button')??[])control.disabled=waiting;
        surface.inert=waiting||compare.value!=='parent'||staleParent;
        for(const control of container.querySelectorAll('input,textarea,select,button'))control.disabled=waiting;
        generate.disabled=waiting||!capabilitiesReady||staleParent;preview.disabled=waiting||staleParent;
        generate.textContent=candidate?tr('同じ親から別候補を生成','Generate another candidate from the same parent'):tr('候補を生成','Generate candidate');
        cancel.disabled=!busy;discard.disabled=waiting||!candidate||candidate.status!=='review';accept.disabled=discard.disabled||staleParent;
        if(staleParent)status.textContent=tr('この候補の親は現在版と異なります。比較のみ可能です。「この編集の親・マスク・設定を復元」から再開できます。','This candidate has a different parent. Comparison only. Restore this edit’s parent, masks and settings to continue.');
    }
    async function refreshHistory(){
        project=await api.imageEditGet(project.id);history.replaceChildren();
        const choices=select(project.revisions.filter(r=>['original','accepted'].includes(r.status)).map((r,i)=>({value:r.id,label:`${i} · ${r.status} · ${new Date(r.createdAt).toLocaleTimeString()}`})),project.currentRevision);
        choices.id='edit-revision';field(history,tr('採用済みの版','Accepted revisions'),choices);
        history.append(button(tr('この版に戻る','Use this revision'),()=>guard(async()=>{project=await api.imageEditSelect(project.id,choices.value);candidate=null;mask.clear('edit');mask.clear('lock');compare.value='parent';await mask.setImage(await parentUrl());await refreshHistory();toggleBusy();}),'edit-restore'));
        const current=parent();
        if(current.parentId)history.append(button(tr('直前の編集範囲をLock','Lock the last edit'),()=>guard(async()=>{await mask.importLock(await api.workflowImage('projects',project.id,`${current.id}-alpha.png`),true);}),'edit-lock-last'));
        const pending=project.attempts.filter(a=>a.status==='review');
        for(const item of pending)history.append(button(`${tr('未採用候補','Pending candidate')} ${item.id.slice(0,6)}`,()=>guard(async()=>{await showCandidate(item);toggleBusy();})));
        const errors=project.attempts.filter(a=>['failed','cancelled','interrupted'].includes(a.status));
        if(errors.length)history.append(element('span',`${errors.at(-1).status}: ${errors.at(-1).error??''}`));
        if(project.attempts.length){
            const records=select(project.attempts.map(a=>({value:a.id,label:`${a.id.slice(0,6)} · ${a.status}`})),candidate?.id??project.attempts.at(-1).id);
            field(history,tr('編集記録','Edit records'),records);
            history.append(button(tr('この編集の親・マスク・設定を復元','Restore this edit’s parent, masks and settings'),()=>guard(async()=>{
                const item=project.attempts.find(a=>a.id===records.value);
                project=await api.imageEditSelect(project.id,item.parentId);candidate=null;compare.value='parent';await mask.setImage(await parentUrl());
                await mask.importEdit(await api.workflowImage('projects',project.id,`${item.id}-mask.png`));
                if(item.assets?.lock)await mask.importLock(await api.workflowImage('projects',project.id,item.assets.lock));else mask.clear('lock');
                for(const [control,key] of [[model,'model'],[sampler,'sampler'],[scheduler,'scheduler'],[seed,'seed'],[steps,'steps'],[cfg,'cfg'],[denoise,'denoise'],[positive,'positive'],[negative,'negative'],[guideSize,'guideSize'],[maxSize,'maxSize']])control.value=item.settings[key]??control.value;
                padding.value=item.transform?.padding??32;feather.value=item.transform?.feather??4;permissionChecked=false;
                await refreshHistory();toggleBusy();
            })));
            const details=element('details');details.append(element('summary',tr('親・変換・保持検査の記録','Parent, transform and preservation records')),element('pre',JSON.stringify(project,null,2)));history.append(details);
        }
    }
    await refreshHistory();toggleBusy();generate.disabled=true;
    try{
        const caps=await api.imageEditCapabilities();
        for(const [control,values,preferred] of [[model,caps.models,globalThis.globalSettings.api_model_file_select],[sampler,caps.samplers,'euler'],[scheduler,caps.schedulers,'normal']]){
            control.replaceChildren(...values.map(value=>{const option=element('option',value);option.value=value;return option;}));if(values.includes(preferred))control.value=preferred;
        }
        capabilitiesReady=true;generate.disabled=false;
    }catch(error){status.textContent=error.message;}
}
