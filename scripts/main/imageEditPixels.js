import sharp from 'sharp';

const MAX_PIXELS = 16_777_216;
const open = bytes => sharp(bytes, { limitInputPixels: MAX_PIXELS, failOn: 'error' });

export function pngBytes(dataUrl) {
    if (typeof dataUrl !== 'string' || dataUrl.length > 96_000_000 || !/^data:image\/png;base64,[a-zA-Z0-9+/=]+$/.test(dataUrl)) throw new Error('8-bit RGB/RGBA PNG required');
    return Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64');
}

export async function readOriginal(bytes) {
    const metadata = await open(bytes).metadata();
    // No silent profile conversion, orientation change, animation flattening or
    // 16-bit truncation. Model input is separate from these authoritative pixels.
    if (metadata.format !== 'png' || metadata.depth !== 'uchar' || metadata.space !== 'srgb'
        || ![3,4].includes(metadata.channels) || metadata.icc || (metadata.pages ?? 1) !== 1
        || (metadata.orientation && metadata.orientation !== 1)) throw new Error('Use an unprofiled 8-bit RGB/RGBA PNG (no animation or rotation metadata)');
    const { data, info } = await open(bytes).raw().toBuffer({ resolveWithObject: true });
    return { data, width: info.width, height: info.height, channels: info.channels };
}

async function maskPixels(bytes, width, height) {
    if (!bytes) return Buffer.alloc(width * height);
    const metadata = await open(bytes).metadata();
    if (metadata.format !== 'png' || metadata.width !== width || metadata.height !== height || metadata.depth !== 'uchar') throw new Error('Mask dimensions must match the original');
    // A mask is an opaque black/white image; its red channel is the coefficient.
    return open(bytes).removeAlpha().toColourspace('srgb').extractChannel(0).raw().toBuffer();
}

const encode = (data, width, height, channels) => sharp(data, { raw: { width, height, channels } }).png().toBuffer();
export async function prepareEdit(original, editMask, lockMask, { padding = 32, feather = 4 } = {}) {
    if (!Number.isInteger(padding) || padding < 0 || padding > 512 || !Number.isInteger(feather) || feather < 0 || feather > 64) throw new Error('Invalid padding or feather');
    const parent = await readOriginal(original);
    const { width, height } = parent;
    const edit = await maskPixels(editMask, width, height);
    const lock = await maskPixels(lockMask, width, height);
    const blurred = feather ? await sharp(edit, { raw: { width, height, channels: 1 } }).blur(Math.max(0.3, feather / 2)).greyscale().raw().toBuffer() : edit;
    const alpha = Buffer.alloc(width * height);
    let left = width, top = height, right = -1, bottom = -1;
    for (let i = 0; i < alpha.length; i++) {
        alpha[i] = edit[i] && !lock[i] ? Math.min(edit[i], blurred[i]) : 0;
        if (!alpha[i]) continue;
        const x = i % width, y = Math.floor(i / width);
        left = Math.min(left, x); right = Math.max(right, x); top = Math.min(top, y); bottom = Math.max(bottom, y);
    }
    if (right < 0) return { empty: true, width, height, alpha, lock };
    const x = Math.max(0, left-padding), y = Math.max(0, top-padding);
    const crop = { x, y, width: Math.min(width, right+padding+1)-x, height: Math.min(height, bottom+padding+1)-y };
    // Crop only; do not rescale the full parent. Any detailer-internal resizing
    // must return this exact crop size before we accept its candidate.
    const inputImage = await open(original).extract({ left:x, top:y, width:crop.width, height:crop.height }).removeAlpha().png().toBuffer();
    const generationMask = await sharp(edit, { raw: { width, height, channels:1 } }).extract({ left:x, top:y, width:crop.width, height:crop.height }).png().toBuffer();
    return { empty: false, width, height, crop, alpha, lock, inputImage, generationMask,
        alphaPng: await encode(alpha, width, height, 1) };
}

export async function compositeEdit(original, candidate, prepared) {
    const parent = await readOriginal(original);
    const next = await readOriginal(candidate);
    const { crop, alpha, lock } = prepared;
    if (next.width !== crop.width || next.height !== crop.height) throw new Error('Candidate crop dimensions changed');
    const out = Buffer.from(parent.data);
    const candidateCanvas = Buffer.from(parent.data);
    for (let y=0; y<crop.height; y++) for (let x=0; x<crop.width; x++) {
        const p=(y+crop.y)*parent.width+x+crop.x, q=y*crop.width+x;
        const a=alpha[p]/255;
        for (let c=0;c<parent.channels;c++) {
            const value = c===3 && next.channels===3 ? 255 : next.data[q*next.channels+c];
            candidateCanvas[p*parent.channels+c] = value;
            if (a!==0) out[p*parent.channels+c] = Math.round(parent.data[p*parent.channels+c]*(1-a)+value*a);
        }
    }
    const image = await encode(out,parent.width,parent.height,parent.channels);
    const decoded = await readOriginal(image);
    let protectedChangedPixels=0, protectedMaxDifference=0, changedPixels=0;
    for (let p=0;p<alpha.length;p++) {
        let delta=0;
        for (let c=0;c<parent.channels;c++) delta=Math.max(delta,Math.abs(parent.data[p*parent.channels+c]-decoded.data[p*parent.channels+c]));
        if (delta) changedPixels++;
        if (alpha[p]===0 || lock[p]) { if(delta) protectedChangedPixels++; protectedMaxDifference=Math.max(protectedMaxDifference,delta); }
    }
    if (protectedChangedPixels || protectedMaxDifference) throw new Error('Pixel preservation failed');
    return { image, candidateCanvas: await encode(candidateCanvas,parent.width,parent.height,parent.channels), verification: { protectedChangedPixels, protectedMaxDifference, changedPixels,
        width:parent.width,height:parent.height,channels:parent.channels,basis:'decoded saved PNG versus parent decoded pixels' } };
}
