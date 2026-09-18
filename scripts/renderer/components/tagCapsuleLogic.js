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
    // plan walks min → max in exactly `count` images (see effectiveStep). A random draw
    // has no step to derive, so it never carries the flag.
    const autoStep = plan?.autoStep === true && mode !== 'random';

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

// ---------------------------------------------------------------- prompt tokenizer
// Prompt text split at its commas and line breaks, except the commas inside a closed
// group: "(red hair, blue eyes:1.2)", "[a, b]" and "{red hair, blue eyes|green hair}"
// each stay one token. A group opens only where a token or a word starts, so emoticon
// tags (":(", ":)") and escaped parentheses ("\(") are plain text, and an opener that
// never closes ("(unclosed, tag") is plain text too - the other groups of that line
// still hold their commas together.
//
// Everything that reads prompt text as a list of tags shares this: the chips, the
// Exclude filter, the plan weights, AI Refine and the Scene counts. Split a group
// anywhere else and half of it ("blue eyes:1.2)") leaks into a prompt.
const CLOSER_OF = { '(': ')', '[': ']', '{': '}' };
const OPENER_OF = { ')': '(', ']': '[', '}': '{' };
// what may stand in front of an opener: white space, a comma, another opener, the
// disabled marker, or the end of the group before it
const OPENS_GROUP = /[\s,([{~)\]}]/;

// [open, close] index pairs of every closed group of one line; an opener that never
// closes is not one.
function groupRanges(line) {
    const open = [];
    const ranges = [];
    for (let index = 0; index < line.length; index += 1) {
        const character = line[index];
        if (character === '\\') {
            index += 1;
            continue;
        }
        if (CLOSER_OF[character] && (index === 0 || OPENS_GROUP.test(line[index - 1]))) {
            open.push({ character, index });
            continue;
        }
        const opener = OPENER_OF[character];
        if (!opener || open.length === 0) continue;
        for (let depth = open.length - 1; depth >= 0; depth -= 1) {
            if (open[depth].character !== opener) continue;
            ranges.push([open[depth].index, index]);
            open.length = depth;
            break;
        }
    }
    return ranges;
}

function splitLineTokens(line) {
    // one pass to mark what sits inside a group, so the split below stays linear
    const inside = new Uint8Array(line.length);
    for (const [start, end] of groupRanges(line)) inside.fill(1, start + 1, end);
    const grouped = index => inside[index] === 1;
    const tokens = [];
    let start = 0;
    for (let index = 0; index < line.length; index += 1) {
        if (line[index] === '\\') {
            index += 1;
            continue;
        }
        if (line[index] !== ',' || grouped(index)) continue;
        tokens.push(line.slice(start, index));
        start = index + 1;
    }
    tokens.push(line.slice(start));
    return tokens;
}

/** The tags of a prompt text: trimmed, blanks dropped, a group's commas kept inside it. */
export function splitPromptTokens(text = '') {
    return String(text ?? '').split('\n').flatMap(splitLineTokens).map(token => token.trim()).filter(Boolean);
}

/**
 * Rewrites the tags of a prompt text in place. `replace(token, index)` answers the new
 * text of one tag, '' to drop it, or null / undefined to leave it alone. The commas, the
 * line breaks and the spacing around each tag stay as they were.
 */
export function mapPromptTokens(text = '', replace) {
    let index = 0;
    return String(text ?? '')
        .split('\n')
        .map(line => splitLineTokens(line)
            .map(part => {
                const token = part.trim();
                if (!token) return part;
                const next = replace(token, index++);
                if (next === null || next === undefined || next === token) return part;
                if (next === '') return '';
                const [leading] = /^\s*/.exec(part);
                const [trailing] = /\s*$/.exec(part);
                return `${leading}${next}${trailing}`;
            })
            .join(','))
        .join('\n');
}

/**
 * The first closed group of a token taken apart, with whatever stands around it, or null
 * when the token holds none: "(red hair, blue eyes:1.2)" becomes
 * { before: '', open: '(', body: 'red hair, blue eyes', close: ':1.2)', after: '' }.
 * A token that is exactly one group is the one with an empty `before` and `after`.
 */
