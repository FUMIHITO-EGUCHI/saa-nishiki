import { app, ipcMain } from 'electron';
import path from 'node:path';
import { resolveSettingsRoot } from './settingsRoot.js';
import { createWorkflowStore } from './workflowStore.js';
import { startWorkflowExecution } from './workflowExecution.js';
import { withStagePreviews } from '../shared/workflowRecord.js';

let store;
export function getWorkflowStore() {
    if (!store) {
        const appPath = app.isPackaged ? path.join(path.dirname(app.getPath('exe')), 'resources', 'app') : app.getAppPath();
        store = createWorkflowStore(path.join(resolveSettingsRoot(appPath), 'workflows'));
    }
    return store;
}
export function executeRecordedWorkflow(options) {
    const storage = getWorkflowStore();
    const diagnostics = storage.preferences().captureStages ? withStagePreviews(options.workflow, options.outputNode) : { workflow: options.workflow, stages: [] };
    return startWorkflowExecution({ ...options, ...diagnostics, store: storage });
}
export function setupWorkflowRecords() {
    ipcMain.handle('workflow-list-runs', () => getWorkflowStore().list('runs').map(({ id, createdAt, status, requested, error }) => ({ id, createdAt, status, requested, error })));
    ipcMain.handle('workflow-read-run', (_, id) => getWorkflowStore().read('runs', id));
    ipcMain.handle('workflow-image', (_, kind, id, name) => `data:image/png;base64,${getWorkflowStore().image(kind, id, name).toString('base64')}`);
    ipcMain.handle('workflow-preferences', (_, patch) => getWorkflowStore().preferences(patch));
}
