import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

// generateGUID names the class a slot row is found by (ADetailer, ControlNet, LoRA rows).
// It ran out of random bytes half way and wrote "NaN" into the id, leaving the tail as
// literal "x"es, so `document.querySelector('.' + className)` found nothing and the row's
// textbox was never built ("[myTextbox] Container with class ... not found" in the console).
// myLoRASlot.js pulls in the DOM components, so the function is taken from the source.

const source = fs.readFileSync(new URL('../scripts/renderer/slots/myLoRASlot.js', import.meta.url), 'utf8');
const body = source.slice(source.indexOf('export function generateGUID'), source.indexOf('async function processLoraMetadata'));
const generateGUID = new Function(`return ${body.replace('export function', 'function')}`)();

test('every slot id is a complete uuid, with no leftover placeholder', () => {
    const shape = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
    const ids = new Set();
    for (let i = 0; i < 2000; i += 1) {
        const id = generateGUID();
        assert.match(id, shape);
        assert.equal(id.length, 36);
        ids.add(id);
    }
    assert.equal(ids.size, 2000, 'ids do not repeat');
});