export function splitGroupToken(token = '') {
    const text = String(token ?? '').trim();
    const ranges = groupRanges(text);
    const top = ranges
        .filter(([start, end]) => !ranges.some(([outerStart, outerEnd]) => outerStart < start && end < outerEnd))
        .sort((left, right) => left[0] - right[0])[0];
    if (!top) return null;
    const [start, end] = top;
    const closer = CLOSER_OF[text[start]];
    const body = text.slice(start + 1, end);
    const weighted = /^([\s\S]*):(\s*-?(?:\d+(?:\.\d+)?|\.\d+)\s*)$/.exec(body);
    return {
        before: text.slice(0, start),
        open: text[start],
        body: weighted ? weighted[1] : body,
        close: weighted ? `:${weighted[2]}${closer}` : closer,
        after: text.slice(end + 1),
    };
}

// One token of prompt text as capsule data ("~(long hair:1.2)" → a disabled "long hair" at 1.2).
function parseCapsuleToken(token) {
    const disabled = token.startsWith(DISABLED_TAG_MARKER);
    const body = disabled ? token.slice(DISABLED_TAG_MARKER.length).trim() : token;
    const weighted = /^\((.*):\s*(-?(?:\d+(?:\.\d+)?|\.\d+))\)$/.exec(body);
    const value = (weighted ? weighted[1] : body).trim();
    const weight = weighted ? Number(weighted[2]) : DEFAULT_WEIGHT;
    return { value, weightPlan: createFixedWeightPlan(weight), disabled };
}

export function parsePromptToCapsules(text = '') {
    const parsed = splitPromptTokens(text)
        .map(parseCapsuleToken)
        .filter(capsule => capsule.value);
    return assignCapsuleIds(parsed);
}

// ---------------------------------------------------------------- stored plan ids
// The tokenizer before this one split every comma, so "(a, smile, b:1.2), smile" named
// the outer "smile" `smile#1`; today it is `smile#0`. A sidecar written by that build
// is renamed here once (and written back), so a plan is not discarded - and the group's
// own `smile#0` plan does not land on the chip that inherited the id.
function legacyIdMap(text) {
    const tokens = splitPromptTokens(text);
    const parsed = tokens.map(parseCapsuleToken);
    const current = assignCapsuleIds(parsed.filter(capsule => capsule.value));
    const legacyPieces = tokens.map(token => token
        .split(',')
        .map(piece => piece.trim())
        .filter(Boolean)
        .map(parseCapsuleToken)
        .filter(capsule => capsule.value));
    const legacy = assignCapsuleIds(legacyPieces.flat());
    const rename = new Map();
    let currentIndex = 0;
    let legacyIndex = 0;
    let split = false;
    for (const [index, pieces] of legacyPieces.entries()) {
        const capsule = parsed[index].value ? current[currentIndex++] : null;
        const ids = legacy.slice(legacyIndex, legacyIndex + pieces.length);
        legacyIndex += pieces.length;
        if (pieces.length > 1) split = true;
        // a token that is one tag under both tokenizers simply keeps its plan
        if (pieces.length === 1 && capsule) rename.set(ids[0].id, capsule.id);
    }
    return {
        rename,
        split,
        legacyIds: new Set(legacy.map(capsule => capsule.id)),
        currentIds: new Set(current.map(capsule => capsule.id)),
    };
}

/**
 * Stored weight plans (id → plan) renamed onto the ids this text gives out now. Nothing
 * moves unless a stored id is gone today and the previous tokenizer did hand it out, so
 * a sidecar this build wrote is never touched. A plan on a fragment of a group ("(a",
 * "b:1.2)") has no chip to move to and is dropped.
 */
export function migratePlanIds(plans = {}, text = '') {
    const stored = Object.entries(plans ?? {});
    if (stored.length === 0) return { plans, changed: false };
    const map = legacyIdMap(text);
    if (!map.split) return { plans, changed: false };
    const fromLegacy = stored.some(([id]) => !map.currentIds.has(id) && map.legacyIds.has(id));
    if (!fromLegacy) return { plans, changed: false };
    const next = {};
    for (const [id, plan] of stored) {
        // an id the old tokenizer never handed out is left alone (reconcilePlans reports it)
        const target = map.legacyIds.has(id) ? map.rename.get(id) : id;
        if (target && !next[target]) next[target] = plan;
    }
    return { plans: next, changed: true };
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
    // a line that only held disabled tags disappears; the others are re-joined
    // cleanly so no ", ," or leading blank is left for the backend
    return source
        .split('\n')
        .map(line => splitLineTokens(line)
            .map(token => token.trim())
            .filter(token => token && !token.startsWith(DISABLED_TAG_MARKER))
            .join(', '))
        .filter((line, index, lines) => line !== '' || lines.length === 1)
        .join('\n');
}

// ---------------------------------------------------------------- multi-selection

