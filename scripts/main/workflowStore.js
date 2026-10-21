import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { writeJsonAtomic, readJsonWithFallback } from './settingsStore.js';

const ID = /^[a-f0-9-]{36}$/;
const ASSET = /^[a-zA-Z0-9_-]+\.png$/;
export function createWorkflowStore(root) {
    const file = (kind, id, name) => {
        if (!['runs', 'projects'].includes(kind) || !ID.test(id) || !/^(record\.json|[a-zA-Z0-9_-]+\.png)$/.test(name)) throw new Error('Invalid workflow record reference');
        return path.join(root, kind, id, name);
    };
    const read = (kind, id) => {
        const value = readJsonWithFallback(file(kind, id, 'record.json')).value;
        if (!value || value.schema !== 1 || value.id !== id) throw new Error('Workflow record not found');
        return value;
    };
    const write = (kind, record) => { writeJsonAtomic(file(kind, record.id, 'record.json'), record); return record; };
    return {
        root, read, write,
        recoverInterrupted() {
            for (const kind of ['runs','projects']) {
                const folder=path.join(root,kind);
                if(!fs.existsSync(folder))continue;
                for(const id of fs.readdirSync(folder).filter(id=>ID.test(id))) {
                    let record;try{record=read(kind,id);}catch{continue;}
                    let changed=false;
                    for(const item of kind==='runs'?[record]:record.attempts??[]) {
                        if(!['preparing','submitting','running'].includes(item.status))continue;
                        item.status='interrupted';item.error='App stopped before completion was recorded; remote execution state is unknown';changed=true;
                    }
                    if(changed)write(kind,record);
                }
            }
        },
        create(kind, data) { return write(kind, { ...data, schema: 1, id: randomUUID(), createdAt: new Date().toISOString() }); },
        list(kind, limit = 100) {
            if (!['runs', 'projects'].includes(kind)) throw new Error('Invalid record kind');
            const folder = path.join(root, kind);
            if (!fs.existsSync(folder)) return [];
            return fs.readdirSync(folder).filter(id => ID.test(id)).map(id => {
                try { return read(kind, id); } catch { return null; }
            }).filter(Boolean).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, Math.min(100, limit));
        },
        putImage(kind, id, name, bytes) {
            if (!ASSET.test(name) || !Buffer.isBuffer(bytes)) throw new Error('Invalid image asset');
            read(kind, id);
            fs.writeFileSync(file(kind, id, name), bytes, { flag: 'wx' });
            return name;
        },
        image(kind, id, name) {
            if (!ASSET.test(name)) throw new Error('Invalid image asset');
            read(kind, id);
            return fs.readFileSync(file(kind, id, name));
        },
        preferences(patch) {
            const location = path.join(root, 'preferences.json');
            const value = readJsonWithFallback(location).value ?? { captureStages: false };
            if (patch) {
                if (typeof patch.captureStages !== 'boolean') throw new Error('captureStages must be boolean');
                value.captureStages = patch.captureStages;
                writeJsonAtomic(location, value);
            }
            return { captureStages: value.captureStages === true };
        },
    };
}
