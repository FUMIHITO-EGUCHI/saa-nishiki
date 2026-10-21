import { randomUUID } from 'node:crypto';
import { pngBytes, readOriginal, prepareEdit, compositeEdit } from './imageEditPixels.js';
import { maskEditWorkflow } from './maskEditWorkflow.js';

export function createImageEditor(store, { generate: execute } = {}) {
    let active=null;
    const get=id=>store.read('projects',id);
    const write=project=>store.write('projects',project);
    const revision=(project,id)=> {
        const result=project.revisions.find(r=>r.id===id);
        if(!result) throw new Error('Revision not found');
        return result;
    };
    const parentOf=request=> {
        const project=get(request.projectId);
        if(project.currentRevision!==request.parentId) throw new Error('Current revision changed; select the parent again');
        const parent=revision(project,request.parentId);
        return {project,parent,bytes:store.image('projects',project.id,parent.asset)};
    };
    return {
        get,
        async create(dataUrl,name='Image') {
            const bytes=pngBytes(dataUrl), image=await readOriginal(bytes);
            const id=randomUUID();
            const project=store.create('projects',{ name:String(name).slice(0,120),width:image.width,height:image.height,
                channels:image.channels,currentRevision:id,attempts:[],revisions:[{id,asset:'original.png',parentId:null,status:'original',createdAt:new Date().toISOString()}] });
            store.putImage('projects',project.id,'original.png',bytes);
            return project;
        },
        async preview(request) {
            const {bytes}=parentOf(request);
            const prepared=await prepareEdit(bytes,pngBytes(request.mask),request.lock?pngBytes(request.lock):null,request);
            return {empty:prepared.empty,crop:prepared.crop,alpha:prepared.alphaPng?`data:image/png;base64,${prepared.alphaPng.toString('base64')}`:null};
        },
        async generate(request) {
            if(active) throw new Error('An image edit is already running');
            const {project,bytes}=parentOf(request);
            const attempt={id:randomUUID(),parentId:request.parentId,status:'preparing',createdAt:new Date().toISOString(),settings:request.settings};
            const job={id:attempt.id,cancelled:false,run:null}; active=job;
            project.attempts.push(attempt); write(project);
            try {
                const mask=pngBytes(request.mask), lock=request.lock?pngBytes(request.lock):null;
                store.putImage('projects',project.id,`${attempt.id}-mask.png`,mask);
                if(lock) store.putImage('projects',project.id,`${attempt.id}-lock.png`,lock);
                const prepared=await prepareEdit(bytes,mask,lock,request);
                if(prepared.empty) { attempt.status='no-change'; return attempt; }
                attempt.crop=prepared.crop;
                attempt.transform={modelInput:prepared.crop,returnSize:prepared.crop,resizeParent:false,padding:request.padding??32,feather:request.feather??4};
                store.putImage('projects',project.id,`${attempt.id}-alpha.png`,prepared.alphaPng);
                if(job.cancelled) throw new Error('Cancelled');
                job.run=await execute(maskEditWorkflow(prepared,request.settings),{...request.settings,parentRevision:request.parentId,crop:prepared.crop});
                attempt.runId=job.run.runId; attempt.status='running'; write(project);
                if(job.cancelled) await job.run.cancel();
                const {image}=await job.run.result;
                if(job.cancelled) throw new Error('Cancelled');
                const result=await compositeEdit(bytes,image,prepared);
                if(job.cancelled) throw new Error('Cancelled');
                store.putImage('projects',project.id,`${attempt.id}-candidate.png`,image);
                store.putImage('projects',project.id,`${attempt.id}-candidate-full.png`,result.candidateCanvas);
                const asset=store.putImage('projects',project.id,`${attempt.id}-composite.png`,result.image);
                attempt.status='review'; attempt.verification=result.verification;
                project.revisions.push({id:attempt.id,parentId:request.parentId,asset,status:'candidate',runId:attempt.runId,createdAt:attempt.createdAt});
                return attempt;
            } catch(error) {
                attempt.status=job.cancelled||error.message==='Cancelled'?'cancelled':'failed'; attempt.error=error.message; throw error;
            } finally {
                attempt.finishedAt=new Date().toISOString(); write(project); active=null;
            }
        },
        async cancel() { if(active) {active.cancelled=true; await active.run?.cancel();} },
        accept(id,revisionId) {
            if(active) throw new Error('Wait for the running edit');
            const project=get(id), item=revision(project,revisionId);
            if(item.status!=='candidate'||project.currentRevision!==item.parentId) throw new Error('Candidate parent is not the current revision');
            item.status='accepted'; project.currentRevision=item.id;
            project.attempts.find(a=>a.id===item.id).status='accepted';
            return write(project);
        },
        discard(id,revisionId) {
            if(active) throw new Error('Wait for the running edit');
            const project=get(id), item=revision(project,revisionId);
            if(item.status!=='candidate') throw new Error('Only a pending candidate can be discarded');
            item.status='discarded'; project.attempts.find(a=>a.id===item.id).status='discarded'; return write(project);
        },
        select(id,revisionId) {
            if(active) throw new Error('Wait for the running edit');
            const project=get(id), item=revision(project,revisionId);
            if(!['accepted','original'].includes(item.status)) throw new Error('Select an accepted revision');
            project.currentRevision=item.id; return write(project);
        },
    };
}
