import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
    USER_LIST_KEYS, applyUserListChange, emptyUserLists, makeUserListsEnvelope, mergeKeyedList,
    mergeUserListsDocs, mergeValueList, normalizeUserLists, readUserListsEnvelope, summarizeUserLists,
} from '../scripts/shared/userLists.js';
import { createUserListsStore } from '../scripts/main/userListsStore.js';

const quiet = { log() {}, warn() {}, error() {} };

function tempDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'saa-user-lists-'));
}

test('normalizeUserLists fills every list and drops malformed input', () => {
    assert.deepEqual(normalizeUserLists(null), emptyUserLists());
    const doc = normalizeUserLists({
        character: {
            entries: { ' Miku ': { tag: '1girl, hatsune miku', thumb: 'AAA=' }, bad: { tag: '' }, '': { tag: 'x' } },
            hidden: ['a', 'a', ' b ', 7],
        },
        view_angle: { entries: { 'dutch angle': { junk: 1 } } },
        view_camera: { entries: { combo: { tag: 'wide shot, from below' } } },
        junk_list: { entries: { x: { tag: 'y' } } },
    });
    assert.deepEqual(Object.keys(doc.character.entries), ['Miku']);
    assert.deepEqual(doc.character.entries.Miku, { tag: '1girl, hatsune miku', thumb: 'AAA=' });
    assert.deepEqual(doc.character.hidden, ['a', 'b']);
    assert.deepEqual(doc.view_angle.entries, { 'dutch angle': {} });
    assert.deepEqual(doc.view_camera.entries, { combo: { tag: 'wide shot, from below' } });
    assert.ok(!('junk_list' in doc));
    for (const list of USER_LIST_KEYS) assert.ok(doc[list]);
});

test('applyUserListChange handles set / remove / hide / unhide and refuses junk', () => {
    let doc = emptyUserLists();
    doc = applyUserListChange(doc, 'character', { action: 'set', key: 'Miku', entry: { tag: 'hatsune miku' } });
    assert.equal(doc.character.entries.Miku.tag, 'hatsune miku');
    doc = applyUserListChange(doc, 'character', { action: 'hide', key: 'old character' });
    assert.deepEqual(doc.character.hidden, ['old character']);
    // setting a hidden key un-hides it
    doc = applyUserListChange(doc, 'character', { action: 'set', key: 'old character', entry: { tag: 'new tag' } });
    assert.deepEqual(doc.character.hidden, []);
    doc = applyUserListChange(doc, 'character', { action: 'remove', key: 'Miku' });
    assert.ok(!('Miku' in doc.character.entries));
    doc = applyUserListChange(doc, 'view_angle', { action: 'set', key: 'dutch angle', entry: {} });
    assert.deepEqual(doc.view_angle.entries, { 'dutch angle': {} });

    assert.equal(applyUserListChange(doc, 'nope', { action: 'set', key: 'x' }), null);
    assert.equal(applyUserListChange(doc, 'character', { action: 'set', key: '', entry: { tag: 'x' } }), null);
    assert.equal(applyUserListChange(doc, 'character', { action: 'set', key: 'x', entry: { tag: '' } }), null);
    assert.equal(applyUserListChange(doc, 'character', { action: 'remove', key: 'not there' }), null);
    assert.equal(applyUserListChange(doc, 'character', { action: 'explode', key: 'x' }), null);
});

test('mergeKeyedList applies overrides, additions and hides; meta keeps every key', () => {
    const base = { A: 'tag a', B: 'tag b', C: 'tag c' };
    const diff = {
        entries: { B: { tag: 'tag b v2', thumb: 'T==' }, D: { tag: 'tag d' } },
        hidden: ['C'],
    };
    const { merged, meta } = mergeKeyedList(base, diff, 'csv');
    assert.deepEqual(merged, { A: 'tag a', B: 'tag b v2', D: 'tag d' });
    assert.deepEqual(meta.A, { source: 'csv', overridden: false, hidden: false });
    assert.deepEqual(meta.B, { source: 'user', overridden: true, hidden: false, thumb: 'T==' });
    assert.deepEqual(meta.C, { source: 'csv', overridden: false, hidden: true });
    assert.deepEqual(meta.D, { source: 'user', overridden: false, hidden: false });
    // empty diff is identity
    assert.deepEqual(mergeKeyedList(base, null, 'original').merged, base);
});