export function removeCapsules(capsules = [], ids = []) {
    const drop = new Set(ids);
    if (drop.size === 0) return capsules;
    const next = capsules.filter(capsule => !drop.has(capsule.id));
    return next.length === capsules.length ? capsules : assignCapsuleIds(next);
}

// disabled: true / false, or 'toggle' (each selected capsule flips on its own)
export function setCapsulesDisabled(capsules = [], ids = [], disabled = true) {
    const pick = new Set(ids);
    if (pick.size === 0) return capsules;
    return capsules.map(capsule => {
        if (!pick.has(capsule.id)) return capsule;
        return { ...capsule, disabled: disabled === 'toggle' ? !capsule.disabled : disabled === true };
    });
}

// Moves the selected capsules as one block (their relative order kept) to the insertion
// index `to` (a slot between chips, counted over the whole list): the block lands before
// the first unselected capsule at or after `to`; `to === length` appends.
export function moveCapsules(capsules = [], ids = [], to) {
    return moveCapsuleBlock(capsules, ids, to).capsules;
}

// moveCapsules plus the ids the block carries afterwards (ids follow the name
// ordinals, so a moved "smile" may change its "#n"), in block order.
export function moveCapsuleBlock(capsules = [], ids = [], to) {
    const pick = new Set(ids);
    const block = capsules.filter(capsule => pick.has(capsule.id));
    if (block.length === 0) return { capsules, ids: [] };
    const target = Math.max(0, Math.min(capsules.length, Math.floor(finiteNumber(to, capsules.length))));
    const anchor = capsules.slice(target).find(capsule => !pick.has(capsule.id)) ?? null;
    const rest = capsules.filter(capsule => !pick.has(capsule.id));
    const position = anchor ? rest.indexOf(anchor) : rest.length;
    const next = [...rest.slice(0, position), ...block, ...rest.slice(position)];
    if (next.every((capsule, index) => capsule === capsules[index])) return { capsules, ids: block.map(capsule => capsule.id) };
    const moved = assignCapsuleIds(next);
    return { capsules: moved, ids: moved.slice(position, position + block.length).map(capsule => capsule.id) };
}

// Where a drop over the wrapped chip row inserts, from the chips' boxes ({ top, bottom,
// left, width }, in chip order): every chip on a row above the pointer counts, plus the
// chips on its row whose centre is left of it. Blank row space and the add slot resolve
// to the end of that row.
export function insertionIndexFromRects(rects = [], x, y) {
    let index = 0;
    for (const rect of rects) {
        if (y > rect.bottom || (y >= rect.top && x > rect.left + rect.width / 2)) index += 1;
    }
    return index;
}

// The target index of one chip dragged within its own row: the insertion index still
// counts the dragged chip while it sits before the point.
export function reorderIndex(from, insertAt) {
    return insertAt > from ? insertAt - 1 : insertAt;
}

