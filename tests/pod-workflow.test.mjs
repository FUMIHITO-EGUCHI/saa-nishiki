import assert from 'node:assert/strict';
import test from 'node:test';

import {
    buildParametersText,
    embedPngParameters,
    findDiskWriterNodes,
    toWebsocketOutputWorkflow,
} from '../scripts/shared/podWorkflow.js';
import { buildBootstrapCommand, buildSshArgs, makeFrameParser } from '../scripts/main/podSshTransport.js';

const WORKFLOW = {
    '17': { inputs: { width: 1024 }, class_type: 'CanvasCreatorAdvanced' },
    '28': { inputs: {}, class_type: 'VAEDecode' },
    '29': {
        inputs: {
            steps: 30, cfg: 7, modelname: 'wai_v160.safetensors', sampler_name: 'euler_ancestral',
            scheduler: 'normal', seed_value: 1234, positive: ['32', 0], negative: ['33', 0],
            images: ['28', 0], path: '%date',
        },
        class_type: 'ImageSaverMira',
    },
    '32': { inputs: { text: 'masterpiece, 1girl' }, class_type: 'TextBoxMira' },
    '33': { inputs: { text: 'bad quality' }, class_type: 'TextBoxMira' },
};

test('pod transform swaps ImageSaverMira for SaveImageWebsocket under the same id', () => {
    const { workflow, saveNodes } = toWebsocketOutputWorkflow(WORKFLOW);
    assert.deepEqual(saveNodes, ['29']);
    assert.equal(workflow['29'].class_type, 'SaveImageWebsocket');
    assert.deepEqual(workflow['29'].inputs, { images: ['28', 0] });
    // untouched nodes are carried over, the input object is not mutated
    assert.equal(workflow['32'], WORKFLOW['32']);
    assert.equal(WORKFLOW['29'].class_type, 'ImageSaverMira');
    // the transformed workflow passes the disk-writer scan
    assert.deepEqual(findDiskWriterNodes(workflow), []);
});

test('disk-writer scan flags save nodes but allows SaveImageWebsocket', () => {
    const offenders = findDiskWriterNodes({
        a: { class_type: 'SaveImage' },
        b: { class_type: 'SaveImageWebsocket' },
        c: { class_type: 'VHS_VideoCombine' },
        d: { class_type: 'KSampler' },
        e: { class_type: 'ImageSaverMira' },
        f: { class_type: 'MySaverNode' }, // heuristic catch
    });
    assert.deepEqual(offenders.map(o => o.id).sort(), ['a', 'c', 'e', 'f']);
});

test('parameters text resolves the prompt links and core sampling settings', () => {
    const text = buildParametersText(WORKFLOW);
    assert.match(text, /^masterpiece, 1girl\n/);
    assert.match(text, /\nNegative prompt: bad quality\n/);
    assert.match(text, /Steps: 30, Sampler: euler_ancestral, Scheduler: normal, CFG scale: 7, Seed: 1234, Model: wai_v160/);
});

test('parameters text follows chained text links (combiner and tagger workflows)', () => {
    // Upscale/tagger workflow shape: saver positive -> TextCombinerTwo -> TextBoxMira
    // plus a runtime-only tagger link that cannot resolve at submit time.
    const workflow = {
        '5': { inputs: { model_name: 'wd-v3' }, class_type: 'wd_tagger_mira' },
        '6': { inputs: { text1: ['9', 0], text2: ['5', 0] }, class_type: 'TextCombinerTwo' },
        '9': { inputs: { text: 'masterpiece, scenery' }, class_type: 'TextBoxMira' },
        '14': {
            inputs: { steps: 20, positive: ['6', 0], negative: ['33', 0], images: ['28', 0] },
            class_type: 'ImageSaverMira',
        },
        '33': { inputs: { text: ['34', 0] }, class_type: 'TextBoxMira' }, // text itself linked
        '34': { inputs: { text: 'bad quality' }, class_type: 'TextBoxMira' },
    };
    const text = buildParametersText(workflow);
    assert.match(text, /^masterpiece, scenery\n/);
    assert.match(text, /\nNegative prompt: bad quality\n/);
});

test('embedPngParameters inserts a tEXt chunk after IHDR and leaves non-PNGs alone', () => {
    // minimal fake PNG: signature + IHDR(13 bytes payload) + IEND-ish tail
    const signature = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
    const ihdr = Buffer.alloc(12 + 13);
    ihdr.writeUInt32BE(13, 0);
    ihdr.write('IHDR', 4, 'latin1');
    const tail = Buffer.from('rest');
    const png = Buffer.concat([signature, ihdr, tail]);

    const embedded = embedPngParameters(png, 'params here');
    assert.equal(embedded.subarray(0, 33).equals(png.subarray(0, 33)), true);
    assert.equal(embedded.subarray(33 + 8, 33 + 8 + 11).toString('latin1'), 'parameters\0');
    assert.equal(embedded.subarray(embedded.length - 4).toString('latin1'), 'rest');
    // not a PNG or empty text: the input buffer comes back unchanged
    const notPng = Buffer.from('JPEG data here, long enough to pass the length check....');
    assert.equal(embedPngParameters(notPng, 'x'), notPng);
    assert.equal(embedPngParameters(png, ''), png);
});

test('frame parser extracts sentinel-framed JSON and ignores PTY noise', () => {
    const frames = [];
    const feed = makeFrameParser(frame => frames.push(frame));
    feed(Buffer.from('Welcome to the pod\r\n@@SAA@@{"event":"ready","clientId":"x"}\r\n'));
    feed(Buffer.from('@@SAA@@{"id":1,'));
    feed(Buffer.from('"ok":true}\r\npartial noise'));
    feed(Buffer.from('\r\n@@SAA@@not json\r\n@@SAA@@{"event":"done"}\r\n'));
    assert.deepEqual(frames, [
        { event: 'ready', clientId: 'x' },
        { id: 1, ok: true },
        { event: 'done' },
    ]);
});

test('ssh args carry no exec command (the proxy ignores it); bootstrap goes over stdin to RAM', () => {
    const args = buildSshArgs({ target: 'pod-user@ssh.runpod.io', keyPath: 'C:/keys/id' });
    assert.equal(args[0], '-tt');
    // the target is the last arg: no remote command, the proxy always opens a shell
    assert.equal(args.at(-1), 'pod-user@ssh.runpod.io');

    const bootstrap = buildBootstrapCommand({ comfyPort: 8188, relaySource: 'x'.repeat(300) });
    assert.match(bootstrap, /base64 -d > \/dev\/shm\/saa_relay\.py <<'SAA_EOF'/);
    // canonical-mode PTY truncates long lines: every bootstrap line stays short
    for (const line of bootstrap.split('\n')) assert.ok(line.length <= 120, `line too long: ${line.length}`);
    // raw mode is set only right before exec so the protocol lines are unlimited
    assert.match(bootstrap, /stty raw 2>\/dev\/null; exec python3 -u \/dev\/shm\/saa_relay\.py --port 8188/);
    assert.match(bootstrap, /\n$/);
    assert.doesNotMatch(bootstrap, /workspace/);
});
