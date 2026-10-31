// On-disk side of the LoRA catalog (scripts/shared/loraCatalog.js): settings/loras.json
// holds what the user set per LoRA, settings/loras/<folder>/<sample>.png the sample grid
// images. The files' own facts (base model, dim, the caption tags) are read from each
// .safetensors header - the 8-byte length and the JSON after it, never the weights - and
// kept by path, size and modified time in settings/library/lora-meta.json.
//
// Node fs only (no Electron), so it is unit-testable.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { readJsonWithFallback, writeJsonAtomic } from './settingsStore.js';
import { LORA_SCHEMA, LORA_SECTION, applyLoraChange, loraBase, loraLabel, normalizeLoraDoc, tagFrequency } from '../shared/loraCatalog.js';

const CAT = '[LoraCatalog]';
const FILE_NAME = 'loras.json';
const SAMPLE_DIR = 'loras';
const META_VERSION = 1;
const MAX_HEADER = 64 * 1024 * 1024;

/** The __metadata__ of a .safetensors file, read from its header alone; {} when it has none. */
export async function readSafetensorsMetadata(file, { fsImpl = fs } = {}) {
    const handle = await fsImpl.promises.open(file, 'r');
    try {
        const head = Buffer.alloc(8);
        await handle.read(head, 0, 8, 0);
        const length = Number(head.readBigUInt64LE(0));
        if (!Number.isFinite(length) || length <= 0 || length > MAX_HEADER) return {};
        const json = Buffer.alloc(length);
        await handle.read(json, 0, length, 8);
        const parsed = JSON.parse(json.toString('utf8'));
        return parsed?.__metadata__ && typeof parsed.__metadata__ === 'object' ? parsed.__metadata__ : {};
    } finally {
        await handle.close();
    }
}

/** What the catalog keeps of a file's metadata (the tag counts, not the whole header). */
export function fileFacts(name, metadata = {}, stat = null) {
    const number = value => (Number.isFinite(Number(value)) ? Number(value) : null);
    return {
        name,
        base: loraBase(metadata, name),
        dim: number(metadata.ss_network_dim),
        alpha: number(metadata.ss_network_alpha),
        images: number(metadata.ss_num_train_images),
        frequency: tagFrequency(metadata.ss_tag_frequency).slice(0, 60),
        size: stat?.size ?? null,
        mtime: stat ? Math.round(stat.mtimeMs) : null,
    };
}

/** A folder name for a LoRA's samples: "subdir\\CharTurnIL.safetensors" → "charturnil-3fa9c1d2". */
export function sampleFolderName(name) {
    const slug = loraLabel(name).toLowerCase().replaceAll(/[^a-z0-9]+/g, '-').replaceAll(/^-+|-+$/g, '').slice(0, 48) || 'lora';
    const hash = crypto.createHash('sha1').update(String(name)).digest('hex').slice(0, 8);
    return `${slug}-${hash}`;
}

