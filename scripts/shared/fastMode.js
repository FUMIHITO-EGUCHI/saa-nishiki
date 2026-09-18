// Fast generation mode (pure, no I/O): rewrites a ComfyUI generateData so every
// sampling pass runs with a step-distillation LoRA and the low step count / cfg /
// sampler that such LoRAs expect.
//
// One switch (api_fast_enable), two sets of values, picked by the model the run uses:
//   Checkpoint (SDXL / Illustrious)  api_fast_*       DMD2 / Hyper-SD / Lightning / LCM
//   Diffusion  (UNET / Anima)        api_fast_diff_*  Anima Turbo LoRA
// An SDXL distillation LoRA does not load on an Anima model and the Turbo LoRA does
// not load on SDXL, so each route only ever gets its own set.
//
// The LoRA rides in the positive prompt as <lora:name:m:c> markup, which the
// workflows' "LoRA Loader from Text" node applies to both the base and the hires
// model outputs — so the hires pass and the ADetailer pass (which sample from the
// same model) get the distilled weights too, and their step/cfg are overridden to
// match. Settings that are 'None'/empty leave the prompt untouched.
//
// The process-wide ComfyUI switches that go with each set (--use-sage-attention,
// --fast) are launch flags, not workflow values: see comfyLaunchArgs.js.

const FAST_SETS = Object.freeze({
    checkpoint: Object.freeze({ prefix: 'api_fast_', strength: 1, steps: 8, cfg: 1, sampler: 'lcm', scheduler: 'sgm_uniform' }),
    // measured on waiANIMA (2026-09-17): Turbo v0.2 at 0.8, euler, 8 steps; CFG 1.5 keeps
    // part of the negative working (at CFG 1 it is ignored)
    diffusion: Object.freeze({ prefix: 'api_fast_diff_', strength: 0.8, steps: 8, cfg: 1.5, sampler: 'euler', scheduler: 'simple' }),
});

// Which set a run takes: the UNET route is the one that carries `unet.enable`.
export function isDiffusionGeneration(generateData) {
    return generateData?.unet?.enable === true;
}

export function fastModeConfig(settings = {}, { diffusion = false } = {}) {
    const set = diffusion ? FAST_SETS.diffusion : FAST_SETS.checkpoint;
    const read = name => settings?.[`${set.prefix}${name}`];
    const lora = String(read('lora') ?? '').trim();
    const strength = Number(read('lora_strength'));
    const steps = Number.parseInt(read('steps'), 10);
    const cfg = Number(read('cfg'));
    return {
        enabled: settings?.api_fast_enable === true,
        lora: lora === '' || lora === 'None' ? '' : lora,
        strength: Number.isFinite(strength) ? strength : set.strength,
        steps: Number.isInteger(steps) && steps > 0 ? steps : set.steps,
        cfg: Number.isFinite(cfg) && cfg >= 0 ? cfg : set.cfg,
        sampler: String(read('sampler') ?? '').trim() || set.sampler,
        scheduler: String(read('scheduler') ?? '').trim() || set.scheduler,
    };
}

export function isFastModeActive(settings) {
    return settings?.api_fast_enable === true;
}

// <lora:name:model:clip> — same form the LoRA slots emit for ComfyUI (getLoRAs), the
// file name exactly as listed under models/loras (extension included).
export function fastLoraTag({ lora, strength }) {
    if (!lora) return '';
    return `<lora:${lora}:${strength}:${strength}>`;
}

function withLoraTag(prompt, tag) {
    if (!tag) return prompt;
    const text = String(prompt ?? '');
    if (text.includes(tag)) return text;
    return text === '' ? tag : `${text}\n${tag}`;
}

// The LoRA fast mode would apply to this run but ComfyUI does not have: the
// "LoRA Loader from Text" node skips a missing file silently, which leaves an
// 8-step, low-CFG run without the weights it was tuned for. `loraList` is the
// ComfyUI LoRA list SAA knows (local scan or the pod's own list); an empty or
// placeholder-only list is "unknown" and never blocks. Returns the missing name or ''.
export function missingFastLora(generateData, settings, loraList) {
    if (!isFastModeActive(settings) || !generateData || typeof generateData !== 'object') return '';
    const { lora } = fastModeConfig(settings, { diffusion: isDiffusionGeneration(generateData) });
    if (!lora) return '';
    const known = (Array.isArray(loraList) ? loraList : []).filter(name => typeof name === 'string' && name !== '' && name !== 'None');
    if (known.length === 0) return '';
    const normalize = name => name.replaceAll('\\', '/');
    return known.some(name => normalize(name) === normalize(lora)) ? '' : lora;
}

/**
 * Returns a new generateData with fast-mode overrides applied, or the input object
 * itself when fast mode is off. ControlNet preprocessing and the MiraITU tagger flow
 * carry no sampler settings of their own here and are left to their callers.
 */
export function applyFastMode(generateData, settings) {
    if (!isFastModeActive(settings) || !generateData || typeof generateData !== 'object') return generateData;
    const fast = fastModeConfig(settings, { diffusion: isDiffusionGeneration(generateData) });

    const tag = fastLoraTag(fast);
    const result = { ...generateData };

    result.step = fast.steps;
    result.cfg = fast.cfg;
    result.sampler = fast.sampler;
    result.scheduler = fast.scheduler;

    if ('positive' in result) result.positive = withLoraTag(result.positive, tag);
    if ('positive_left' in result) result.positive_left = withLoraTag(result.positive_left, tag);

    if (result.hifix && typeof result.hifix === 'object') {
        result.hifix = { ...result.hifix, steps: fast.steps, cfg: fast.cfg };
    }

    if (Array.isArray(result.adetailer)) {
        result.adetailer = result.adetailer.map(slot => (slot && typeof slot === 'object'
            ? { ...slot, steps: fast.steps, cfg: fast.cfg, sampler: fast.sampler, scheduler: fast.scheduler }
            : slot));
    }

    result.fastMode = { lora: fast.lora, steps: fast.steps, cfg: fast.cfg, sampler: fast.sampler, scheduler: fast.scheduler };
    return result;
}
