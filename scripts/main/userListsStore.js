// On-disk store for the user list diff (R3): settings/user_lists.json.
// Node fs only — no Electron — so it is unit-testable. Same atomic-write / .bak
// fallback discipline as settingsStore.js.
import fs from 'node:fs';
import path from 'node:path';
import { readJsonWithFallback, writeJsonAtomic } from './settingsStore.js';
import {
    applyUserListChange, emptyUserLists, makeUserListsEnvelope, mergeUserListsDocs,
    normalizeUserLists, readUserListsEnvelope, summarizeUserLists,
} from '../shared/userLists.js';

const CAT = '[UserListsStore]';
const FILE_NAME = 'user_lists.json';

export function createUserListsStore({ rootDir, saaVersion = '', now = () => new Date(), log = console, fsImpl = fs } = {}) {
    if (!rootDir) throw new Error('createUserListsStore: rootDir is required');
    const file = path.join(rootDir, FILE_NAME);
    const warn = message => log?.warn?.(CAT, message);

    let doc = null;

    function load() {
        const { value, source, error } = readJsonWithFallback(file, fsImpl);
        if (error) warn(`${FILE_NAME}: ${error.message}${source ? ` (using ${source})` : ''}`);
        doc = normalizeUserLists(value ? readUserListsEnvelope(value, { warn }) : null);
        return doc;
    }

    function get() {
        if (!doc) load();
        return doc;
    }

    function save(nextDoc) {
        doc = normalizeUserLists(nextDoc);
        writeJsonAtomic(file, makeUserListsEnvelope(doc, { saaVersion, now }), fsImpl);
        return doc;
    }

    /** Apply one management change and persist. Returns the new doc, or null when refused. */
    function apply(list, change) {
        const next = applyUserListChange(get(), list, change);
        if (!next) {
            warn(`apply refused: list=${list} action=${change?.action} key=${JSON.stringify(change?.key ?? null)}`);
            return null;
        }
        return save(next);
    }

    /** Write the current diff to an arbitrary path (export). */
    function exportTo(targetPath) {
        writeJsonAtomic(targetPath, makeUserListsEnvelope(get(), { saaVersion, now }), fsImpl);
        return summarizeUserLists(get());
    }

    /**
     * Read a diff file and merge ('merge') or replace ('replace') the stored one.
     * Returns { ok, summary } — ok=false when the file is not a user-lists document.
     */
    function importFrom(sourcePath, mode = 'merge') {
        const { value, error } = readJsonWithFallback(sourcePath, fsImpl);
        if (error || !value) {
            warn(`import ${sourcePath}: ${error?.message ?? 'no readable JSON'}`);
            return { ok: false, summary: null };
        }
        const incoming = readUserListsEnvelope(value, { warn });
        if (!incoming) return { ok: false, summary: null };
        const next = mode === 'replace' ? normalizeUserLists(incoming) : mergeUserListsDocs(get(), incoming);
        save(next);
        return { ok: true, summary: summarizeUserLists(next) };
    }

    function reset() {
        return save(emptyUserLists());
    }

    return { file, load, get, save, apply, exportTo, importFrom, reset };
}