export function createLoraCatalog({ rootDir, saaVersion = '', now = () => new Date(), log = console, fsImpl = fs, readMetadata = file => readSafetensorsMetadata(file, { fsImpl }) } = {}) {
    if (!rootDir) throw new Error('createLoraCatalog: rootDir is required');
    const file = path.join(rootDir, FILE_NAME);
    const metaFile = path.join(rootDir, 'library', 'lora-meta.json');
    const sampleRoot = path.join(rootDir, SAMPLE_DIR);
    const stamp = () => {
        const value = now();
        return value instanceof Date ? value.toISOString() : String(value);
    };
    let doc = null;
    let meta = null;   // path -> { size, mtime, facts }
    let metaDirty = false;

    function load() {
        const { value, source, error } = readJsonWithFallback(file, fsImpl);
        if (error) log?.warn?.(CAT, `${FILE_NAME}: ${error.message}${source ? ` (using ${source})` : ''}`);
        doc = normalizeLoraDoc(value && typeof value === 'object' && value.section === LORA_SECTION ? value.data : null);
        return doc;
    }

    function get() {
        if (!doc) load();
        return doc;
    }

    function save(next) {
        doc = normalizeLoraDoc(next);
        writeJsonAtomic(file, { schema: LORA_SCHEMA, section: LORA_SECTION, saa_version: saaVersion, saved_at: stamp(), data: doc }, fsImpl);
        return doc;
    }

    function apply(change) {
        const next = applyLoraChange(get(), change);
        if (!next) return null;
        return save(next);
    }

    function loadMeta() {
        meta = new Map();
        try {
            const data = JSON.parse(fsImpl.readFileSync(metaFile, 'utf8'));
            if (data?.v === META_VERSION && Array.isArray(data.files)) for (const entry of data.files) if (entry?.path) meta.set(entry.path, entry);
        } catch { /* read again from the files */ }
    }

    function saveMeta() {
        if (!metaDirty) return;
        metaDirty = false;
        try {
            fsImpl.mkdirSync(path.dirname(metaFile), { recursive: true });
            fsImpl.writeFileSync(metaFile, JSON.stringify({ v: META_VERSION, files: [...meta.values()] }));
        } catch (error) {
            log?.warn?.(CAT, 'metadata cache not saved:', error?.message ?? error);
        }
    }

    /**
     * The facts of each LoRA: `files` is [{ name, path }] (the LoRA list with each file
     * found on disk; path '' for one that is not, a pod's say). Read once per file change.
     */
    async function facts(files) {
        if (!meta) loadMeta();
        const result = [];
        for (const { name, path: target } of files) {
            if (!target) {
                result.push(fileFacts(name, {}, null));
                continue;
            }
            let stat;
            try { stat = await fsImpl.promises.stat(target); } catch { result.push(fileFacts(name, {}, null)); continue; }
            const known = meta.get(target);
            if (known && known.size === stat.size && known.mtime === Math.round(stat.mtimeMs)) {
                result.push({ ...known.facts, name });
                continue;
            }
            let metadata = {};
            try { metadata = await readMetadata(target); } catch (error) { log?.warn?.(CAT, 'unreadable header', target, error?.message ?? error); }
            const entry = fileFacts(name, metadata, stat);
            meta.set(target, { path: target, size: stat.size, mtime: Math.round(stat.mtimeMs), facts: entry });
            metaDirty = true;
            result.push(entry);
        }
        saveMeta();
        return result;
    }

    /** Stores a sample image (PNG bytes) of `name` at `weight`; returns the document. */
    function addSample(name, sampleMeta, png) {
        const folder = path.join(sampleRoot, sampleFolderName(name));
        fsImpl.mkdirSync(folder, { recursive: true });
        const id = `${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
        const fileName = `${id}.png`;
        fsImpl.writeFileSync(path.join(folder, fileName), png);
        // the image this one replaces (same weight, same model) goes from the disk too
        const before = get().loras[name]?.samples ?? [];
        const weight = Number(sampleMeta.weight);
        for (const old of before) {
            if (old.weight === weight && old.model === String(sampleMeta.model ?? '')) {
                try { fsImpl.rmSync(path.join(folder, old.file), { force: true }); } catch { /* already gone */ }
            }
        }
        return apply({ action: 'add-sample', name, sample: { ...sampleMeta, id, file: fileName, created: stamp() } });
    }

    function readSample(name, sampleId) {
        const sample = (get().loras[name]?.samples ?? []).find(entry => entry.id === sampleId);
        if (!sample) return null;
        try { return fsImpl.readFileSync(path.join(sampleRoot, sampleFolderName(name), sample.file)); } catch { return null; }
    }

    return { file, load, get, apply, facts, addSample, readSample, sampleRoot };
}

/** The sha256 of a file, streamed (a LoRA is hundreds of megabytes). */
export function sha256File(file, { fsImpl = fs } = {}) {
    return new Promise((resolve, reject) => {
        const hash = crypto.createHash('sha256');
        fsImpl.createReadStream(file).on('data', chunk => hash.update(chunk)).on('end', () => resolve(hash.digest('hex'))).on('error', reject);
    });
}

/**
 * What Civitai says of a model version found by its file hash: the trigger words, the
 * base model, the page, and a weight range when the version names one.
 */
export function civitaiFacts(version) {
    if (!version || typeof version !== 'object' || !version.modelId) return null;
    const number = value => (Number.isFinite(Number(value)) ? Number(value) : null);
    const settings = version.settings ?? version.recommendedSettings ?? {};
    const min = number(settings.minStrength ?? settings.strengthMin);
    const max = number(settings.maxStrength ?? settings.strengthMax);
    const strength = number(settings.strength ?? settings.weight);
    return {
        modelId: number(version.modelId),
        versionId: number(version.id),
        name: String(version.model?.name ?? version.name ?? ''),
        baseModel: String(version.baseModel ?? ''),
        url: `https://civitai.com/models/${version.modelId}${version.id ? `?modelVersionId=${version.id}` : ''}`,
        triggers: (Array.isArray(version.trainedWords) ? version.trainedWords : []).flatMap(words => String(words).split(',')).map(word => word.trim()).filter(Boolean),
        range: min !== null && max !== null && max > min ? { min, max, def: strength ?? (min + max) / 2, src: 'Civitai' } : null,
    };
}
