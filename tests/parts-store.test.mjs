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

const DEFAULTS_FILE = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..', 'data', 'parts_defaults.json');

test('a settings folder without parts.json starts with the bundled starter set, written as its parts.json', () => {
    const rootDir = tempRoot();
    const store = createPartsStore({ rootDir, defaultsFile: DEFAULTS_FILE, now: () => new Date('2026-09-27T08:00:00Z'), log: null });
    const doc = store.load();
    assert.equal(Object.keys(doc.parts).length, 175);
    assert.equal(doc.parts['sailor uniform'].created, '2026-09-27T08:00:00.000Z');
    const envelope = JSON.parse(fs.readFileSync(path.join(rootDir, 'parts.json'), 'utf8'));
    assert.equal(envelope.section, 'parts');
    assert.equal(Object.keys(envelope.data.parts).length, 175, 'the seeded set is on disk, so a later launch does not seed again');
    // without a starter file the store starts empty, as before
    const bare = createPartsStore({ rootDir: tempRoot(), log: null });
    assert.deepEqual(bare.get(), { parts: {} });
    fs.rmSync(rootDir, { recursive: true, force: true });
});

test('an existing parts.json, even an empty one, is the user\'s and is not seeded', () => {
    const rootDir = tempRoot();
    const first = createPartsStore({ rootDir, log: null });
    first.reset();
    const store = createPartsStore({ rootDir, defaultsFile: DEFAULTS_FILE, log: null });
    assert.deepEqual(store.load(), { parts: {} });
    // a .bak alone counts as the user's file too
    const withBak = tempRoot();
    fs.writeFileSync(path.join(withBak, 'parts.json.bak'), JSON.stringify({ schema: 1, section: 'parts', data: { parts: { mine: { name: 'mine', category: 'hair', tags: 'bob cut' } } } }));
    const fromBak = createPartsStore({ rootDir: withBak, defaultsFile: DEFAULTS_FILE, log: null });
    assert.deepEqual(Object.keys(fromBak.load().parts), ['mine']);
    fs.rmSync(rootDir, { recursive: true, force: true });
    fs.rmSync(withBak, { recursive: true, force: true });
});

test('importDefaults adds the starter parts the store lacks and leaves a same-named part alone', () => {
    const rootDir = tempRoot();
    const store = createPartsStore({ rootDir, defaultsFile: DEFAULTS_FILE, now: () => new Date('2026-09-27T09:00:00Z'), log: null });
    store.reset();
    store.apply({ action: 'set', entry: { name: 'Sailor Uniform', category: 'outfit', tags: 'serafuku, ~loafers' } });
    const result = store.importDefaults();
    assert.deepEqual([result.ok, result.added, result.skipped], [true, 174, 1]);
    assert.equal(result.doc.parts['sailor uniform'].tags, 'serafuku, ~loafers');
    assert.equal(result.doc.parts['sailor uniform'].name, 'Sailor Uniform');
    assert.equal(Object.keys(store.get().parts).length, 175);
    const again = store.importDefaults();
    assert.deepEqual([again.ok, again.added, again.skipped], [true, 0, 175]);
    const reloaded = createPartsStore({ rootDir, log: null });
    assert.equal(Object.keys(reloaded.get().parts).length, 175, 'the merge was saved');
    // no starter file, or an unreadable one: refused, the store untouched
    const none = createPartsStore({ rootDir: tempRoot(), log: null });
    assert.deepEqual(none.importDefaults(), { ok: false, added: 0, skipped: 0, doc: { parts: {} } });
    const broken = createPartsStore({ rootDir: tempRoot(), defaultsFile: path.join(rootDir, 'nope.json'), log: null });
    assert.equal(broken.importDefaults().ok, false);
    fs.rmSync(rootDir, { recursive: true, force: true });
});
