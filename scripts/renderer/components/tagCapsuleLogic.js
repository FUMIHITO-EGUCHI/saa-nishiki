// Pure tag-capsule logic. No DOM access; every export is unit-tested with node:test.
// Data model (SAA-tag-ui-redesign.md §14):
//   Capsule   = { id: '<normalized name>#<ordinal>', value: string, weightPlan: WeightPlan }
//   WeightPlan = { mode: 'fixed'|'increment'|'decrement'|'random', min, max, step, seed }
//   Sidecar    = Record<capsuleId, WeightPlan>   (only variable plans are stored)

const WEIGHT_MODES = new Set(['fixed', 'increment', 'decrement', 'random']);
const VARIABLE_MODES = new Set(['increment', 'decrement', 'random']);
const EPSILON = 1e-9;
const DEFAULT_WEIGHT = 1;
const DEFAULT_STEP = 0.05;

export const WEIGHT_PRESETS = Object.freeze([0.8, 0.9, 1, 1.1, 1.2, 1.3]);
export const WEIGHT_WARN_MIN = 0.5;
export const WEIGHT_WARN_MAX = 1.5;
export const WEIGHT_CLAMP_MIN = 0;
export const WEIGHT_CLAMP_MAX = 3;
export const BATCH_COUNT_MIN = 1;
export const BATCH_COUNT_MAX = 32;
export const DEFAULT_BATCH = Object.freeze({ enabled: false, count: 4 });

function finiteNumber(value, fallback) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
}

export function roundWeight(value) {
    return Math.round((Number(value) + EPSILON) * 1_000_000) / 1_000_000;
}

export function formatTagWeight(weight) {
    return finiteNumber(weight, DEFAULT_WEIGHT).toFixed(2);
}

export function createFixedWeightPlan(weight = DEFAULT_WEIGHT) {
    const value = finiteNumber(weight, DEFAULT_WEIGHT);
    return {
        mode: 'fixed',
        min: value,
        max: value,
        step: DEFAULT_STEP,
        seed: 0,
    };
}

export function normalizeWeightPlan(plan = {}) {
    const mode = WEIGHT_MODES.has(plan?.mode) ? plan.mode : 'fixed';
    const fallback = finiteNumber(plan?.value, DEFAULT_WEIGHT);
    const first = finiteNumber(plan?.min, fallback);
    const second = finiteNumber(plan?.max, first);
    const step = Math.max(EPSILON, Math.abs(finiteNumber(plan?.step, DEFAULT_STEP)));
    const seed = Math.max(0, Math.floor(finiteNumber(plan?.seed, 0)));
    // autoStep: the step is derived from the batch count at expansion time so the
    // plan walks min → max in exactly `count` images (see effectiveStep).
    const autoStep = plan?.autoStep === true;

    if (mode === 'fixed') {
        return { mode, min: first, max: first, step, seed, autoStep: false };
    }
    const min = Math.min(first, second);
    const max = Math.max(first, second);
    return { mode, min, max, step, seed, autoStep };
}

export function effectiveStep(plan, batchCount) {
    const normalized = normalizeWeightPlan(plan);
    if (!normalized.autoStep || !isVariablePlan(normalized)) return normalized.step;
    const count = Math.max(1, Math.floor(finiteNumber(batchCount, 1)));
    const span = Math.abs(normalized.max - normalized.min);
    if (span <= EPSILON) return normalized.step;
    return count > 1 ? span / (count - 1) : span;
}

export function isVariablePlan(plan) {
    return VARIABLE_MODES.has(plan?.mode);
}

export function plansEqual(a, b) {
    const left = normalizeWeightPlan(a);
    const right = normalizeWeightPlan(b);
    return left.mode === right.mode
        && Math.abs(left.min - right.min) <= EPSILON
        && Math.abs(left.max - right.max) <= EPSILON
        && Math.abs(left.step - right.step) <= EPSILON
        && left.seed === right.seed
        && left.autoStep === right.autoStep;
}

function candidateCount(min, max, step) {
    if (Math.abs(max - min) <= EPSILON) return 0;
    return Math.max(0, Math.floor(((max - min) / step) + EPSILON));
}

export function buildWeightCandidates(plan = {}, options = {}) {
    const normalized = normalizeWeightPlan(plan);
    const { mode, min, max } = normalized;
    if (mode === 'fixed' || Math.abs(min - max) <= EPSILON) return [roundWeight(min)];

    const step = effectiveStep(normalized, options.batchCount);
    const count = candidateCount(min, max, step);
    const values = [];
    for (let index = 0; index <= count; index += 1) {
        const value = mode === 'decrement'
            ? max - (index * step)
            : min + (index * step);
        if (value < min - EPSILON || value > max + EPSILON) break;
        values.push(roundWeight(value));
    }
    return values.length ? values : [roundWeight(mode === 'decrement' ? max : min)];
}

