// Every icon the UI draws comes from scripts/shared/iconSet.js: the renderer draws no SVG of
// its own, and the files in scripts/svg are written from the same shapes.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ICON_NAMES, ICON_SHAPES, iconElement, iconFile, iconMarkup } from '../scripts/shared/iconSet.js';
import { ICON_FILES, SVG_DIR } from '../scripts/buildIconFiles.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

test('every icon is drawn to the set\'s rules: the 16 box, 1.5 strokes, round ends, the text colour', () => {
    assert.ok(ICON_NAMES.length >= 45);
    for (const name of ICON_NAMES) {
        const markup = iconMarkup(name, 14);
        assert.match(markup, /^<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1\.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">/, name);
        assert.ok(ICON_SHAPES[name].length > 0, `${name} draws something`);
        // only dots are filled
        for (const [tag, values] of ICON_SHAPES[name]) if (values.fill) assert.equal(tag, 'circle', `${name}: a filled ${tag}`);
    }
    assert.throws(() => iconMarkup('no-such-icon'), /no icon named/);
});

test('an element icon gets each class on its own (a real classList refuses a token with a space)', () => {
    const added = [];
    const node = () => ({ setAttribute() {}, appendChild() {}, classList: { add: (...tokens) => added.push(...tokens) } });
    const saved = globalThis.document;
    globalThis.document = { createElementNS: () => node() };
    try {
        iconElement('search', 13, { className: 'tag-ui-icon tag-ui-icon-search' });
    } finally {
        globalThis.document = saved;
    }
    assert.deepEqual(added, ['tag-ui-icon', 'tag-ui-icon-search']);
});

test('the files in scripts/svg are the set\'s shapes in black (node scripts/buildIconFiles.mjs)', () => {
    const files = fs.readdirSync(SVG_DIR).filter(file => file.endsWith('.svg')).map(file => file.replace(/\.svg$/, ''));
    assert.deepEqual(files.sort(), Object.keys(ICON_FILES).sort(), 'one entry per file');
    for (const [file, name] of Object.entries(ICON_FILES)) {
        assert.ok(ICON_SHAPES[name], `${file}: ${name} is in the set`);
        const text = fs.readFileSync(path.join(SVG_DIR, `${file}.svg`), 'utf8').replace(/\r\n/g, '\n');
        assert.equal(text, iconFile(name), `${file}.svg: rerun node scripts/buildIconFiles.mjs`);
    }
});

test('the renderer draws no SVG of its own', () => {
    const sources = fs.readdirSync(path.join(root, 'scripts'), { recursive: true, withFileTypes: true })
        .filter(entry => entry.isFile() && /\.js$/.test(entry.name))
        .map(entry => path.relative(root, path.join(entry.parentPath, entry.name)).replaceAll('\\', '/'))
        .filter(file => file !== 'scripts/shared/iconSet.js');
    const drawing = sources.filter(file => /<svg[\s>]|createElementNS\(\s*['"]http:\/\/www\.w3\.org\/2000\/svg/.test(fs.readFileSync(path.join(root, file), 'utf8')));
    assert.deepEqual(drawing, []);
});
