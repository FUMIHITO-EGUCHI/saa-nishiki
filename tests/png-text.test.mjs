// PNG text chunks (scripts/shared/pngText.js): what SAA writes into a saved image (the
// recipe and the time) has to come back out unchanged, sit before the image data where
// the Library's reader stops, and replace an older record of the same name.
import assert from 'node:assert/strict';
import test from 'node:test';
import zlib from 'node:zlib';

import { asciiJson, crc32, insertTextChunks, isPng, pngSize, readTextChunks } from '../scripts/shared/pngText.js';

// a valid 2×3 RGBA PNG: signature, IHDR, one IDAT, IEND
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
    ihdr.writeUInt32BE(2, 0);
    ihdr.writeUInt32BE(3, 4);
    ihdr[8] = 8; ihdr[9] = 6;
    const raw = Buffer.alloc(3 * (1 + 2 * 4));
    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
        chunk('IHDR', ihdr),
        chunk('IDAT', zlib.deflateSync(raw)),
        chunk('IEND', Buffer.alloc(0)),
    ]);
}

function chunkTypes(png) {
    const types = [];
    for (let offset = 8; offset < png.length;) {
        const length = png.readUInt32BE(offset);
        types.push(png.toString('latin1', offset + 4, offset + 8));
        offset += 12 + length;
    }
    return types;
}

test('records written in come back out, before the image data', () => {
    const png = insertTextChunks(tinyPng(), [['saa_recipe', '{"v":1}'], ['saa_time', '{"total":10200}']]);
    assert.ok(isPng(png));
    assert.deepEqual(chunkTypes(png), ['IHDR', 'tEXt', 'tEXt', 'IDAT', 'IEND']);
    assert.deepEqual(readTextChunks(png), { records: { saa_recipe: '{"v":1}', saa_time: '{"total":10200}' }, complete: true });
    assert.deepEqual(pngSize(png), { width: 2, height: 3 });
});

test('a record of the same name is replaced, the others stay', () => {
    const first = insertTextChunks(tinyPng(), [['parameters', 'Steps: 8'], ['saa_time', 'old']]);
    const second = insertTextChunks(first, [['saa_time', 'new']]);
    assert.deepEqual(readTextChunks(second).records, { parameters: 'Steps: 8', saa_time: 'new' });
    assert.equal(chunkTypes(second).filter(type => type === 'tEXt').length, 2);
});

test('every chunk keeps a valid CRC after the rewrite', () => {
    const png = insertTextChunks(tinyPng(), [['saa_recipe', asciiJson({ name: 'ライス' })]]);
    for (let offset = 8; offset < png.length;) {
        const length = png.readUInt32BE(offset);
        const body = png.subarray(offset + 4, offset + 8 + length);
        assert.equal(png.readUInt32BE(offset + 8 + length), crc32(body));
        offset += 12 + length;
    }
});

test('asciiJson keeps non-ASCII text through a Latin-1 chunk', () => {
    const value = { prompt: 'ライスシャワー, 1girl', weight: 0.8 };
    const text = asciiJson(value);
    assert.match(text, /^[\x20-\x7e]*$/);
    const png = insertTextChunks(tinyPng(), [['saa_recipe', text]]);
    assert.deepEqual(JSON.parse(readTextChunks(png).records.saa_recipe), value);
});

test('a buffer cut before the image data says it is incomplete', () => {
    const png = insertTextChunks(tinyPng(), [['saa_recipe', 'x'.repeat(200)]]);
    const { records, complete } = readTextChunks(png.subarray(0, 60));
    assert.equal(complete, false);
    assert.deepEqual(records, {});
});

test('iTXt and zTXt records are read too', () => {
    const itxt = Buffer.concat([Buffer.from('parameters\0\0\0\0\0', 'latin1'), Buffer.from('ライス, Steps: 8', 'utf8')]);
    const ztxt = Buffer.concat([Buffer.from('prompt\0\0', 'latin1'), zlib.deflateSync(Buffer.from('{"3":{}}', 'latin1'))]);
    const typed = (type, data) => {
        const out = Buffer.alloc(12 + data.length);
        out.writeUInt32BE(data.length, 0);
        out.write(type, 4, 'latin1');
        data.copy(out, 8);
        out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
        return out;
    };
    const base = tinyPng();
    const png = Buffer.concat([base.subarray(0, 33), typed('iTXt', itxt), typed('zTXt', ztxt), base.subarray(33)]);
    assert.deepEqual(readTextChunks(png, { inflate: zlib.inflateSync }).records, { parameters: 'ライス, Steps: 8', prompt: '{"3":{}}' });
    assert.deepEqual(readTextChunks(png).records, { parameters: 'ライス, Steps: 8' }, 'no inflate: the compressed record is skipped');
});

test('anything that is not a PNG comes back as it was', () => {
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]);
    assert.equal(insertTextChunks(jpeg, [['saa_time', '{}']]), jpeg);
    assert.deepEqual(readTextChunks(jpeg), { records: {}, complete: true });
    assert.equal(pngSize(jpeg), null);
});
