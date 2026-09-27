import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createPartsStore } from '../scripts/main/partsStore.js';
import { STARTER_SET_VERSION } from '../scripts/shared/parts.js';

function tempRoot() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'saa-parts-'));
}

test('the store starts empty, saves an envelope and reloads it', () => {
    const rootDir = tempRoot();
    const store = createPartsStore({ rootDir, saaVersion: '9.9.9', now: () => new Date('2026-09-22T10:00:00Z'), log: null });
    assert.deepEqual(store.get(), { parts: {}, starterVersion: 0 });
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
    assert.deepEqual(store.get(), { parts: {}, starterVersion: 0 });
    fs.rmSync(rootDir, { recursive: true, force: true });
});

const DEFAULTS_FILE = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..', 'data', 'parts_defaults.json');

test('a settings folder without parts.json starts with the whole starter set, written as its parts.json at the set version', () => {
    const rootDir = tempRoot();
    const store = createPartsStore({ rootDir, defaultsFile: DEFAULTS_FILE, now: () => new Date('2026-09-27T08:00:00Z'), log: null });
    const doc = store.load();
    assert.equal(Object.keys(doc.parts).length, 175);
    assert.equal(doc.starterVersion, STARTER_SET_VERSION);
    assert.equal(doc.parts['sailor uniform'].created, '2026-09-27T08:00:00.000Z');
    const envelope = JSON.parse(fs.readFileSync(path.join(rootDir, 'parts.json'), 'utf8'));
    assert.equal(envelope.section, 'parts');
    assert.equal(Object.keys(envelope.data.parts).length, 175);
    assert.equal(envelope.data.starterVersion, STARTER_SET_VERSION, 'the version on disk stops the next launch from merging again');
    // without a starter file the store starts empty and writes nothing
    const bareRoot = tempRoot();
    const bare = createPartsStore({ rootDir: bareRoot, log: null });
    assert.deepEqual(bare.get(), { parts: {}, starterVersion: 0 });
    assert.ok(!fs.existsSync(path.join(bareRoot, 'parts.json')));
    fs.rmSync(rootDir, { recursive: true, force: true });
    fs.rmSync(bareRoot, { recursive: true, force: true });
});

test('an existing parts.json older than the starter set gains the names it lacks, and a same-named part is left alone', () => {
    const rootDir = tempRoot();
    const first = createPartsStore({ rootDir, log: null });
    first.reset();
    first.apply({ action: 'set', entry: { name: 'Sailor Uniform', category: 'outfit', tags: 'serafuku, ~loafers' } });
    first.apply({ action: 'set', entry: { name: 'mine', category: 'hair', tags: 'bob cut' } });
    const store = createPartsStore({ rootDir, defaultsFile: DEFAULTS_FILE, now: () => new Date('2026-09-28T09:00:00Z'), log: null });
    const doc = store.load();
    assert.equal(Object.keys(doc.parts).length, 176, '174 starter parts added beside the two of the user');
    assert.equal(doc.parts['sailor uniform'].tags, 'serafuku, ~loafers', 'the user\'s tags win');
    assert.equal(doc.parts['sailor uniform'].name, 'Sailor Uniform');
    assert.equal(doc.parts.mine.tags, 'bob cut');
    assert.equal(doc.parts.classroom.created, '2026-09-28T09:00:00.000Z');
    assert.equal(doc.starterVersion, STARTER_SET_VERSION);
    const envelope = JSON.parse(fs.readFileSync(path.join(rootDir, 'parts.json'), 'utf8'));
    assert.equal(Object.keys(envelope.data.parts).length, 176, 'the merge is saved');
    // a .bak alone is read the same way
    const withBak = tempRoot();
    fs.writeFileSync(path.join(withBak, 'parts.json.bak'), JSON.stringify({ schema: 1, section: 'parts', data: { parts: { mine: { name: 'mine', category: 'hair', tags: 'bob cut' } } } }));
    const fromBak = createPartsStore({ rootDir: withBak, defaultsFile: DEFAULTS_FILE, log: null });
    assert.equal(Object.keys(fromBak.load().parts).length, 176);
    fs.rmSync(rootDir, { recursive: true, force: true });
    fs.rmSync(withBak, { recursive: true, force: true });
});

test('a starter part the user deleted stays deleted: a document at the set version is not merged again', () => {
    const rootDir = tempRoot();
    const store = createPartsStore({ rootDir, defaultsFile: DEFAULTS_FILE, log: null });
    store.load();
    store.apply({ action: 'remove', id: 'sailor uniform' });
    assert.equal(Object.keys(store.get().parts).length, 174);
    const again = createPartsStore({ rootDir, defaultsFile: DEFAULTS_FILE, log: null });
    const doc = again.load();
    assert.equal(Object.keys(doc.parts).length, 174, 'nothing came back');
    assert.equal(doc.parts['sailor uniform'], undefined);
    // an older version on disk is merged once more, so a grown set reaches the store
    const older = JSON.parse(fs.readFileSync(path.join(rootDir, 'parts.json'), 'utf8'));
    older.data.starterVersion = STARTER_SET_VERSION - 1;
    fs.writeFileSync(path.join(rootDir, 'parts.json'), JSON.stringify(older));
    const grown = createPartsStore({ rootDir, defaultsFile: DEFAULTS_FILE, log: null });
    assert.equal(Object.keys(grown.load().parts).length, 175, 'the deleted starter part is back only when the set moved on');
    // an unreadable bundled file: the document is read as it is, nothing written
    const brokenRoot = tempRoot();
    const broken = createPartsStore({ rootDir: brokenRoot, defaultsFile: path.join(rootDir, 'nope.json'), log: null });
    assert.deepEqual(broken.load(), { parts: {}, starterVersion: 0 });
    assert.ok(!fs.existsSync(path.join(brokenRoot, 'parts.json')));
    fs.rmSync(rootDir, { recursive: true, force: true });
    fs.rmSync(brokenRoot, { recursive: true, force: true });
});
