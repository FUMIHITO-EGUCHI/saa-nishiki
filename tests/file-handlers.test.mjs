// Behaviour of scripts/main/fileHandlers.js in plain node: electron and the model list
// are swapped for stubs through module hooks, and everything the handlers read lives in
// a temp directory of this test - except the shipped character CSV, which is read where
// it is, BOM and CRLF and all. Nothing is written outside the temp directory.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import module from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

const projectRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const stub = {
    appPath: fs.mkdtempSync(path.join(os.tmpdir(), 'saa-file-handlers-')),
    extraModels: { exist: false, yamlContent: null },
    relativePaths: [],      // what collectRelativePaths('loras') reports
    handlers: {},           // the ipcMain channels the module registers
};
globalThis.__fileHandlersStub = stub;

const STUBS = {
    electron: `
        const stub = globalThis.__fileHandlersStub;
        export const app = { isPackaged: false, getAppPath: () => stub.appPath, getPath: () => stub.appPath };
        export const ipcMain = { handle(name, handler) { stub.handlers[name] = handler; } };`,
    modelList: `
        const stub = globalThis.__fileHandlersStub;
        export function getExtraModels() { return stub.extraModels; }
        export function collectRelativePaths() { return stub.relativePaths; }`,
    probe: 'export const hooked = true;',
};
const stubUrl = name => `data:text/javascript,${encodeURIComponent(STUBS[name])}`;

const hooksAvailable = typeof module.registerHooks === 'function';
if (hooksAvailable) {
    module.registerHooks({
        resolve(specifier, context, nextResolve) {
            const fromHandlers = String(context.parentURL ?? '').endsWith('/scripts/main/fileHandlers.js');
            if (specifier === 'saa-file-handlers-hook-probe') return { url: stubUrl('probe'), shortCircuit: true };
            if (fromHandlers && specifier === 'electron') return { url: stubUrl('electron'), shortCircuit: true };
            if (fromHandlers && specifier === './modelList.js') return { url: stubUrl('modelList'), shortCircuit: true };
            return nextResolve(specifier, context);
        },
    });
}

// the app path is read once, when the module loads: the temp directory above is already there
let handlers = null;
if (hooksAvailable) {
    const { hooked } = await import('saa-file-handlers-hook-probe');
    if (hooked === true) handlers = await import('../scripts/main/fileHandlers.js');
}
const skip = handlers ? false : 'needs node:module registerHooks';
const opts = { skip, timeout: 30_000 };

if (handlers) handlers.setupFileHandlers();

// files under the temp app path: one directory per test, so no test sees another's
let nextCase = 0;
let caseDir = '';
function write(name, contents) {
    const relative = path.join(caseDir, name);
    const full = path.join(stub.appPath, relative);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, contents);
    return { relative, full };
}

test.beforeEach(() => {
    caseDir = `case-${nextCase++}`;
    fs.mkdirSync(path.join(stub.appPath, caseDir), { recursive: true });
});

test.after(() => {
    fs.rmSync(stub.appPath, { recursive: true, force: true });
});

// --- the CSV and JSON loaders -------------------------------------------------------

test('the shipped character CSV loads through its BOM and CRLF line endings', opts, () => {
    // read where it lies, as scripts/main/cachedFiles.js loads it: UTF-8 with a BOM,
    // CRLF endings, and non-ASCII keys
    const csv = handlers.loadCSVFile(path.join(projectRoot, 'data', 'waiANIMA_v10Base10_characters.csv'));
    assert.ok(csv, 'the shipped CSV is there');
    const keys = Object.keys(csv);
    assert.ok(keys.length > 100, `${keys.length} characters`);
    // the BOM belongs to the file, not to the first key
    assert.equal(keys[0], '25时miku');
    assert.equal(csv[keys[0]], '25-ji miku');
    assert.equal(keys.some(key => key.includes('\uFEFF') || key.includes('\r')), false);
    assert.equal(Object.values(csv).some(value => value.includes('\r')), false);
});

test('a CSV is read as key and value; a line that is not a pair is left out', opts, () => {
    const { full } = write('tags.csv', '\uFEFFkey one,value one\r\n\r\nkey two, value two \r\n three fields,a,b\r\nlonely\r\nempty value,\r\n');
    const csv = handlers.loadCSVFile(full);
    assert.deepEqual(csv, {
        'key one': 'value one',
        'key two': 'value two',
        'empty value': '',
    });
});

