// The size range the run bar's width / height boxes accept, derived from the model
// type (pure, shared by the renderer and tests). A checkpoint (SDXL / Illustrious)
// is trained around 1024² and degrades past ~1536 a side; a diffusion model (Anima /
// Lumina) tolerates more. The upper bound per type lives in the settings
// (`size_limit_checkpoint` / `size_limit_diffusion`, Settings > Model) so it can be
// raised for a model that handles it. The lower bound and the step are fixed.
// Hires fix scales the base image afterwards and is outside this range on purpose:
// the range describes what the model samples natively, not what the upscaler emits.

export const SIZE_MIN = 512;
export const SIZE_STEP = 8;
// hard ceiling of the width / height sliders and of the limit settings themselves
export const SIZE_HARD_MAX = 4096;
// grid of the limit settings (Settings > Model boxes), measured from SIZE_MIN: the box and
// the range derived here must land on the same value (1500 is 1472 in both)
export const SIZE_LIMIT_STEP = 64;

export const SIZE_LIMIT_KEYS = Object.freeze({
    Checkpoint: 'size_limit_checkpoint',
    Diffusion: 'size_limit_diffusion',
});

export const DEFAULT_SIZE_LIMITS = Object.freeze({
    Checkpoint: 1536,
    Diffusion: 2048,
});

function limitFor(type, settings = {}) {
    const key = SIZE_LIMIT_KEYS[type] ?? SIZE_LIMIT_KEYS.Checkpoint;
    const fallback = DEFAULT_SIZE_LIMITS[type] ?? DEFAULT_SIZE_LIMITS.Checkpoint;
    const raw = Number(settings[key]);
    if (!Number.isFinite(raw)) return fallback;
    const snapped = SIZE_MIN + Math.round((raw - SIZE_MIN) / SIZE_LIMIT_STEP) * SIZE_LIMIT_STEP;
    return Math.min(SIZE_HARD_MAX, Math.max(SIZE_MIN, snapped));
}

// { min, max, step } for the width / height boxes under `settings.api_model_type`.
export function sizeRangeFor(settings = {}) {
    const type = settings.api_model_type === 'Diffusion' ? 'Diffusion' : 'Checkpoint';
    return { min: SIZE_MIN, max: limitFor(type, settings), step: SIZE_STEP };
}

// The label text beside "Size": "512–1536".
export function formatSizeRange(range) {
    return `${range.min}–${range.max}`;
}

// Whether a typed value sits outside the range (a non-number is never "over":
// the box is empty or mid-edit).
export function isOutOfRange(value, range) {
    const number = typeof value === 'number' ? value : Number.parseFloat(value);
    if (!Number.isFinite(number)) return false;
    return number < range.min || number > range.max;
}
