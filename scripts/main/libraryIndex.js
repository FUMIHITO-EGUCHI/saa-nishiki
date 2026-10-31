// The Library's index: the images under the folders SAA's runs are saved in (ComfyUI's
// output, the pod transport's folder), each with what its PNG text says. Reading a PNG
// stops at the image data, where the text chunks end; what was read is kept in a cache
// file by path, size and modified time, which can always be rebuilt from the images.
//
// Node fs only (no Electron), so it is unit-testable; thumbnails come from a `thumbnail`
// function the backend gives it (sharp).

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';

import { pngSize, readTextChunks } from '../shared/pngText.js';
import { parseRecipe } from '../shared/recipe.js';
import { summarizeImage } from '../shared/imageSummary.js';

export const IMAGE_FILE = /\.(png|jpe?g|webp)$/i;
// SAA's own sample images live in the output folder too; they are no one's pictures
export const SKIPPED_FOLDERS = new Set(['parts-samples', 'lora-samples']);
const DATE_FOLDER = /^\d{4}-\d{2}-\d{2}$/;
const HEADER_BYTES = 64 * 1024;
const CACHE_VERSION = 2;

/** The text records and size of an image file, read up to its image data. */
export async function readImageHeader(file, { fsImpl = fs } = {}) {
    if (!/\.png$/i.test(file)) return { records: {}, size: null };
    const handle = await fsImpl.promises.open(file, 'r');
    try {
        const { size: fileSize } = await handle.stat();
        let length = Math.min(fileSize, HEADER_BYTES);
        for (;;) {
            const buffer = Buffer.alloc(length);
            await handle.read(buffer, 0, length, 0);
            const { records, complete } = readTextChunks(buffer, { inflate: zlib.inflateSync });
            if (complete || length >= fileSize) return { records, size: pngSize(buffer) };
            length = Math.min(fileSize, length * 4);
        }
    } finally {
        await handle.close();
    }
}

function searchText(summary, records) {
    const recipe = parseRecipe(records.saa_recipe);
    const prompt = recipe ? recipe.run.positive : String(records.parameters ?? '').split('\nNegative prompt:')[0];
    return [prompt.slice(0, 1500), summary.model, summary.characters.join(' '), summary.loras.map(row => row.name).join(' '), summary.seed ?? '']
        .join(' ').toLowerCase();
}

/** One index entry from a file's stat and header. */
export function indexEntry(file, stat, header) {
    const records = header?.records ?? {};
    const summary = summarizeImage({ recipe: records.saa_recipe, timing: records.saa_time, parameters: records.parameters, path: file });
    const recipe = parseRecipe(records.saa_recipe);
    return {
        path: file,
        name: path.basename(file),
        folder: path.dirname(file),
        size: stat.size,
        mtime: Math.round(stat.mtimeMs),
        width: header?.size?.width ?? summary.width ?? null,
        height: header?.size?.height ?? summary.height ?? null,
        state: summary.state,
        model: summary.model,
        type: summary.type,
        seed: summary.seed,
        characters: summary.characters,
        loras: summary.loras.map(row => row.name),
        fast: Boolean(summary.fast),
        time: summary.time?.total ?? null,
        created: recipe?.created || new Date(stat.mtimeMs).toISOString(),
text: searchText(summary, records),
    };
}

