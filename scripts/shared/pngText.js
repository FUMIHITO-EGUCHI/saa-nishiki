// PNG text chunks: the records SAA reads back from a saved image (parameters, prompt,
// saa_recipe, saa_time) and the ones it writes into one. Buffer-based, so the writers
// only run in the main process; the module itself loads anywhere (Buffer is looked up
// when a function runs).
//
// Text chunks are kept before the first IDAT: a reader that stops at the image data
// (the Library's index) then sees every record without reading the pixels.

const SIGNATURE = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];
const TEXT_TYPES = new Set(['tEXt', 'iTXt', 'zTXt']);

const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
        table[n] = c >>> 0;
    }
    return table;
})();

export function crc32(bytes) {
    let crc = 0xFFFFFFFF;
    for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xFF] ^ (crc >>> 8);
    return (crc ^ 0xFFFFFFFF) >>> 0;
}

export function isPng(buffer) {
    if (!buffer || buffer.length < 8) return false;
    return SIGNATURE.every((byte, index) => buffer[index] === byte);
}

/**
 * JSON with every character outside printable ASCII written as \uXXXX, so it fits a
 * tEXt chunk (Latin-1) unchanged and parses back to the same value.
 */
export function asciiJson(value) {
    return JSON.stringify(value).replace(/[\u007f-￿]/g, char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

/** One tEXt chunk (length, type, keyword NUL text, CRC). */
export function textChunk(keyword, text) {
    const payload = Buffer.concat([Buffer.from(`${keyword}\0`, 'latin1'), Buffer.from(String(text ?? ''), 'latin1')]);
    const chunk = Buffer.alloc(12 + payload.length);
    chunk.writeUInt32BE(payload.length, 0);
    chunk.write('tEXt', 4, 'latin1');
    payload.copy(chunk, 8);
    chunk.writeUInt32BE(crc32(chunk.subarray(4, 8 + payload.length)), 8 + payload.length);
    return chunk;
}

// [{ type, start, end, dataStart, length }] for every chunk the buffer holds whole
function listChunks(png) {
    const chunks = [];
    let offset = 8;
    while (offset + 12 <= png.length) {
        const length = png.readUInt32BE(offset);
        const type = png.toString('latin1', offset + 4, offset + 8);
        const end = offset + 12 + length;
        if (end > png.length) break;
        chunks.push({ type, start: offset, end, dataStart: offset + 8, length });
        offset = end;
        if (type === 'IEND') break;
    }
    return chunks;
}

function keywordOf(png, chunk) {
    const data = png.subarray(chunk.dataStart, chunk.dataStart + chunk.length);
    const nul = data.indexOf(0);
    return nul < 0 ? '' : data.toString('latin1', 0, nul);
}

/**
 * The PNG with the given text records written in: `entries` is [[keyword, text], ...].
 * A record already in the file under the same keyword is replaced, not repeated. The
 * new chunks go right before the first IDAT. Anything that is not a PNG comes back as it
 * was.
 */
export function insertTextChunks(png, entries) {
    if (typeof Buffer === 'undefined' || !Buffer.isBuffer(png) || !isPng(png)) return png;
    const records = (entries ?? []).filter(([keyword]) => keyword);
    if (records.length === 0) return png;
    const replaced = new Set(records.map(([keyword]) => keyword));
    const chunks = listChunks(png);
    const firstData = chunks.find(chunk => chunk.type === 'IDAT');
    if (!firstData) return png;
    const parts = [png.subarray(0, 8)];
    for (const chunk of chunks) {
        if (chunk === firstData) parts.push(...records.map(([keyword, text]) => textChunk(keyword, text)));
        if (TEXT_TYPES.has(chunk.type) && chunk.start < firstData.start && replaced.has(keywordOf(png, chunk))) continue;
        parts.push(png.subarray(chunk.start, chunk.end));
    }
    const last = chunks.at(-1);
    if (last && last.end < png.length) parts.push(png.subarray(last.end));
    return Buffer.concat(parts);
}

function decodeText(png, chunk, inflate) {
    const data = png.subarray(chunk.dataStart, chunk.dataStart + chunk.length);
    const nul = data.indexOf(0);
    if (nul < 0) return null;
    const keyword = data.toString('latin1', 0, nul);
    if (chunk.type === 'tEXt') return [keyword, data.toString('latin1', nul + 1)];
    if (chunk.type === 'zTXt') {
        if (typeof inflate !== 'function') return null;
        try { return [keyword, inflate(data.subarray(nul + 2)).toString('latin1')]; } catch { return null; }
    }
    // iTXt: keyword NUL flag method language NUL translated NUL text (UTF-8)
    const compressed = data[nul + 1] === 1;
    const languageEnd = data.indexOf(0, nul + 3);
    const translatedEnd = languageEnd < 0 ? -1 : data.indexOf(0, languageEnd + 1);
    if (translatedEnd < 0) return null;
    const body = data.subarray(translatedEnd + 1);
    if (!compressed) return [keyword, body.toString('utf8')];
    if (typeof inflate !== 'function') return null;
    try { return [keyword, inflate(body).toString('utf8')]; } catch { return null; }
}

/**
 * The text records before the image data: { records: { keyword: text }, complete }.
 * `complete` is false when the buffer ended before the first IDAT (the caller read too
 * little of the file). `inflate` (zlib.inflateSync) decodes compressed records.
 */
export function readTextChunks(png, { inflate = null } = {}) {
    const records = {};
    if (!png || !isPng(png)) return { records, complete: true };
    let offset = 8;
    while (offset + 8 <= png.length) {
        const length = png.readUInt32BE(offset);
        const type = png.toString('latin1', offset + 4, offset + 8);
        if (type === 'IDAT' || type === 'IEND') return { records, complete: true };
        const end = offset + 12 + length;
        if (end > png.length) return { records, complete: false };
        if (TEXT_TYPES.has(type)) {
            const decoded = decodeText(png, { type, dataStart: offset + 8, length }, inflate);
            if (decoded && !(decoded[0] in records)) records[decoded[0]] = decoded[1];
        }
        offset = end;
    }
    return { records, complete: false };
}

/** Width and height from IHDR, or null. */
export function pngSize(png) {
    if (!isPng(png) || png.length < 24) return null;
    if (png.toString('latin1', 12, 16) !== 'IHDR') return null;
    return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}
