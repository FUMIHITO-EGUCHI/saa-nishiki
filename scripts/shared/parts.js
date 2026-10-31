// Parts: a named bundle of prompt tags (an outfit, a hairstyle, a body type, a
// background) that stands in a prompt field as one "parts:<name>" token and is
// expanded into its tags when the prompt is built.
//
//   parts:sailor uniform          → serafuku, pleated skirt, (red neckerchief:1.2), …
//   (parts:sailor uniform:0.8)    → every member weighted by 0.8 on top of its own weight
//   ~parts:sailor uniform         → nothing (the chip is switched off)
//
// The prefix is a word, not a sign, because "@" already means an artist (artistSlots.js)
// and a cast alias (castMembers.js). A part may contain another part; expansion stops
// at PART_MAX_DEPTH and never follows a cycle. A token that names no part becomes the
// bare name ("parts:red dress" → "red dress"), which is the closest thing to what the
// user meant and is visible in the final-prompt preview.
//
// Stored document (settings/parts.json, the `data` of the envelope):
//   { parts: { "<id>": { name, category, tags, samples: [sample], pinned, created, updated } } }
//   sample = { id, file, modelType, model, base, seed, width, height, promptVersion, created }
// `id` is the normalized name (lower case, single spaces): what a "parts:" token resolves
// by. `tags` is prompt text exactly as the chips write it (weights and "~" kept).
// Pure: no fs, no DOM; the renderer, the main store and the tests all import this.

import { mapPromptTokens, normalizeTagName, splitPromptTokens } from '../renderer/components/tagCapsuleLogic.js';

export const PARTS_SCHEMA = 1;
export const PARTS_SECTION = 'parts';
export const PART_PREFIX = 'parts:';
export const PART_MAX_DEPTH = 4;
export const PART_CATEGORIES = Object.freeze(['outfit', 'hair', 'body', 'background', 'camera', 'composition', 'tone', 'pose', 'expression', 'other']);
export const PART_NAME_MAX = 80;

const WEIGHTED = /^\((.*):\s*(-?(?:\d+(?:\.\d+)?|\.\d+))\)$/;
const DISABLED = '~';

export function partId(name) {
    return normalizeTagName(name);
}

export function normalizeCategory(value) {
    const category = String(value ?? '').trim().toLowerCase();
    return PART_CATEGORIES.includes(category) ? category : 'other';
}

// "parts:sailor uniform" → "sailor uniform"; null when the value is not a part token.
export function partNameOf(value) {
    const text = String(value ?? '').trim();
    if (text.length <= PART_PREFIX.length) return null;
    if (text.slice(0, PART_PREFIX.length).toLowerCase() !== PART_PREFIX) return null;
    const name = text.slice(PART_PREFIX.length).trim();
    return name || null;
}

export function isPartToken(value) {
    return partNameOf(value) !== null;
}

export function partToken(name, weight = 1) {
    const text = `${PART_PREFIX}${String(name ?? '').trim()}`;
    const w = Number(weight);
    return Number.isFinite(w) && Math.abs(w - 1) > 1e-9 ? `(${text}:${formatWeight(w)})` : text;
}

function formatWeight(weight) {
    return String(Math.round(weight * 100) / 100);
}

// One prompt token taken apart: { disabled, value, weight } ("~(a:1.2)" → off, "a", 1.2).
function readToken(token) {
    const disabled = token.startsWith(DISABLED);
    const body = disabled ? token.slice(1).trim() : token;
    const weighted = WEIGHTED.exec(body);
    return {
        disabled,
        value: (weighted ? weighted[1] : body).trim(),
        weight: weighted ? Number(weighted[2]) : 1,
    };
}

function writeToken(value, weight) {
    return Math.abs(weight - 1) <= 1e-9 ? value : `(${value}:${formatWeight(weight)})`;
}

/**
 * The LoRAs the enabled part tokens of `text` bring, nested parts included:
 * [{ name, weight, part }] in the order they come, each LoRA once.
 */
