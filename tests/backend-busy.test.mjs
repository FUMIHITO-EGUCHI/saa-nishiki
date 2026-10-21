import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
const electron=`export const app={getVersion:()=> 'test'};export const ipcMain={};`;
register('data:text/javascript,'+encodeURIComponent(`export async function resolve(name,context,next){
    if(name==='electron')return {url:${JSON.stringify('data:text/javascript,'+encodeURIComponent(electron))},shortCircuit:true};
    return next(name,context);
}`),import.meta.url);
const {tryAcquireBackendBusy,setMutexBackendBusy}=await import('../main-common.js');
test('simultaneous normal-generation and image-edit claims have exactly one winner',async()=>{
    await setMutexBackendBusy(false);
    const results=await Promise.all([tryAcquireBackendBusy(),tryAcquireBackendBusy(),tryAcquireBackendBusy()]);
    assert.equal(results.filter(Boolean).length,1);
    await setMutexBackendBusy(false);
    assert.equal(await tryAcquireBackendBusy(),true);
    await setMutexBackendBusy(false);
});
