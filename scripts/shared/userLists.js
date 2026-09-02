// User-diff layer for the bundled lists (R3 data model).
//
// The upstream data files (characters CSV, original_character.json, view_tags.json)
// stay read-only; everything the user adds, overrides or hides lives in one diff
// document saved as settings/user_lists.json. Merging happens in the main process so
// the renderer keeps seeing the historical plain shapes ({name: tag} maps, string
// arrays) plus a per-key meta map for source badges.
//
// Diff document (the `data` of the envelope):
//   {
//     character:   { entries: { "<name>": { tag, thumb? } }, hidden: ["<name>"] },
//     oc:          { entries: { "<name>": { tag } },         hidden: [...] },
//     view_angle:  { entries: { "<tag>": {} },               hidden: [...] },
//     view_camera: { entries: { "<tag>": {} },               hidden: [...] }
//   }
//
// An entry whose key exists upstream is an override; one that doesn't is an addition.
// `hidden` only ever names upstream keys (a user entry is removed, not hidden).
// Pure (no fs / Electron); imported by scripts/main/userListsStore.js and tests.

export const USER_LISTS_SCHEMA = 1;
export const USER_LISTS_SECTION = 'user_lists';

// key → the base list it patches: keyed maps carry {tag}, value lists carry bare names.
export const USER_LIST_KEYS = Object.freeze(['character', 'oc', 'view_angle', 'view_camera']);
export const KEYED_LISTS = Object.freeze(['character', 'oc']);

// Source labels for merged entries: upstream CSV characters, upstream OC file, user data.
export const SOURCE_BY_LIST = Object.freeze({ character: 'csv', oc: 'original', view_angle: 'view', view_camera: 'view' });

export function emptyUserLists() {
    const doc = {};
    for (const list of USER_LIST_KEYS) doc[list] = { entries: {}, hidden: [] };
    return doc;
}

function cleanEntry(list, value) {
    const source = value && typeof value === 'object' ? value : {};
    if (!KEYED_LISTS.includes(list)) return {};
    const entry = { tag: typeof source.tag === 'string' ? source.tag : '' };
    if (list === 'character' && typeof source.thumb === 'string' && source.thumb) entry.thumb = source.thumb;
    return entry;
}

function cleanKey(key) {
    return typeof key === 'string' ? key.trim() : '';
}

/** Return a complete, typed diff document; junk keys and malformed values are dropped. */
export function normalizeUserLists(raw) {
    const doc = emptyUserLists();
    if (!raw || typeof raw !== 'object') return doc;
    for (const list of USER_LIST_KEYS) {
        const source = raw[list];
        if (!source || typeof source !== 'object') continue;
        if (source.entries && typeof source.entries === 'object' && !Array.isArray(source.entries)) {
            for (const [rawKey, value] of Object.entries(source.entries)) {
                const key = cleanKey(rawKey);
                if (!key) continue;
                const entry = cleanEntry(list, value);
                if (KEYED_LISTS.includes(list) && entry.tag === '') continue;
                doc[list].entries[key] = entry;
            }
        }
        if (Array.isArray(source.hidden)) {
            doc[list].hidden = [...new Set(source.hidden.map(cleanKey).filter(Boolean))];
        }
    }
    return doc;
}

/**
 * Apply one management operation and return the changed document (a new object).
 * change = { action: 'set' | 'remove' | 'hide' | 'unhide', key, entry? }
 * Returns null for an invalid list / action / key so callers can refuse the IPC cleanly.
 */
export function applyUserListChange(doc, list, change) {
    if (!USER_LIST_KEYS.includes(list)) return null;
    const key = cleanKey(change?.key);
    if (!key) return null;
    const next = normalizeUserLists(doc);
    const target = next[list];
    switch (change?.action) {
        case 'set': {
            const entry = cleanEntry(list, change.entry);
            if (KEYED_LISTS.includes(list) && entry.tag === '') return null;
            target.entries[key] = entry;
            // setting a value un-hides the key: the user clearly wants it visible again
            target.hidden = target.hidden.filter(hidden => hidden !== key);
            return next;
        }
        case 'remove':
            if (!Object.hasOwn(target.entries, key)) return null;
            delete target.entries[key];
            return next;
        case 'hide':
            if (!target.hidden.includes(key)) target.hidden.push(key);
            return next;
        case 'unhide':
            target.hidden = target.hidden.filter(hidden => hidden !== key);
            return next;
        default:
            return null;
    }
}

