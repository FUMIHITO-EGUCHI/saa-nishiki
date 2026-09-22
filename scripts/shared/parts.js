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
export const PART_CATEGORIES = Object.freeze(['outfit', 'hair', 'body', 'background', 'other']);
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
    return { parts: {} };
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
    };
}

export function normalizePartsDoc(raw) {
    const doc = emptyPartsDoc();
    const source = raw && typeof raw === 'object' && raw.parts && typeof raw.parts === 'object' ? raw.parts : null;
    if (!source) return doc;
    for (const [key, value] of Object.entries(source)) {
        const entry = cleanPart(value, key);
        if (!entry) continue;
        doc.parts[partId(entry.name)] = entry;
    }
    return doc;
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
export const SAMPLE_PROMPT_VERSION = 1;
export const SAMPLE_SIZE = Object.freeze({ width: 512, height: 704 });
export const SAMPLE_SEED = 3;
// the bench's sampler settings, not the run bar's (a sample looks the same whatever the
// user is tuning); Fast mode, when on, still applies as it does to every run
export const SAMPLE_GENERATION = Object.freeze({
    Diffusion: Object.freeze({ steps: 20, cfg: 4.5, sampler: 'er_sde', scheduler: 'simple' }),
    Checkpoint: Object.freeze({ steps: 24, cfg: 5, sampler: 'euler_ancestral', scheduler: 'normal' }),
});

const MANNEQUIN = Object.freeze({
    Diffusion: Object.freeze({
        outfit: '1girl, white mannequin, faceless, bald, standing, arms at sides, full body, simple background, white background',
        hair: '1girl, white mannequin, faceless, upper body, facing viewer, simple background, white background',
        body: '1girl, white mannequin, faceless, bald, white bodysuit, standing, full body, simple background, white background',
        background: 'no humans, scenery',
        other: '1girl, white mannequin, faceless, standing, full body, simple background, white background',
    }),
    Checkpoint: Object.freeze({
        outfit: '1girl, solo, faceless, bald, white skin, colored skin, standing, facing viewer, looking at viewer, arms at sides, full body, simple background, white background',
        hair: '1girl, solo, faceless, white skin, colored skin, upper body, facing viewer, looking at viewer, simple background, white background',
        body: '1girl, solo, faceless, bald, white skin, colored skin, white bodysuit, standing, facing viewer, looking at viewer, full body, simple background, white background',
        background: 'no humans, scenery',
        other: '1girl, solo, faceless, white skin, colored skin, standing, facing viewer, looking at viewer, full body, simple background, white background',
    }),
});

// A sample on the current character: the character's tags take the mannequin's place.
const CHARACTER_BASE = Object.freeze({
    outfit: 'solo, standing, facing viewer, looking at viewer, arms at sides, full body, simple background, white background',
    hair: 'solo, upper body, facing viewer, looking at viewer, simple background, white background',
    body: 'solo, standing, facing viewer, looking at viewer, full body, simple background, white background',
    background: 'solo, standing, full body',
    other: 'solo, standing, facing viewer, looking at viewer, full body, simple background, white background',
});

const QUALITY = Object.freeze({
    Diffusion: 'masterpiece, best quality, score_7, safe',
    Checkpoint: 'masterpiece, best quality, very aesthetic, absurdres',
});

const NEGATIVE = Object.freeze({
    Diffusion: 'worst quality, low quality, score_1, score_2, score_3, artist name, signature, watermark, text, logo, 2girls, multiple girls, multiple views, dress form, mannequin stand',
    Checkpoint: 'worst quality, low quality, bad anatomy, bad hands, artist name, signature, watermark, text, logo, 2girls, multiple girls, multiple views, dress form, mannequin stand',
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
    return { positive, negative: NEGATIVE[type], base: character ? 'character' : 'mannequin', promptVersion: SAMPLE_PROMPT_VERSION };
}

/** A file-safe folder name for a part: "sailor uniform" → "sailor-uniform", never empty. */
export function partFolderName(id) {
    const slug = partId(id).replaceAll(/[^a-z0-9]+/g, '-').replaceAll(/^-+|-+$/g, '').slice(0, 60);
    return slug || 'part';
}
