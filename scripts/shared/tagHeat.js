// A tag's heat (its post count in data/danbooru_e621_merged.csv) as a rough measure of
// how much the image models have seen of it, shown in three tiers rather than as a
// number: "weak" (under 100 posts: the model has barely learned it), "thin" (100 to
// 999) and "enough" (1,000 or more, the common case, which gets no mark).

export const HEAT_THIN = 100;
export const HEAT_ENOUGH = 1000;

/** 'weak' | 'thin' | 'enough' for a post count; null when there is no count. */
export function heatTier(heat) {
    if (heat === null || heat === undefined || heat === '') return null;
    const count = Number(heat);
    if (!Number.isFinite(count) || count < 0) return null;
    if (count < HEAT_THIN) return 'weak';
    if (count < HEAT_ENOUGH) return 'thin';
    return 'enough';
}

/** The language key of a tier's wording ("tag_ui_heat_weak" ...), or null. */
export function heatTierKey(heat) {
    const tier = heatTier(heat);
    return tier ? `tag_ui_heat_${tier}` : null;
}

/** The tier wording with the exact count, "Rare tag: ... (99)"; '' without a count. */
export function heatLabel(text, heat) {
    const key = heatTierKey(heat);
    if (!key) return '';
    const wording = typeof text === 'function' ? String(text(key) ?? '') : '';
    return `${wording || key} (${Number(heat).toLocaleString('en-US')})`;
}
