import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createSequencesStore } from '../scripts/main/sequencesStore.js';

test('the sequences store starts empty, saves an envelope and reloads it normalized', () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'saa-sequences-'));
    try {
        const store = createSequencesStore({ rootDir, saaVersion: '9.9.9', now: () => new Date('2026-11-14T10:00:00Z'), log: null });
        assert.deepEqual(store.get(), { sequences: {}, current: { name: '', field: '', scenes: [] }, editBackup: null });
        store.save({
            sequences: { '一日の流れ': { field: 'cf_a', scenes: [{ id: 'a', name: '起床', text: 'waking up', thumb: 'data:image/png;base64,AA' }] } },
            current: { name: '一日の流れ', field: 'cf_a', scenes: [] },
            editBackup: { fieldKey: 'cf_a', text: 'mine' },
        });
        const envelope = JSON.parse(fs.readFileSync(path.join(rootDir, 'sequences.json'), 'utf8'));
        assert.equal(envelope.section, 'sequences');
        assert.equal(envelope.saa_version, '9.9.9');
        assert.equal(envelope.saved_at, '2026-11-14T10:00:00.000Z');
        const again = createSequencesStore({ rootDir, log: null });
        const scene = again.get().sequences['一日の流れ'].scenes[0];
        assert.equal(scene.text, 'waking up');
        assert.equal(scene.thumb, '', 'only a JPEG data URL is kept as a thumb');
        assert.deepEqual(again.get().editBackup, { fieldKey: 'cf_a', text: 'mine' });
    } finally {
        fs.rmSync(rootDir, { recursive: true, force: true });
    }
});

test('a file that is not a sequences envelope reads as empty', () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'saa-sequences-'));
    try {
        fs.writeFileSync(path.join(rootDir, 'sequences.json'), JSON.stringify({ section: 'parts', data: { sequences: { x: {} } } }));
        assert.deepEqual(createSequencesStore({ rootDir, log: null }).get().sequences, {});
    } finally {
        fs.rmSync(rootDir, { recursive: true, force: true });
    }
});