export function partLorasIn(text, resolve, { depth = 0, trail = new Set(), found = new Map() } = {}) {
    const source = String(text ?? '');
    if (!source.toLowerCase().includes(PART_PREFIX)) return [...found.values()];
    const lookup = typeof resolve === 'function' ? resolve : () => null;
    mapPromptTokens(source, token => {
        const { disabled, value } = readToken(token);
        const name = partNameOf(value);
        if (name === null || disabled) return null;
        const id = partId(name);
        const entry = lookup(id);
        if (!entry || depth >= PART_MAX_DEPTH || trail.has(id)) return null;
        for (const lora of Array.isArray(entry.loras) ? entry.loras : []) {
            if (!found.has(lora.name)) found.set(lora.name, { ...lora, part: id });
        }
        partLorasIn(entry.tags, lookup, { depth: depth + 1, trail: new Set([...trail, id]), found });
        return null;
    });
    return [...found.values()];
}

/**
 * The prompt text with every part token replaced by its tags. `resolve(id)` answers a
 * part entry ({ tags }) or null. Disabled members and disabled part tokens vanish; a
 * weighted token scales every member. Text that holds no part token comes back as is.
 */
export function expandPartTokens(text, resolve, options = {}) {
    const source = String(text ?? '');
    if (!source.toLowerCase().includes(PART_PREFIX)) return source;
    const depth = Number(options.depth) || 0;
    const trail = options.trail instanceof Set ? options.trail : new Set();
    const lookup = typeof resolve === 'function' ? resolve : () => null;
    let dropped = false;
    const expanded = mapPromptTokens(source, token => {
        const { disabled, value, weight } = readToken(token);
        const name = partNameOf(value);
        if (name === null) return null;
        if (disabled) { dropped = true; return ''; }
        const id = partId(name);
        const entry = lookup(id);
        if (!entry || depth >= PART_MAX_DEPTH || trail.has(id)) return writeToken(name, weight);
        const members = expandMembers(entry.tags, weight, lookup, depth, new Set([...trail, id]));
        if (members.length === 0) dropped = true;
        return members.length ? members.join(', ') : '';
    });
    return dropped ? tidy(expanded) : expanded;
}

// mapPromptTokens keeps the comma of a token it dropped ("a, , b"); re-join the lines.
function tidy(text) {
    return String(text)
        .split('\n')
        .map(line => splitPromptTokens(line).join(', '))
        .filter((line, index, lines) => line !== '' || lines.length === 1)
        .join('\n');
}

function expandMembers(tags, weight, lookup, depth, trail) {
    const out = [];
    for (const raw of splitPromptTokens(tags)) {
        const member = readToken(raw);
        if (member.disabled || !member.value) continue;
        const scaled = member.weight * weight;
        const nested = partNameOf(member.value);
        if (nested !== null) {
            const expanded = expandPartTokens(writeToken(member.value, scaled), lookup, { depth: depth + 1, trail });
            for (const piece of splitPromptTokens(expanded)) out.push(piece);
            continue;
        }
        out.push(writeToken(member.value, scaled));
    }
    return out;
}

/** The ids of every part a prompt text refers to, in order of first appearance. */
export function partIdsIn(text) {
    const ids = [];
    for (const token of splitPromptTokens(text)) {
        const name = partNameOf(readToken(token).value);
        if (name === null) continue;
        const id = partId(name);
        if (!ids.includes(id)) ids.push(id);
    }
    return ids;
}

/** Prompt text with the tokens of part `fromId` renamed to `toName` (weights and "~" kept). */
export function renamePartTokens(text, fromId, toName) {
    const target = partId(fromId);
    const next = String(toName ?? '').trim();
    if (!target || !next) return String(text ?? '');
    return mapPromptTokens(text, token => {
        const { disabled, value, weight } = readToken(token);
        const name = partNameOf(value);
        if (name === null || partId(name) !== target) return null;
        return `${disabled ? DISABLED : ''}${writeToken(`${PART_PREFIX}${next}`, weight)}`;
    });
}

/** Prompt text with the tokens of part `id` replaced by its tags — the "Expand to tags" action. */
export function expandOnePart(text, id, entry) {
    const target = partId(id);
    let dropped = false;
    const expanded = mapPromptTokens(text, token => {
        const { disabled, value, weight } = readToken(token);
        const name = partNameOf(value);
        if (name === null || partId(name) !== target) return null;
        if (disabled) { dropped = true; return ''; }
        const members = expandMembers(entry?.tags ?? '', weight, () => null, PART_MAX_DEPTH, new Set());
        if (members.length === 0) dropped = true;
        return members.length ? members.join(', ') : '';
    });
    return dropped ? tidy(expanded) : expanded;
}

// ---------------------------------------------------------------- the document

export function emptyPartsDoc() {
    return { parts: {}, starterVersion: 0 };
}

