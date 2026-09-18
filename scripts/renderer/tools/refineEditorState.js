import { stripDisabledTags } from '../components/tagCapsuleLogic.js';
import { isFieldMuted } from '../../shared/promptFieldOrder.js';

const FIELD_KEYS = Object.freeze(['common', 'positive', 'positiveRight', 'negative', 'negativeLeft', 'negativeRight', 'exclude']);
const SETTINGS_KEY_BY_FIELD = Object.freeze({
    common: 'common',
    positive: 'positive',
    positiveRight: 'positive_right',
    negative: 'negative',
    negativeLeft: 'negative_left',
    negativeRight: 'negative_right',
    exclude: 'exclude',
});

function cloneJsonValue(value) {
    if (Array.isArray(value)) return value.map(cloneJsonValue);
    if (value && typeof value === 'object') {
        return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, cloneJsonValue(child)]));
    }
    return value ?? null;
}

function deepFreeze(value) {
    if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
    for (const child of Object.values(value)) deepFreeze(child);
    return Object.freeze(value);
}

function stableStringify(value) {
    if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
    if (value && typeof value === 'object') {
        return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
    }
    return JSON.stringify(value);
}

// Positive (right) and Negative (left / right) only exist while Regional is on; outside it
// their stored text is not part of the prompt, so Refine neither sees it nor may rewrite it.
const REGIONAL_ONLY_KEYS = new Set(['positiveRight', 'negativeLeft', 'negativeRight']);

function normalizeFields(fields = {}, mode = 'normal') {
    return Object.fromEntries(FIELD_KEYS.map(key => [
        key,
        mode !== 'regional' && REGIONAL_ONLY_KEYS.has(key) ? '' : String(fields[key] ?? ''),
    ]));
}

function normalizeKeyedJson(values = {}, fallback) {
    return Object.fromEntries(FIELD_KEYS.map(key => [key, cloneJsonValue(values[key] ?? fallback)]));
}

// A muted field (the Scene row's switch) keeps its text but sends nothing, so Refine
// neither sees nor rewrites it either.
function normalizeMuted(muted, mode) {
    const keys = new Set(Array.isArray(muted) ? muted : []);
    return FIELD_KEYS.filter(key => keys.has(key) && !(mode !== 'regional' && REGIONAL_ONLY_KEYS.has(key)));
}

export function mutedRefineFields(settings = {}) {
    return FIELD_KEYS.filter(field => isFieldMuted(settings, SETTINGS_KEY_BY_FIELD[field]));
}

export function createRefineEditorSnapshot({ mode = 'normal', fields = {}, muted = [], plans = {}, batches = {}, ai = {} } = {}) {
    const normalizedMode = mode === 'regional' ? 'regional' : 'normal';
    const content = {
        mode: normalizedMode,
        fields: normalizeFields(fields, normalizedMode),
        muted: normalizeMuted(muted, normalizedMode),
        plans: normalizeKeyedJson(plans, []),
        batches: normalizeKeyedJson(batches, { enabled: false, count: 4 }),
        ai: {
            interface: String(ai.interface ?? 'None'),
            role: String(ai.role ?? 'None'),
            promptMode: String(ai.promptMode ?? 'Expand'),
            instruction: String(ai.instruction ?? ''),
            systemPrompt: String(ai.systemPrompt ?? ''),
            refineSystemPrompt: String(ai.refineSystemPrompt ?? ''),
            modelMode: String(ai.modelMode ?? 'Auto'),
            apiUrl: String(ai.apiUrl ?? ''),
        },
    };
    const revision = stableStringify(content);
    return deepFreeze({ ...content, revision });
}

export function hasRefineEditorConflict(snapshot, currentSnapshot) {
    if (!snapshot?.revision || !currentSnapshot?.revision) return true;
    return snapshot.revision !== currentSnapshot.revision;
}

export function captureRefineEditorSnapshot({ mode = 'normal', ai = {}, prompt, settings } = {}) {
    const promptControls = prompt ?? globalThis.prompt ?? {};
    const storedSettings = settings ?? globalThis.globalSettings ?? {};
    const fields = {};
    const plans = {};
    const batches = {};
    for (const field of FIELD_KEYS) {
        const settingsKey = SETTINGS_KEY_BY_FIELD[field];
        fields[field] = promptControls[settingsKey]?.getValue?.() ?? storedSettings[settingsKey] ?? '';
        plans[field] = storedSettings[`${settingsKey}_weight_plans`] ?? [];
        batches[field] = storedSettings[`${settingsKey}_batch`] ?? { enabled: false, count: 4 };
    }
    return createRefineEditorSnapshot({ mode, fields, muted: mutedRefineFields(storedSettings), plans, batches, ai });
}

// The editable fields a structured Refine request carries: only the text that reaches the
// prompt. A muted field goes out empty and a switched-off "~tag" not at all; applying the
// answer keeps both as they are (refineEditorApplication.js). `locked` names the muted
// fields to the model, which would otherwise move content into an empty-looking field and
// lose it: their answer is dropped in generation and in the editor alike (rule 14 of the
// Refine system prompt, aiPromptRefiner.js). Exclude is no field of the request.
export function refineRequestFields(snapshot) {
    const muted = new Set(snapshot?.muted ?? []);
    return Object.freeze({
        ...Object.fromEntries(FIELD_KEYS.map(key => [
            key,
            muted.has(key) ? '' : stripDisabledTags(snapshot?.fields?.[key] ?? ''),
        ])),
        locked: Object.freeze(FIELD_KEYS.filter(key => key !== 'exclude' && muted.has(key))),
    });
}

export function snapshotFieldsForPromptOverride(snapshot) {
    return Object.freeze({
        common: snapshot?.fields?.common ?? '',
        positive: snapshot?.fields?.positive ?? '',
        positive_right: snapshot?.fields?.positiveRight ?? '',
        negative: snapshot?.fields?.negative ?? '',
        negative_left: snapshot?.fields?.negativeLeft ?? '',
        negative_right: snapshot?.fields?.negativeRight ?? '',
        exclude: snapshot?.fields?.exclude ?? '',
    });
}