// Deterministic UTF-8 FNV-1a 32-bit hash used by Random weight plans.
export function stableHash32(value) {
    const bytes = new TextEncoder().encode(value);
    let hash = 0x811c9dc5;
    for (const byte of bytes) {
        hash ^= byte;
        hash = Math.imul(hash, 0x01000193);
    }
    return hash >>> 0;
}

// murmur3 finalizer: FNV-1a alone maps consecutive image indexes to consecutive
// candidates (visible as a linear ramp in the batch table), so spread the bits first.
function mix32(value) {
    let hash = value >>> 0;
    hash ^= hash >>> 16;
    hash = Math.imul(hash, 0x85ebca6b);
    hash ^= hash >>> 13;
    hash = Math.imul(hash, 0xc2b2ae35);
    hash ^= hash >>> 16;
    return hash >>> 0;
}

function randomCandidateIndex(candidates, plan, options) {
    const imageIndex = Math.max(0, Math.floor(finiteNumber(options.imageIndex, 0)));
    const generationSeed = finiteNumber(options.generationSeed, 0);
    const tokenId = String(options.tokenId ?? '');
    const hashInput = [generationSeed, plan.seed, tokenId, imageIndex].join('');
    return mix32(stableHash32(hashInput)) % candidates.length;
}

export function resolveWeight(plan = {}, options = {}) {
    const normalized = normalizeWeightPlan(plan);
    const candidates = buildWeightCandidates(normalized, { batchCount: options.batchCount });
    if (normalized.mode === 'random') {
        return candidates[randomCandidateIndex(candidates, normalized, options)];
    }

    const imageIndex = Math.max(0, Math.floor(finiteNumber(options.imageIndex, 0)));
    return candidates[Math.min(imageIndex, candidates.length - 1)];
}

// True when an increment/decrement plan has run out of candidates before imageIndex.
export function isTerminalAt(plan, imageIndex, batchCount) {
    const normalized = normalizeWeightPlan(plan);
    if (normalized.mode !== 'increment' && normalized.mode !== 'decrement') return false;
    const index = Math.max(0, Math.floor(finiteNumber(imageIndex, 0)));
    return index >= buildWeightCandidates(normalized, { batchCount }).length;
}

// ---------------------------------------------------------------- identity

export function normalizeTagName(value) {
    return String(value ?? '').trim().replaceAll(/\s+/g, ' ').toLocaleLowerCase();
}

export function assignCapsuleIds(capsules = []) {
    const ordinals = new Map();
    return capsules.map(capsule => {
        const key = normalizeTagName(capsule.value);
        const ordinal = ordinals.get(key) ?? 0;
        ordinals.set(key, ordinal + 1);
        return { ...capsule, id: `${key}#${ordinal}` };
    });
}

// A disabled tag stays in the field text with a leading marker ("~long hair") so
// it survives text-mode editing and presets, and is dropped when the prompt is built.
export const DISABLED_TAG_MARKER = '~';

export function parsePromptToCapsules(text = '') {
    const parsed = String(text ?? '')
        .split(/[,\n]/)
        .map(token => token.trim())
        .filter(Boolean)
        .map(token => {
            const disabled = token.startsWith(DISABLED_TAG_MARKER);
            const body = disabled ? token.slice(DISABLED_TAG_MARKER.length).trim() : token;
            const weighted = /^\((.*):\s*(-?(?:\d+(?:\.\d+)?|\.\d+))\)$/.exec(body);
            const value = (weighted ? weighted[1] : body).trim();
            const weight = weighted ? Number(weighted[2]) : DEFAULT_WEIGHT;
            return { value, weightPlan: createFixedWeightPlan(weight), disabled };
        })
        .filter(capsule => capsule.value);
    return assignCapsuleIds(parsed);
}

