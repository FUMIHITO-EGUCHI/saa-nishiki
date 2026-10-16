// settings/library.json: what the viewer and the Library keep that the image files do not
// - the stars. An image is named by its absolute path (compared without case on Windows,
// whose paths are). Node fs only, no Electron, so it is unit-testable; the same atomic
// write / .bak discipline as the other stores.
import fs from 'node:fs';
import path from 'node:path';
import { readJsonWithFallback, writeJsonAtomic } from './settingsStore.js';

const CAT = '[LibraryStore]';
const FILE_NAME = 'library.json';
export const LIBRARY_SECTION = 'library';
const SCHEMA = 1;

export function createLibraryStore({ rootDir, saaVersion = '', now = () => new Date(), log = console, fsImpl = fs, platform = process.platform } = {}) {
    if (!rootDir) throw new Error('createLibraryStore: rootDir is required');
    const file = path.join(rootDir, FILE_NAME);
    const pathApi = platform === 'win32' ? path.win32 : path.posix;
    const keyOf = value => {
        const resolved = pathApi.resolve(String(value ?? ''));
        return platform === 'win32' ? resolved.toLowerCase() : resolved;
    };
    let favorites = null;   // Map key -> path as given

    function load() {
        const { value, source, error } = readJsonWithFallback(file, fsImpl);
        if (error) log?.warn?.(CAT, `${FILE_NAME}: ${error.message}${source ? ` (using ${source})` : ''}`);
        const data = value && typeof value === 'object' && value.section === LIBRARY_SECTION ? value.data : null;
        favorites = new Map();
        for (const entry of Array.isArray(data?.favorites) ? data.favorites : []) {
            if (typeof entry === 'string' && entry.trim()) favorites.set(keyOf(entry), pathApi.resolve(entry));
        }
        return list();
    }

    function list() {
        if (!favorites) load();
        return [...favorites.values()];
    }

    function save() {
        const stamp = now();
        writeJsonAtomic(file, {
            schema: SCHEMA,
            section: LIBRARY_SECTION,
            saa_version: saaVersion,
            saved_at: stamp instanceof Date ? stamp.toISOString() : String(stamp),
            data: { favorites: [...favorites.values()] },
        }, fsImpl);
    }

    function setFavorite(target, on) {
        if (!favorites) load();
        const text = String(target ?? '').trim();
        if (!text || !pathApi.isAbsolute(text)) return list();
        const key = keyOf(text);
        if (on) favorites.set(key, pathApi.resolve(text));
        else favorites.delete(key);
        save();
        return list();
    }

    function isFavorite(target) {
        if (!favorites) load();
        return favorites.has(keyOf(target));
    }

    return { file, load, list, setFavorite, isFavorite };
}
