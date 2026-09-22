// Contact sheets from the bench PNGs, one per model: rows = category, columns = method.
//   node design/parts/bench/sheet.mjs
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const sharp = require('sharp');

const OUT = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const W = 256, H = 352, PAD = 8, LABEL = 22;

async function sheet(name, rows, cols, model = name) {
    const width = PAD + cols.length * (W + PAD);
    const height = PAD + LABEL + rows.length * (H + LABEL + PAD);
    const layers = [];
    const svgText = [];
    cols.forEach((c, j) => svgText.push(`<text x="${PAD + j * (W + PAD) + 4}" y="${PAD + 15}" font-size="14" fill="#eee" font-family="Segoe UI, sans-serif">${c.label}</text>`));
    for (let i = 0; i < rows.length; i++) {
        const y0 = PAD + LABEL + i * (H + LABEL + PAD);
        svgText.push(`<text x="${PAD + 4}" y="${y0 + 15}" font-size="14" fill="#e0c080" font-family="Segoe UI, sans-serif">${rows[i]}</text>`);
        for (let j = 0; j < cols.length; j++) {
            const file = path.join(OUT, `${rows[i]}-${cols[j].key}-${model}.png`);
            if (!fs.existsSync(file)) continue;
            const buf = await sharp(file).resize(W, H, { fit: 'inside' }).png().toBuffer();
            layers.push({ input: buf, left: PAD + j * (W + PAD), top: y0 + LABEL });
        }
    }
    layers.push({ input: Buffer.from(`<svg width="${width}" height="${height}">${svgText.join('')}</svg>`), left: 0, top: 0 });
    await sharp({ create: { width, height, channels: 3, background: '#111111' } }).composite(layers).png().toFile(path.join(OUT, `sheet-${name}.png`));
    console.log(`sheet-${name}.png ${width}x${height}`);
}

const R2COLS = [{ key: 't2i', label: 'round1 base' }, { key: 'r2a', label: 'r2a faceless white skin' }, { key: 'r2b', label: 'r2b mannequin+solo' }, { key: 'r2c', label: 'r2c base+neg' }];
await sheet('round2-illustrious', ['outfit', 'hair'], R2COLS, 'illustrious');
await sheet('round2-anima', ['outfit'], R2COLS.slice(0, 3), 'anima');

await sheet('round3-illustrious', ['outfit', 'hair'], [{ key: 'r3a', label: 'r3a faceless bald white skin, framed' }, { key: 'r3b', label: 'r3b no face pale skin' }, { key: 'r3a-i2i', label: 'r3a img2img 0.88' }, { key: 'r3a-s4', label: 'r3a seed 4' }, { key: 'r3a-s5', label: 'r3a seed 5' }], 'illustrious');

{
    // final: rows = category, columns = model
    const rows = ['outfit', 'hair', 'body', 'background'];
    const width = PAD + 2 * (W + PAD), height = PAD + LABEL + rows.length * (H + LABEL + PAD);
    const layers = [], txt = [];
    ['anima', 'illustrious'].forEach((m, j) => txt.push(`<text x="${PAD + j * (W + PAD) + 4}" y="${PAD + 15}" font-size="14" fill="#eee" font-family="Segoe UI, sans-serif">${m}</text>`));
    for (let i = 0; i < rows.length; i++) {
        const y0 = PAD + LABEL + i * (H + LABEL + PAD);
        txt.push(`<text x="${PAD + 4}" y="${y0 + 15}" font-size="14" fill="#e0c080" font-family="Segoe UI, sans-serif">${rows[i]}</text>`);
        for (let j = 0; j < 2; j++) {
            const file = path.join(OUT, `${rows[i]}-final-${['anima', 'illustrious'][j]}.png`);
            if (!fs.existsSync(file)) continue;
            layers.push({ input: await sharp(file).resize(W, H, { fit: 'inside' }).png().toBuffer(), left: PAD + j * (W + PAD), top: y0 + LABEL });
        }
    }
    layers.push({ input: Buffer.from(`<svg width="${width}" height="${height}">${txt.join('')}</svg>`), left: 0, top: 0 });
    await sharp({ create: { width, height, channels: 3, background: '#111111' } }).composite(layers).png().toFile(path.join(OUT, 'sheet-final.png'));
}

for (const model of ['anima', 'illustrious']) {
    await sheet(model, ['outfit', 'hair', 'body', 'background'], [{ key: 't2i', label: 'A txt2img' }, { key: 'i2i', label: 'B img2img white 0.88' }]);
    await sheet(`extra-${model}`, ['outfit'], [{ key: 't2i', label: 'base' }, { key: 'i2i95', label: 'img2img 0.95' }, { key: 'alt-t2i', label: 'alt mannequin' }, { key: 'small-t2i', label: '384x528' }], model);
}
