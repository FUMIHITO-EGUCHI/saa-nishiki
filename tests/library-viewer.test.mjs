import test from 'node:test';
import assert from 'node:assert/strict';
import { withFakeDom } from './helpers/fakeDom.mjs';
import { createLibraryViewer } from '../scripts/renderer/libraryViewer.js';

test('opening a source reserves the viewer before its pixels arrive',()=>withFakeDom(async()=>{
    const host=document.createElement('section');document.body.append(host);
    const viewer=createLibraryViewer(host,{onBack(){}});
    let resolve;
    const pixels=new Promise(done=>{resolve=done;});
    const opening=viewer.openImage(()=>pixels);
    assert.equal(viewer.busy(),true);
    assert.equal(await viewer.openImage({key:'second',name:'Second',dataUrl:'second'}),false);
    resolve({key:'first',name:'First',dataUrl:'first'});
    assert.equal(await opening,true);
    assert.equal(host.querySelector('.library-viewer-image').src,'first');
    assert.equal(viewer.busy(),false);
}));

test('a source read failure releases the viewer without replacing the previous image',()=>withFakeDom(async()=>{
    const host=document.createElement('section');document.body.append(host);
    const viewer=createLibraryViewer(host,{onBack(){}});
    await viewer.openImage({key:'first',name:'First',dataUrl:'first'});
    await assert.rejects(viewer.openImage(async()=>{throw new Error('Missing image');}),/Missing image/);
    assert.equal(viewer.busy(),false);
    assert.equal(host.querySelector('.library-viewer-image').src,'first');
    assert.equal(await viewer.openImage({key:'second',name:'Second',dataUrl:'second'}),true);
    assert.equal(host.querySelector('.library-viewer-image').src,'second');
}));
