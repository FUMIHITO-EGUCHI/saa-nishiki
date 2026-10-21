export function normalizeADetailerSeed(value) {
    const seed = typeof value === 'number' || typeof value === 'string' && value.trim() ? Number(value) : -1;
    return Number.isInteger(seed) && seed >= -1 && seed <= 4294967295 ? seed : -1;
}

export function resolveADetailerSeed(value, baseSeed) {
    const seed = normalizeADetailerSeed(value);
    const resolved = seed === -1 ? Number(baseSeed) : seed;
    if (!Number.isInteger(resolved) || resolved < 0 || resolved > 4294967295) throw new Error('ADetailer needs a resolved generation seed');
    return resolved;
}
