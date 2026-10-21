import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { WebSocketServer } from 'ws';
import { startWorkflowExecution } from '../scripts/main/workflowExecution.js';

test('a completed cached run is retrieved without progress events and retains output identity', async t => {
    const server = http.createServer((req, res) => {
        if (req.url === '/prompt') { res.end(JSON.stringify({ prompt_id: 'p1' })); return; }
        if (req.url === '/history/p1') { res.end(JSON.stringify({ p1: { status: { completed: true, status_str: 'success', messages: [['execution_cached', { nodes: ['2'] }]] }, outputs: { '29': { images: [{ filename: 'result.png', subfolder: '', type: 'output' }] } } } })); return; }
        if (req.url.startsWith('/view?')) { res.end(Buffer.from('image')); return; }
        res.end('{}');
    });
    const ws = new WebSocketServer({ server });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    t.after(() => { ws.close(); server.close(); });
    let saved;
    const store = { create: (_, r) => ({ ...r, id: 'test' }), write: (_, r) => { saved = structuredClone(r); }, putImage() {} };
    const run = await startWorkflowExecution({ addr: `127.0.0.1:${server.address().port}`, workflow: { '29': { class_type: 'SaveImage', inputs: {} }, '2': { class_type: 'KSampler', inputs: { seed: 1 } } }, store });
    const result = await run.result;
    assert.equal(result.image.toString(), 'image');
    assert.equal(saved.promptId, 'p1');
    assert.equal(saved.output.batchIndex, 0);
    assert.equal(saved.output.filename, 'result.png');
    assert.equal(saved.provenance.nodes['2'].state, 'cached');
    assert.equal(saved.status, 'succeeded');
});

test('cancellation during submission waits for targeted remote cancellation before settling', async t => {
    let cancelFinished=false, submitted;
    const submission=new Promise(resolve=>{submitted=resolve;});
    const server=http.createServer(async(req,res)=>{
        if(req.url==='/prompt') { submitted(); await new Promise(r=>setTimeout(r,50)); res.end('{"prompt_id":"cancel-me"}'); return; }
        if(req.url==='/api/jobs/cancel-me/cancel') { await new Promise(r=>setTimeout(r,100)); cancelFinished=true; res.end('{"cancelled":true}'); return; }
        assert.notEqual(req.url,'/interrupt','never interrupt another prompt globally');
        res.end('{}');
    });
    const ws=new WebSocketServer({server});
    await new Promise(r=>server.listen(0,'127.0.0.1',r));
    t.after(()=>{ws.close();server.close();});
    let saved;
    const store={create:(_,r)=>({...r,id:'test'}),write:(_,r)=>{saved=structuredClone(r);},putImage(){}};
    const cancellation={cancelled:false};
    const starting=startWorkflowExecution({addr:`127.0.0.1:${server.address().port}`,workflow:{},store,cancellation});
    await submission;cancellation.cancelled=true;
    const run=await starting;
    await assert.rejects(run.result,/Cancelled/);
    assert.equal(cancelFinished,true);
    assert.equal(saved.status,'cancelled');
    assert.equal(saved.promptId,'cancel-me');
});

test('a dropped history connection is retried without discarding a running generation',async t=>{
    let polls=0,saved;
    const server=http.createServer((req,res)=>{
        if(req.url==='/prompt'){res.end('{"prompt_id":"retry"}');return;}
        if(req.url==='/history/retry'){
            if(++polls===1){req.socket.destroy();return;}
            res.end(JSON.stringify({retry:{status:{completed:true},outputs:{'29':{images:[{filename:'final.png',type:'temp',subfolder:''}]}}}}));return;
        }
        res.end('pixels');
    });
    const ws=new WebSocketServer({server});await new Promise(r=>server.listen(0,'127.0.0.1',r));
    t.after(()=>{ws.close();server.close();});
    const store={create:(_,r)=>({...r,id:'test'}),write:(_,r)=>{saved=structuredClone(r);},putImage(){}};
    const run=await startWorkflowExecution({addr:`127.0.0.1:${server.address().port}`,workflow:{},store});
    await run.result;assert.equal(saved.status,'succeeded');assert.ok(polls>=2);
    assert.ok(saved.events.some(e=>e.type==='history-retry'));
});
