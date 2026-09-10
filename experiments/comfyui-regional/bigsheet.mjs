// Tiles a sweep directory into readable sheets: one row per case, at a cell size large
// enough to judge eye colour and how many people are in the picture. The 250-300px
// contact sheets used earlier hid both.
//
//   node bigsheet.mjs --in=./sweepSplit --out=./big/split --cell=520 --rows=3
//   node bigsheet.mjs --in=./sweepCN --filter='_A\.png$' --out=./big/cnA

import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';

const arg = (name, fallback) => process.argv.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;

const IN = arg('in');
const OUT = arg('out');
const CELL = Number(arg('cell', 520));
const ROWS = Number(arg('rows', 3));
const FILTER = arg('filter', '');
const DIRS = arg('dirs', '');
const dirFilter = DIRS ? new RegExp(DIRS) : null;
const filter = FILTER ? new RegExp(FILTER) : null;

const label = (text, width, height, size = 15) => Buffer.from(
    `<svg width="${width}" height="${height}"><text x="6" y="${size}" font-family="monospace" font-size="${size}" fill="#ffd23c">${
        String(text).replace(/[<>&]/g, ch => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[ch]))}</text></svg>`);

const cases = fs.readdirSync(IN, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .filter(entry => !dirFilter || dirFilter.test(entry.name))
    .map(entry => {
        const files = fs.readdirSync(path.join(IN, entry.name))
            .filter(name => name.endsWith('.png'))
            .filter(name => !filter || filter.test(name))
            .sort();
        return { name: entry.name, files: files.map(name => path.join(IN, entry.name, name)) };
    })
    .filter(entry => entry.files.length);

if (!cases.length) throw new Error(`no case directories with images under ${IN}`);

const probe = await sharp(cases[0].files[0]).metadata();
const cellHeight = Math.round(CELL * (probe.height / probe.width));
const HEAD = 20;
const GAP = 5;

fs.mkdirSync(path.dirname(OUT), { recursive: true });

for (let start = 0, part = 1; start < cases.length; start += ROWS, part += 1) {
    const group = cases.slice(start, start + ROWS);
    const columns = Math.max(...group.map(entry => entry.files.length));
    const width = columns * (CELL + GAP);
    const height = group.length * (cellHeight + HEAD + GAP);
    const layers = [];

    for (const [row, entry] of group.entries()) {
        const top = row * (cellHeight + HEAD + GAP);
        layers.push({ input: label(`${entry.name}   ${entry.files.map(f => path.basename(f, '.png')).join(' | ')}`, width, HEAD), top, left: 0 });
        for (const [column, file] of entry.files.entries()) {
            layers.push({
                input: await sharp(file).resize(CELL, cellHeight, { fit: 'fill' }).png().toBuffer(),
                top: top + HEAD,
                left: column * (CELL + GAP),
            });
        }
    }

    const target = `${OUT}_${part}.jpg`;
    await sharp({ create: { width, height, channels: 3, background: { r: 18, g: 18, b: 22 } } })
        .composite(layers)
        .jpeg({ quality: 86 })
        .toFile(target);
    console.log(`${target}  ${width}x${height}  ${(fs.statSync(target).size / 1024).toFixed(0)}KB  (${group.map(e => e.name).join(', ')})`);
}
