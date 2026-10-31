// Writes the icon files in scripts/svg from the icon set (scripts/shared/iconSet.js). The
// upstream layout shows these files through <img> (tinted by a CSS filter) and CSS masks, so
// they keep their old names; each is drawn as the icon set's shape below.
//
//   node scripts/buildIconFiles.mjs           rewrite scripts/svg/*.svg
//   node scripts/buildIconFiles.mjs --check   exit 1 when a file is out of date
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { iconFile } from './shared/iconSet.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const SVG_DIR = path.join(ROOT, 'scripts', 'svg');

// file name -> icon set name
export const ICON_FILES = Object.freeze({
    add: 'plus',
    del: 'minus',
    delete: 'trash',
    info: 'info',
    refresh: 'refresh',
    reload: 'refresh',
    save: 'save',
    preset: 'bookmark',
    sliders: 'sliders',
    swap: 'swap',
    moon: 'moon',
    sun: 'sun',
    paste: 'clipboard',
    'image-upload': 'image-upload',
    'file-upload': 'file-upload',
    portrait: 'portrait',
    painting: 'brush',
    pose: 'pose',
    'mydropdown-arrow': 'chevron-down',
});

function main() {
    const check = process.argv.includes('--check');
    let stale = false;
    for (const [file, name] of Object.entries(ICON_FILES)) {
        const target = path.join(SVG_DIR, `${file}.svg`);
        const next = iconFile(name);
        const current = fs.existsSync(target) ? fs.readFileSync(target, 'utf8').replace(/\r\n/g, '\n') : null;
        if (current === next) continue;
        stale = true;
        if (check) console.error(`scripts/svg/${file}.svg is out of date: run node scripts/buildIconFiles.mjs`);
        else { fs.writeFileSync(target, next); console.log(`wrote scripts/svg/${file}.svg (${name})`); }
    }
    if (check && stale) process.exit(1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
