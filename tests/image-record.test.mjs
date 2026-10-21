// Where a generated image is on disk and what the run writes into it afterwards
// (scripts/main/imageRecord.js), and the ComfyUI backend's side of the recipe: the recipe
// goes out with the prompt, the run is timed, and the result is handed to the renderer.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import { register } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import zlib from 'node:zlib';
import { WebSocketServer } from 'ws';

import { isLocalAddress, outputDirFromStats, savedImagePath, stampImageTime, writePngRecords } from '../scripts/main/imageRecord.js';
import { asciiJson, crc32, insertTextChunks, readTextChunks } from '../scripts/shared/pngText.js';

function tinyPng() {
    const chunk = (type, data) => {
        const head = Buffer.alloc(8);
        head.writeUInt32BE(data.length, 0);
        head.write(type, 4, 'latin1');
        const crc = Buffer.alloc(4);
        crc.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, 'latin1'), data])), 0);
        return Buffer.concat([head, data, crc]);
    };
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(1, 0);
    ihdr.writeUInt32BE(1, 4);
    ihdr[8] = 8; ihdr[9] = 6;
    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
        chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(Buffer.alloc(5))), chunk('IEND', Buffer.alloc(0)),
    ]);
}

test('the output directory: --output-directory, then --base-directory, then beside custom_nodes', () => {
    const main = 'C:\\stack\\runtime\\ComfyUI\\main.py';
    assert.equal(outputDirFromStats({ system: { argv: [main, '--listen', '127.0.0.1', '--output-directory', 'D:\\out'] } }, null), 'D:\\out');
    assert.equal(outputDirFromStats({ system: { argv: [main, '--output-directory=D:\\out2'] } }, null), 'D:\\out2');
    assert.equal(outputDirFromStats({ system: { argv: [main, '--base-directory', 'E:\\comfy'] } }, null), 'E:\\comfy\\output');
    assert.equal(outputDirFromStats({ system: { argv: [main, '--output-directory', 'out'] } }, null), 'C:\\stack\\runtime\\ComfyUI\\out', 'relative to ComfyUI');
    assert.equal(outputDirFromStats({ system: { argv: ['main.py'] } }, { custom_nodes: ['C:\\ComfyUI\\custom_nodes'] }), 'C:\\ComfyUI\\output');
    assert.equal(outputDirFromStats({ system: { argv: ['/opt/ComfyUI/main.py'] } }, null), '/opt/ComfyUI/output');
    assert.equal(outputDirFromStats(null, null), '');
});

test('only a ComfyUI on this machine has its folders on this disk', () => {
    assert.equal(isLocalAddress('127.0.0.1:8189'), true);
    assert.equal(isLocalAddress('localhost:8188'), true);
    assert.equal(isLocalAddress('192.168.0.5:8188'), false);
    assert.equal(isLocalAddress('https://abc-8188.proxy.runpod.net'), false);
});

test('a saver result becomes a path under the output directory, never outside it', () => {
    const root = path.resolve('/comfy/output');
    assert.equal(savedImagePath(root, { filename: 'a.png', subfolder: '2026-10-16', type: 'output' }), path.join(root, '2026-10-16', 'a.png'));
    assert.equal(savedImagePath(root, { filename: 'a.png', subfolder: '', type: 'output' }), path.join(root, 'a.png'));
    assert.equal(savedImagePath(root, { filename: 'a.png', subfolder: '../..', type: 'output' }), '');
    assert.equal(savedImagePath(root, { filename: 'a.png', subfolder: '', type: 'temp' }), '', 'a preview is no saved image');
    assert.equal(savedImagePath('', { filename: 'a.png', type: 'output' }), '');
});

