import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createPartsStore } from '../scripts/main/partsStore.js';

function tempRoot() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'saa-parts-'));
}

test('the store starts empty, saves an envelope and reloads it', () => {
    const rootDir = tempRoot();
    const store = createPartsStore({ rootDir, saaVersion: '9.9.9', now: () => new Date('2026-09-22T10:00:00Z'), log: null });
    assert.deepEqual(store.get(), { parts: {} });
    const doc = store.apply({ action: 'set', entry: { name: 'Sailor Uniform', category: 'outfit', tags: 'serafuku, pleated skirt' } });
    assert.equal(doc.parts['sailor uniform'].updated, '2026-09-22T10:00:00.000Z');
    const envelope = JSON.parse(fs.readFileSync(path.join(rootDir, 'parts.json'), 'utf8'));
    assert.equal(envelope.section, 'parts');
    assert.equal(envelope.saa_version, '9.9.9');
    const again = createPartsStore({ rootDir, log: null });
    assert.equal(again.get().parts['sailor uniform'].tags, 'serafuku, pleated skirt');
    assert.equal(again.apply({ action: 'remove', id: 'missing' }), null);
    fs.rmSync(rootDir, { recursive: true, force: true });
});

test('a sample is written under the part folder, read back, and removed with its part', () => {
    const rootDir = tempRoot();
    const store = createPartsStore({ rootDir, log: null });
    store.apply({ action: 'set', entry: { name: 'Sailor Uniform', category: 'outfit', tags: 'serafuku' } });
    const png = Buffer.from('89504e470d0a1a0a0000', 'hex');
    assert.equal(store.addSample('nope', {}, png), null);
    const doc = store.addSample('sailor uniform', { modelType: 'Diffusion', model: 'waiANIMA', seed: 3, width: 512, height: 704 }, png);
    const [sample] = doc.parts['sailor uniform'].samples;
    assert.equal(sample.modelType, 'Diffusion');
    assert.equal(sample.base, 'mannequin');
    assert.ok(sample.created);
    const file = path.join(rootDir, 'parts', 'sailor-uniform', sample.file);
    assert.ok(fs.existsSync(file));
    assert.deepEqual(store.readSample('sailor uniform', sample.id), png);
    assert.equal(store.readSample('sailor uniform', 'other'), null);

    // renaming keeps the image: the folder follows the name
    store.apply({ action: 'set', id: 'sailor uniform', entry: { name: 'seifuku', category: 'outfit', tags: 'serafuku' } });
    assert.ok(fs.existsSync(path.join(rootDir, 'parts', 'seifuku', sample.file)));
    assert.deepEqual(store.readSample('seifuku', sample.id), png);

    store.apply({ action: 'remove-sample', id: 'seifuku', sampleId: sample.id });
    assert.ok(!fs.existsSync(path.join(rootDir, 'parts', 'seifuku', sample.file)));
    store.addSample('seifuku', { modelType: 'Checkpoint' }, png);
    store.apply({ action: 'remove', id: 'seifuku' });
    assert.ok(!fs.existsSync(path.join(rootDir, 'parts', 'seifuku')));
    assert.deepEqual(store.get(), { parts: {} });
    fs.rmSync(rootDir, { recursive: true, force: true });
});