// `omitDisabled` builds prompt text (disabled tags dropped); the default keeps them
// with the marker so the textarea round-trips.
export function serializeCapsules(capsules = [], options = {}) {
    const generationSeed = finiteNumber(options.generationSeed, 0);
    const imageIndex = Math.max(0, Math.floor(finiteNumber(options.imageIndex, 0)));
    const tokenPrefix = options.tokenPrefix ? `${options.tokenPrefix}/` : '';
    const omitDisabled = options.omitDisabled === true;
    return capsules
        .map(capsule => {
            const value = String(capsule?.value ?? '').trim();
            if (!value) return '';
            if (capsule.disabled && omitDisabled) return '';
            const weight = resolveWeight(capsule.weightPlan, {
                generationSeed,
                imageIndex,
                tokenId: `${tokenPrefix}${capsule.id}`,
                batchCount: options.batchCount,
            });
            const token = Math.abs(weight - DEFAULT_WEIGHT) <= EPSILON
                ? value
                : `(${value}:${formatTagWeight(weight)})`;
            return capsule.disabled ? `${DISABLED_TAG_MARKER}${token}` : token;
        })
        .filter(Boolean)
        .join(', ');
}

export function toggleCapsuleDisabled(capsules = [], index) {
    const capsule = capsules[index];
    if (!capsule) return capsules;
    return capsules.map((item, position) => (position === index ? { ...item, disabled: !item.disabled } : item));
}

export function setAllCapsulesDisabled(capsules = [], disabled) {
    return capsules.map(item => ({ ...item, disabled: disabled === true }));
}

// Prompt-side filter for plain field text: drops "~tag" tokens, keeps everything else verbatim.
export function stripDisabledTags(text = '') {
    const source = String(text ?? '');
    if (!source.includes(DISABLED_TAG_MARKER)) return source;
    return source
        .split('\n')
        .map(line => line
            .split(',')
            .filter(token => !token.trim().startsWith(DISABLED_TAG_MARKER))
            .join(','))
        .join('\n');
}

export function previewBatch(capsules = [], count = 1, generationSeed = 0, tokenPrefix = '') {
    const total = Math.max(0, Math.floor(finiteNumber(count, 1)));
    const prefix = tokenPrefix ? `${tokenPrefix}/` : '';
    return Array.from({ length: total }, (_, imageIndex) => ({
        imageIndex,
        weights: capsules.map(capsule => resolveWeight(capsule.weightPlan, {
            generationSeed,
            imageIndex,
            tokenId: `${prefix}${capsule.id}`,
        })),
        prompt: serializeCapsules(capsules, { generationSeed, imageIndex, tokenPrefix }),
    }));
}

// ---------------------------------------------------------------- sidecar

// Re-matches a sidecar (id → plan) against freshly parsed capsules. Plans whose id
// no longer exists are reported in `discarded` so the UI can show a one-time notice.
export function reconcilePlans(capsules = [], plans = {}) {
    const known = new Set(capsules.map(capsule => capsule.id));
    const nextPlans = {};
    const discarded = [];
    for (const [id, plan] of Object.entries(plans ?? {})) {
        const normalized = normalizeWeightPlan(plan);
        if (!isVariablePlan(normalized)) continue;
        if (known.has(id)) nextPlans[id] = normalized;
        else discarded.push(id);
    }
    const nextCapsules = capsules.map(capsule => (
        nextPlans[capsule.id] ? { ...capsule, weightPlan: nextPlans[capsule.id] } : capsule
    ));
    return { capsules: nextCapsules, plans: nextPlans, discarded };
}

export function collectPlans(capsules = []) {
    const plans = {};
    for (const capsule of capsules) {
        if (isVariablePlan(capsule.weightPlan)) plans[capsule.id] = normalizeWeightPlan(capsule.weightPlan);
    }
    return plans;
}

export function serializePlans(plans = {}) {
    return Object.entries(plans ?? {})
        .filter(([, plan]) => isVariablePlan(plan))
        .map(([id, plan]) => {
            const { autoStep, ...rest } = normalizeWeightPlan(plan);
            return autoStep ? { id, ...rest, autoStep } : { id, ...rest }; // stored form stays compact
        });
}

export function parsePlans(entries = []) {
    const plans = {};
    for (const entry of Array.isArray(entries) ? entries : []) {
        const id = String(entry?.id ?? '');
        if (!id || !isVariablePlan(entry)) continue;
        plans[id] = normalizeWeightPlan(entry);
    }
    return plans;
}

export function normalizeBatch(batch = {}) {
    const count = Math.round(finiteNumber(batch?.count, DEFAULT_BATCH.count));
    return {
        enabled: Boolean(batch?.enabled),
        count: Math.min(BATCH_COUNT_MAX, Math.max(BATCH_COUNT_MIN, count)),
    };
}

// ---------------------------------------------------------------- editing helpers

