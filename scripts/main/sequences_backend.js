// Main-process side of the sequence batch's store (settings/sequences.json) behind the
// renderer's IPC calls. The renderer keeps the document and sends it whole; the store
// normalizes it on the way in.
import { app, ipcMain } from 'electron';
import path from 'node:path';
import { createSequencesStore } from './sequencesStore.js';
import { resolveSettingsRoot } from './settingsRoot.js';

const CAT = '[SequencesBackend]';
const appPath = app.isPackaged ? path.join(path.dirname(app.getPath('exe')), 'resources', 'app') : app.getAppPath();

let store = null;

function getStore() {
    if (!store) {
        store = createSequencesStore({ rootDir: resolveSettingsRoot(appPath), saaVersion: app.getVersion?.() ?? '', log: console });
        store.load();
        console.log(CAT, `${Object.keys(store.get().sequences).length} sequence(s) loaded from ${store.file}`);
    }
    return store;
}

export function setupSequencesBackend() {
    ipcMain.handle('sequences-get', async () => getStore().get());
    ipcMain.handle('sequences-save', async (event, doc) => getStore().save(doc));
    return true;
}
