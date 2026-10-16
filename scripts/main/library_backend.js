// Main-process side of the viewer's and the Library's file work: the stars
// (settings/library.json) and showing an image in the file manager. The images
// themselves stay where ComfyUI or the pod transport saved them.
import { app, ipcMain, shell } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { createLibraryStore } from './libraryStore.js';
import { resolveSettingsRoot } from './settingsRoot.js';

const appPath = app.isPackaged ? path.join(path.dirname(app.getPath('exe')), 'resources', 'app') : app.getAppPath();

let store = null;

function getStore() {
    if (!store) {
        store = createLibraryStore({ rootDir: resolveSettingsRoot(appPath), saaVersion: app.getVersion?.() ?? '', log: console });
        store.load();
    }
    return store;
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

export function setupLibraryBackend() {
    ipcMain.handle('library-favorites', async () => libraryFavorites());
    ipcMain.handle('library-set-favorite', async (event, file, on) => librarySetFavorite(file, on));
    ipcMain.handle('library-show-in-folder', async (event, file) => libraryShowInFolder(file));
    return true;
}
