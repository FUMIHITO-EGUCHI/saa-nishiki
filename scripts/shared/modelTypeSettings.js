// Generation settings remembered per model type (pure, shared by the renderer and
// tests). A checkpoint (Illustrious) and a diffusion model (Anima) want different
// samplers, steps, CFG and sizes: switching the type stores the current values
// under the type being left and brings back the ones stored for the type entered.
// The store lives in the `model_type_generation` setting: { Checkpoint: {...}, Diffusion: {...} }.

export const MODEL_TYPES = Object.freeze(['Checkpoint', 'Diffusion']);

export const GENERATION_KEYS = Object.freeze([
    'api_model_sampler', 'api_model_scheduler', 'step', 'cfg', 'width', 'height', 'api_image_landscape',
    'api_hf_enable', 'api_hf_scale', 'api_hf_denoise', 'api_hf_steps', 'api_hf_upscaler_selected',
    // Regional is a checkpoint feature: it comes back on when the checkpoint comes back
    'regional_condition',
]);

// What a Diffusion (Anima) model starts with when nothing was stored for it yet
// (the run bar's "Anima defaults"); the orientation follows the current size.
export const ANIMA_DEFAULTS = Object.freeze({
    api_model_sampler: 'er_sde', api_model_scheduler: 'simple', step: 30, cfg: 4.5,
});

export function snapshotGeneration(settings = {}) {
    const snapshot = {};
    for (const key of GENERATION_KEYS) {
        if (Object.hasOwn(settings, key)) snapshot[key] = settings[key];
    }
    return snapshot;
}

function isType(value) {
    return MODEL_TYPES.includes(value);
}

// The store with `type`'s entry replaced by a snapshot of `settings`.
export function rememberGeneration(store, type, settings = {}) {
    const next = store && typeof store === 'object' ? { ...store } : {};
    if (isType(type)) next[type] = snapshotGeneration(settings);
    return next;
}

// The values to apply when entering `type`: the stored entry, else for Diffusion
// the Anima defaults with the current size turned to 1216 × 832 (orientation kept),
// else nothing (the current values stay).
export function generationFor(store, type, settings = {}) {
    const stored = store && typeof store === 'object' && isType(type) ? store[type] : null;
    if (stored && typeof stored === 'object') {
        const values = {};
        for (const key of GENERATION_KEYS) {
            if (Object.hasOwn(stored, key)) values[key] = stored[key];
        }
        return values;
    }
    if (type === 'Diffusion') {
        const landscape = Number(settings.width) >= Number(settings.height);
        return { ...ANIMA_DEFAULTS, width: landscape ? 1216 : 832, height: landscape ? 832 : 1216 };
    }
    return {};
}
