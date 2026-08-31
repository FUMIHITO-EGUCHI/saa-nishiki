// Bridge between the tag-capsule field set and generate.js / generate_regional.js.
// When a field has "Expand weights per image" enabled, one generate click becomes
// `count` queue entries, each with batch_size=1, expanded prompts, and seed + n − 1.
// Nothing here touches ComfyUI; it only decides what text and seed each loop reads.

let activeOverride = null;

function fieldSet() {
    return globalThis.prompt?.tagCapsuleFields ?? null;
}

// Reads a prompt field, honouring the per-image override while one is active.
export function readPromptValue(key) {
    if (activeOverride?.fields && typeof activeOverride.fields[key] === 'string') {
        return activeOverride.fields[key];
    }
    return globalThis.prompt?.[key]?.getValue?.() ?? '';
}

// Seed for the current image while an override is active (falls back to the slider value).
export function overrideSeed(sliderSeed) {
    if (activeOverride && Number.isFinite(activeOverride.seed) && activeOverride.seed >= 0) {
        return activeOverride.seed;
    }
    return sliderSeed;
}

export function planBatchExpansion({ loops = 1, runSame = false } = {}, options = {}) {
    const base = { loops, enabled: false, count: 1, baseSeed: -1 };
    const set = options.fieldSet ?? fieldSet();
    if (runSame || !set?.getBatchExpansion) return base;
    const plan = set.getBatchExpansion();
    if (!plan?.enabled) return base;

    const sliderSeed = Number(options.sliderSeed ?? globalThis.generate?.seed?.getValue?.() ?? -1);
    const randomSeed = typeof options.generateRandomSeed === 'function' ? options.generateRandomSeed : () => Math.floor(Math.random() * 4294967295);
    const baseSeed = Number.isFinite(sliderSeed) && sliderSeed >= 0 ? sliderSeed : randomSeed();
    return {
        loops: loops <= 1 ? plan.count : loops,
        enabled: true,
        count: plan.count,
        baseSeed,
    };
}

export function beginImageOverride(expansion, loop, options = {}) {
    activeOverride = null;
    if (!expansion?.enabled) return null;
    const set = options.fieldSet ?? fieldSet();
    const row = set?.getPromptOverrides?.(loop, expansion.baseSeed);
    if (!row) return null;
    const { weights, terminal, ...fields } = row;
    activeOverride = {
        fields,
        weights: weights ?? {},
        terminal: terminal ?? [],
        seed: expansion.baseSeed + loop,
        imageIndex: loop,
    };
    return activeOverride;
}

export function endImageOverride() {
    activeOverride = null;
}

export function getActiveOverride() {
    return activeOverride;
}

// "Weights #3: positive/detailed eyes#0=1.10, positive/soft lighting#0=0.95 ■"
export function describeOverrideWeights(override) {
    if (!override?.weights) return '';
    const entries = Object.entries(override.weights);
    if (entries.length === 0) return '';
    const terminal = new Set(override.terminal ?? []);
    const parts = entries.map(([tokenId, weight]) => {
        const name = tokenId.replace(/#\d+$/, '');
        return `${name}=${Number(weight).toFixed(2)}${terminal.has(tokenId) ? ' ■' : ''}`;
    });
    return `Weights #${override.imageIndex + 1}: ${parts.join(', ')}`;
}

// ---------------------------------------------------------------- AI Refine interplay
// AI Refine ("Once" role) caches the refined text of image #1 and re-applies it to every later image,
// which silently drops the per-image weights. These helpers put the planned weights back afterwards.

function normalizeName(value) {
    return String(value ?? '').trim().replaceAll(/\s+/g, ' ').toLocaleLowerCase();
}

// weights: { 'positive/detailed eyes#0': 1.1, ... } → { positive: [{ name, ordinal, weight }], ... }
export function planWeightEntries(weights = {}) {
    const byField = {};
    for (const [tokenId, weight] of Object.entries(weights ?? {})) {
        const slash = tokenId.indexOf('/');
        const hash = tokenId.lastIndexOf('#');
        if (slash < 0 || hash < slash) continue;
        const field = tokenId.slice(0, slash);
        const name = normalizeName(tokenId.slice(slash + 1, hash));
        const ordinal = Number.parseInt(tokenId.slice(hash + 1), 10);
        if (!name || !Number.isFinite(ordinal) || !Number.isFinite(Number(weight))) continue;
        (byField[field] ??= []).push({ name, ordinal, weight: Number(weight) });
    }
    return byField;
}

// Rewrites "(tag:w)" / "tag" tokens in a comma-separated prompt so that planned tags carry their
// per-image weight. Matching is by normalized name + occurrence ordinal; everything else is untouched.
export function applyPlanWeights(text, entries = []) {
    if (!entries.length || !text) return text;
    const wanted = new Map();
    for (const entry of entries) wanted.set(`${entry.name}#${entry.ordinal}`, entry.weight);
    const seen = new Map();
    return String(text).split(/(,|\n)/).map(part => {
        if (part === ',' || part === '\n') return part;
        const leading = /^\s*/.exec(part)[0];
        const trailing = /\s*$/.exec(part)[0];
        const token = part.trim();
        if (!token) return part;
        const weighted = /^\((.*):\s*(-?(?:\d+(?:\.\d+)?|\.\d+))\)$/.exec(token);
        const rawName = weighted ? weighted[1].trim() : token;
        const name = normalizeName(rawName);
        const ordinal = seen.get(name) ?? 0;
        seen.set(name, ordinal + 1);
        const weight = wanted.get(`${name}#${ordinal}`);
        if (weight === undefined) return part;
        const rendered = Math.abs(weight - 1) < 1e-9 ? rawName : `(${rawName}:${weight.toFixed(2)})`;
        return `${leading}${rendered}${trailing}`;
    }).join('');
}

// Applies the planned weights to the final prompt trio after AI Refine.
// Positive text is common + positive; positiveRight is common + positive_right; negative is negative.
export function reapplyPlanWeights(prompts, weights) {
    const byField = planWeightEntries(weights);
    const merge = (...fields) => fields.flatMap(field => byField[field] ?? []);
    return {
        ...prompts,
        positive: applyPlanWeights(prompts.positive ?? '', merge('common', 'positive')),
        positiveRight: applyPlanWeights(prompts.positiveRight ?? '', merge('common', 'positive_right')),
        negative: applyPlanWeights(prompts.negative ?? '', merge('negative')),
    };
}
