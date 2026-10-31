// The colours of both themes come from one file: design/tokens.json holds each --saa-* token's
// dark and light value, scripts/buildThemeTokens.mjs writes them into index_dark.css and
// index_light.css, and the rules themselves live once, in theme.css and gallery.css: the two
// themes differ only in the values.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { THEME_FILES, readTokens, themeProperties, withTokens } from '../scripts/buildThemeTokens.mjs';
import { parseStylesheet } from './helpers/cssRules.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const tokens = readTokens();

function filesUnder(dir, pattern) {
    return fs.readdirSync(path.join(root, dir), { recursive: true, withFileTypes: true })
        .filter(entry => entry.isFile() && pattern.test(entry.name))
        .map(entry => path.relative(root, path.join(entry.parentPath, entry.name)).replaceAll('\\', '/'));
}

test('the theme files carry the token values design/tokens.json has (node scripts/buildThemeTokens.mjs)', () => {
    for (const [theme, file] of Object.entries(THEME_FILES)) {
        const source = fs.readFileSync(file, 'utf8');
        assert.equal(withTokens(source, tokens, theme), source, `${theme}: rerun node scripts/buildThemeTokens.mjs`);
    }
});

test('both themes define the same tokens, each with a value', () => {
    const dark = themeProperties(tokens, 'dark');
    const light = themeProperties(tokens, 'light');
    assert.deepEqual([...light.keys()], [...dark.keys()]);
    assert.ok(dark.size > 80);
});

test('one palette: the old palette and the per-part copies of the core colours are gone', () => {
    const names = [...themeProperties(tokens, 'dark').keys()];
    assert.deepEqual(names.filter(name => /^saa-(classic|prompt|artist)-/.test(name)), []);
    for (const name of ['saa-chip-bg', 'saa-chip-border', 'saa-chip-text', 'saa-chip-toggle']) assert.ok(!names.includes(name), name);
    for (const name of ['saa-accent-soft', 'saa-backdrop']) assert.ok(names.includes(name), name);
});

test('every --saa-* a stylesheet or a script reads is a token or set where it is used', () => {
    const defined = new Set(themeProperties(tokens, 'dark').keys());
    const sources = [...filesUnder('html', /\.css$/), ...filesUnder('scripts', /\.(js|mjs)$/)];
    const set = new Set();
    const uses = [];
    for (const file of sources) {
        const text = read(file);
        for (const match of text.matchAll(/(?:^|[\s{;'"(])--(saa-[\w-]+)\s*:/g)) set.add(match[1]);
        for (const match of text.matchAll(/setProperty\(\s*['"]--(saa-[\w-]+)/g)) set.add(match[1]);
        for (const match of text.matchAll(/var\(--(saa-[\w-]+)/g)) uses.push([file, match[1]]);
    }
    const missing = uses.filter(([, name]) => !defined.has(name) && !set.has(name)).map(([file, name]) => `${file}: --${name}`);
    assert.deepEqual([...new Set(missing)], []);
});

test('the themes differ only in token values: the theme files hold no rules of their own', () => {
    for (const [theme, file] of Object.entries(THEME_FILES)) {
        const rules = parseStylesheet(fs.readFileSync(file, 'utf8')).filter(rule => !rule.selectors.includes(':root'));
        assert.deepEqual(rules.map(rule => rule.selectors.join(', ')), [], theme);
    }
});

test('the shared rules and the gallery set no token values of their own', () => {
    for (const file of ['html/theme.css', 'html/gallery.css', 'html/index.css']) {
        const roots = parseStylesheet(read(file)).filter(rule => rule.selectors.includes(':root'));
        const values = roots.flatMap(rule => [...rule.declarations.keys()].filter(name => name.startsWith('--saa-')));
        assert.deepEqual(values, [], file);
    }
});

test('the parts gold comes from the saa-part-* tokens, so it reads in the light theme too', () => {
    assert.doesNotMatch(read('html/index.css'), /#e0c080|#8a7440|rgba\(224, ?192, ?128/i);
});
