// Aspect ratios of the run bar's Size picker (pure, shared by the renderer and tests).
// A ratio is stored as long side / short side; the orientation (portrait / landscape)
// is the image's own and turns it either way. Sizes land on the Size boxes' grid
// (sizeLimits.js SIZE_STEP) inside their range, so a ratio is kept as closely as the
// 8 px grid allows: a size "fits" a ratio when it is what that rounding gives.

import { SIZE_MIN, SIZE_STEP } from './sizeLimits.js';

export const RATIOS = Object.freeze([
    { id: '1-1', label: '1:1', long: 1 },
    { id: '4-5', label: '4:5', long: 5 / 4 },
    { id: '3-4', label: '3:4', long: 4 / 3 },
    { id: 'a4', label: 'A4', long: Math.SQRT2 },
    { id: '2-3', label: '2:3', long: 3 / 2 },
    { id: 'golden', label: 'Golden', labelKey: 'ui_ratio_golden', long: (1 + Math.sqrt(5)) / 2 },
    { id: '9-16', label: '9:16', long: 16 / 9 },
].map(Object.freeze));

const DEFAULT_RANGE = Object.freeze({ min: SIZE_MIN, max: 1536, step: SIZE_STEP });

export function ratioById(id) {
    return RATIOS.find(ratio => ratio.id === id) ?? null;
}

// height / width of a ratio as the image stands
export function heightPerWidth(ratio, landscape) {
    return landscape ? 1 / ratio.long : ratio.long;
}

// a length on the boxes' grid (measured from min, like sliderValue.js) inside the range
export function snapLength(value, range = DEFAULT_RANGE) {
    const { min, max, step } = { ...DEFAULT_RANGE, ...range };
    const snapped = min + Math.round((value - min) / step) * step;
    return Math.min(max, Math.max(min, snapped));
}

// One side typed, the other follows the ratio. When the follower would leave the range it
// stops at the bound and the typed side is pulled back so the ratio still holds.
export function followSize(ratio, landscape, axis, value, range = DEFAULT_RANGE) {
    const { min, max } = { ...DEFAULT_RANGE, ...range };
    const factor = axis === 'width' ? heightPerWidth(ratio, landscape) : 1 / heightPerWidth(ratio, landscape);
    let leader = snapLength(value, range);
    const wanted = leader * factor;
    let follower = snapLength(wanted, range);
    if (wanted > max || wanted < min) leader = snapLength(follower / factor, range);
    return axis === 'width' ? { width: leader, height: follower } : { width: follower, height: leader };
}

// The size a ratio gets at a pixel count (a ratio picked keeps the pixels the size has),
// brought inside the range with the ratio kept.
export function sizeAtArea(ratio, area, landscape, range = DEFAULT_RANGE) {
    const { min, max } = { ...DEFAULT_RANGE, ...range };
    const shortSide = Math.sqrt(area / ratio.long);
    let longSide = shortSide * ratio.long;
    if (longSide > max) longSide = max;
    if (longSide / ratio.long < min) longSide = min * ratio.long;
    const long = snapLength(longSide, range);
    const short = snapLength(long / ratio.long, range);
    return landscape ? { width: long, height: short } : { width: short, height: long };
}

// Whether a size is what the grid gives for a ratio (either orientation): each side is
// off by at most half a step, so the long side may miss short × ratio by step/2 × (1 + ratio).
export function fitsRatio(ratio, width, height, step = SIZE_STEP) {
    const long = Math.max(width, height);
    const short = Math.min(width, height);
    if (!(short > 0)) return false;
    return Math.abs(long - short * ratio.long) <= (step / 2) * (1 + ratio.long) + 1e-6;
}

export function findRatio(width, height, step = SIZE_STEP) {
    return RATIOS.find(ratio => fitsRatio(ratio, width, height, step)) ?? null;
}

export function nearestRatio(width, height) {
    const long = Math.max(width, height) / Math.max(1, Math.min(width, height));
    return RATIOS.reduce((best, ratio) => (Math.abs(Math.log(ratio.long / long)) < Math.abs(Math.log(best.long / long)) ? ratio : best));
}

// What the picker shows for a size and the stored choice: the ratio it is linked to
// (null = Free). A linked ratio the size no longer fits (a recipe, a model type's own
// size, a clamp) gives way to the ratio the size does fit, or to Free.
export function settleRatio({ width, height, ratioId, linked }) {
    const stored = ratioById(ratioId);
    if (linked !== false && stored && fitsRatio(stored, width, height)) return { ratioId: stored.id, linked: true };
    if (linked === false && stored) return { ratioId: stored.id, linked: false };
    const found = linked === false ? null : findRatio(width, height);
    if (found) return { ratioId: found.id, linked: true };
    return { ratioId: stored?.id ?? '', linked: false };
}
