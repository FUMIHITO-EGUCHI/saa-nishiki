import test from 'node:test';
import assert from 'node:assert/strict';
import { createPodWorkflowRecord } from '../scripts/main/podWorkflowRecord.js';

test('Pod run records transformed graph and relay evidence without inventing node execution',()=>{
    let saved,asset;
    const store={create:(_,data)=>({...data,id:'run'}),write:(_,r)=>{saved=structuredClone(r);},putImage:(_kind,_id,_name,image)=>{asset=image;}};
    const graph={'29':{class_type:'SaveImageWebsocket',inputs:{images:['1',0]}}};
    const run=createPodWorkflowRecord(store,graph,{seed:42},[{reason:'Pod WebSocket output'}],['29']);
    run.event({event:'queued',promptId:'real-job'});
    run.finish({promptId:'real-job'},Buffer.from('png'));
    assert.equal(saved.submitted,true);assert.equal(saved.promptId,'real-job');
    assert.equal(saved.apiPrompt['29'].class_type,'SaveImageWebsocket');
    assert.equal(saved.provenance.nodes['29'].state,'unknown');
    assert.equal(saved.output.node,'29');assert.equal(asset.toString(),'png');
});