test('a CSV that is missing is null, and one with nothing to read is an error', opts, () => {
    assert.equal(handlers.loadCSVFile(path.join(stub.appPath, 'nowhere.csv')), null);

    const { full: empty } = write('empty.csv', '\r\n \r\n');
    assert.throws(() => handlers.loadCSVFile(empty), /Failed to load CSV file:.*CSV file is empty or invalid/s);

    const { full: junk } = write('junk.csv', 'a,b,c\r\nd,e,f\r\n');
    assert.throws(() => handlers.loadCSVFile(junk), /No valid data found in CSV file/);
});

test('a JSON file is parsed, a BOM and CRLF included; a broken one says which file', opts, () => {
    const { full } = write('thumbs.json', '\uFEFF{\r\n  "hatsune miku": "AAA",\r\n  "nested": { "a": 1 }\r\n}\r\n');
    assert.deepEqual(handlers.loadJSONFile(full), { 'hatsune miku': 'AAA', nested: { a: 1 } });

    assert.equal(handlers.loadJSONFile(path.join(stub.appPath, 'nowhere.json')), null);

    const { full: broken } = write('broken.json', '{ "a": 1, }');
    assert.throws(() => handlers.loadJSONFile(broken), /Failed to load JSON file:/);
});

test('loadFile picks its loader by extension, and reports what it cannot read', opts, () => {
    const { relative: csv } = write('list.csv', 'a,1\r\nb,2\r\n');
    assert.deepEqual(handlers.loadFile(csv), { a: '1', b: '2' });

    const { relative: json } = write('data.json', '{"a":1}');
    assert.deepEqual(handlers.loadFile(json), { a: 1 });

    // anything else comes back as base64: a LoRA preview, a thumbnail
    const { relative: png } = write('preview.png', Buffer.from([1, 2, 3, 4]));
    assert.equal(handlers.loadFile(png), Buffer.from([1, 2, 3, 4]).toString('base64'));

    assert.equal(handlers.loadFile(path.join(caseDir, 'nowhere.png')), null, 'a file that is not there is null, not an error');

    // a directory has no extension and cannot be read as bytes: the error is returned, not thrown
    const folder = handlers.loadFile(path.dirname(png));
    assert.ok(folder?.error, `a directory is reported: ${JSON.stringify(folder)}`);
});

test('a LoRA preview is looked up next to its model, under the prefix it was given', opts, () => {
    const model = write(path.join('models', 'loras', 'style.safetensors'), 'x');
    const preview = write(path.join('models', 'loras', 'anime', 'style.png'), Buffer.from('PNGDATA'));
    // scripts/renderer/slots/myLoRASlot.js: readFile(modelPath, prefix, name.png)
    assert.equal(
        handlers.loadFile(model.full, 'anime', 'style.png'),
        Buffer.from('PNGDATA').toString('base64'),
    );
    assert.ok(fs.existsSync(preview.full));
    assert.equal(handlers.loadFile(model.full, 'other', 'style.png'), null);
});

// --- PNG metadata -------------------------------------------------------------------

function pngChunk(type, data) {
    const out = Buffer.alloc(8 + data.length + 4);
    out.writeUInt32BE(data.length, 0);
    out.write(type, 4, 'ascii');
    data.copy(out, 8);
    out.writeUInt32BE(0, 8 + data.length);      // the reader never checks the CRC
    return out;
}

const PNG_HEADER = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
const png = (...chunks) => Buffer.concat([PNG_HEADER, ...chunks, pngChunk('IEND', Buffer.alloc(0))]);
const zero = Buffer.from([0]);

const tEXt = (keyword, text) => pngChunk('tEXt', Buffer.concat([Buffer.from(keyword, 'latin1'), zero, Buffer.from(text, 'utf8')]));
const zTXt = (keyword, text) => pngChunk('zTXt', Buffer.concat([Buffer.from(keyword, 'latin1'), Buffer.from([0, 0]), zlib.deflateSync(Buffer.from(text, 'utf8'))]));
const iTXt = (keyword, text, compressed = false) => {
    // keyword \0 compression_flag compression_method language \0 translated keyword \0 text
    const head = Buffer.concat([Buffer.from(keyword, 'latin1'), Buffer.from([0, compressed ? 1 : 0, 0]), Buffer.from('en', 'latin1'), zero, Buffer.from('', 'latin1'), zero]);
    const body = compressed ? zlib.deflateSync(Buffer.from(text, 'utf8')) : Buffer.from(text, 'utf8');
    return pngChunk('iTXt', Buffer.concat([head, body]));
};

