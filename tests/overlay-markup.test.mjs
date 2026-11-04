import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

// the color classes go into the first stylesheet
const rules = [];
globalThis.document = { styleSheets: [{ cssRules: rules, insertRule: rule => rules.push({ selectorText: rule.split(' ')[0], cssText: rule }) }] };
const { overlayMarkup } = await import('../scripts/renderer/customOverlay.js');

test('overlay links and colors are classes, since the page CSP drops style="" attributes', () => {
  const html = overlayMarkup('see [COPY_URL]https://example.com/a[/COPY_URL]\n[COPY_CUSTOM=#ff8800]warm[/COPY_CUSTOM] [COPY_CUSTOM]plain[/COPY_CUSTOM]');
  assert.doesNotMatch(html, /style=/);
  assert.match(html, /<a href="https:\/\/example\.com\/a" target="_blank" class="myInfoBox-link">https:\/\/example\.com\/a<\/a>/);
  assert.match(html, /<span class="color--ff8800">warm<\/span>/);
  assert.match(html, /<span class="color--ffffff">plain<\/span>/, 'no color named is white, as before');
  assert.match(html, /<br>/);
  assert.ok(rules.some(rule => rule.cssText === '.color--ff8800 { color: #ff8800; }'));
});

test('no renderer script writes a style="" attribute into markup', () => {
  const offenders = [];
  const walk = dir => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.js') && /style=["'$]/.test(fs.readFileSync(full, 'utf8'))) offenders.push(path.relative(root, full));
    }
  };
  walk(path.join(root, 'scripts', 'renderer'));
  assert.deepEqual(offenders, []);
});
