// Main-process side of the viewer's and the Library's file work: where SAA's images are
// (ComfyUI's output folder, the pod transport's folder), what each one is (libraryIndex.js),
// their thumbnails, the stars (settings/library.json), showing an image in the file
// manager and moving one to the trash. The images stay where they were saved.
import { app, ipcMain, nativeImage, shell } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { createLibraryStore } from './libraryStore.js';
import { createLibraryIndex, thumbnailKey } from './libraryIndex.js';
import { comfyOutputDir, forgetComfyOutputDirs } from './imageRecord.js';
import { getGlobalSettings } from './globalSettings.js';
import { resolveSettingsRoot } from './settingsRoot.js';
import { readTextChunks } from '../shared/pngText.js';
import zlib from 'node:zlib';

const CAT = '[Library]';
const appPath = app.isPackaged ? path.join(path.dirname(app.getPath('exe')), 'resources', 'app') : app.getAppPath();
const THUMB_WIDTH = 320;

let store = null;
let index = null;

function settingsRoot() {
    return resolveSettingsRoot(appPath);
}

function getStore() {
    if (!store) {
        store = createLibraryStore({ rootDir: settingsRoot(), saaVersion: app.getVersion?.() ?? '', log: console });
        store.load();
    }
    return store;
}

function getIndex() {
    if (!index) {
        index = createLibraryIndex({ cacheFile: path.join(settingsRoot(), 'library', 'index.json'), log: console });
        index.load();
    }
    return index;
}

export function libraryFavorites() {
    return getStore().list();
}

export function librarySetFavorite(file, on) {
    return getStore().setFavorite(file, on === true);
}

/** Opens the file manager on the image; false when there is no such file. */
export function libraryShowInFolder(file) {
    const target = String(file ?? '');
    if (!target || !path.isAbsolute(target) || !fs.existsSync(target)) return false;
    shell.showItemInFolder(target);
    return true;
}

function existingDir(dir) {
    try { return dir && fs.statSync(dir).isDirectory() ? dir : ''; } catch { return ''; }
}

/**
 * The folders the Library offers: ComfyUI's output (asked of the ComfyUI on this machine,
 * remembered for when it is not running) and the pod transport's save folder.
 */
export async function libraryRoots() {
    const settings = getGlobalSettings();
    const roots = [];
    let comfy = existingDir(await comfyOutputDir(String(settings.api_addr ?? ''), '').catch(() => ''));
    if (comfy) getStore().setValue('comfyOutputDir', comfy);
    else comfy = existingDir(getStore().getValue('comfyOutputDir'));
    if (comfy) roots.push({ id: 'comfy', label: 'ComfyUI output', dir: comfy, flat: false });
    const pod = existingDir(String(settings.pod_image_save_dir ?? '').trim() || path.join(app.getPath('pictures'), 'SAA'));
    if (pod && pod !== comfy) roots.push({ id: 'pod', label: 'Pod saves', dir: pod, flat: true });
    for (const root of roots) root.folders = await getIndex().folders(root.dir, { flat: root.flat });
    return roots;
}

async function rootById(id) {
    return (await libraryRoots()).find(root => root.id === id) ?? null;
}

const newestFirst = (a, b) => (b.created || '').localeCompare(a.created || '') || b.mtime - a.mtime;

/**
 * Images for the Library: `{ root, folder }` (one folder), `{ view: 'all' | 'favorites' }`,
 * or `{ paths }` (this session's images). Newest first.
 */
export async function libraryImages(query = {}) {
    const libraryIndex = getIndex();
    let entries = [];
    if (Array.isArray(query.paths)) {
        entries = await libraryIndex.some(query.paths.filter(file => typeof file === 'string' && path.isAbsolute(file)));
    } else if (query.view === 'favorites') {
        entries = await libraryIndex.some(getStore().list());
    } else if (query.view === 'all') {
        const roots = await libraryRoots();
        entries = await libraryIndex.all(roots);
    } else if (query.root) {
        const root = await rootById(query.root);
        if (root) entries = await libraryIndex.images(root.dir, String(query.folder ?? '.'));
    }
    return entries.sort(newestFirst);
}

