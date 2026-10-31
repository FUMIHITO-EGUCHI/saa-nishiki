// Main-process side of the LoRA catalog: the LoRA list with each file's own facts (read
// from its .safetensors header, scripts/main/loraCatalog.js), the user's choices
// (settings/loras.json), the sample grid images, and the Civitai lookup the user asks
// for by hand (the file's sha256, sent to Civitai's by-hash endpoint).
import { app, ipcMain } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { createLoraCatalog, civitaiFacts, sha256File } from './loraCatalog.js';
import { getGlobalSettings } from './globalSettings.js';
import { getExtraModels, collectRelativePaths, getLoRAList, getLoRAListSource } from './modelList.js';
import { resolveSettingsRoot } from './settingsRoot.js';
import { tagLookup } from './tagAutoComplete_backend.js';
import { LORA_CATEGORIES, loraView, tagKey } from '../shared/loraCatalog.js';

const CAT = '[LoraBackend]';
const appPath = app.isPackaged ? path.join(path.dirname(app.getPath('exe')), 'resources', 'app') : app.getAppPath();

let catalog = null;

function getCatalog() {
    if (!catalog) {
        catalog = createLoraCatalog({ rootDir: resolveSettingsRoot(appPath), saaVersion: app.getVersion?.() ?? '', log: console });
        catalog.load();
    }
    return catalog;
}

// Where a listed LoRA is on this disk (the folder beside the checkpoints, or the extra
// model paths), as fileHandlers.readSafetensors finds it; '' for a list that is the pod's.
function loraPath(name) {
    if (getLoRAListSource() !== 'local') return '';
    const settings = getGlobalSettings();
    const base = String(settings.model_path_comfyui ?? '');
    const direct = base ? path.join(path.dirname(base), 'loras', name) : '';
    if (direct && fs.existsSync(direct)) return direct;
    const extra = getExtraModels();
    const root = extra?.yamlContent?.a111?.base_path;
    if (extra?.exist && root) {
        for (const relative of collectRelativePaths('loras')) {
            const candidate = path.join(root, relative, name);
            if (fs.existsSync(candidate)) return candidate;
        }
    }
    return '';
}

function listedLoras() {
    return (getLoRAList('ComfyUI') ?? []).filter(name => typeof name === 'string' && name && name !== 'None');
}

// The tag dictionary's post counts for the caption words (its keys use underscores)
function knownTags(facts) {
    const words = [...new Set(facts.flatMap(entry => entry.frequency.map(([tag]) => tag)))];
    if (words.length === 0) return null;
    const known = new Map();
    for (let index = 0; index < words.length; index += 2000) {
        const slice = words.slice(index, index + 2000);
        const answer = tagLookup(slice.map(word => word.replaceAll(' ', '_')));
        if (!answer.loaded) return null;
        for (const [key, heat] of Object.entries(answer.heat)) known.set(tagKey(key), heat);
    }
    return known;
}

/** Every listed LoRA as the renderer shows it: { loras, defaults, samplePrompt, categories }. */
export async function loraCatalogView() {
    const store = getCatalog();
    const names = listedLoras();
    const facts = await store.facts(names.map(name => ({ name, path: loraPath(name) })));
    const known = knownTags(facts);
    const doc = store.get();
    return {
        loras: facts.map(file => loraView(file, doc.loras[file.name] ?? {}, { defaults: doc.defaults, known })),
        defaults: doc.defaults,
        // the sample prompt every LoRA without its own shares; null = the built-in one
        samplePrompt: doc.samplePrompt ?? null,
        categories: LORA_CATEGORIES,
    };
}

export async function loraApply(change) {
    if (!getCatalog().apply(change)) return null;
    return loraCatalogView();
}

export async function loraAddSample(name, meta, dataUrl) {
    const text = String(dataUrl ?? '');
    if (!text.startsWith('data:image/png;base64,')) return null;
    const png = Buffer.from(text.slice(text.indexOf(',') + 1), 'base64');
    if (png.length === 0) return null;
    getCatalog().addSample(String(name), meta ?? {}, png);
    return loraCatalogView();
}

export function loraSampleImage(name, sampleId) {
    const png = getCatalog().readSample(String(name), String(sampleId));
    return png ? `data:image/png;base64,${png.toString('base64')}` : null;
}

/**
 * Asks Civitai about a LoRA by its file's hash. Its trigger words fill the catalog's when
 * the user has not chosen any; a weight range it names replaces the default one (never
 * the user's own). Returns { ok, facts } or { ok: false, message }.
 */
export async function loraCivitai(name) {
    const store = getCatalog();
    const file = loraPath(String(name));
    if (!file) return { ok: false, message: 'The LoRA file is not on this machine.' };
    const stored = store.get().loras[name] ?? {};
    let sha256 = stored.sha256;
    if (!sha256) {
        sha256 = await sha256File(file);
        store.apply({ action: 'set', name, patch: { sha256 } });
    }
    const settings = getGlobalSettings();
    const token = String(settings.api_pod_civitai_token ?? '').trim();
    let response;
    try {
        response = await fetch(`https://civitai.com/api/v1/model-versions/by-hash/${sha256}`, {
            headers: token ? { Authorization: `Bearer ${token}` } : {},
            signal: AbortSignal.timeout(15000),
        });
    } catch (error) {
        return { ok: false, message: `Civitai did not answer: ${error?.message ?? error}` };
    }
    if (response.status === 404) return { ok: false, message: 'Civitai does not know this file.' };
    if (!response.ok) return { ok: false, message: `Civitai answered ${response.status}.` };
    const facts = civitaiFacts(await response.json());
    if (!facts) return { ok: false, message: 'Civitai sent no model.' };
    const patch = { civitai: facts };
    if (!stored.triggers && facts.triggers.length) patch.triggers = facts.triggers;
    if (facts.range && stored.range?.src !== 'custom') patch.range = facts.range;
    store.apply({ action: 'set', name, patch });
    console.log(CAT, `Civitai: ${name} is ${facts.name}`);
    return { ok: true, facts, catalog: await loraCatalogView() };
}

export function setupLoraBackend() {
    ipcMain.handle('lora-catalog', async () => loraCatalogView());
    ipcMain.handle('lora-apply', async (event, change) => loraApply(change));
    ipcMain.handle('lora-add-sample', async (event, name, meta, dataUrl) => loraAddSample(name, meta, dataUrl));
    ipcMain.handle('lora-sample-image', async (event, name, sampleId) => loraSampleImage(name, sampleId));
    ipcMain.handle('lora-civitai', async (event, name) => loraCivitai(name));
    return true;
}