test('mergeValueList keeps base order, appends additions as {key,value}, drops hidden, applies tag overrides', () => {
    const { merged, meta } = mergeValueList(['front', 'side', 'back'], {
        entries: {
            'dutch angle': {},
            'my combo': { tag: 'from above, dutch angle' },
            back: { tag: 'from behind, looking back' },
        },
        hidden: ['side'],
    });
    assert.deepEqual(merged, [
        { key: 'front', value: 'front' },
        { key: 'back', value: 'from behind, looking back' },
        { key: 'dutch angle', value: 'dutch angle' },
        { key: 'my combo', value: 'from above, dutch angle' },
    ]);
    assert.equal(meta.side.hidden, true);
    assert.equal(meta['dutch angle'].source, 'user');
    assert.equal(meta.back.overridden, true);
});

test('envelope round-trips and rejects foreign files', () => {
    const doc = applyUserListChange(emptyUserLists(), 'oc', { action: 'set', key: 'My OC', entry: { tag: 'oc tag' } });
    const envelope = makeUserListsEnvelope(doc, { saaVersion: '2.8.9', now: () => new Date('2026-09-02T00:00:00Z') });
    assert.equal(envelope.section, 'user_lists');
    assert.deepEqual(readUserListsEnvelope(envelope), doc);
    assert.equal(readUserListsEnvelope({ section: 'app', data: {} }), null);
    assert.equal(readUserListsEnvelope({ section: 'user_lists', schema: 99, data: {} }), null);
});

test('mergeUserListsDocs: incoming entries win per key, hidden unions', () => {
    const a = normalizeUserLists({ character: { entries: { X: { tag: 'old' } }, hidden: ['h1'] } });
    const b = normalizeUserLists({ character: { entries: { X: { tag: 'new' }, Y: { tag: 'y' } }, hidden: ['h2'] } });
    const merged = mergeUserListsDocs(a, b);
    assert.equal(merged.character.entries.X.tag, 'new');
    assert.equal(merged.character.entries.Y.tag, 'y');
    assert.deepEqual(merged.character.hidden.sort(), ['h1', 'h2']);
});

test('store: load empty, apply persists atomically, export / import round-trip', () => {
    const dir = tempDir();
    const store = createUserListsStore({ rootDir: dir, saaVersion: '2.8.9', log: quiet });
    assert.deepEqual(store.get(), emptyUserLists());
    assert.ok(!fs.existsSync(store.file));

    const applied = store.apply('character', { action: 'set', key: 'Miku', entry: { tag: 'hatsune miku' } });
    assert.equal(applied.character.entries.Miku.tag, 'hatsune miku');
    assert.ok(fs.existsSync(store.file));
    assert.equal(store.apply('character', { action: 'set', key: '', entry: { tag: 'x' } }), null);

    // a second store on the same dir sees the saved diff
    const store2 = createUserListsStore({ rootDir: dir, log: quiet });
    assert.equal(store2.get().character.entries.Miku.tag, 'hatsune miku');

    const exportPath = path.join(dir, 'exported.json');
    const summary = store.exportTo(exportPath);
    assert.equal(summary.character.entries, 1);

    const other = createUserListsStore({ rootDir: fs.mkdtempSync(path.join(os.tmpdir(), 'saa-user-lists-b-')), log: quiet });
    other.apply('character', { action: 'set', key: 'Existing', entry: { tag: 'kept' } });
    const result = other.importFrom(exportPath, 'merge');
    assert.equal(result.ok, true);
    assert.equal(other.get().character.entries.Miku.tag, 'hatsune miku');
    assert.equal(other.get().character.entries.Existing.tag, 'kept');

    const replaced = other.importFrom(exportPath, 'replace');
    assert.equal(replaced.ok, true);
    assert.ok(!('Existing' in other.get().character.entries));

    // importing a non-user-lists JSON is refused
    const foreign = path.join(dir, 'foreign.json');
    fs.writeFileSync(foreign, JSON.stringify({ section: 'app', schema: 1, data: {} }), 'utf8');
    assert.equal(other.importFrom(foreign).ok, false);
    assert.deepEqual(summarizeUserLists(other.get()).character, { entries: 1, hidden: 0 });
});
