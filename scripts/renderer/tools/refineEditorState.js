const FIELD_KEYS = Object.freeze(['common', 'positive', 'positiveRight', 'negative', 'exclude']);
const SETTINGS_KEY_BY_FIELD = Object.freeze({
    common: 'common',
    positive: 'positive',
    positiveRight: 'positive_right',
    negative: 'negative',
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

function normalizeFields(fields = {}) {
    return Object.fromEntries(FIELD_KEYS.map(key => [key, String(fields[key] ?? '')]));
}

function normalizeKeyedJson(values = {}, fallback) {
    return Object.fromEntries(FIELD_KEYS.map(key => [key, cloneJsonValue(values[key] ?? fallback)]));
}

export function createRefineEditorSnapshot({ mode = 'normal', fields = {}, plans = {}, batches = {}, ai = {} } = {}) {
    const content = {
        mode: mode === 'regional' ? 'regional' : 'normal',
        fields: normalizeFields(fields),
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
    return createRefineEditorSnapshot({ mode, fields, plans, batches, ai });
}

export function snapshotFieldsForPromptOverride(snapshot) {
    return Object.freeze({
        common: snapshot?.fields?.common ?? '',
        positive: snapshot?.fields?.positive ?? '',
        positive_right: snapshot?.fields?.positiveRight ?? '',
        negative: snapshot?.fields?.negative ?? '',
        exclude: snapshot?.fields?.exclude ?? '',
    });
}