/**
 * Merge a keyed base map ({name: tag}) with its diff.
 * Returns { merged, meta } where merged keeps the base shape (hidden keys removed,
 * overrides applied, additions appended) and meta describes every key — including
 * hidden ones — for the management UI:
 *   meta[name] = { source: 'csv'|'original'|'user', overridden, hidden, thumb? }
 */
export function mergeKeyedList(base, diff, baseSource) {
    const merged = {};
    const meta = {};
    const entries = diff?.entries ?? {};
    const hidden = new Set(diff?.hidden ?? []);
    for (const [name, tag] of Object.entries(base ?? {})) {
        const override = entries[name];
        const isHidden = hidden.has(name);
        meta[name] = { source: override ? 'user' : baseSource, overridden: Boolean(override), hidden: isHidden };
        if (override?.thumb) meta[name].thumb = override.thumb;
        if (isHidden) continue;
        merged[name] = override ? override.tag : tag;
    }
    for (const [name, entry] of Object.entries(entries)) {
        if (Object.hasOwn(meta, name)) continue; // override, handled above
        meta[name] = { source: 'user', overridden: false, hidden: false };
        if (entry.thumb) meta[name].thumb = entry.thumb;
        merged[name] = entry.tag;
    }
    return { merged, meta };
}

/**
 * Merge a value list (view angle / camera arrays) with its diff.
 * Base order is kept, user additions are appended in insertion order.
 */
export function mergeValueList(base, diff, baseSource = 'view') {
    const merged = [];
    const meta = {};
    const entries = diff?.entries ?? {};
    const hidden = new Set(diff?.hidden ?? []);
    for (const name of base ?? []) {
        meta[name] = { source: baseSource, overridden: false, hidden: hidden.has(name) };
        if (!hidden.has(name)) merged.push(name);
    }
    for (const name of Object.keys(entries)) {
        if (Object.hasOwn(meta, name)) continue;
        meta[name] = { source: 'user', overridden: false, hidden: false };
        merged.push(name);
    }
    return { merged, meta };
}

/** Envelope helpers (same shape as the settings sections files). */
export function makeUserListsEnvelope(data, { saaVersion = '', now = () => new Date() } = {}) {
    const stamp = now();
    return {
        schema: USER_LISTS_SCHEMA,
        section: USER_LISTS_SECTION,
        saa_version: saaVersion,
        saved_at: stamp instanceof Date ? stamp.toISOString() : String(stamp),
        data,
    };
}

export function readUserListsEnvelope(envelope, { warn = null } = {}) {
    if (!envelope || typeof envelope !== 'object') return null;
    if (envelope.section !== USER_LISTS_SECTION) {
        warn?.(`expected section "${USER_LISTS_SECTION}", file says "${envelope.section}"`);
        return null;
    }
    if (typeof envelope.schema !== 'number' || envelope.schema > USER_LISTS_SCHEMA) {
        warn?.(`unsupported schema ${envelope.schema} (max ${USER_LISTS_SCHEMA})`);
        return null;
    }
    return envelope.data && typeof envelope.data === 'object' ? envelope.data : null;
}

/** Merge another diff document into `doc` (import): other's entries / hidden win per key. */
export function mergeUserListsDocs(doc, other) {
    const result = normalizeUserLists(doc);
    const incoming = normalizeUserLists(other);
    for (const list of USER_LIST_KEYS) {
        Object.assign(result[list].entries, incoming[list].entries);
        result[list].hidden = [...new Set([...result[list].hidden, ...incoming[list].hidden])];
    }
    return result;
}

/** Small summary for logs / UI: entry and hidden counts per list. */
export function summarizeUserLists(doc) {
    const summary = {};
    for (const list of USER_LIST_KEYS) {
        summary[list] = {
            entries: Object.keys(doc?.[list]?.entries ?? {}).length,
            hidden: (doc?.[list]?.hidden ?? []).length,
        };
    }
    return summary;
}
