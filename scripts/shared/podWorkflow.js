// Pod-SSH image transport: workflow preparation and inspection (pure, no I/O).
//
// Design invariant (see docs in memory: pod image transport): a workflow sent to a
// Runpod pod must never write images to the pod's disks. The disk-writing output
// node (ImageSaverMira) is swapped for SaveImageWebsocket, which streams the image
// bytes over the client WebSocket instead of saving a file, and the whole workflow
// is scanned for any other file-writing node before submission.

// Explicit deny-list plus a /save/i heuristic below. SaveImageWebsocket is the only
// allowed "save" node — it writes to the WebSocket, not the disk.
const DISK_WRITER_CLASS_TYPES = new Set([
    'SaveImage',
    'SaveAnimatedWEBP',
    'SaveAnimatedPNG',
    'SaveAudio',
    'SaveGLB',
    'VHS_VideoCombine',
    'ImageSave',
    'ImageSaverMira',
    'SaveImageExtended',
]);

const ALLOWED_SAVE_CLASS_TYPES = new Set(['SaveImageWebsocket']);

export function findDiskWriterNodes(workflow) {
    const offenders = [];
    for (const [id, node] of Object.entries(workflow ?? {})) {
        const classType = String(node?.class_type ?? '');
        if (ALLOWED_SAVE_CLASS_TYPES.has(classType)) continue;
        if (DISK_WRITER_CLASS_TYPES.has(classType) || /save/i.test(classType)) {
            offenders.push({ id, classType });
        }
    }
    return offenders;
}

/**
 * Replace every ImageSaverMira output node with a SaveImageWebsocket node under the
 * same id (so history/output indices stay stable) and return the transformed
 * workflow plus the ids whose binary frames carry the final images. The input
 * workflow is not modified.
 */
export function toWebsocketOutputWorkflow(workflow) {
    const result = {};
    const saveNodes = [];
    for (const [id, node] of Object.entries(workflow ?? {})) {
        if (node?.class_type === 'ImageSaverMira') {
            saveNodes.push(id);
            result[id] = {
                inputs: { images: node.inputs?.images },
                class_type: 'SaveImageWebsocket',
                _meta: { title: 'Save Image (WebSocket)' },
            };
        } else {
            result[id] = node;
        }
    }
    return { workflow: result, saveNodes };
}

function resolveTextLink(workflow, value, depth = 0) {
    if (typeof value === 'string') return value;
    if (depth > 8 || !Array.isArray(value)) return '';
    const inputs = workflow?.[value[0]]?.inputs;
    if (!inputs) return '';
    if (inputs.text !== undefined) return resolveTextLink(workflow, inputs.text, depth + 1);
    if (inputs.text1 !== undefined || inputs.text2 !== undefined) {
        // TextCombinerTwo: join what resolves statically; a link into a runtime-only
        // producer (e.g. a tagger node) contributes nothing at submit time.
        return [
            resolveTextLink(workflow, inputs.text1, depth + 1),
            resolveTextLink(workflow, inputs.text2, depth + 1),
        ].filter(Boolean).join('\n');
    }
    return '';
}

/**
 * A1111-style "parameters" text built from the original (pre-transform) workflow's
 * ImageSaverMira node, so the locally saved PNG keeps the generation metadata the
 * pod-side saver would have embedded.
 */
export function buildParametersText(workflow) {
    const saver = Object.values(workflow ?? {}).find(node => node?.class_type === 'ImageSaverMira');
    if (!saver) return '';
    const inputs = saver.inputs ?? {};
    const positive = resolveTextLink(workflow, inputs.positive);
    const negative = resolveTextLink(workflow, inputs.negative);
    const settings = [
        `Steps: ${inputs.steps ?? ''}`,
        `Sampler: ${inputs.sampler_name ?? ''}`,
        `Scheduler: ${inputs.scheduler ?? ''}`,
        `CFG scale: ${inputs.cfg ?? ''}`,
        `Seed: ${inputs.seed_value ?? ''}`,
        `Model: ${String(inputs.modelname ?? '').replace(/\.[^.]+$/, '')}`,
    ].join(', ');
    return `${positive}\nNegative prompt: ${negative}\n${settings}`;
}

// ---------------------------------------------------------------- PNG metadata

// Buffer only exists in the main process; resolved lazily so this shared module
// still loads in a renderer / browser context (which never embeds PNG metadata).
const PNG_SIGNATURE_BYTES = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];

const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
        table[n] = c >>> 0;
    }
    return table;
})();

function crc32(buffer) {
    let crc = 0xFFFFFFFF;
    for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xFF] ^ (crc >>> 8);
    return (crc ^ 0xFFFFFFFF) >>> 0;
}

/**
 * Insert a tEXt chunk (keyword "parameters") right after IHDR. Returns the input
 * buffer unchanged when it is not a PNG or the text is empty.
 */
export function embedPngParameters(png, text) {
    if (typeof Buffer === 'undefined' || !Buffer.isBuffer(png) || png.length < 33) return png;
    if (!png.subarray(0, 8).equals(Buffer.from(PNG_SIGNATURE_BYTES))) return png;
    if (!text) return png;
    const keyword = Buffer.from('parameters\0', 'latin1');
    const payload = Buffer.concat([keyword, Buffer.from(text, 'utf8')]);
    const chunk = Buffer.alloc(12 + payload.length);
    chunk.writeUInt32BE(payload.length, 0);
    chunk.write('tEXt', 4, 'latin1');
    payload.copy(chunk, 8);
    chunk.writeUInt32BE(crc32(chunk.subarray(4, 8 + payload.length)), 8 + payload.length);
    const ihdrEnd = 8 + 12 + png.readUInt32BE(8); // signature + IHDR length/type/crc + data
    return Buffer.concat([png.subarray(0, ihdrEnd), chunk, png.subarray(ihdrEnd)]);
}