export function capsuleStats(capsules = []) {
    let weighted = 0;
    let variable = 0;
    for (const capsule of capsules) {
        const plan = normalizeWeightPlan(capsule.weightPlan);
        if (isVariablePlan(plan)) variable += 1;
        else if (Math.abs(plan.min - DEFAULT_WEIGHT) > EPSILON) weighted += 1;
    }
    return { total: capsules.length, weighted, variable };
}

export function weightWarning(plan) {
    const normalized = normalizeWeightPlan(plan);
    return normalized.min < WEIGHT_WARN_MIN - EPSILON || normalized.max > WEIGHT_WARN_MAX + EPSILON;
}

export function clampWeight(value) {
    return roundWeight(Math.min(WEIGHT_CLAMP_MAX, Math.max(WEIGHT_CLAMP_MIN, finiteNumber(value, DEFAULT_WEIGHT))));
}

export function adjustWeight(value, delta) {
    return clampWeight(finiteNumber(value, DEFAULT_WEIGHT) + finiteNumber(delta, 0));
}

export function describePlan(plan) {
    const normalized = normalizeWeightPlan(plan);
    if (isVariablePlan(normalized)) {
        const range = `${formatTagWeight(normalized.min)}–${formatTagWeight(normalized.max)}`;
        return normalized.autoStep ? `${range} ÷n` : range;
    }
    return Math.abs(normalized.min - DEFAULT_WEIGHT) <= EPSILON ? '' : `:${formatTagWeight(normalized.min)}`;
}

export function chipKind(plan) {
    const normalized = normalizeWeightPlan(plan);
    if (isVariablePlan(normalized)) return 'plan';
    if (normalized.min > DEFAULT_WEIGHT + EPSILON) return 'up';
    if (normalized.min < DEFAULT_WEIGHT - EPSILON) return 'down';
    return '';
}

export function removeCapsule(capsules = [], index) {
    if (index < 0 || index >= capsules.length) return capsules;
    return assignCapsuleIds(capsules.filter((_, position) => position !== index));
}

export function moveCapsule(capsules = [], from, to) {
    if (from < 0 || from >= capsules.length || to < 0 || to >= capsules.length || from === to) return capsules;
    const next = capsules.slice();
    const [item] = next.splice(from, 1);
    next.splice(to, 0, item);
    return assignCapsuleIds(next);
}

export function insertCapsules(capsules = [], values = [], at = capsules.length) {
    const additions = parsePromptToCapsules(Array.isArray(values) ? values.join(', ') : String(values ?? ''));
    if (additions.length === 0) return capsules;
    const position = Math.max(0, Math.min(capsules.length, at));
    return assignCapsuleIds([...capsules.slice(0, position), ...additions, ...capsules.slice(position)]);
}

export function setCapsulePlan(capsules = [], id, plan) {
    const normalized = normalizeWeightPlan(plan);
    return capsules.map(capsule => (capsule.id === id ? { ...capsule, weightPlan: normalized } : capsule));
}

export function nudgeCapsuleWeight(capsules = [], index, delta) {
    const capsule = capsules[index];
    if (!capsule) return capsules;
    const plan = normalizeWeightPlan(capsule.weightPlan);
    if (isVariablePlan(plan)) return capsules;
    return setCapsulePlan(capsules, capsule.id, createFixedWeightPlan(adjustWeight(plan.min, delta)));
}

// Tags listed in the Exclude field are struck through on the chips (§13.11).
export function excludedTagSet(excludeText = '') {
    const set = new Set();
    for (const token of String(excludeText ?? '').split(/[,\n]/)) {
        const [name] = token.split(':');
        const normalized = normalizeTagName(name);
        if (normalized) set.add(normalized);
    }
    return set;
}

// ---------------------------------------------------------------- keyboard reducer (§9.2)