function cleanSample(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const id = String(raw.id ?? '').trim();
    const file = String(raw.file ?? '').trim();
    if (!id || !file) return null;
    return {
        id,
        file,
        modelType: raw.modelType === 'Diffusion' ? 'Diffusion' : 'Checkpoint',
        model: String(raw.model ?? ''),
        base: raw.base === 'character' ? 'character' : 'mannequin',
        character: typeof raw.character === 'string' ? raw.character : '',
        seed: Number.isFinite(Number(raw.seed)) ? Number(raw.seed) : 0,
        width: Number(raw.width) || 0,
        height: Number(raw.height) || 0,
        promptVersion: Number(raw.promptVersion) || 1,
        created: typeof raw.created === 'string' ? raw.created : '',
    };
}

// A LoRA a part carries: { name, weight }, the name as the LoRA list has it
function cleanPartLora(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const name = String(raw.name ?? '').trim();
    const weight = Number(raw.weight);
    if (!name || name.toLowerCase() === 'none') return null;
    return { name, weight: Number.isFinite(weight) ? weight : 1 };
}

/** A complete, typed part entry from loose input, or null when it has no name. */
export function cleanPart(raw, fallbackId = '') {
    if (!raw || typeof raw !== 'object') return null;
    const source = raw;
    const name = String(source.name ?? fallbackId ?? '').trim().replaceAll(/\s+/g, ' ').slice(0, PART_NAME_MAX);
    if (!name) return null;
    const samples = (Array.isArray(source.samples) ? source.samples : []).map(cleanSample).filter(Boolean);
    const pinned = typeof source.pinned === 'string' && samples.some(sample => sample.id === source.pinned) ? source.pinned : null;
    return {
        name,
        category: normalizeCategory(source.category),
        tags: typeof source.tags === 'string' ? source.tags.trim() : '',
        samples,
        pinned,
        created: typeof source.created === 'string' ? source.created : '',
        updated: typeof source.updated === 'string' ? source.updated : '',
        // from the bundled starter set (the picker says "starter" instead of "yours")
        starter: source.starter === true,
        // the LoRAs the part brings into a prompt with it, whether their trigger words come
        // too, and what happens on a model of another base: skip them, or use them anyway
        loras: (Array.isArray(source.loras) ? source.loras : []).map(cleanPartLora).filter(Boolean),
        loraTriggers: source.loraTriggers !== false,
        otherBase: source.otherBase === 'use' ? 'use' : 'skip',
    };
}

export function normalizePartsDoc(raw) {
    const doc = emptyPartsDoc();
    // which starter set has been merged in (see STARTER_SET_VERSION); 0 = none yet
    const version = Number(raw?.starterVersion);
    doc.starterVersion = Number.isInteger(version) && version > 0 ? version : 0;
    const source = raw && typeof raw === 'object' && raw.parts && typeof raw.parts === 'object' ? raw.parts : null;
    if (!source) return doc;
    for (const [key, value] of Object.entries(source)) {
        const entry = cleanPart(value, key);
        if (!entry) continue;
        doc.parts[partId(entry.name)] = entry;
    }
    return doc;
}

// ---------------------------------------------------------------- the starter set

/**
 * The version of the bundled starter set (data/parts_defaults.json). A parts document
 * records the version it has been merged with (`starterVersion`); the store merges the
 * set in whenever the document's version is older, adding the names it lacks and never
 * touching a part the user already has. So every install has the whole set from the
 * start, and a starter part the user deleted stays deleted until the set itself grows.
 * Bump this whenever the bundled file gains names.
 *   1: the first 85 (outfit, hair, body, background, other)
 *   2: 175 across nine categories (camera, composition, tone, pose, expression added)
 *   3: 295 across ten categories (120 additional outfit, expression, background, camera,
 *      pose, tone, composition, hair and other parts)
 */
export const STARTER_SET_VERSION = 3;

/** True when the document has not yet been merged with the current starter set. */
export function starterSetPending(doc) {
    return (Number(doc?.starterVersion) || 0) < STARTER_SET_VERSION;
}

/**
 * The bundled starter parts (data/parts_defaults.json, `{ parts: [{ name, category, tags }] }`,
 * drafted and checked in design/parts/defaults) as a document: what a fresh install's
 * parts.json starts as, and what the store merges into an older document. An entry
 * without a name or tags is left out; a repeated name keeps its first entry.
 */
