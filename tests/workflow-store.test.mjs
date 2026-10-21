import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createWorkflowStore } from '../scripts/main/workflowStore.js';

test('records survive a fresh store and image assets cannot be overwritten or traversed', t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'saa-workflow-store-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const store = createWorkflowStore(root);
    const run = store.create('runs', { status: 'queued' });
    store.putImage('runs', run.id, 'final.png', Buffer.from('pixels'));
    assert.throws(() => store.putImage('runs', run.id, 'final.png', Buffer.from('replace')));
    assert.throws(() => store.image('runs', run.id, '../secret.png'));
    assert.equal(createWorkflowStore(root).read('runs', run.id).status, 'queued');
    assert.equal(store.image('runs', run.id, 'final.png').toString(), 'pixels');
});

test('restart marks unfinished work interrupted without changing the selected parent',t=>{
    const root=fs.mkdtempSync(path.join(os.tmpdir(),'saa-workflow-store-'));
    t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
    const store=createWorkflowStore(root);
    const run=store.create('runs',{status:'running'});
    const project=store.create('projects',{currentRevision:'parent',attempts:[{status:'preparing'}]});
    store.recoverInterrupted();
    assert.equal(store.read('runs',run.id).status,'interrupted');
    assert.equal(store.read('projects',project.id).attempts[0].status,'interrupted');
    assert.equal(store.read('projects',project.id).currentRevision,'parent');
});
