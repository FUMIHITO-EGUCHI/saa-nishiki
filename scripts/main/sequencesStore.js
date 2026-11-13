// On-disk store for the sequence batch (scripts/shared/sequenceBatch.js):
// settings/sequences.json holds the saved sequences, the one the dialog has open and the
// scene field's own text while edit mode runs. Its own file, like parts.json, rather than
// a settings section: a section would join state.json, the undo history and the preset
// rows. Node fs only, so it is unit-testable; same atomic-write / .bak discipline as the
// settings store.
import fs from 'node:fs';
import path from 'node:path';
import { readJsonWithFallback, writeJsonAtomic } from './settingsStore.js';
import { normalizeSequenceDocument } from '../shared/sequenceBatch.js';

const CAT = '[SequencesStore]';
const FILE_NAME = 'sequences.json';
export const SEQUENCES_SECTION = 'sequences';
export const SEQUENCES_SCHEMA = 1;

export function createSequencesStore({ rootDir, saaVersion = '', now = () => new Date(), log = console, fsImpl = fs } = {}) {
    if (!rootDir) throw new Error('createSequencesStore: rootDir is required');
    const file = path.join(rootDir, FILE_NAME);
    const warn = message => log?.warn?.(CAT, message);
    let doc = null;

    function load() {
        const { value, source, error } = readJsonWithFallback(file, fsImpl);
        if (error) warn(`${FILE_NAME}: ${error.message}${source ? ` (using ${source})` : ''}`);
        const data = value && typeof value === 'object' && value.section === SEQUENCES_SECTION ? value.data : null;
        doc = normalizeSequenceDocument(data);
        return doc;
    }

    function get() {
        if (!doc) load();
        return doc;
    }

    function save(nextDoc) {
        doc = normalizeSequenceDocument(nextDoc);
        const stamp = now();
        writeJsonAtomic(file, {
            schema: SEQUENCES_SCHEMA,
            section: SEQUENCES_SECTION,
            saa_version: saaVersion,
            saved_at: stamp instanceof Date ? stamp.toISOString() : String(stamp),
            data: doc,
        }, fsImpl);
        return doc;
    }

    return { file, load, get, save };
}
