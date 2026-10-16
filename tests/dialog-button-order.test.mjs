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
import { declarationsFor, parseStylesheet } from './helpers/cssRules.mjs';
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

test('the list edit form and the AI Refine footers sit at the right', () => {
    for (const theme of ['index_dark.css', 'index_light.css']) {
        const rules = stylesheet(theme);
        assert.equal(declarationsFor(rules, '.list-manager-edit-buttons').get('justify-content'), 'flex-end', theme);
        assert.equal(declarationsFor(rules, '.ai-result-modal-actions').get('justify-content'), 'flex-end', theme);
        assert.equal(declarationsFor(rules, '.ai-result-modal-actions .ai-result-modal-copy').get('margin-right'), 'auto', `${theme}: Copy is not a footer choice, it stays left`);
    }
    assert.equal(declarationsFor(stylesheet('index.css'), '.ai-refine-actions').get('justify-content'), 'flex-end');
});
