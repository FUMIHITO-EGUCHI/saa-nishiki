// Pure helper for the slider / number-box pair (mySlider.js): turns whatever was
// typed into a value the control can hold. Out-of-range input is clamped to
// [min, max] and snapped to the step grid measured from min, so a size typed as
// "500" into a 512..2048 / 8 box becomes 512 instead of being silently dropped.
// Returns null when the input is not a number at all (empty box, "abc").
export function resolveSliderValue(raw, { min = 0, max = 255, step = 1 } = {}) {
    const value = typeof raw === 'number' ? raw : Number.parseFloat(raw);
    if (!Number.isFinite(value)) return null;
    let next = Math.min(max, Math.max(min, value));
    if (Number.isFinite(step) && step > 0) {
        next = min + Math.round((next - min) / step) * step;
        if (next > max) next -= step;
        if (next < min) next = min;
        // float steps (cfg 0.01) leave binary noise: keep the step's own precision
        const decimals = Number.isInteger(step) ? 0 : Math.min(10, (String(step).split('.')[1] ?? '').length);
        next = Number(next.toFixed(decimals));
    }
    return Number.isInteger(step) ? Math.trunc(next) : next;
}
