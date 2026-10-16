// What the viewer's Info tab and the Library's detail panel say about one image, built
// from what is known of it: its recipe (full), else the A1111 "parameters" text every
// saver writes (partial), and the generation time when the run was timed.
//
// Pure: names and numbers only; the renderer turns them into rows.

import { parseParameters, parseRecipe, recipeLoras, recipeModel, recipeSize } from './recipe.js';
import { parseRunTiming } from './runTiming.js';

/** "anima-turbo-lora-v0.2.safetensors" → "anima-turbo-lora-v0.2" (any folder dropped too). */
export function modelLabel(name) {
    const base = String(name ?? '').split(/[\\/]/).pop() ?? '';
    return base.replace(/\.(safetensors|ckpt|pt|pth|bin|gguf|sft)$/i, '');
}

/** "bbox/face_yolov8m.pt" → "face" */
export function detailerLabel(name) {
    return modelLabel(name).replace(/_yolo.*$/i, '').replace(/[_-]+$/, '');
}

function finite(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
}

/**
 * The summary of an image from its records: `recipe` and `timing` (parsed objects or the
 * chunk texts), `parameters` (the A1111 text), `path` and `seed` as the caller knows them.
 */
export function summarizeImage({ recipe = null, timing = null, parameters = '', path = '', seed = null } = {}) {
    const full = parseRecipe(recipe);
    const time = parseRunTiming(timing);
    if (full) {
        const model = recipeModel(full);
        const size = recipeSize(full);
        const sent = model.sent ?? null;
        const steps = sent?.steps ?? model.steps;
        const cfg = sent?.cfg ?? model.cfg;
        const loras = recipeLoras(full)
            .filter(row => row.stage !== 'OFF')
            .map(row => ({ name: modelLabel(row.name), file: row.name, weight: row.model, stage: row.stage, fast: false }));
        if (sent?.fast?.lora) loras.push({ name: modelLabel(sent.fast.lora), file: sent.fast.lora, weight: sent.fast.strength, stage: 'Fast', fast: true });
        return {
            state: 'full',
            version: full.v,
            path: String(path ?? ''),
            created: String(full.created ?? ''),
            type: model.type,
            model: modelLabel(model.model),
            sampler: sent?.sampler || model.sampler,
            scheduler: sent?.scheduler || model.scheduler,
            steps,
            cfg,
            // what the editor asked for, when Fast mode sent something else
            asked: sent?.fast && (sent.steps !== model.steps || sent.cfg !== model.cfg) ? { steps: model.steps, cfg: model.cfg } : null,
            fast: sent?.fast ? { lora: modelLabel(sent.fast.lora), strength: sent.fast.strength } : null,
            seed: full.run.seed ?? finite(seed),
            width: size.width,
            height: size.height,
            hires: size.hires,
            detailers: size.detailers.map(detailerLabel),
            loras,
            characters: full.run.names ? full.run.names.split('\n').filter(Boolean) : [],
            prose: full.run.prose?.applied ? full.run.prose.paragraph : '',
            time,
        };
    }
    const parsed = parseParameters(parameters);
    if (parsed) {
        return {
            state: 'partial',
            version: 0,
            path: String(path ?? ''),
            created: '',
            type: '',
            model: modelLabel(parsed.model),
            sampler: parsed.sampler,
            scheduler: parsed.scheduler,
            steps: parsed.steps,
            cfg: parsed.cfg,
            asked: null,
            fast: null,
            seed: parsed.seed ?? finite(seed),
            width: parsed.width,
            height: parsed.height,
            hires: null,
            detailers: [],
            loras: parsed.loras.map(row => ({ name: modelLabel(row.name), file: row.name, weight: row.model, stage: 'ALL', fast: false })),
            characters: [],
            prose: '',
            time,
        };
    }
    return {
        state: 'none', version: 0, path: String(path ?? ''), created: '', type: '', model: '', sampler: '', scheduler: '',
        steps: null, cfg: null, asked: null, fast: null, seed: finite(seed), width: null, height: null, hires: null,
        detailers: [], loras: [], characters: [], prose: '', time,
    };
}
