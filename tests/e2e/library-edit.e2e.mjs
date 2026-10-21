// Library viewing and editing share one surface; no generation or model changes.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import sharp from 'sharp';
import { launchApp } from './harness.mjs';

test('a Library image is edited in its viewer and reopened from edit history', async t => {
    const folder=fs.mkdtempSync(path.join(os.tmpdir(),'saa-library-viewer-'));
    const original=await sharp({create:{width:640,height:480,channels:3,background:'#52728a'}}).png().toBuffer();
    const file=path.join(folder,'SAA_2026-10-21T09-00-00_viewer.png');fs.writeFileSync(file,original);
    const app=await launchApp({settings:{pod_image_save_dir:folder}});
    t.after(async()=>{await app.close();fs.rmSync(folder,{recursive:true,force:true});});
    const {page}=app;
    await page.click('#viewer-library-open');
    await page.waitFor(`Boolean(document.querySelector('.library-rail-item[data-root="pod"]'))`);
    await page.evaluate("document.querySelector('.library-rail-item[data-root=\"pod\"]').scrollIntoView({block:'center'})");
    await page.click('.library-rail-item[data-root="pod"]');
    await page.waitFor("document.querySelector('.library-detail-name')?.textContent === 'SAA_2026-10-21T09-00-00_viewer.png'");
    await page.waitFor(`Boolean(document.querySelector('.library-view-image'))`);
    await page.click('.library-view-image');
    await page.waitFor(`!document.querySelector('.library-viewer').hidden`);
    assert.equal(await page.evaluate(`document.querySelector('.library-viewer-image').naturalWidth`),640);
    await page.click('#library-viewer-edit');
    await page.waitFor(`Boolean(document.querySelector('.library-viewer #edit-positive'))`);
    assert.equal(await page.evaluate(`Boolean(document.querySelector('#workflow-studio'))`),false,'no separate editor dialog');
    assert.equal(await page.evaluate(`document.querySelector('.library-viewer .edit-canvas-surface img').naturalWidth`),640);
    const projects=await page.evaluate(`api.imageEditList()`);
    assert.equal(projects.length,1);
    // A real brush stroke and permission preview in this same viewer.
    const rect=await page.rect('.library-viewer .edit-canvas-surface canvas');
    await page.send('Input.dispatchMouseEvent',{type:'mousePressed',x:rect.x,y:rect.y,button:'left',clickCount:1});
    await page.send('Input.dispatchMouseEvent',{type:'mouseReleased',x:rect.x,y:rect.y,button:'left',clickCount:1});
    await page.click('#edit-preview');
    await page.waitFor(`document.querySelector('.workflow-edit-status').textContent.includes('Only the green area')`);
    // Closing and reopening the Library retains the in-progress mask and editor.
    await page.key('Escape','Escape',27);
    await page.click('#viewer-library-open');
    assert.equal(await page.evaluate(`document.querySelector('.workflow-edit-status').textContent.includes('Only the green area')`),true);
    await page.click('#library-viewer-back');
    await page.evaluate(`document.querySelector('.library-rail-item[data-view="projects"]').scrollIntoView({block:'center'})`);
    await page.click('.library-rail-item[data-view="projects"]');
    await page.waitFor(`Boolean(document.querySelector('.library-tile[data-project]'))`);
    await page.click('.library-tile[data-project]');
    assert.equal(await page.evaluate(`document.querySelector('.workflow-edit-status').textContent.includes('Only the green area')`),true,'reopening the same project retains the draft');
    // A new editor instance opened by source identity resumes the saved project.
    const resumed=await page.evaluate(`api.imageEditCreate(${JSON.stringify(`data:image/png;base64,${original.toString('base64')}`)},'viewer-original.png',undefined,{resume:true,sourceKey:${JSON.stringify(`file:${file.split(path.sep).join('/').toLowerCase()}`)}})`);
    assert.equal(resumed.id,projects[0].id);
    assert.deepEqual(fs.readFileSync(file),original);
});