const A1111_TEXT = '1girl, solo\nNegative prompt: worst quality\nSteps: 28, Sampler: Euler a, CFG scale: 5, Seed: 1234';

test('an A1111 PNG hands back its parameters text, a ComfyUI PNG its workflow', opts, () => {
    const a1111 = handlers.readImage(png(tEXt('parameters', A1111_TEXT)), 'a.png', 'image/png');
    assert.equal(a1111.fileName, 'a.png');
    assert.equal(a1111.fileType, 'image/png');
    // not JSON, so it stays the text the renderer parses into prompts
    assert.deepEqual(a1111.metadata, { parameters: A1111_TEXT });

    // ComfyUI writes JSON under `prompt` and `workflow`, in two chunks: both are kept
    const comfy = handlers.readImage(png(
        tEXt('prompt', JSON.stringify({ 3: { class_type: 'KSampler' } })),
        tEXt('workflow', JSON.stringify({ nodes: [1, 2] })),
    ), 'b.png', 'image/png');
    assert.deepEqual(comfy.metadata, { 3: { class_type: 'KSampler' }, nodes: [1, 2] });
});

test('a compressed PNG text chunk is inflated, and an unknown keyword keeps its name', opts, () => {
    const zipped = handlers.readImage(png(zTXt('parameters', A1111_TEXT)), 'c.png', 'image/png');
    assert.deepEqual(zipped.metadata, { parameters: A1111_TEXT });

    const international = handlers.readImage(png(iTXt('parameters', A1111_TEXT)), 'd.png', 'image/png');
    assert.deepEqual(international.metadata, { parameters: A1111_TEXT });

    const deflated = handlers.readImage(png(iTXt('prompt', JSON.stringify({ a: 1 }), true)), 'e.png', 'image/png');
    assert.deepEqual(deflated.metadata, { a: 1 });

    // a keyword that is not one of the AI ones is kept as it is, JSON or not
    const other = handlers.readImage(png(tEXt('Software', 'NovelAI')), 'f.png', 'image/png');
    assert.deepEqual(other.metadata, { Software: 'NovelAI' });
});

test('a PNG with nothing to say, and one whose chunk is cut short, are both reported as such', opts, () => {
    const plain = handlers.readImage(png(pngChunk('IHDR', Buffer.alloc(13))), 'g.png', 'image/png');
    assert.equal(plain.metadata.note, 'No AI generation metadata found');
    assert.equal(plain.metadata.format, 'png');
    assert.equal(plain.error, undefined);

    // a chunk whose length runs past the end of the file: what was read so far is kept
    const truncated = Buffer.concat([PNG_HEADER, tEXt('parameters', A1111_TEXT)]).subarray(0, PNG_HEADER.length + 20);
    const cut = handlers.readImage(truncated, 'h.png', 'image/png');
    assert.equal(cut.metadata.note, 'No AI generation metadata found');

    // the two chunks before a broken one still come back
    const partly = Buffer.concat([PNG_HEADER, tEXt('parameters', A1111_TEXT), Buffer.from([0, 0, 0, 100]), Buffer.from('tEXt', 'ascii'), Buffer.alloc(12)]);
    assert.deepEqual(handlers.readImage(partly, 'i.png', 'image/png').metadata, { parameters: A1111_TEXT });
});

test('a file type the readers do not know is an error, not a guess', opts, () => {
    const result = handlers.readImage(Buffer.from('GIF89a'), 'j.gif', 'image/gif');
    assert.match(result.error, /Only PNG, JPEG, and WebP formats are supported, received: image\/gif/);
    assert.deepEqual(result.metadata, { note: 'Processing error occurred' });
    assert.equal(result.fileName, 'j.gif');
});

// --- JPEG and WebP metadata ---------------------------------------------------------

function jpegSegment(marker, payload) {
    const out = Buffer.alloc(4 + payload.length);
    out[0] = 0xFF;
    out[1] = marker;
    out.writeUInt16BE(payload.length + 2, 2);
    payload.copy(out, 4);
    return out;
}

