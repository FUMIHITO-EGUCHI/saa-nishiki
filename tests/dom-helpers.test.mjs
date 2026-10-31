// The renderer builds its elements with scripts/renderer/dom.js: one element() instead of a copy
// in every module, and one icon-only button (Design System: IconButton, .saa-icon-btn) instead of
// a class per feature that drew the same 24px button again.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { withFakeDom } from './helpers/fakeDom.mjs';
import { parseStylesheet, themeCss } from './helpers/cssRules.mjs';
import { element, iconButton } from '../scripts/renderer/dom.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

test('element() sets the class and the text; no text leaves it empty, a number is written out', async () => {
    await withFakeDom(async () => {
        const node = element('span', 'a b', 'hello');
        assert.equal(node.tagName, 'SPAN');
        assert.equal(node.className, 'a b');
        assert.equal(node.textContent, 'hello');
        assert.equal(element('div').className, '');
        assert.equal(element('div', '', null).textContent, '');
        assert.equal(element('div', '', undefined).textContent, '');
        assert.equal(element('div', '', 0).textContent, '0');
    });
});

test('iconButton() is a named button with one icon of the set, in the size asked for', async () => {
    await withFakeDom(async () => {
        let clicks = 0;
        const button = iconButton('search', 'Search tags', { className: 'lora-retake-search', onClick: () => { clicks += 1; } });
        assert.equal(button.tagName, 'BUTTON');
        assert.equal(button.type, 'button');
        assert.equal(button.className, 'saa-icon-btn lora-retake-search');
        assert.equal(button.getAttribute('aria-label'), 'Search tags');
        assert.equal(button.title, 'Search tags');
        assert.equal(button.children.length, 1);
        assert.equal(button.children[0].tagName.toLowerCase(), 'svg');
        button.click();
        assert.equal(clicks, 1);
        assert.equal(iconButton('close', 'Remove', { size: 28 }).className, 'saa-icon-btn is-28');
        assert.equal(iconButton('dice', 'Random', { size: 26, framed: true }).className, 'saa-icon-btn is-26 is-framed');
    });
});

test('no renderer module keeps its own copy of the element helper', () => {
    const files = fs.readdirSync(path.join(root, 'scripts', 'renderer'), { recursive: true, withFileTypes: true })
        .filter(entry => entry.isFile() && entry.name.endsWith('.js'))
        .map(entry => path.relative(root, path.join(entry.parentPath, entry.name)).replaceAll('\\', '/'))
        .filter(file => file !== 'scripts/renderer/dom.js');
    const copies = files.filter(file => /document\.createElement\((tag|tagName)\)/.test(read(file)));
    assert.deepEqual(copies, []);
});

test('the icon-only buttons share .saa-icon-btn; the old per-feature classes draw nothing of their own', () => {
    for (const theme of ['html/index_dark.css', 'html/index_light.css']) {
        const rules = parseStylesheet(themeCss(theme));
        const looks = ['width', 'height', 'background', 'border', 'color', 'border-radius'];
        for (const name of ['run-icon-button', 'edit-history-button', 'lora-slot-icon', 'viewer-tool-button', 'lora-rename', 'lora-retake-search',
            'scene-menu-button', 'run-ratio-chain', 'slot-action', 'viewer-seed-button']) {
            const own = rules.filter(rule => rule.selectors.some(selector => new RegExp(`^\\.${name}(:hover|:focus-visible|\\.is-[a-z]+)?$`).test(selector)));
            const drawn = own.flatMap(rule => [...rule.declarations.keys()].filter(key => looks.includes(key)));
            assert.deepEqual(drawn, [], `${theme}: .${name}`);
        }
        const base = rules.find(rule => rule.selectors.includes('.saa-icon-btn'));
        assert.equal(base.declarations.get('width'), '24px');
        assert.ok(rules.some(rule => rule.selectors.includes('.saa-icon-btn.is-28')));
        assert.ok(rules.some(rule => rule.selectors.includes('.saa-icon-btn.is-framed')));
    }
    const body = read('scripts/html_shared_body.js');
    for (const id of ['edit-history-undo', 'edit-history-redo', 'viewer-grid-toggle', 'viewer-library-open', 'seed-random-button', 'seed-reuse-button', 'run-ratio-chain']) {
        assert.match(body, new RegExp(`<button[^>]*class="saa-icon-btn[^"]*"[^>]*id="${id}"|<button[^>]*id="${id}"[^>]*class="saa-icon-btn`), id);
    }
});