/** "SAA_2026-09-03T05-57-52_860766942.png" (a pod save) → "2026-09-03"; else the file's own day. */
export function dayOf(entry) {
    const stamped = /(\d{4}-\d{2}-\d{2})[T_]/.exec(entry.name);
    if (stamped) return stamped[1];
    const date = new Date(entry.created || entry.mtime);
    if (Number.isNaN(date.getTime())) return '';
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

export function createLibraryIndex({ cacheFile = '', fsImpl = fs, readHeader = file => readImageHeader(file, { fsImpl }), log = console } = {}) {
    let cache = null;   // path -> entry
    let saveTimer = null;

    function load() {
        cache = new Map();
        if (!cacheFile) return cache;
        try {
            const data = JSON.parse(fsImpl.readFileSync(cacheFile, 'utf8'));
            if (data?.v === CACHE_VERSION && Array.isArray(data.entries)) for (const entry of data.entries) if (entry?.path) cache.set(entry.path, entry);
        } catch { /* no cache yet, or an old one: rebuilt as images are read */ }
        return cache;
    }

    function scheduleSave() {
        if (!cacheFile || saveTimer) return;
        saveTimer = setTimeout(() => {
            saveTimer = null;
            try {
                fsImpl.mkdirSync(path.dirname(cacheFile), { recursive: true });
                const temp = `${cacheFile}.tmp`;
                fsImpl.writeFileSync(temp, JSON.stringify({ v: CACHE_VERSION, entries: [...cache.values()] }));
                fsImpl.renameSync(temp, cacheFile);
            } catch (error) {
                log?.warn?.('[LibraryIndex] cache not saved:', error?.message ?? error);
            }
        }, 2000);
        saveTimer.unref?.();
    }

    function entries() {
        if (!cache) load();
        return cache;
    }

    /** The entry for one image file, read again when it changed; null when it is gone. */
    async function entryFor(file) {
        let stat;
        try { stat = await fsImpl.promises.stat(file); } catch { entries().delete(file); return null; }
        if (!stat.isFile()) return null;
        const known = entries().get(file);
        if (known && known.size === stat.size && known.mtime === Math.round(stat.mtimeMs)) return known;
        let header = null;
        try { header = await readHeader(file); } catch (error) { log?.warn?.('[LibraryIndex] unreadable', file, error?.message ?? error); }
        const entry = indexEntry(file, stat, header);
        entries().set(file, entry);
        scheduleSave();
        return entry;
    }

    async function imagesIn(dir) {
        let names = [];
        try { names = await fsImpl.promises.readdir(dir); } catch { return []; }
        const files = names.filter(name => IMAGE_FILE.test(name)).map(name => path.join(dir, name));
        const result = [];
        // a few at a time: an output folder holds thousands
        for (let index = 0; index < files.length; index += 16) {
            const batch = await Promise.all(files.slice(index, index + 16).map(entryFor));
            result.push(...batch.filter(Boolean));
        }
        return result;
    }

    /**
     * The folders of a root, newest day first, then the others by name: [{ id, label, count }].
     * The root's own loose images are a folder of their own ('.'). A `flat` root (the pod
     * folder, one directory of stamped files) is split into days instead.
     */
    async function folders(root, { flat = false } = {}) {
        let items = [];
        try { items = await fsImpl.promises.readdir(root, { withFileTypes: true }); } catch { return []; }
        const loose = items.filter(item => item.isFile() && IMAGE_FILE.test(item.name));
        if (flat) {
            const days = new Map();
            for (const item of loose) {
                const day = dayOf({ name: item.name, created: '', mtime: 0 }) || 'other';
                days.set(day, (days.get(day) ?? 0) + 1);
            }
            return [...days.entries()].sort((a, b) => b[0].localeCompare(a[0])).map(([day, count]) => ({ id: `day:${day}`, label: day, count }));
        }
        const result = [];
        for (const item of items) {
            if (!item.isDirectory() || item.name.startsWith('.') || SKIPPED_FOLDERS.has(item.name)) continue;
            let count = 0;
            try { count = (await fsImpl.promises.readdir(path.join(root, item.name))).filter(name => IMAGE_FILE.test(name)).length; } catch { continue; }
            if (count > 0) result.push({ id: item.name, label: item.name, count });
        }
        result.sort((a, b) => {
            const aDate = DATE_FOLDER.test(a.id);
            const bDate = DATE_FOLDER.test(b.id);
            if (aDate !== bDate) return aDate ? -1 : 1;
            return aDate ? b.id.localeCompare(a.id) : a.id.localeCompare(b.id);
        });
        if (loose.length > 0) result.push({ id: '.', label: path.basename(root), count: loose.length });
        return result;
    }

    /** The images of one folder of a root (an id from `folders`). */
    async function images(root, folder) {
        if (String(folder).startsWith('day:')) {
            const day = folder.slice(4);
            return (await imagesIn(root)).filter(entry => (dayOf(entry) || 'other') === day);
        }
        const dir = folder === '.' ? root : path.join(root, folder);
        if (path.relative(root, dir).startsWith('..')) return [];
        return imagesIn(dir);
    }

    /** Every image under the roots: [{ dir, flat }]. */
    async function all(roots) {
        const result = [];
        for (const root of roots) {
            if (root.flat) {
                result.push(...await imagesIn(root.dir));
                continue;
            }
            for (const folder of await folders(root.dir)) result.push(...await images(root.dir, folder.id));
        }
        return result;
    }

    /** Entries for a list of paths (the stars, this session's images), skipping the gone ones. */
    async function some(files) {
        const result = [];
        for (const file of files) {
            const entry = await entryFor(file);
            if (entry) result.push(entry);
        }
        return result;
    }

    function forget(file) {
        entries().delete(file);
        scheduleSave();
    }

    return { load, entryFor, folders, images, all, some, forget, cacheFile };
}

/** A cache file name for an image's thumbnail: its path, size and modified time. */
export function thumbnailKey(entry, width) {
    return crypto.createHash('sha1').update(`${entry.path}|${entry.size}|${entry.mtime}|${width}`).digest('hex');
}