async function thumbnailFor(entry) {
    const dir = path.join(settingsRoot(), 'library', 'thumbs');
    const file = path.join(dir, `${thumbnailKey(entry, THUMB_WIDTH)}.jpg`);
    try {
        return `data:image/jpeg;base64,${(await fs.promises.readFile(file)).toString('base64')}`;
    } catch { /* not made yet */ }
    const image = nativeImage.createFromPath(entry.path);
    if (image.isEmpty()) return '';
    const size = image.getSize();
    const jpeg = (size.width > THUMB_WIDTH ? image.resize({ width: THUMB_WIDTH, quality: 'good' }) : image).toJPEG(78);
    try {
        await fs.promises.mkdir(dir, { recursive: true });
        await fs.promises.writeFile(file, jpeg);
    } catch (error) {
        console.warn(CAT, 'thumbnail not cached:', error?.message ?? error);
    }
    return `data:image/jpeg;base64,${jpeg.toString('base64')}`;
}

/** The images made with a LoRA (its label): { total, recent } - the five newest paths. */
export async function libraryLoraUses(label) {
    const name = String(label ?? '');
    if (!name) return { total: 0, recent: [] };
    const entries = (await getIndex().all(await libraryRoots())).filter(entry => entry.loras.includes(name)).sort(newestFirst);
    return { total: entries.length, recent: entries.slice(0, 5).map(entry => entry.path) };
}

/** Thumbnails of the given images: { path: dataUrl }. */
export async function libraryThumbs(paths = []) {
    const result = {};
    for (const file of Array.isArray(paths) ? paths : []) {
        const entry = await getIndex().entryFor(file);
        if (entry) result[file] = await thumbnailFor(entry).catch(() => '');
    }
    return result;
}

/** One image whole, with its records: { dataUrl, records: { recipe, timing, parameters } }. */
export async function libraryImage(file) {
    const target = String(file ?? '');
    if (!path.isAbsolute(target)) return null;
    let data;
    try { data = await fs.promises.readFile(target); } catch { return null; }
    const extension = path.extname(target).slice(1).toLowerCase();
    const mime = extension === 'jpg' || extension === 'jpeg' ? 'image/jpeg' : extension === 'webp' ? 'image/webp' : 'image/png';
    const { records } = readTextChunks(data, { inflate: zlib.inflateSync });
    return {
        dataUrl: `data:${mime};base64,${data.toString('base64')}`,
        records: { recipe: records.saa_recipe ?? null, timing: records.saa_time ?? null, parameters: records.parameters ?? '' },
    };
}

/** Moves an image to the system trash; its star goes with it. */
export async function libraryTrash(file) {
    const target = String(file ?? '');
    if (!target || !path.isAbsolute(target) || !fs.existsSync(target)) return false;
    await shell.trashItem(target);
    getIndex().forget(target);
    if (getStore().isFavorite(target)) getStore().setFavorite(target, false);
    return true;
}

export function setupLibraryBackend() {
    ipcMain.handle('library-favorites', async () => libraryFavorites());
    ipcMain.handle('library-set-favorite', async (event, file, on) => librarySetFavorite(file, on));
    ipcMain.handle('library-show-in-folder', async (event, file) => libraryShowInFolder(file));
    ipcMain.handle('library-roots', async () => {
        // the Library opens on what ComfyUI says now (it may have been restarted elsewhere)
        forgetComfyOutputDirs();
        return libraryRoots();
    });
    ipcMain.handle('library-images', async (event, query) => libraryImages(query));
    ipcMain.handle('library-thumbs', async (event, paths) => libraryThumbs(paths));
    ipcMain.handle('library-image', async (event, file) => libraryImage(file));
    ipcMain.handle('library-trash', async (event, file) => libraryTrash(file));
    ipcMain.handle('library-lora-uses', async (event, label) => libraryLoraUses(label));
    return true;
}