// Several capsules into another field at `at`, in their source order.
export function transferCapsules(source = [], target = [], ids = [], options = {}) {
    const { at = target.length, copy = false } = options;
    const pick = new Set(ids);
    const block = source.filter(capsule => pick.has(capsule.id)).map(capsule => ({
        value: capsule.value,
        weightPlan: normalizeWeightPlan(capsule.weightPlan),
        disabled: capsule.disabled === true,
    }));
    if (block.length === 0) return { source, target, moved: [] };
    const position = Math.max(0, Math.min(target.length, Math.floor(finiteNumber(at, target.length))));
    const nextTarget = assignCapsuleIds([...target.slice(0, position), ...block, ...target.slice(position)]);
    const nextSource = copy ? source : assignCapsuleIds(source.filter(capsule => !pick.has(capsule.id)));
    return { source: nextSource, target: nextTarget, moved: nextTarget.slice(position, position + block.length) };
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

// ---------------------------------------------------------------- cross-field transfer

// Moves (or copies) one capsule from `source` into `target` at `at`, keeping its weight
// plan and disabled state. Returns the new lists and the inserted capsule (null when
// the id is unknown). Same-field reordering stays with moveCapsule.
export function transferCapsule(source = [], target = [], capsuleId, options = {}) {
    const { at = target.length, copy = false } = options;
    const index = source.findIndex(capsule => capsule.id === capsuleId);
    if (index < 0) return { source, target, moved: null };
    const capsule = source[index];
    const clone = {
        value: capsule.value,
        weightPlan: normalizeWeightPlan(capsule.weightPlan),
        disabled: capsule.disabled === true,
    };
    const position = Math.max(0, Math.min(target.length, Math.floor(finiteNumber(at, target.length))));
    const nextTarget = assignCapsuleIds([...target.slice(0, position), clone, ...target.slice(position)]);
    const nextSource = copy ? source : assignCapsuleIds(source.filter((_, position_) => position_ !== index));
    return { source: nextSource, target: nextTarget, moved: nextTarget[position] };
}

// Text-mode counterparts (a textarea selection moved to another field): tokens are
// matched by normalized name, the first occurrence of each is removed, and the
// remaining text keeps its line structure.
function splitTokens(text) {
    return splitPromptTokens(text);
}

function tokenName(token) {
    const body = token.startsWith(DISABLED_TAG_MARKER) ? token.slice(DISABLED_TAG_MARKER.length) : token;
    const weighted = /^\((.*):\s*(-?(?:\d+(?:\.\d+)?|\.\d+))\)$/.exec(body.trim());
    return normalizeTagName(weighted ? weighted[1] : body);
}

export function appendTagsToText(text = '', tags = []) {
    const additions = (Array.isArray(tags) ? tags : splitTokens(tags)).map(tag => String(tag ?? '').trim()).filter(Boolean);
    if (additions.length === 0) return String(text ?? '');
    const base = String(text ?? '').replace(/[\s,]+$/, '');
    return base ? `${base}, ${additions.join(', ')}` : additions.join(', ');
}

export function removeTagsFromText(text = '', tags = []) {
    const wanted = new Map();
    for (const tag of (Array.isArray(tags) ? tags : splitTokens(tags))) {
        const name = tokenName(String(tag ?? '').trim());
        if (name) wanted.set(name, (wanted.get(name) ?? 0) + 1);
    }
    if (wanted.size === 0) return String(text ?? '');
    return String(text ?? '')
        .split('\n')
        .map(line => splitLineTokens(line)
            .filter(token => {
                const name = tokenName(token.trim());
                const remaining = wanted.get(name) ?? 0;
                if (remaining <= 0) return true;
                wanted.set(name, remaining - 1);
                return false;
            })
            .map(token => token.trim())
            .filter(Boolean)
            .join(', '))
        .filter(line => line !== '')
        .join('\n');
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
    const BUILTIN_KEYS = new Set(['common', 'background', 'style', 'positive', 'positive_right', 'negative', 'negative_left', 'negative_right', 'exclude']);

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
        const join = (...parts) => parts.filter(Boolean).join(', ');
        // every field expands under its own key: built-ins and cf_* custom fields
        const expandedFields = {};
        for (const field of fields) expandedFields[field.key] = expandField(field.key, imageIndex);
        for (const key of BUILTIN_KEYS) if (!(key in expandedFields)) expandedFields[key] = '';
        // options.chain = { positive: [unit ids], positiveRight: [unit ids] | null, negative: [unit ids] }
        // in generation order (scripts/shared/regionalSides.js): the prompts then mirror
        // what generate.js assembles - background, style, custom fields and their sides
        // included; structural units (views / ai / characters) have no field and are
        // skipped. Without a chain the legacy common + positive shape is used.
        const chain = options.chain && typeof options.chain === 'object' ? options.chain : null;
        const chainText = ids => join(...(Array.isArray(ids) ? ids : []).map(id => expandedFields[id] ?? ''));
        let positive = chain ? chainText(chain.positive) : join(expandedFields.common, expandedFields.positive);
        let positiveRight = chain
            ? (chain.positiveRight ? chainText(chain.positiveRight) : '')
            : join(expandedFields.common, expandedFields.positive_right);
        // Regional: `chain.negativeShared` are the units both sides get. Generation writes
        // them once and drops a side unit that repeats one of them (scripts/shared/
        // negativeComposition.js composeRegionalNegatives), so the preview does the same.
        const shared = new Set(Array.isArray(chain?.negativeShared) ? chain.negativeShared : []);
        const negativeIds = chain ? (chain.negative ?? ['negative']) : [];
        const sharedTexts = new Set(negativeIds.filter(id => shared.has(id)).map(id => expandedFields[id] ?? '').filter(Boolean));
        const negative = chain
            ? join(...negativeIds.map(id => {
                const value = expandedFields[id] ?? '';
                return shared.has(id) || !sharedTexts.has(value) ? value : '';
            }))
            : expandedFields.negative;
        const exclude = expandedFields.exclude;
        if (applyExclude && exclude) {
            positive = applyExclude(positive, exclude);
            positiveRight = applyExclude(positiveRight, exclude);
        }
        return {
            imageIndex,
            // a fixed slider seed stays fixed so only the weights change between images
            seed: options.fixedSeed ? baseSeed : baseSeed + imageIndex,
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