const jpeg = (...segments) => Buffer.concat([Buffer.from([0xFF, 0xD8]), ...segments, Buffer.from([0xFF, 0xD9])]);
// EXIF UserComment: a marker, two zero bytes, then UTF-16LE text
const userComment = (marker, text) => Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), Buffer.from(marker, 'latin1'), Buffer.from([0, 0]), Buffer.from(text, 'utf16le')]);

test('a JPEG carries its metadata in the EXIF comment, whichever tool wrote it', opts, () => {
    const a1111 = handlers.readImage(jpeg(jpegSegment(0xE1, userComment('(UNICODE', A1111_TEXT))), 'a.jpg', 'image/jpeg');
    // not JSON: the renderer reads `data` for a JPEG
    assert.deepEqual(a1111.metadata, { data: A1111_TEXT });

    const comfy = handlers.readImage(jpeg(jpegSegment(0xE1, userComment('L>UNICODE', JSON.stringify({ prompt: { 3: 'KSampler' } })))), 'b.jpg', 'image/jpeg');
    assert.deepEqual(comfy.metadata, { prompt: { 3: 'KSampler' } });

    // a comment segment is read too, after the segments before it are stepped over
    const comment = handlers.readImage(jpeg(
        jpegSegment(0xDB, Buffer.alloc(65)),
        jpegSegment(0xFE, Buffer.from(`parameters: ${A1111_TEXT}`, 'utf16le')),
    ), 'c.jpg', 'image/jpeg');
    assert.deepEqual(comment.metadata, { data: `parameters: ${A1111_TEXT}` });

    const plain = handlers.readImage(jpeg(jpegSegment(0xDB, Buffer.alloc(65))), 'd.jpg', 'image/jpeg');
    assert.equal(plain.metadata.note, 'No AI generation metadata found');
    assert.equal(plain.metadata.format, 'jpeg');
});

function webp(...chunks) {
    const body = Buffer.concat([Buffer.from('WEBP', 'ascii'), ...chunks]);
    return Buffer.concat([Buffer.from('RIFF', 'ascii'), (() => { const size = Buffer.alloc(4); size.writeUInt32LE(body.length); return size; })(), body]);
}

function webpChunk(type, data) {
    const head = Buffer.alloc(8);
    head.write(type, 0, 'ascii');
    head.writeUInt32LE(data.length, 4);
    // an odd-sized chunk is padded to an even boundary
    return Buffer.concat([head, data, data.length % 2 ? Buffer.alloc(1) : Buffer.alloc(0)]);
}

test('a WebP is read past its image data, odd-sized chunks included', opts, () => {
    const image = webp(
        webpChunk('VP8 ', Buffer.alloc(33, 7)),      // odd size: the padding byte must be stepped over
        webpChunk('EXIF', userComment('L^UNICODE', JSON.stringify({ workflow: { nodes: 2 } }))),
    );
    assert.deepEqual(handlers.readImage(image, 'a.webp', 'image/webp').metadata, { workflow: { nodes: 2 } });

    const a1111 = webp(webpChunk('EXIF', userComment('(UNICODE', A1111_TEXT)));
    assert.deepEqual(handlers.readImage(a1111, 'b.webp', 'image/webp').metadata, { data: A1111_TEXT });

    const plain = handlers.readImage(webp(webpChunk('VP8 ', Buffer.alloc(16, 7))), 'c.webp', 'image/webp');
    assert.equal(plain.metadata.note, 'No AI generation metadata found');
    assert.equal(plain.metadata.format, 'webp');
});

// --- data URLs ----------------------------------------------------------------------

test('an image pasted as a data URL is read the same way, and a broken URL is refused', opts, () => {
    const dataUrl = `data:image/png;base64,${png(tEXt('parameters', A1111_TEXT)).toString('base64')}`;
    assert.deepEqual(handlers.readBase64Image(dataUrl).metadata, { parameters: A1111_TEXT });

    assert.equal(handlers.readBase64Image('https://example.invalid/a;base64,QUJD'), null, 'only data URLs are read');
    assert.equal(handlers.readBase64Image('data:image/png;base64'), null, 'a URL with no data at all');
    assert.equal(handlers.readBase64Image('data:image/png,AAAA'), null, 'only base64 is understood');
    assert.equal(handlers.readBase64Image(null), null);

    const gif = handlers.readBase64Image('data:image/gif;base64,R0lGODlh');
    assert.match(gif.error, /received: image\/gif/);

    // a PNG with no text chunks: the note, not an error
    const plain = handlers.readBase64Image(`data:image/png;base64,${png(pngChunk('IHDR', Buffer.alloc(13))).toString('base64')}`);
    assert.equal(plain.metadata.note, 'No AI generation metadata found');
});

