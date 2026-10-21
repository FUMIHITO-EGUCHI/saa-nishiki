import { describeWorkflow } from '../shared/workflowRecord.js';

// The relay does not expose per-node execution or stage images. Preserve that
// uncertainty and record the API graph after the WebSocket output conversion.
export function createPodWorkflowRecord(store, workflow, requested, transforms, saveNodes) {
    const record=store.create('runs',{requested,transforms,transport:'pod-ssh',status:'preparing',submitted:false,
        apiPrompt:workflow,provenance:describeWorkflow(workflow,saveNodes.length===1?saveNodes[0]:'unknown'),
        events:[],stages:[],stageCapture:'unavailable over existing Pod relay',timing:{basis:'client wall clock; per-stage durations not measured'}});
    const save=()=>store.write('runs',record);
    return {
        id:record.id,
        event(frame){
            if(!['queued','done','error'].includes(frame.event))return;
            record.events.push({type:frame.event,at:new Date().toISOString()});
            if(frame.event==='queued'){record.promptId=frame.promptId;record.submitted=true;record.status='running';record.startedAt=new Date().toISOString();}
            save();
        },
        finish(result,image,cancelled=false){
            record.finishedAt=new Date().toISOString();
            if(result.promptId)record.promptId=result.promptId;
            if(result.error){record.status=cancelled?'cancelled':'failed';record.error=result.error;}
            else {
                record.status='succeeded';
                store.putImage('runs',record.id,'final.png',image);
                record.output={node:saveNodes.length===1?saveNodes[0]:'unknown',imageSlot:'websocket',batchIndex:0,asset:'final.png'};
            }
            save();
        },
    };
}