export function partsDefaultsDoc(raw, now = () => new Date().toISOString()) {
    const list = Array.isArray(raw?.parts) ? raw.parts : Array.isArray(raw) ? raw : [];
    const stamp = now();
    const doc = emptyPartsDoc();
    doc.starterVersion = STARTER_SET_VERSION;
    for (const item of list) {
        const entry = cleanPart(item);
        if (!entry || !entry.tags) continue;
        const id = partId(entry.name);
        if (doc.parts[id]) continue;
        doc.parts[id] = { ...entry, samples: [], pinned: null, created: stamp, updated: stamp, starter: true };
    }
    return doc;
}

/**
 * The starter parts a document lacks, added to it. A part the user already has under
 * that name keeps its tags, samples and pin, whatever the starter set says.
 * Answers { doc, added, skipped }.
 */
export function mergePartsDefaults(doc, raw, now = () => new Date().toISOString()) {
    const next = normalizePartsDoc(doc);
    let added = 0;
    let skipped = 0;
    for (const [id, entry] of Object.entries(partsDefaultsDoc(raw, now).parts)) {
        if (next.parts[id]) {
            skipped += 1;
            continue;
        }
        next.parts[id] = entry;
        added += 1;
    }
    next.starterVersion = STARTER_SET_VERSION;
    return { doc: next, added, skipped };
}

/** Entries as a list, newest first by `updated`, then by name. */
export function listParts(doc, category = '') {
    const wanted = category ? normalizeCategory(category) : '';
    return Object.entries(doc?.parts ?? {})
        .map(([id, entry]) => ({ id, ...entry }))
        .filter(entry => !wanted || entry.category === wanted)
        .sort((a, b) => (b.updated || '').localeCompare(a.updated || '') || a.name.localeCompare(b.name));
}

/**
 * Apply one change and answer the new document, or null when the change is refused.
 * change = { action: 'set', id?, entry }            create / update (a new name moves the id)
 *        | { action: 'remove', id }
 *        | { action: 'add-sample', id, sample }
 *        | { action: 'remove-sample', id, sampleId }
 *        | { action: 'pin', id, sampleId | null }
 */
export function applyPartsChange(doc, change, now = () => new Date().toISOString()) {
    const next = normalizePartsDoc(doc);
    const stamp = now();
    switch (change?.action) {
        case 'set': {
            const entry = cleanPart(change.entry);
            if (!entry) return null;
            const id = partId(entry.name);
            const previousId = change.id ? partId(change.id) : id;
            const previous = next.parts[previousId] ?? null;
            if (previousId !== id && next.parts[id]) return null; // the new name is taken
            if (previousId !== id) delete next.parts[previousId];
            next.parts[id] = {
                ...entry,
                // samples and the pin live with the entry, whatever the caller sent
                samples: previous?.samples ?? [],
                pinned: previous?.pinned ?? null,
                created: previous?.created || stamp,
                updated: stamp,
            };
            return next;
        }
        case 'remove': {
            const id = partId(change.id);
            if (!next.parts[id]) return null;
            delete next.parts[id];
            return next;
        }
        case 'add-sample': {
            const id = partId(change.id);
            const entry = next.parts[id];
            const sample = cleanSample({ created: stamp, ...change.sample });
            if (!entry || !sample) return null;
            entry.samples = [...entry.samples.filter(item => item.id !== sample.id), sample];
            entry.updated = stamp;
            return next;
        }
        case 'remove-sample': {
            const id = partId(change.id);
            const entry = next.parts[id];
            if (!entry || !entry.samples.some(item => item.id === change.sampleId)) return null;
            entry.samples = entry.samples.filter(item => item.id !== change.sampleId);
            if (entry.pinned === change.sampleId) entry.pinned = null;
            return next;
        }
        case 'pin': {
            const id = partId(change.id);
            const entry = next.parts[id];
            if (!entry) return null;
            if (change.sampleId === null || change.sampleId === undefined) { entry.pinned = null; return next; }
            if (!entry.samples.some(item => item.id === change.sampleId)) return null;
            entry.pinned = change.sampleId;
            return next;
        }
        default:
            return null;
    }
}

// ---------------------------------------------------------------- samples

// The picker and the chip card show the model the app runs on now; the tile says
// which models a sample exists for. Display names only.
export const MODEL_TYPE_LABELS = Object.freeze({ Checkpoint: 'Illustrious', Diffusion: 'Anima' });

