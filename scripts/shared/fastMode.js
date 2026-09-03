// Fast generation mode (pure, no I/O): rewrites a ComfyUI generateData so every
// sampling pass runs with a step-distillation LoRA (DMD2 / Hyper-SD / Lightning /
// LCM ...) and the low step count / cfg / sampler that such LoRAs expect.
//
// The LoRA rides in the positive prompt as <lora:name:m:c> markup, which the
// workflows' "LoRA Loader from Text" node applies to both the base and the hires
// model outputs — so the hires pass and the ADetailer pass (which sample from the
// same model) get the distilled weights too, and their step/cfg are overridden to
// match. Settings that are 'None'/empty leave the prompt untouched.

export function fastModeConfig(settings = {}) {
    const lora = String(settings.api_fast_lora ?? '').trim();
    const strength = Number(settings.api_fast_lora_strength);
    const steps = Number.parseInt(settings.api_fast_steps, 10);
    const cfg = Number(settings.api_fast_cfg);
    return {
        enabled: settings.api_fast_enable === true,
        lora: lora === '' || lora === 'None' ? '' : lora,
        strength: Number.isFinite(strength) ? strength : 1,
        steps: Number.isInteger(steps) && steps > 0 ? steps : 8,
        cfg: Number.isFinite(cfg) && cfg >= 0 ? cfg : 1,
        sampler: String(settings.api_fast_sampler ?? '').trim() || 'lcm',
        scheduler: String(settings.api_fast_scheduler ?? '').trim() || 'sgm_uniform',
    };
}

export function isFastModeActive(settings) {
    return fastModeConfig(settings).enabled;
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

/**
 * Returns a new generateData with fast-mode overrides applied, or the input object
 * itself when fast mode is off. ControlNet preprocessing and the MiraITU tagger flow
 * carry no sampler settings of their own here and are left to their callers.
 */
export function applyFastMode(generateData, settings) {
    const fast = fastModeConfig(settings);
    if (!fast.enabled || !generateData || typeof generateData !== 'object') return generateData;

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
