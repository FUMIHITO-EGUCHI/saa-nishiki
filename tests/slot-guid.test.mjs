import assert from 'node:assert/strict';
import test from 'node:test';

// generateGUID names the class a slot row is found by (ADetailer, ControlNet, LoRA rows).
// It ran out of random bytes half way and wrote "NaN" into the id, leaving the tail as
// literal "x"es, so `document.querySelector('.' + className)` found nothing and the row's
// textbox was never built ("[myTextbox] Container with class ... not found" in the console).

import { generateGUID } from '../scripts/renderer/slots/myLoRASlot.js';

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