export function modelTypeLabel(modelType) {
    return MODEL_TYPE_LABELS[modelType] ?? String(modelType ?? '');
}

/** "Illustrious / Anima": the model types a part has samples for, in that fixed order. */
export function sampleModelLabels(entry) {
    const types = new Set((entry?.samples ?? []).map(sample => sample.modelType));
    return Object.keys(MODEL_TYPE_LABELS).filter(type => types.has(type)).map(modelTypeLabel);
}

/**
 * The sample a tile shows: the pinned one, else the newest mannequin sample of the
 * current model type, else the newest of that type, else the newest of any type.
 * The answer carries `foreign: true` when it is not of the wanted model type.
 */
export function pickSample(entry, modelType) {
    const samples = entry?.samples ?? [];
    if (samples.length === 0) return null;
    const pinned = samples.find(sample => sample.id === entry.pinned);
    if (pinned) return { ...pinned, foreign: pinned.modelType !== modelType };
    const byDate = [...samples].sort((a, b) => (b.created || '').localeCompare(a.created || ''));
    const same = byDate.filter(sample => sample.modelType === modelType);
    const chosen = same.find(sample => sample.base === 'mannequin') ?? same[0] ?? byDate[0];
    return { ...chosen, foreign: chosen.modelType !== modelType };
}

// ---------------------------------------------------------------- the sample prompt

// Fixed base per category and model type, settled on the bench of 2026-09-22
// (design/parts/bench). Anima keeps a literal white mannequin; Illustrious paints a
// shop dress form beside a real girl for that wording, so it gets a faceless
// white-skinned figure and a negative against a second one. Bump SAMPLE_PROMPT_VERSION
// when any of these change: History tells samples of different versions apart.
// v2 (2026-09-27, the starter-set run of design/parts/defaults): the hair figure wears a
// white shirt (an upper-body mannequin with no clothes named came out topless for six of
// seventeen hairstyles), and the `other` figure is no longer "full body", which overrode
// composition parts such as upper body, cowboy shot and close-up.
export const SAMPLE_PROMPT_VERSION = 4;
export const SAMPLE_SIZE = Object.freeze({ width: 512, height: 704 });
export const SAMPLE_SEED = 3;
// the bench's sampler settings, not the run bar's (a sample looks the same whatever the
// user is tuning); Fast mode is skipped for a sample (fastMode.js applyFastMode)
export const SAMPLE_GENERATION = Object.freeze({
    Diffusion: Object.freeze({ steps: 20, cfg: 4.5, sampler: 'er_sde', scheduler: 'simple' }),
    Checkpoint: Object.freeze({ steps: 24, cfg: 5, sampler: 'euler_ancestral', scheduler: 'normal' }),
});

// The figure: a bald, faceless, pale human in a white leotard. "white mannequin" with a
// "white bodysuit" drew a plugsuit android on Anima (2026-09-28, the user's samples), and
// the bench of five bases (design/parts/defaults/SEEDING.md) found the leotard on plain
// skin the cleanest at showing a body, a pose or an angle. Categories that dress the
// figure (outfit, hair, expression) leave the leotard out.
const MANNEQUIN = Object.freeze({
    Diffusion: Object.freeze({
        outfit: '1girl, faceless, bald, white skin, colored skin, standing, arms at sides, full body, simple background, white background',
        hair: '1girl, faceless, white skin, colored skin, white shirt, upper body, facing viewer, simple background, white background',
        body: '1girl, faceless, bald, white skin, colored skin, white leotard, standing, full body, simple background, white background',
        background: 'no humans, scenery',
        // the part decides the angle and the framing, so neither the view nor the gaze is fixed
        camera: '1girl, faceless, bald, white skin, colored skin, white leotard, standing, arms at sides, indoors, wooden floor, simple background',
        // no framing, no count of views: a split or a sheet part fights any single-view tag
        composition: '1girl, faceless, bald, white skin, colored skin, white leotard, standing, simple background, white background',
        tone: '1girl, faceless, bald, white skin, colored skin, white leotard, standing, simple background, white background',
        pose: '1girl, faceless, bald, white skin, colored skin, white leotard, full body, simple background, white background',
        // a face is needed for an expression
        expression: '1girl, bald, white skin, colored skin, white shirt, upper body, facing viewer, looking at viewer, simple background, white background',
        other: '1girl, faceless, bald, white skin, colored skin, standing, simple background, white background',
    }),
    Checkpoint: Object.freeze({
        outfit: '1girl, solo, faceless, bald, white skin, colored skin, standing, facing viewer, looking at viewer, arms at sides, full body, simple background, white background',
        hair: '1girl, solo, faceless, white skin, colored skin, white shirt, upper body, facing viewer, looking at viewer, simple background, white background',
        body: '1girl, solo, faceless, bald, white skin, colored skin, white leotard, standing, facing viewer, looking at viewer, full body, simple background, white background',
        background: 'no humans, scenery',
        camera: '1girl, solo, faceless, bald, white skin, colored skin, white leotard, standing, arms at sides, indoors, wooden floor, simple background',
        composition: '1girl, faceless, bald, white skin, colored skin, white leotard, standing, simple background, white background',
        tone: '1girl, solo, faceless, bald, white skin, colored skin, white leotard, standing, facing viewer, looking at viewer, simple background, white background',
        pose: '1girl, solo, faceless, bald, white skin, colored skin, white leotard, full body, simple background, white background',
        expression: '1girl, solo, bald, white skin, colored skin, white shirt, upper body, facing viewer, looking at viewer, simple background, white background',
        other: '1girl, solo, faceless, bald, white skin, colored skin, standing, facing viewer, looking at viewer, simple background, white background',
    }),
});

