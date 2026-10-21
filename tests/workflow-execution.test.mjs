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
