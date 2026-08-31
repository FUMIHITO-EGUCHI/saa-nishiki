// On-disk settings store (main process). Node fs only — no Electron — so it is unit-testable.
//
//   settings/app.json                  app section, autosaved
//   settings/state.json                prompt / generation / lora / adetailer / controlnet working state, autosaved
//   settings/presets/<section>/<name>.json
//   settings/legacy/                   pre-split settings/*.json moved here on first start (never read)
//   *.bak                              previous version of each file (one generation)
//
// Every write is tmp → rename; every read falls back to the .bak when the main file is unreadable.
import fs from 'node:fs';
import path from 'node:path';
import {
    DEFAULT_SETTINGS, PRESET_SECTIONS, STATE_SECTIONS, isPresetSection, isSection,
    makeEnvelope, mergeSections, normalizeSection, readEnvelope, sanitizePresetName, clone,
} from '../shared/settingsSections.js';

const CAT = '[SettingsStore]';

export function writeJsonAtomic(filePath, value, fsImpl = fs) {
    const tmp = `${filePath}.tmp`;
    fsImpl.mkdirSync(path.dirname(filePath), { recursive: true });
    fsImpl.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8');
    if (fsImpl.existsSync(filePath)) {
        const bak = `${filePath}.bak`;
        try { fsImpl.rmSync(bak, { force: true }); } catch { /* ignore */ }
        fsImpl.renameSync(filePath, bak);
    }
    fsImpl.renameSync(tmp, filePath);
}

/** @returns {{ value: any, source: 'main' | 'bak' | null, error: Error | null }} */
export function readJsonWithFallback(filePath, fsImpl = fs) {
    let error = null;
    for (const [candidate, source] of [[filePath, 'main'], [`${filePath}.bak`, 'bak']]) {
        if (!fsImpl.existsSync(candidate)) continue;
        try {
            return { value: JSON.parse(fsImpl.readFileSync(candidate, 'utf8')), source, error };
        } catch (caught) {
            error = caught;
        }
    }
    return { value: null, source: null, error };
}

