// Writes the --saa-* custom properties from design/tokens.json into the two theme files, between
// the "tokens" markers. Edit the values in design/tokens.json, never in the theme files.
//
//   node scripts/buildThemeTokens.mjs           rewrite html/index_dark.css and html/index_light.css
//   node scripts/buildThemeTokens.mjs --check   exit 1 when either file is out of date
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const TOKENS_PATH = path.join(ROOT, 'design', 'tokens.json');
export const THEME_FILES = { dark: path.join(ROOT, 'html', 'index_dark.css'), light: path.join(ROOT, 'html', 'index_light.css') };
const BEGIN = '/* === tokens: generated from design/tokens.json by scripts/buildThemeTokens.mjs === */';
const END = '/* === /tokens === */';

export function readTokens(file = TOKENS_PATH) {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
}

// A token's value in one theme: {dark, light} or one string for both
function valueIn(token, theme) {
    const value = typeof token.value === 'string' ? token.value : token.value[theme];
    if (typeof value !== 'string' || !value) throw new Error(`${token.name} has no ${theme} value`);
    return value;
}

// name -> value of every custom property the theme defines
export function themeProperties(tokens, theme) {
    const properties = new Map();
    for (const token of [...tokens.color.tokens, ...tokens.themeValues.tokens]) {
        if (properties.has(token.name)) throw new Error(`${token.name} is defined twice`);
        properties.set(token.name, valueIn(token, theme));
    }
    return properties;
}

export function themeBlock(tokens, theme, eol = '\n') {
    const lines = [...themeProperties(tokens, theme)].map(([name, value]) => `    --${name}: ${value};`);
    return [BEGIN, ':root {', ...lines, '}', END].join(eol);
}

// the block in the file's own line endings (a Windows checkout has CRLF)
export function withTokens(source, tokens, theme) {
    const start = source.indexOf(BEGIN), end = source.indexOf(END);
    if (start < 0 || end < start) throw new Error(`the ${theme} theme file has no tokens markers`);
    const eol = source.includes('\r\n') ? '\r\n' : '\n';
    return source.slice(0, start) + themeBlock(tokens, theme, eol) + source.slice(end + END.length);
}

function main() {
    const check = process.argv.includes('--check');
    const tokens = readTokens();
    let stale = false;
    for (const [theme, file] of Object.entries(THEME_FILES)) {
        const source = fs.readFileSync(file, 'utf8');
        const next = withTokens(source, tokens, theme);
        if (next === source) continue;
        stale = true;
        if (check) console.error(`${path.relative(ROOT, file)} is out of date: run node scripts/buildThemeTokens.mjs`);
        else { fs.writeFileSync(file, next); console.log(`wrote ${path.relative(ROOT, file)}`); }
    }
    if (check && stale) process.exit(1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
