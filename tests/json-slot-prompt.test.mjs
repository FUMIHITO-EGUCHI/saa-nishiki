import test from 'node:test';
import assert from 'node:assert/strict';

import { escapeJsonSlotPrompt, jsonSlotFragment } from '../scripts/shared/jsonSlotPrompt.js';

test('a blank slot prompt contributes nothing (no stray ", ")', () => {
    assert.equal(jsonSlotFragment('', 1), '');
    assert.equal(jsonSlotFragment('   ', 1), '');
    assert.equal(jsonSlotFragment(undefined, 1), '');
    assert.equal(jsonSlotFragment(null, 0.8), '');
});

test('weight 1 is a plain fragment, any other weight is wrapped', () => {
    assert.equal(jsonSlotFragment('red dress', 1), 'red dress, ');
    assert.equal(jsonSlotFragment('red dress', '1'), 'red dress, ');
    assert.equal(jsonSlotFragment('red dress', 0.8), '(red dress:0.8), ');
    assert.equal(jsonSlotFragment('red dress', 'abc'), 'red dress, ', 'an unparsable weight reads as 1');
});

test('parentheses, backslashes and colons are escaped the way the generators did', () => {
    assert.equal(escapeJsonSlotPrompt('a (b) c:d \\e'), String.raw`a \(b\) c d \\e`);
    assert.equal(jsonSlotFragment('(masterpiece)', 1.2), String.raw`(\(masterpiece\):1.2), `);
});
