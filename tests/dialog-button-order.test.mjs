// One order for every dialog footer: Cancel (or No / Discard) on the left, the primary
// button on the right, the row right-aligned. myDialog runs on the in-memory DOM and is
// checked for the order it rendered; the footers that are laid out by a stylesheet are
// checked for the rule that right-aligns them.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { withFakeDom } from './helpers/fakeDom.mjs';
import { declarationsFor, parseStylesheet, themeCss } from './helpers/cssRules.mjs';
import { showDialog } from '../scripts/renderer/components/myDialog.js';

// the input dialog's textbox measures its line height a tick after it is built
globalThis.getComputedStyle = () => ({ lineHeight: '20px' });

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const stylesheet = (name) => parseStylesheet(fs.readFileSync(path.join(root, 'html', name), 'utf8'));

const rowOrder = (document) => {
    const row = document.querySelector('.dialog-button-row');
    assert.ok(row, 'the buttons share one row');
    return row.children.map(node => node.className);
};

test('a confirm puts No on the left and Yes on the right, in one row', async () => {
    await withFakeDom(async (document) => {
        const answer = showDialog('confirm', { message: 'Stop it?', yesText: 'Stop', noText: 'Keep running' });
        assert.deepEqual(rowOrder(document), ['dialog-button-container-no', 'dialog-button-container-yes']);
        document.querySelector('.dialog-button-container-yes button').click();
        assert.equal(await answer, true);
    });
});

test('an input dialog puts Cancel on the left and OK on the right', async () => {
    await withFakeDom(async (document) => {
        const answer = showDialog('input', { message: 'Name?' });
        assert.deepEqual(rowOrder(document), ['dialog-button-container-cancel', 'dialog-button-container-ok']);
        document.querySelector('.dialog-button-container-cancel button').click();
        assert.equal(await answer, null);
    });
});

test('an input dialog without Cancel keeps OK alone in the row', async () => {
    await withFakeDom(async (document) => {
        const answer = showDialog('input', { message: 'Name?', showCancel: false });
        assert.deepEqual(rowOrder(document), ['dialog-button-container-ok']);
        document.querySelector('.dialog-button-container-ok button').click();
        await answer;
    });
});

// myDialog is the Dialog component too: its buttons are the footer buttons the tag and parts
// dialogs use, Esc takes the way out, and closing gives the focus back
const escape = document => document.dispatchEvent({ type: 'keydown', key: 'Escape', preventDefault() {}, stopPropagation() {} });

test('a confirm draws its buttons as the Dialog footer buttons, with no colour of its own', async () => {
    await withFakeDom(async (document) => {
        const answer = showDialog('confirm', { message: 'Stop it?' });
        const yes = document.querySelector('.dialog-button-container-yes button');
        const no = document.querySelector('.dialog-button-container-no button');
        assert.equal(yes.className, 'selection-modal-apply');
        assert.equal(no.className, 'selection-modal-cancel');
        assert.equal(yes.type, 'button');
        assert.equal(yes.style.backgroundColor ?? '', '');
        assert.equal(document.querySelector('.dialog-container').getAttribute('role'), 'dialog');
        yes.click();
        await answer;
    });
    const source = fs.readFileSync(path.join(root, 'scripts/renderer/components/myDialog.js'), 'utf8');
    assert.doesNotMatch(source, /saa-legacy|setupButtons/);
});

test('Esc takes the way out: No for a confirm, Cancel for an input, OK for a notice', async () => {
    await withFakeDom(async (document) => {
        const confirm = showDialog('confirm', { message: 'Stop it?' });
        escape(document);
        assert.equal(await confirm, false);
        const input = showDialog('input', { message: 'Name?' });
        escape(document);
        assert.equal(await input, null);
        const info = showDialog('info', { message: 'Saved' });
        escape(document);
        assert.equal(await info, true);
        assert.equal(document.querySelector('.dialog-container'), null);
    });
});

test('the primary button takes the focus, and closing gives it back to where it was', async () => {
    await withFakeDom(async (document) => {
        const opener = document.body.appendChild(document.createElement('button'));
        opener.focus();
        const answer = showDialog('confirm', { message: 'Stop it?' });
        assert.equal(document.activeElement, document.querySelector('.dialog-button-container-yes button'));
        escape(document);
        await answer;
        assert.equal(document.activeElement, opener);
    });
});

test('the list edit form and the AI Refine footers sit at the right', () => {
    for (const theme of ['index_dark.css', 'index_light.css']) {
        const rules = parseStylesheet(themeCss(theme));
        assert.equal(declarationsFor(rules, '.list-manager-edit-buttons').get('justify-content'), 'flex-end', theme);
        assert.equal(declarationsFor(rules, '.ai-result-modal-actions').get('justify-content'), 'flex-end', theme);
        assert.equal(declarationsFor(rules, '.ai-result-modal-actions .ai-result-modal-copy').get('margin-right'), 'auto', `${theme}: Copy is not a footer choice, it stays left`);
    }
    assert.equal(declarationsFor(stylesheet('index.css'), '.ai-refine-actions').get('justify-content'), 'flex-end');
});