test('the time goes into the saved file, which keeps its dates', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'saa-record-'));
    try {
        const file = path.join(dir, '2026-10-16-143200_7.png');
        fs.writeFileSync(file, tinyPng());
        const old = new Date('2026-10-16T05:32:00Z');
        fs.utimesSync(file, old, old);
        assert.equal(await stampImageTime(file, { v: 1, total: 10200, segments: [{ id: 'base', ms: 5800 }] }), true);
        const { records } = readTextChunks(fs.readFileSync(file));
        assert.deepEqual(JSON.parse(records.saa_time), { v: 1, total: 10200, segments: [{ id: 'base', ms: 5800 }] });
        assert.equal(fs.statSync(file).mtime.getTime(), old.getTime());
        assert.deepEqual(fs.readdirSync(dir), ['2026-10-16-143200_7.png'], 'no temporary file is left');

        // a second write replaces the record
        await writePngRecords(file, [['saa_time', '{"total":1}']]);
        assert.equal(readTextChunks(fs.readFileSync(file)).records.saa_time, '{"total":1}');

        // a missing file or one that is not a PNG is left alone, without a throw
        assert.equal(await stampImageTime(path.join(dir, 'gone.png'), { total: 1 }), false);
        fs.writeFileSync(path.join(dir, 'x.jpg'), Buffer.from([0xff, 0xd8]));
        assert.equal(await stampImageTime(path.join(dir, 'x.jpg'), { total: 1 }), false);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

// --- the backend ----------------------------------------------------------------------

const requests = [];
globalThis.__saaTestRequests = requests;
const electron = `export const app = { isPackaged: false, getAppPath: () => process.cwd(), getPath: () => process.cwd(), getVersion: () => '0.0.0-test', on() {} };
export const ipcMain = { handle() {}, on() {} };
export const dialog = { showErrorBox() {} };
export const net = { request(options) {
    const handlers = {};
    const record = { options, body: '' };
    globalThis.__saaTestRequests.push(record);
    return {
        on(event, handler) { handlers[event] = handler; },
        write(body) { record.body += body; },
        end() {
            const response = { statusCode: 200, on(event, handler) {
                if (event === 'data') handler('{"prompt_id":"p1"}');
                if (event === 'end') handler();
            } };
            handlers.response?.(response);
        },
    };
} };
export const shell = { openPath() {} };
export const nativeImage = {};
export class BrowserWindow { static getAllWindows() { return []; } }`;
register('data:text/javascript,' + encodeURIComponent(`export async function resolve(specifier, context, next) {
    if (specifier === 'electron') return { url: 'data:text/javascript,' + encodeURIComponent(${JSON.stringify(electron)}), shortCircuit: true };
    return next(specifier, context);
}`));
const { ComfyUI } = await import('../scripts/main/generate_backend_comfyui.js');

test('a run with a recipe sends it as extra_pnginfo; a run without sends none', async () => {
    const backend = new ComfyUI('client');
    backend.uuid = 'browser-client';
    backend.addr = '192.168.0.9:8188';
    backend.podEnabled = () => false;
    requests.length = 0;
    const recipe = { v: 1, sections: {}, run: { seed: 3 } };
    assert.equal(await backend.run({ 29: { class_type: 'ImageSaverMira' } }, false, { recipe, before: { jobStart: 1 } }), '{"prompt_id":"p1"}');
    assert.deepEqual(JSON.parse(requests[0].body).extra_data, { extra_pnginfo: { saa_recipe: recipe } });
    assert.ok(backend.timeline, 'the run is timed');

    await backend.run({ 1: { class_type: 'GzippedBase64ToImage' } });
    assert.equal('extra_data' in JSON.parse(requests[1].body), false);
    assert.equal(backend.timeline, null);
});

test('the finished run hands its timing and recipe to the renderer once', async () => {
    const backend = new ComfyUI('client');
    backend.uuid = 'browser-client';
    backend.addr = '192.168.0.9:8188';   // remote: no path on this disk
    backend.podEnabled = () => false;
    requests.length = 0;
    const recipe = { v: 1, sections: {}, run: {} };
    await backend.run({ 36: { class_type: 'KSamplerAdvanced' }, 29: { class_type: 'ImageSaverMira' } }, false, { recipe, before: { jobStart: Date.now() } });
    backend.prompt_id = 'p1';
    backend.recordMessage({ type: 'executing', data: { node: '36', prompt_id: 'p1' } });
    backend.recordMessage({ type: 'executing', data: { node: '29', prompt_id: 'other' } });
    backend.recordMessage({ type: 'executing', data: { node: null, prompt_id: 'p1' } });
    backend.savedImage = { filename: 'a.png', subfolder: '2026-10-16', type: 'output' };
    backend.finishRecord();
    const result = await backend.takeResult();
    assert.equal(result.path, '');
    assert.equal(result.recipe, recipe);
    assert.ok(Number.isFinite(result.timing.total));
    assert.deepEqual(backend.timeline, null);
    assert.equal(await backend.takeResult(), null, 'taken once');
});

test('a recorded desktop run preserves the recipe, saved path and node timing', async t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'saa-recorded-recipe-'));
    const previousSettingsDir = process.env.SAA_SETTINGS_DIR;
    process.env.SAA_SETTINGS_DIR = path.join(dir, 'settings');
    const file = path.join(dir, 'result.png');
    const recipe = { v: 1, sections: {}, run: { seed: 42 } };
    let submitted;
    const server = http.createServer(async (req, res) => {
        if (req.url === '/prompt') {
            let body = '';
            for await (const chunk of req) body += chunk;
            submitted = JSON.parse(body);
            fs.writeFileSync(file, insertTextChunks(tinyPng(), [['saa_recipe', asciiJson(submitted.extra_data?.extra_pnginfo?.saa_recipe)]]));
            for (const client of ws.clients) {
                client.send(JSON.stringify({ type: 'executing', data: { prompt_id: 'another-job', node: '37' } }));
                client.send(JSON.stringify({ type: 'executing', data: { prompt_id: 'desktop-job', node: '36' } }));
            }
            res.end('{"prompt_id":"desktop-job"}');
            return;
        }
        if (req.url === '/history/desktop-job') {
            await new Promise(resolve => setTimeout(resolve, 30));
            res.end(JSON.stringify({ 'desktop-job': { status: { completed: true }, outputs: {
                '29': { images: [{ filename: 'result.png', subfolder: '', type: 'output' }] },
            } } }));
            return;
        }
        if (req.url.startsWith('/view?')) { res.end(fs.readFileSync(file)); return; }
        if (req.url === '/system_stats') { res.end(JSON.stringify({ system: { argv: [path.join(dir, 'main.py'), '--output-directory', dir] } })); return; }
        res.end('{}');
    });
    const ws = new WebSocketServer({ server });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(async () => {
        for (const client of ws.clients) client.terminate();
        ws.close();
        await new Promise(resolve => server.close(resolve));
        if (previousSettingsDir === undefined) delete process.env.SAA_SETTINGS_DIR;
        else process.env.SAA_SETTINGS_DIR = previousSettingsDir;
        fs.rmSync(dir, { recursive: true, force: true });
    });
    const backend = new ComfyUI('desktop-client');
    backend.addr = `127.0.0.1:${server.address().port}`;
    backend.podEnabled = () => false;
    const reply = JSON.parse(await backend.run({
        '36': { class_type: 'KSamplerAdvanced', inputs: {} },
        '29': { class_type: 'ImageSaverMira', inputs: {} },
    }, false, { recipe, before: { jobStart: Date.now() } }));
    assert.ok(reply.saa_run_id);
    assert.match(await backend.openWS(reply.prompt_id), /^data:image\/png;base64,/);
    const result = await backend.takeResult();
    assert.equal(result.path, file);
    assert.deepEqual(result.recipe, recipe);
    assert.ok(result.timing.segments.some(segment => segment.id === 'base' && segment.ms > 0));
    assert.ok(!result.timing.segments.some(segment => segment.id === 'refiner'), 'other jobs are ignored');
    const { records } = readTextChunks(fs.readFileSync(file));
    assert.deepEqual(JSON.parse(records.saa_recipe), recipe);
    assert.deepEqual(JSON.parse(records.saa_time), result.timing);
    assert.equal(await backend.takeResult(), null);
});

test('a pod image gets the recipe and the time written in before it is saved', () => {
    const backend = new ComfyUI('client');
    backend.record = { recipe: { v: 1, sections: {}, run: { seed: 9 } }, before: {}, workflow: {} };
    backend.timeline = { timeline: { posted: 0, nodes: [], ended: null, fetched: null }, end() { this.timeline.ended = 5; }, fetched() { this.timeline.fetched = 6; } };
    const image = backend.embedPodRecord(tinyPng());
    const { records } = readTextChunks(image);
    assert.equal(JSON.parse(records.saa_recipe).run.seed, 9);
    assert.equal(JSON.parse(records.saa_time).total, 6);
    assert.equal(backend.record, null);
});
