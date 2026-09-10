// Tiles a sweep directory into one contact sheet: a row per case, a column per
// seed x branch. Judging a method needs the whole batch in one view, not one picture.
//
//   node sheet.mjs --in=./out --out=./out/sheet.png [--cell=320]

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const arg = (name, fallback) => process.argv.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const IN = arg('in', path.join(HERE, 'out'));
const OUT = arg('out', path.join(IN, 'sheet.png'));
const CELL = Number(arg('cell', 320));
const LABEL_WIDTH = 200;
const HEADER = 34;
const GAP = 6;

const escape = text => String(text).replace(/[<>&]/g, ch => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[ch]));

const MATCH = arg('match', '');

const rows = fs.readdirSync(IN, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .filter(entry => !MATCH || entry.name.includes(MATCH))
    .map(entry => {
        const files = fs.readdirSync(path.join(IN, entry.name))
            .filter(name => name.endsWith('.png'))
            .sort();
        return { name: entry.name, files };
    })
    .filter(row => row.files.length);

if (!rows.length) throw new Error(`no case directories with images under ${IN}`);

const columns = Math.max(...rows.map(row => row.files.length));
const first = await sharp(path.join(IN, rows[0].name, rows[0].files[0])).metadata();
const cellHeight = Math.round(CELL * (first.height / first.width));

const width = LABEL_WIDTH + columns * (CELL + GAP);
const height = HEADER + rows.length * (cellHeight + HEADER);

const composites = [];
const labels = [];

for (const [rowIndex, row] of rows.entries()) {
    const top = HEADER + rowIndex * (cellHeight + HEADER);
    labels.push(`<text x="10" y="${top + cellHeight / 2}" font-family="sans-serif" font-size="18" fill="#111">${escape(row.name)}</text>`);
    for (const [columnIndex, file] of row.files.entries()) {
        const left = LABEL_WIDTH + columnIndex * (CELL + GAP);
        composites.push({
            input: await sharp(path.join(IN, row.name, file)).resize(CELL, cellHeight, { fit: 'cover' }).png().toBuffer(),
            left,
            top,
        });
        labels.push(`<text x="${left + 4}" y="${top + cellHeight + 22}" font-family="sans-serif" font-size="16" fill="#333">${escape(path.basename(file, '.png'))}</text>`);
    }
}

const overlay = Buffer.from(
    `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">${labels.join('')}</svg>`,
);

await sharp({ create: { width, height, channels: 3, background: '#ffffff' } })
    .composite([...composites, { input: overlay, left: 0, top: 0 }])
    .png()
    .toFile(OUT);

console.log(`${rows.length} cases x ${columns} images -> ${OUT}`);
