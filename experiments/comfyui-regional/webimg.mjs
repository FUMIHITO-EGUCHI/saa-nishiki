// Shrinks contact sheets for embedding in a report page: fixed width, moderate JPEG
// quality, written next to each other so the page can inline them as data URIs.
//
//   node webimg.mjs --out=./report --width=1100 a.jpg b.jpg ...

import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';

const arg = (name, fallback) => process.argv.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;

const OUT = arg('out', './report');
const WIDTH = Number(arg('width', 1100));
const QUALITY = Number(arg('quality', 76));
const files = process.argv.slice(2).filter(a => !a.startsWith('--'));

fs.mkdirSync(OUT, { recursive: true });
for (const file of files) {
    const target = path.join(OUT, path.basename(file).replace(/\.(png|jpe?g)$/i, '.jpg'));
    await sharp(file).resize({ width: WIDTH, withoutEnlargement: true }).jpeg({ quality: QUALITY, mozjpeg: true }).toFile(target);
    console.log(`${path.basename(target)}  ${(fs.statSync(target).size / 1024).toFixed(0)}KB`);
}