export function createSettingsStore({ rootDir, saaVersion = DEFAULT_SETTINGS.version, now = () => new Date(), log = console, fsImpl = fs } = {}) {
    if (!rootDir) throw new Error('createSettingsStore: rootDir is required');
    const appFile = path.join(rootDir, 'app.json');
    const stateFile = path.join(rootDir, 'state.json');
    const presetsDir = path.join(rootDir, 'presets');
    const legacyDir = path.join(rootDir, 'legacy');
    const warn = message => log?.warn?.(CAT, message);

    let app = null;
    let state = null;

    function readSectionFile(file, section) {
        const { value, source, error } = readJsonWithFallback(file, fsImpl);
        if (error) warn(`${path.basename(file)}: ${error.message}${source ? ` (using ${source})` : ''}`);
        if (!value) return null;
        const data = readEnvelope(section, value, { warn });
        if (!data) warn(`${path.basename(file)}: not a "${section}" file, using defaults`);
        return data;
    }

    function writeSectionFile(file, section, data) {
        writeJsonAtomic(file, makeEnvelope(section, data, { saaVersion, now }), fsImpl);
    }

    function loadApp() {
        app = normalizeSection('app', readSectionFile(appFile, 'app'), { warn });
        return clone(app);
    }

    function loadState() {
        const raw = readSectionFile(stateFile, 'state') ?? {};
        state = {};
        for (const section of STATE_SECTIONS) state[section] = normalizeSection(section, raw[section], { warn });
        return clone(state);
    }

    function ensureLoaded() {
        if (!app) loadApp();
        if (!state) loadState();
    }

    function saveApp(patch) {
        ensureLoaded();
        app = normalizeSection('app', { ...app, ...(patch ?? {}) }, { warn });
        writeSectionFile(appFile, 'app', app);
        return clone(app);
    }

    /** patch = { prompt?: {...}, generation?: {...}, ... } — full section objects or partial patches. */
    function saveState(patch) {
        ensureLoaded();
        let changed = false;
        for (const [section, data] of Object.entries(patch ?? {})) {
            if (!STATE_SECTIONS.includes(section)) { warn(`saveState: ignoring section "${section}"`); continue; }
            state[section] = normalizeSection(section, { ...state[section], ...(data ?? {}) }, { warn });
            changed = true;
        }
        if (changed) writeSectionFile(stateFile, 'state', state);
        return clone(state);
    }

    /** Route a mixed { app?, prompt?, ... } payload to the right files. Returns the merged flat object. */
    function saveSections(payload) {
        const statePatch = {};
        for (const [section, data] of Object.entries(payload ?? {})) {
            if (section === 'app') saveApp(data);
            else if (STATE_SECTIONS.includes(section)) statePatch[section] = data;
            else warn(`saveSections: ignoring section "${section}"`);
        }
        if (Object.keys(statePatch).length) saveState(statePatch);
        return getMerged();
    }

    function getMerged() {
        ensureLoaded();
        return mergeSections(app, state);
    }

    function presetDir(section) {
        return path.join(presetsDir, section);
    }

    function presetFile(section, name) {
        const safe = sanitizePresetName(name);
        if (!isPresetSection(section) || !safe) return null;
        return path.join(presetDir(section), `${safe}.json`);
    }

    function listPresets(section) {
        if (!isPresetSection(section)) return [];
        const dir = presetDir(section);
        if (!fsImpl.existsSync(dir)) return [];
        return fsImpl.readdirSync(dir)
            .filter(file => file.toLowerCase().endsWith('.json'))
            .map(file => file.slice(0, -5))
            .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
    }

    function savePreset(section, name, data) {
        const file = presetFile(section, name);
        if (!file) return { ok: false, name: null };
        try {
            writeSectionFile(file, section, normalizeSection(section, data, { warn }));
            return { ok: true, name: path.basename(file, '.json') };
        } catch (error) {
            log?.error?.(CAT, `savePreset ${section}/${name}: ${error.message}`);
            return { ok: false, name: null };
        }
    }

    function loadPreset(section, name) {
        const file = presetFile(section, name);
        if (!file || !fsImpl.existsSync(file)) return null;
        const data = readSectionFile(file, section);
        return data ? normalizeSection(section, data, { warn }) : null;
    }

    function deletePreset(section, name) {
        const file = presetFile(section, name);
        if (!file || !fsImpl.existsSync(file)) return false;
        try {
            fsImpl.rmSync(file);
            try { fsImpl.rmSync(`${file}.bak`, { force: true }); } catch { /* ignore */ }
            return true;
        } catch (error) {
            log?.error?.(CAT, `deletePreset ${section}/${name}: ${error.message}`);
            return false;
        }
    }

    /**
     * First start on a pre-split settings directory: move every top-level *.json / *.bak
     * (except app.json / state.json and their .bak) into legacy/. Nothing is read from them.
     * @returns {string[]} moved file names
     */
    function stashLegacy() {
        if (!fsImpl.existsSync(rootDir)) return [];
        if (fsImpl.existsSync(appFile)) return [];
        const keep = new Set(['app.json', 'state.json', 'app.json.bak', 'state.json.bak', 'app.json.tmp', 'state.json.tmp']);
        const moved = [];
        for (const entry of fsImpl.readdirSync(rootDir, { withFileTypes: true })) {
            if (!entry.isFile() || keep.has(entry.name)) continue;
            if (!/\.(json|bak)$/i.test(entry.name)) continue;
            fsImpl.mkdirSync(legacyDir, { recursive: true });
            fsImpl.renameSync(path.join(rootDir, entry.name), path.join(legacyDir, entry.name));
            moved.push(entry.name);
        }
        if (moved.length) log?.log?.(CAT, `moved ${moved.length} pre-split file(s) to ${legacyDir}`);
        return moved;
    }

    return {
        paths: { rootDir, appFile, stateFile, presetsDir, legacyDir },
        sections: { preset: PRESET_SECTIONS, state: STATE_SECTIONS, is: isSection },
        loadApp, saveApp, loadState, saveState, saveSections, getMerged,
        listPresets, savePreset, loadPreset, deletePreset,
        stashLegacy,
    };
}
