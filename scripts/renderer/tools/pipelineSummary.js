// Pure helpers that turn the current settings / slot state into the one-line
// summaries shown on the Pipeline rows ("×1.5 · RealESRGAN · denoise 0.40 · 20 steps").
// No DOM access: callers pass plain data so the output is unit-testable.

const SEP = ' · ';

function fileStem(name) {
    const text = String(name ?? '').trim();
    if (!text) return '';
    return text.replaceAll('\\', '/').split('/').pop().replace(/\.(safetensors|ckpt|pt|pth|onnx)$/i, '');
}

function fixed(value, digits) {
    const number = Number(value);
    return Number.isFinite(number) ? number.toFixed(digits) : '';
}

function roundTo8(value) {
    return Math.round(value / 8) * 8;
}

export function summarizeHires(settings = {}, text = {}) {
    const scale = Number(settings.api_hf_scale);
    const parts = [];
    if (Number.isFinite(scale)) parts.push(`×${fixed(scale, 1)}`);
    const upscaler = fileStem(settings.api_hf_upscaler_selected);
    if (upscaler) parts.push(upscaler);
    if (settings.api_hf_denoise !== undefined) parts.push(`${text.denoise ?? 'denoise'} ${fixed(settings.api_hf_denoise, 2)}`);
    if (settings.api_hf_steps !== undefined) parts.push(`${settings.api_hf_steps} ${text.steps ?? 'steps'}`);
    const width = Number(settings.width);
    const height = Number(settings.height);
    if (Number.isFinite(scale) && Number.isFinite(width) && Number.isFinite(height)) {
        parts.push(`→ ${roundTo8(width * scale)} × ${roundTo8(height * scale)}`);
    }
    return parts.join(SEP);
}

export function summarizeRefiner(settings = {}, text = {}) {
    const parts = [];
    const model = fileStem(settings.api_refiner_model);
    if (model) parts.push(model);
    if (settings.api_refiner_ratio !== undefined) parts.push(`${text.ratio ?? 'ratio'} ${fixed(settings.api_refiner_ratio, 1)}`);
    if (settings.api_refiner_add_noise) parts.push(text.addNoise ?? 'add noise');
    return parts.join(SEP);
}

// slots: [{ model, sam, denoise, enabled }] as read from the ADetailer slot manager
export function summarizeADetailer(slots = [], text = {}) {
    const active = slots.filter(slot => slot && slot.enabled !== false);
    if (active.length === 0) return text.noSlots ?? 'no slots';
    const first = active[0];
    const parts = [];
    if (first.model) parts.push(fileStem(first.model));
    if (first.sam) parts.push(fileStem(first.sam).replace(/_[0-9a-f]{6,}$/i, ''));
    if (first.denoise !== undefined) parts.push(`${text.denoise ?? 'denoise'} ${fixed(first.denoise, 2)}`);
    if (active.length > 1) parts.push(`+${active.length - 1}`);
    return parts.join(SEP);
}

// slots: [{ model, strength, enabled }]
export function summarizeControlNet(slots = [], text = {}) {
    const active = slots.filter(slot => slot && slot.enabled !== false);
    if (active.length === 0) return text.noSlots ?? 'no slots';
    return active.map(slot => {
        const name = fileStem(slot.model) || (text.slot ?? 'slot');
        return slot.strength === undefined ? name : `${name} ${fixed(slot.strength, 1)}`;
    }).join(SEP);
}

// slots: [{ name, strength, enabled }] — disabled entries are kept but marked (off)
export function summarizeLoRA(slots = [], text = {}) {
    const rows = slots.filter(slot => slot && slot.name);
    if (rows.length === 0) return text.none ?? 'none';
    return rows.map(slot => {
        const name = fileStem(slot.name);
        if (slot.enabled === false) return `${name} (${text.off ?? 'off'})`;
        return slot.strength === undefined ? name : `${name} ${fixed(slot.strength, 1)}`;
    }).join(SEP);
}

// entries: [{ name, strength, enabled }]
export function summarizeJson(entries = [], text = {}) {
    const rows = entries.filter(entry => entry && entry.name);
    if (rows.length === 0) return text.none ?? 'none';
    return rows.map(entry => entry.enabled === false ? `${entry.name} (${text.off ?? 'off'})` : entry.name).join(SEP);
}

export function summarizeRegional(settings = {}, text = {}) {
    const parts = [];
    if (settings.regional_image_ratio !== undefined) parts.push(`${text.ratio ?? 'L/R'} ${settings.regional_image_ratio}`);
    if (settings.regional_overlap_ratio !== undefined) parts.push(`${text.overlap ?? 'overlap'} ${settings.regional_overlap_ratio}`);
    if (settings.regional_str_left !== undefined && settings.regional_str_right !== undefined) {
        parts.push(`${fixed(settings.regional_str_left, 1)} / ${fixed(settings.regional_str_right, 1)}`);
    }
    if (settings.regional_swap) parts.push(text.swap ?? 'swapped');
    return parts.join(SEP);
}

export function countLabel(count) {
    const number = Number(count);
    return Number.isFinite(number) && number >= 0 ? String(Math.floor(number)) : '0';
}
