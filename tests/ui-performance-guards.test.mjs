import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('pipeline card: slots changed from outside the card (Image Info, dropped JSON, API switch) redraw the summaries', () => {
    const shell = read('scripts/renderer/uiShell.js');
    const pipeline = shell.slice(shell.indexOf('function setupPipelineRows()'), shell.indexOf('function setupCharactersCard()'));
    assert.doesNotMatch(pipeline, /setInterval/, 'still no poll');
    assert.match(pipeline, /const bodyObserver = new MutationObserver\(debounced\);/);
    assert.match(pipeline, /card\.querySelectorAll\('\.pipe-row-body'\)[\s\S]*bodyObserver\.observe\(body, \{ childList: true, subtree: true, attributes: true, attributeFilter: \['class'\] \}\);/);
    assert.match(pipeline, /bodyObserver\.disconnect\(\);/);
    // refresh() must never write into a watched body, or the observer would feed itself
    const refresh = pipeline.slice(pipeline.indexOf('function refresh()'), pipeline.indexOf('const debounced'));
    assert.doesNotMatch(refresh, /pipe-row-body/);
});

test('tag suggestions: the caret mirror wraps at the textarea clientWidth (no scrollbar, no border)', () => {
    const source = read('scripts/renderer/tagAutoComplete.js');
    const measure = source.slice(source.indexOf('function measureCaretOffset('), source.indexOf('function updateSuggestionBoxPosition('));
    assert.match(measure, /style\.borderWidth = '0';/);
    assert.match(measure, /style\.width = `\$\{textbox\.clientWidth > 0 \? textbox\.clientWidth : width\}px`;/);
    assert.doesNotMatch(measure, /borderLeftWidth/);
});
