// Autosave bookkeeping for the sectioned settings (pure: no DOM, no Electron).
//
//   const autosave = createAutosave({ sectionOf, collect, save, saveSync });
//   autosave.markDirty('cfg');            // key or section name
//   autosave.flush();                     // debounced automatically; explicit flush before quit
//
// `collect(section)` returns the current data of one section; `save(sections)` persists
// a { section: data } map and resolves to true on success; `saveSync` is the same for
// `beforeunload`. Nothing is marked dirty while `enabled` is false (startup).
import { sectionOf as defaultSectionOf, isSection as defaultIsSection } from '../../shared/settingsSections.js';

export function createSettingsProxy(target, onSet) {
    return new Proxy(target, {
        set(object, key, value) {
            object[key] = value;
            if (typeof key === 'string') onSet(key);
            return true;
        },
        deleteProperty(object, key) {
            delete object[key];
            if (typeof key === 'string') onSet(key);
            return true;
        },
    });
}

export function createAutosave({
    sectionOf = defaultSectionOf,
    isSection = defaultIsSection,
    collect,
    save,
    saveSync = null,
    debounceMs = 500,
    setTimer = (fn, ms) => setTimeout(fn, ms),
    clearTimer = handle => clearTimeout(handle),
    onSaved = null,
    onError = null,
    log = console,
} = {}) {
    if (typeof collect !== 'function' || typeof save !== 'function') throw new Error('createAutosave: collect and save are required');

    const dirty = new Set();
    let enabled = false;
    let timer = null;
    let inflight = null;
    let saveCount = 0;

    function resolveSection(keyOrSection) {
        if (typeof keyOrSection !== 'string') return null;
        if (isSection(keyOrSection)) return keyOrSection;
        return sectionOf(keyOrSection) ?? null;
    }

    function markDirty(keyOrSection) {
        if (!enabled) return false;
        const section = resolveSection(keyOrSection);
        if (!section) return false;
        dirty.add(section);
        schedule();
        return true;
    }

    function schedule() {
        if (timer !== null) clearTimer(timer);
        timer = setTimer(() => { timer = null; flush(); }, debounceMs);
    }

    function takePayload() {
        const payload = {};
        for (const section of dirty) payload[section] = collect(section);
        dirty.clear();
        return payload;
    }

    async function flush() {
        if (timer !== null) { clearTimer(timer); timer = null; }
        if (inflight) await inflight;
        if (dirty.size === 0) return true;
        const payload = takePayload();
        const sections = Object.keys(payload);
        inflight = (async () => {
            try {
                const ok = await save(payload);
                if (ok) { saveCount += 1; onSaved?.(sections); }
                else { for (const section of sections) dirty.add(section); onError?.(new Error('save returned false'), sections); }
                return Boolean(ok);
            } catch (error) {
                for (const section of sections) dirty.add(section);
                log?.error?.('[Autosave]', error);
                onError?.(error, sections);
                return false;
            } finally {
                inflight = null;
            }
        })();
        return inflight;
    }

    function flushSync() {
        if (timer !== null) { clearTimer(timer); timer = null; }
        if (dirty.size === 0 || typeof saveSync !== 'function') return dirty.size === 0;
        const payload = takePayload();
        try {
            const ok = saveSync(payload);
            if (ok) saveCount += 1;
            return Boolean(ok);
        } catch (error) {
            log?.error?.('[Autosave] sync flush failed', error);
            return false;
        }
    }

    return {
        markDirty,
        flush,
        flushSync,
        enable(value = true) { enabled = Boolean(value); },
        isEnabled: () => enabled,
        pending: () => [...dirty],
        saveCount: () => saveCount,
    };
}
