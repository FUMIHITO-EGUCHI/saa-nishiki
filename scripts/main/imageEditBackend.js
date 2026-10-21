import { ipcMain } from 'electron';
import { getGlobalSettings } from './globalSettings.js';
import { getWorkflowStore, executeRecordedWorkflow } from './workflowRuntime.js';
import { createImageEditor } from './imageEditService.js';
import { backendAuthHeaders, httpApiUrl } from '../shared/backendAddress.js';
import { getMutexBackendBusy, setMutexBackendBusy } from '../../main-common.js';

function target() {
    const settings=getGlobalSettings();
    const addr=settings.api_addr;
    const url=new URL(httpApiUrl(addr,'object_info'));
    if(!['127.0.0.1','localhost','[::1]'].includes(url.hostname)) throw new Error('Partial editing currently requires local ComfyUI');
    return {addr,auth:settings.webui_auth_enable==='ON'?settings.webui_auth??'':''};
}
async function capabilities() {
    const {addr,auth}=target();
    const names=['CheckpointLoaderSimple','GzippedBase64ToImage','ImageToMask','LoRAfromText','CLIPTextEncode','ToBasicPipe','MaskDetailerPipe','PreviewImage'];
    const definitions=await Promise.all(names.map(async name=> {
        const response=await fetch(httpApiUrl(addr,`object_info/${name}`),{headers:backendAuthHeaders(auth),signal:AbortSignal.timeout(10_000)});
        if(!response.ok) throw new Error(`Cannot inspect ${name}: HTTP ${response.status}`);
        const definition=(await response.json())[name];
        if(!definition) throw new Error(`Required ComfyUI node is unavailable: ${name}`);
        return definition;
    }));
    const required=definitions[6].input.required;
    const options=definition=>Array.isArray(definition[0])?definition[0]:definition[1]?.options??[];
    return {models:options(definitions[0].input.required.ckpt_name),samplers:options(required.sampler_name),schedulers:options(required.scheduler),family:'Checkpoint'};
}

export function validateEditSettings(input, available) {
    if(!input||typeof input!=='object') throw new Error('Editing settings required');
    const result={};
    for(const [key,list] of [['model',available.models],['sampler',available.samplers],['scheduler',available.schedulers]]) {
        if(!list.includes(input[key])) throw new Error(`Unavailable ${key}`);
        result[key]=input[key];
    }
    for(const [key,min,max,integer] of [['seed',0,4294967295,true],['steps',1,100,true],['cfg',0,30,false],['denoise',0.01,1,false]]) {
        const number=input[key];
        if(!Number.isFinite(number)||number<min||number>max||(integer&&!Number.isInteger(number))) throw new Error(`Invalid ${key}`);
        result[key]=number;
    }
    for(const key of ['positive','negative']) {
        if(typeof input[key]!=='string'||input[key].length>20_000) throw new Error(`Invalid ${key} prompt`);
        result[key]=input[key];
    }
    if(!result.positive.trim()) throw new Error('Describe the requested edit');
    return result;
}

export function setupImageEditing() {
    const editor=createImageEditor(getWorkflowStore(),{
        generate:(workflow,requested)=>executeRecordedWorkflow({...target(),workflow,requested}),
    });
    ipcMain.handle('image-edit-capabilities',capabilities);
    ipcMain.handle('image-edit-list',()=>getWorkflowStore().list('projects').map(({id,name,createdAt,currentRevision})=>({id,name,createdAt,currentRevision})));
    ipcMain.handle('image-edit-get',(_,id)=>editor.get(id));
    ipcMain.handle('image-edit-create',(_,dataUrl,name)=>editor.create(dataUrl,name));
    ipcMain.handle('image-edit-preview',(_,request)=>editor.preview(request));
    let busy=false;
    ipcMain.handle('image-edit-generate',async (_,request)=> {
        if(busy||await getMutexBackendBusy()) throw new Error('ComfyUI is busy');
        busy=true;
        await setMutexBackendBusy(true);
        try {
            const settings=validateEditSettings(request.settings,await capabilities());
            return await editor.generate({...request,settings});
        } finally {busy=false; await setMutexBackendBusy(false);}
    });
    ipcMain.handle('image-edit-cancel',()=>editor.cancel());
    ipcMain.handle('image-edit-accept',(_,id,revisionId)=>editor.accept(id,revisionId));
    ipcMain.handle('image-edit-discard',(_,id,revisionId)=>editor.discard(id,revisionId));
    ipcMain.handle('image-edit-select',(_,id,revisionId)=>editor.select(id,revisionId));
}
