import assert from 'node:assert/strict';
import test from 'node:test';
import zlib from 'node:zlib';

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

// minimal fake PNG: signature + IHDR(13 bytes payload) + IEND-ish tail
function fakePng() {
    const signature = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
    const ihdr = Buffer.alloc(12 + 13);
    ihdr.writeUInt32BE(13, 0);
    ihdr.write('IHDR', 4, 'latin1');
    return Buffer.concat([signature, ihdr, Buffer.from('rest')]);
}

test('embedPngParameters inserts a tEXt chunk after IHDR and leaves non-PNGs alone', () => {
    const png = fakePng();
    const embedded = embedPngParameters(png, 'params here');
    assert.equal(embedded.subarray(0, 33).equals(png.subarray(0, 33)), true);
    assert.equal(embedded.subarray(33 + 8, 33 + 8 + 11).toString('latin1'), 'parameters\0');
    assert.equal(embedded.subarray(embedded.length - 4).toString('latin1'), 'rest');
    // not a PNG or empty text: the input buffer comes back unchanged
    const notPng = Buffer.from('JPEG data here, long enough to pass the length check....');
    assert.equal(embedPngParameters(notPng, 'x'), notPng);
    assert.equal(embedPngParameters(png, ''), png);
});

test('the tEXt chunk is checksummed the way PNG readers expect, so the parameters survive', () => {
    // a wrong CRC makes viewers drop the chunk: the image would come back without its prompt
    const text = 'masterpiece, 1girl\nNegative prompt: bad quality\nSteps: 30, Seed: 1234';
    const embedded = embedPngParameters(fakePng(), text);
    const length = embedded.readUInt32BE(33);
    const chunk = embedded.subarray(33, 33 + 12 + length);
    assert.equal(chunk.subarray(4, 8).toString('latin1'), 'tEXt');
    assert.equal(chunk.subarray(8, 8 + length).toString('utf8'), `parameters\0${text}`);
    // zlib computes the same CRC-32 PNG uses; that it does is anchored by IEND's known checksum
    assert.equal(zlib.crc32(Buffer.from('IEND', 'latin1')), 0xAE42_6082);
    assert.equal(chunk.readUInt32BE(8 + length), zlib.crc32(chunk.subarray(4, 8 + length)));
    // a longer text takes another path through the table: check that one too
    const long = embedPngParameters(fakePng(), 'x'.repeat(5000));
    const longLength = long.readUInt32BE(33);
    assert.equal(long.readUInt32BE(33 + 8 + longLength), zlib.crc32(long.subarray(37, 41 + longLength)));
});

// One saver whose positive walks `links`; the negative is the plain string ''.
function saverWith(links, nodes = {}) {
    return {
        ...nodes,
        '14': { inputs: { steps: 20, positive: links, negative: '' }, class_type: 'ImageSaverMira' },
    };
}

test('a text combiner joins both inputs, and one input on its own still resolves', () => {
    const nodes = {
        '9': { inputs: { text: 'masterpiece, scenery' }, class_type: 'TextBoxMira' },
        '10': { inputs: { text: 'golden hour' }, class_type: 'TextBoxMira' },
    };
    const combined = inputs => buildParametersText(saverWith(['6', 0], { ...nodes, '6': { inputs, class_type: 'TextCombinerTwo' } }));
    assert.match(combined({ text1: ['9', 0], text2: ['10', 0] }), /^masterpiece, scenery\ngolden hour\nNegative prompt: \n/);
    assert.match(combined({ text1: ['9', 0] }), /^masterpiece, scenery\nNegative prompt: /, 'text2 unwired');
    assert.match(combined({ text2: ['10', 0] }), /^golden hour\nNegative prompt: /, 'text1 unwired');
    assert.match(combined({ text1: ['9', 0], text2: ['5', 0] }), /^masterpiece, scenery\nNegative prompt: /, 'a runtime-only producer contributes nothing');
});

test('a link into nothing, and one that goes in a circle, end the walk instead of the run', () => {
    // a node the workflow no longer has, and one that carries no text input at all
    const broken = saverWith(['99', 0], { '15': { inputs: {}, class_type: 'TextBoxMira' } });
    broken['14'].inputs.negative = ['15', 0];
    assert.equal(buildParametersText(broken), '\nNegative prompt: \nSteps: 20, Sampler: , Scheduler: , CFG scale: , Seed: , Model: ');

    // two text nodes pointing at each other
    const circle = saverWith(['20', 0], {
        '20': { inputs: { text: ['21', 0] }, class_type: 'TextBoxMira' },
        '21': { inputs: { text: ['20', 0] }, class_type: 'TextBoxMira' },
    });
    assert.equal(buildParametersText(circle).split('\n')[0], '');
});

test('the text walk follows nine links and stops there', () => {
    const chainOf = length => {
        const nodes = {};
        for (let step = 1; step <= length; step++) {
            nodes[`t${step}`] = { inputs: { text: step === length ? 'deep enough' : [`t${step + 1}`, 0] }, class_type: 'TextBoxMira' };
        }
        return saverWith(['t1', 0], nodes);
    };
    assert.match(buildParametersText(chainOf(9)), /^deep enough\n/);
    assert.equal(buildParametersText(chainOf(10)).split('\n')[0], '', 'one link further and nothing comes back');
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
