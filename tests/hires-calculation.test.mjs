import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { hiresCalculate } from '../scripts/renderer/tools/hiresCalculation.js';

const projectRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const LANGUAGE = JSON.parse(fs.readFileSync(path.join(projectRoot, 'data', 'language.json'), 'utf8'));

// The line under the size sliders while Hires fix is on:
// "[Width x Height x Scale] 1024 x 1024 x 1.5 = 1536 x 1536 = 2.25M".
// The target size it states is the size the run asks the backend for, so the per-side
// rounding to a multiple of 8 and the megapixel figure are the contract.
function withGlobals(values, body) {
    const saved = Object.keys(values).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]);
    for (const [key, value] of Object.entries(values)) {
        Object.defineProperty(globalThis, key, { value, configurable: true, writable: true, enumerable: true });
    }
    try {
        return body();
    } finally {
        for (const [key, descriptor] of saved) {
            if (descriptor) Object.defineProperty(globalThis, key, descriptor);
            else delete globalThis[key];
        }
    }
}

function renderHiresRow(settings) {
    const row = { innerHTML: '' };
    withGlobals({
        document: { querySelector: selector => (selector === '.hires-fix-resolution' ? row : null) },
        globalSettings: { language: 'en-US', ...settings },
        cachedFiles: { language: LANGUAGE },
    }, () => hiresCalculate());
    return row.innerHTML;
}

test('the Hires row states the source size, the scale, the target size and its megapixels', () => {
    assert.equal(
        renderHiresRow({ width: 1024, height: 1024, api_hf_scale: 1.5 }),
        '<span>[Width x Height x Scale] 1024 x 1024 x 1.5 = 1536 x 1536 = 2.25M</span>',
    );
});

test('the target size is rounded to a multiple of 8 per side, up or down', () => {
    // 1000 x 1.1 = 1100 -> 1104 (up), 700 x 1.1 = 770 -> 768 (down), 1104 x 768 = 0.81 MP
    assert.equal(
        renderHiresRow({ width: 1000, height: 700, api_hf_scale: 1.1 }),
        '<span>[Width x Height x Scale] 1000 x 700 x 1.1 = 1104 x 768 = 0.81M</span>',
    );
    // scale 1 leaves the size where it is
    assert.equal(
        renderHiresRow({ width: 832, height: 1216, api_hf_scale: 1 }),
        '<span>[Width x Height x Scale] 832 x 1216 x 1 = 832 x 1216 = 0.96M</span>',
    );
});

test('the row is written in the selected language', () => {
    const chinese = renderHiresRow({ width: 1024, height: 1024, api_hf_scale: 1.5, language: 'zh-CN' });
    assert.notEqual(chinese, renderHiresRow({ width: 1024, height: 1024, api_hf_scale: 1.5 }));
    assert.equal(chinese, LANGUAGE['zh-CN'].api_hf_message
        .replace('{0}', 1024).replace('{1}', 1024).replace('{2}', 1.5)
        .replace('{3}', 1536).replace('{4}', 1536).replace('{5}', '2.25'));
});

test('without the Hires row on the page nothing is read and nothing throws', () => {
    // the row only exists while the Hires panel is built; a size slider moved before that
    // must not reach for the language file at all
    withGlobals({
        document: { querySelector: () => null },
        globalSettings: { language: 'en-US', width: 1024, height: 1024, api_hf_scale: 1.5 },
        cachedFiles: undefined,
    }, () => assert.doesNotThrow(() => hiresCalculate()));
});
