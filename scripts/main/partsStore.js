// On-disk store for the Parts (scripts/shared/parts.js): settings/parts.json holds the
// entries, settings/parts/<part folder>/<sample id>.png the sample images. Node fs only —
// no Electron — so it is unit-testable. Same atomic-write / .bak discipline as the
// settings and user-list stores.
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { readJsonWithFallback, writeJsonAtomic } from './settingsStore.js';
import { PARTS_SCHEMA, PARTS_SECTION, applyPartsChange, normalizePartsDoc, partFolderName, partId } from '../shared/parts.js';

const CAT = '[PartsStore]';
const FILE_NAME = 'parts.json';
const IMAGE_DIR = 'parts';

export function createPartsStore({ rootDir, saaVersion = '', now = () => new Date(), log = console, fsImpl = fs } = {}) {
    if (!rootDir) throw new Error('createPartsStore: rootDir is required');
    const file = path.join(rootDir, FILE_NAME);
    const imageRoot = path.join(rootDir, IMAGE_DIR);
    const warn = message => log?.warn?.(CAT, message);
    const stamp = () => {
        const value = now();
        return value instanceof Date ? value.toISOString() : String(value);
    };

    let doc = null;

    function load() {
        const { value, source, error } = readJsonWithFallback(file, fsImpl);
        if (error) warn(`${FILE_NAME}: ${error.message}${source ? ` (using ${source})` : ''}`);
        const data = value && typeof value === 'object' && value.section === PARTS_SECTION ? value.data : null;
        doc = normalizePartsDoc(data);
        return doc;
    }

    function get() {
        if (!doc) load();
        return doc;
    }

    function save(nextDoc) {
        doc = normalizePartsDoc(nextDoc);
        writeJsonAtomic(file, { schema: PARTS_SCHEMA, section: PARTS_SECTION, saa_version: saaVersion, saved_at: stamp(), data: doc }, fsImpl);
        return doc;
    }

    /** Apply one change (scripts/shared/parts.js applyPartsChange) and persist; null when refused. */
    function apply(change) {
        const next = applyPartsChange(get(), change, stamp);
        if (!next) {
            warn(`apply refused: action=${change?.action} id=${JSON.stringify(change?.id ?? change?.entry?.name ?? null)}`);
            return null;
        }
        // a removed part (or a removed sample) takes its image files with it
        if (change.action === 'remove') removeFolder(partId(change.id));
        if (change.action === 'remove-sample') {
            const sample = get().parts[partId(change.id)]?.samples.find(item => item.id === change.sampleId);
            if (sample) removeFile(sampleFile(partId(change.id), sample));
        }
        // a renamed part keeps its folder: the sample paths are stored relative to it
        if (change.action === 'set' && change.id && partId(change.id) !== partId(change.entry?.name)) {
            const from = path.join(imageRoot, partFolderName(change.id));
            const to = path.join(imageRoot, partFolderName(change.entry.name));
            try {
                if (fsImpl.existsSync(from) && !fsImpl.existsSync(to)) fsImpl.renameSync(from, to);
            } catch (error) {
                warn(`rename ${from} → ${to}: ${error.message}`);
            }
        }
        return save(next);
    }

    function sampleFile(id, sample) {
        return path.join(imageRoot, partFolderName(id), sample.file);
    }

    function removeFile(target) {
        try { fsImpl.rmSync(target, { force: true }); } catch (error) { warn(`rm ${target}: ${error.message}`); }
    }

    function removeFolder(id) {
        const folder = path.join(imageRoot, partFolderName(id));
        try { fsImpl.rmSync(folder, { recursive: true, force: true }); } catch (error) { warn(`rm ${folder}: ${error.message}`); }
    }

    /**
     * Write one sample image and record it on the part. `png` is a Buffer; `meta` is the
     * sample's description (modelType, model, base, character, seed, width, height,
     * promptVersion). Answers the new document, or null when the part does not exist.
     */
    function addSample(id, meta, png) {
        const key = partId(id);
        if (!get().parts[key]) return null;
        const sampleId = `${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`;
        const folder = path.join(imageRoot, partFolderName(key));
        fsImpl.mkdirSync(folder, { recursive: true });
        const fileName = `${sampleId}.png`;
        fsImpl.writeFileSync(path.join(folder, fileName), png);
        const next = applyPartsChange(get(), { action: 'add-sample', id: key, sample: { ...meta, id: sampleId, file: fileName } }, stamp);
        if (!next) {
            removeFile(path.join(folder, fileName));
            return null;
        }
        return save(next);
    }

    /** The PNG of one sample as a Buffer, or null. */
    function readSample(id, sampleId) {
        const key = partId(id);
        const sample = get().parts[key]?.samples.find(item => item.id === sampleId);
        if (!sample) return null;
        try {
            return fsImpl.readFileSync(sampleFile(key, sample));
        } catch (error) {
            warn(`read sample ${key}/${sampleId}: ${error.message}`);
            return null;
        }
    }

    function reset() {
        return save({ parts: {} });
    }

    return { file, imageRoot, load, get, save, apply, addSample, readSample, reset };
}