// state = { index: number, count: number }  index === count means the "+ Add tag" slot.
// Returns { index, action } where action is one of:
//   null | 'open' | 'delete' | 'move-left' | 'move-right' | 'weight-up' | 'weight-down' | 'add' | 'exit' | 'type'
export function handleChipKey(state, key, modifiers = {}) {
    const count = Math.max(0, Math.floor(finiteNumber(state?.count, 0)));
    const index = Math.max(0, Math.min(count, Math.floor(finiteNumber(state?.index, 0))));
    const ctrl = Boolean(modifiers.ctrlKey || modifiers.metaKey);
    const onChip = index < count;

    switch (key) {
        case 'ArrowLeft':
            if (ctrl) return onChip && index > 0 ? { index: index - 1, action: 'move-left' } : { index, action: null };
            return { index: Math.max(0, index - 1), action: null };
        case 'ArrowRight':
            if (ctrl) return onChip && index < count - 1 ? { index: index + 1, action: 'move-right' } : { index, action: null };
            return { index: Math.min(count, index + 1), action: null };
        case 'ArrowUp':
            return { index, action: ctrl && onChip ? 'weight-up' : null };
        case 'ArrowDown':
            return { index, action: ctrl && onChip ? 'weight-down' : null };
        case 'Home':
            return { index: 0, action: null };
        case 'End':
            return { index: count, action: null };
        case 'Enter':
        case ' ':
            return onChip ? { index, action: 'open' } : { index, action: 'add' };
        case 'Delete':
        case 'Backspace': {
            if (!onChip) return { index, action: null };
            // focus moves to the next chip; when the last chip is removed, to the previous one
            const remaining = count - 1;
            return { index: Math.max(0, Math.min(index, remaining - 1)), action: 'delete' };
        }
        case 'Escape':
            return { index, action: 'exit' };
        default:
            if (key.length === 1 && !ctrl && /[\p{L}\p{N}]/u.test(key)) {
                return { index: count, action: 'type' };
            }
            return { index, action: null };
    }
}

// ---------------------------------------------------------------- batch expansion (§14.2)

// fields: Array<{ key, capsules, batch? }>
// Returns one entry per image with the expanded text of every field.
export function expandAll(fields = [], generationSeed = 0, count = 1, options = {}) {
    const total = Math.max(1, Math.floor(finiteNumber(count, 1)));
    const baseSeed = finiteNumber(generationSeed, 0);
    const applyExclude = typeof options.applyExclude === 'function' ? options.applyExclude : null;
    const byKey = new Map(fields.map(field => [field.key, field]));

    const expandField = (key, imageIndex) => {
        const field = byKey.get(key);
        if (!field) return '';
        return serializeCapsules(field.capsules ?? [], { generationSeed: baseSeed, imageIndex, tokenPrefix: key, omitDisabled: true, batchCount: total });
    };
    const BUILTIN_KEYS = new Set(['common', 'background', 'style', 'positive', 'positive_right', 'negative', 'exclude']);

    return Array.from({ length: total }, (_, imageIndex) => {
        const weights = {};
        const terminal = [];
        for (const field of fields) {
            for (const capsule of field.capsules ?? []) {
                if (!isVariablePlan(capsule.weightPlan)) continue;
                const tokenId = `${field.key}/${capsule.id}`;
                weights[tokenId] = resolveWeight(capsule.weightPlan, { generationSeed: baseSeed, imageIndex, tokenId, batchCount: total });
                if (isTerminalAt(capsule.weightPlan, imageIndex, total)) terminal.push(tokenId);
            }
        }
        const common = expandField('common', imageIndex);
        const background = expandField('background', imageIndex);
        const style = expandField('style', imageIndex);
        const positiveTail = expandField('positive', imageIndex);
        const positiveRightTail = expandField('positive_right', imageIndex);
        const negative = expandField('negative', imageIndex);
        const exclude = expandField('exclude', imageIndex);
        const join = (...parts) => parts.filter(Boolean).join(', ');
        let positive = join(common, positiveTail);
        let positiveRight = join(common, positiveRightTail);
        if (applyExclude && exclude) {
            positive = applyExclude(positive, exclude);
            positiveRight = applyExclude(positiveRight, exclude);
        }
        const expandedFields = {
            common,
            background,
            style,
            positive: positiveTail,
            positive_right: positiveRightTail,
            negative,
            exclude,
        };
        // custom prompt fields (cf_*) expand under their own key
        for (const field of fields) {
            if (!BUILTIN_KEYS.has(field.key)) expandedFields[field.key] = expandField(field.key, imageIndex);
        }
        return {
            imageIndex,
            seed: baseSeed + imageIndex,
            positive,
            positiveRight,
            negative,
            fields: expandedFields,
            weights,
            terminal,
        };
    });
}

// Combined batch decision for a set of fields: enabled if any field enabled, count = max.
export function resolveBatchPlan(fields = []) {
    let enabled = false;
    let count = 1;
    let variable = 0;
    for (const field of fields) {
        const stats = capsuleStats(field.capsules ?? []);
        variable += stats.variable;
        const batch = normalizeBatch(field.batch);
        if (batch.enabled && stats.variable > 0) {
            enabled = true;
            count = Math.max(count, batch.count);
        }
    }
    return { enabled: enabled && variable > 0, count: enabled ? count : 1, variable };
}

export { WEIGHT_MODES, VARIABLE_MODES, DEFAULT_STEP, DEFAULT_WEIGHT };
