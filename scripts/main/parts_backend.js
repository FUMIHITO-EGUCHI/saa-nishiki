// Main-process side of the Parts: the store (settings/parts.json + sample PNGs) behind
// the renderer's IPC calls and the web-service API (wsService.js). A sample image
// travels as a data URL both ways: the renderer receives one from ComfyUI and hands it
// here to be written; the picker asks for one to show a tile.
import { app, ipcMain } from 'electron';
import path from 'node:path';
import { createPartsStore } from './partsStore.js';
import { resolveSettingsRoot } from './settingsRoot.js';

const CAT = '[PartsBackend]';
const appPath = app.isPackaged ? path.join(path.dirname(app.getPath('exe')), 'resources', 'app') : app.getAppPath();

let store = null;

function getStore() {
    if (!store) {
        store = createPartsStore({ rootDir: resolveSettingsRoot(appPath), saaVersion: app.getVersion?.() ?? '', log: console });
        store.load();
        console.log(CAT, `${Object.keys(store.get().parts).length} parts loaded from ${store.file}`);
    }
    return store;
}

function pngFromDataUrl(dataUrl) {
    const text = String(dataUrl ?? '');
    const comma = text.indexOf(',');
    if (!text.startsWith('data:image/png;base64,') || comma < 0) return null;
    try {
        return Buffer.from(text.slice(comma + 1), 'base64');
    } catch {
        return null;
    }
}

export function getPartsDoc() {
    return getStore().get();
}

export function applyParts(change) {
    return getStore().apply(change);
}

export function addPartSample(id, meta, dataUrl) {
    const png = pngFromDataUrl(dataUrl);
    if (!png || png.length === 0) return null;
    return getStore().addSample(id, meta ?? {}, png);
}

export function readPartSample(id, sampleId) {
    const png = getStore().readSample(id, sampleId);
    return png ? `data:image/png;base64,${png.toString('base64')}` : null;
}

export function setupPartsBackend() {
    ipcMain.handle('parts-get', async () => getPartsDoc());
    ipcMain.handle('parts-apply', async (event, change) => applyParts(change));
    ipcMain.handle('parts-add-sample', async (event, id, meta, dataUrl) => addPartSample(id, meta, dataUrl));
    ipcMain.handle('parts-sample-image', async (event, id, sampleId) => readPartSample(id, sampleId));
    return true;
}