// A sample on the current character: the character's tags take the mannequin's place.
const CHARACTER_BASE = Object.freeze({
    outfit: 'solo, standing, facing viewer, looking at viewer, arms at sides, full body, simple background, white background',
    hair: 'solo, upper body, facing viewer, looking at viewer, simple background, white background',
    body: 'solo, standing, facing viewer, looking at viewer, full body, simple background, white background',
    background: 'solo, standing, full body',
    camera: 'solo, standing, arms at sides, indoors, wooden floor, simple background',
    composition: 'standing, simple background, white background',
    tone: 'solo, standing, facing viewer, looking at viewer, full body, simple background, white background',
    pose: 'solo, full body, simple background, white background',
    expression: 'solo, upper body, facing viewer, looking at viewer, simple background, white background',
    other: 'solo, standing, facing viewer, looking at viewer, full body, simple background, white background',
});

const QUALITY = Object.freeze({
    Diffusion: 'masterpiece, best quality, score_7, safe',
    Checkpoint: 'masterpiece, best quality, very aesthetic, absurdres',
});

const NEGATIVE = Object.freeze({
    Diffusion: 'worst quality, low quality, score_1, score_2, score_3, artist name, signature, watermark, text, logo, 2girls, multiple girls, multiple views, dress form, mannequin stand, android, cyborg, robot, mecha, plugsuit, bodysuit, armor, glowing',
    Checkpoint: 'worst quality, low quality, bad anatomy, bad hands, artist name, signature, watermark, text, logo, 2girls, multiple girls, multiple views, dress form, mannequin stand, android, cyborg, robot, mecha, plugsuit, bodysuit, armor, glowing',
});

/**
 * The positive / negative text of one sample. `tags` is the part's prompt text already
 * expanded (nested parts resolved, disabled members gone). With `character` (a tag
 * string) the figure is that character instead of the mannequin.
 */
export function samplePrompt({ category, tags, modelType, character = '' }) {
    const type = modelType === 'Diffusion' ? 'Diffusion' : 'Checkpoint';
    const cat = normalizeCategory(category);
    const base = character
        ? `${character}, ${CHARACTER_BASE[cat]}`
        : MANNEQUIN[type][cat];
    const positive = [QUALITY[type], base, String(tags ?? '').trim()].filter(Boolean).join(', ');
    // a composition part asks for the very things the negative refuses elsewhere (a second
    // view of the figure, panels), so it gets a negative without the view and count terms
    const negative = cat === 'composition' ? NEGATIVE[type].replace(/, (2girls|multiple girls|multiple views)/g, '') : NEGATIVE[type];
    return { positive, negative, base: character ? 'character' : 'mannequin', promptVersion: SAMPLE_PROMPT_VERSION };
}

/** A file-safe folder name for a part: "sailor uniform" → "sailor-uniform", never empty. */
export function partFolderName(id) {
    const slug = partId(id).replaceAll(/[^a-z0-9]+/g, '-').replaceAll(/^-+|-+$/g, '').slice(0, 60);
    return slug || 'part';
}