// --- safetensors --------------------------------------------------------------------

function safetensors(header, trailing = 32) {
    const json = Buffer.from(JSON.stringify(header), 'utf8');
    const length = Buffer.alloc(8);
    length.writeUInt32LE(json.length, 0);
    return Buffer.concat([length, json, Buffer.alloc(trailing, 9)]);
}

test('a LoRA hands back its training metadata; one without any says None', opts, () => {
    const model = write(path.join('loras', 'style.safetensors'), 'x');
    const lora = write(path.join('loras', 'anime', 'style.safetensors'), safetensors({
        __metadata__: { ss_network_dim: '32', ss_output_name: 'style' },
        'lora_unet.weight': { dtype: 'F16', shape: [32, 32] },
    }));
    assert.deepEqual(handlers.readSafetensors(model.full, 'anime', 'style.safetensors'), { ss_network_dim: '32', ss_output_name: 'style' });
    assert.ok(fs.existsSync(lora.full));

    const bare = write(path.join('loras', 'anime', 'bare.safetensors'), safetensors({ 'lora_unet.weight': { dtype: 'F16' } }));
    assert.equal(handlers.readSafetensors(model.full, 'anime', 'bare.safetensors'), 'None');
    assert.ok(fs.existsSync(bare.full));

    // a header length that runs past the file, and a file that is not safetensors at all
    write(path.join('loras', 'anime', 'short.safetensors'), Buffer.concat([Buffer.from([0xFF, 0xFF, 0, 0, 0, 0, 0, 0]), Buffer.alloc(8)]));
    assert.equal(handlers.readSafetensors(model.full, 'anime', 'short.safetensors'), 'None');

    // a header of the right length that is not JSON: the read says so instead of guessing
    const length = Buffer.alloc(8);
    length.writeUInt32LE(10, 0);
    write(path.join('loras', 'anime', 'text.safetensors'), Buffer.concat([length, Buffer.from('not a model', 'ascii')]));
    assert.match(handlers.readSafetensors(model.full, 'anime', 'text.safetensors'), /^Error: Reading metadata failed:/);

    assert.match(handlers.readSafetensors(model.full, 'anime', 'gone.safetensors'), /^Error: File not found:/);
});

test('a LoRA that is not beside its model is looked for in the extra model paths', opts, () => {
    const model = write(path.join('models', 'loras', 'style.safetensors'), 'x');
    const elsewhere = write(path.join('extra', 'loras', 'far.safetensors'), safetensors({ __metadata__: { ss_network_dim: '64' } }));
    stub.extraModels = { exist: true, yamlContent: { a111: { base_path: path.dirname(path.dirname(elsewhere.full)) } } };
    stub.relativePaths = ['nowhere', 'loras'];
    try {
        assert.deepEqual(handlers.readSafetensors(model.full, 'anime', 'far.safetensors'), { ss_network_dim: '64' });
        // nowhere at all: the read fails rather than reporting metadata that is not there
        assert.match(handlers.readSafetensors(model.full, 'anime', 'missing.safetensors'), /^Error:/);
    } finally {
        stub.extraModels = { exist: false, yamlContent: null };
        stub.relativePaths = [];
    }
});

// --- the IPC surface ----------------------------------------------------------------

test('the IPC channels of the file handlers answer what the renderer asks for', opts, async () => {
    for (const channel of ['read-file', 'read-safetensors', 'read-image-metadata', 'read-base64-image-metadata']) {
        assert.ok(stub.handlers[channel], `${channel} is registered`);
    }
    const { relative } = write('ipc.json', '{"a":1}');
    assert.deepEqual(await stub.handlers['read-file']({}, relative, '', ''), { a: 1 });

    // the renderer sends the bytes as a plain array over IPC
    const bytes = [...png(tEXt('parameters', A1111_TEXT))];
    const image = await stub.handlers['read-image-metadata']({}, bytes, 'ipc.png', 'image/png');
    assert.deepEqual(image.metadata, { parameters: A1111_TEXT });

    const pasted = await stub.handlers['read-base64-image-metadata']({}, `data:image/png;base64,${png(tEXt('parameters', A1111_TEXT)).toString('base64')}`);
    assert.deepEqual(pasted.metadata, { parameters: A1111_TEXT });
});
