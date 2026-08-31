import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createSettingsStore, readJsonWithFallback, writeJsonAtomic } from '../scripts/main/settingsStore.js';
import { DEFAULT_SETTINGS } from '../scripts/shared/settingsSections.js';

const quiet = { log() {}, warn() {}, error() {} };

function tempDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'saa-settings-'));
}

function readJson(file) {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
}

test('writeJsonAtomic keeps one .bak generation and never leaves a .tmp behind', () => {
    const dir = tempDir();
    const file = path.join(dir, 'nested', 'a.json');
    writeJsonAtomic(file, { n: 1 });
    writeJsonAtomic(file, { n: 2 });
    writeJsonAtomic(file, { n: 3 });
    assert.deepEqual(readJson(file), { n: 3 });
    assert.deepEqual(readJson(`${file}.bak`), { n: 2 });
    assert.ok(!fs.existsSync(`${file}.tmp`));
});

test('readJsonWithFallback returns the .bak when the main file is corrupt', () => {
    const dir = tempDir();
    const file = path.join(dir, 'b.json');
    writeJsonAtomic(file, { ok: 1 });
    writeJsonAtomic(file, { ok: 2 });
    fs.writeFileSync(file, '{ truncated', 'utf8');
    const result = readJsonWithFallback(file);
    assert.deepEqual(result.value, { ok: 1 });
    assert.equal(result.source, 'bak');
    assert.ok(result.error);
    assert.deepEqual(readJsonWithFallback(path.join(dir, 'missing.json')), { value: null, source: null, error: null });
});

test('app / state start from defaults, persist through saveSections and merge back flat', () => {
    const dir = tempDir();
    const store = createSettingsStore({ rootDir: dir, saaVersion: '2.8.9', log: quiet, now: () => new Date('2026-08-30T00:00:00Z') });
    const flat = store.getMerged();
    assert.equal(flat.api_prompt, DEFAULT_SETTINGS.api_prompt);
    assert.ok(!fs.existsSync(store.paths.appFile));

    store.saveSections({ app: { api_addr: '127.0.0.1:8189', junk: true }, prompt: { api_prompt: '1girl' }, lora: { lora_slot: [['x', 0.7, 0.7, 'ALL']] } });
    const app = readJson(store.paths.appFile);
    assert.equal(app.schema, 1);
    assert.equal(app.section, 'app');
    assert.equal(app.saa_version, '2.8.9');
    assert.equal(app.saved_at, '2026-08-30T00:00:00.000Z');
    assert.equal(app.data.api_addr, '127.0.0.1:8189');
    assert.ok(!('junk' in app.data));
    assert.ok(!('api_prompt' in app.data));
    const state = readJson(store.paths.stateFile);
    assert.equal(state.section, 'state');
    assert.equal(state.data.prompt.api_prompt, '1girl');
    assert.deepEqual(state.data.lora.lora_slot, [['x', 0.7, 0.7, 'ALL']]);
    assert.equal(state.data.generation.cfg, DEFAULT_SETTINGS.cfg);

    // partial patch keeps the other keys of the section
    store.saveSections({ prompt: { api_neg_prompt: 'bad' } });
    const again = createSettingsStore({ rootDir: dir, log: quiet });
    const merged = again.getMerged();
    assert.equal(merged.api_prompt, '1girl');
    assert.equal(merged.api_neg_prompt, 'bad');
    assert.equal(merged.api_addr, '127.0.0.1:8189');
});

test('a corrupt state.json falls back to its .bak and a foreign envelope is ignored', () => {
    const dir = tempDir();
    const store = createSettingsStore({ rootDir: dir, log: quiet });
    store.saveState({ generation: { cfg: 3 } });
    store.saveState({ generation: { cfg: 4 } });
    fs.writeFileSync(store.paths.stateFile, 'not json', 'utf8');
    assert.equal(createSettingsStore({ rootDir: dir, log: quiet }).getMerged().cfg, 3);

    fs.writeFileSync(store.paths.appFile, JSON.stringify({ schema: 1, section: 'prompt', data: { api_prompt: 'x' } }), 'utf8');
    const merged = createSettingsStore({ rootDir: dir, log: quiet }).getMerged();
    assert.equal(merged.api_addr, DEFAULT_SETTINGS.api_addr);
});

test('presets are per section, sorted, sanitized, and never accept app or bundle', () => {
    const dir = tempDir();
    const store = createSettingsStore({ rootDir: dir, log: quiet });
    assert.deepEqual(store.listPresets('lora'), []);
    assert.deepEqual(store.savePreset('lora', 'Detail: v4/x', { lora_slot: [['detail', 0.5, 0.5, 'ALL']], api_prompt: 'ignored' }), { ok: true, name: 'Detail v4 x' });
    assert.deepEqual(store.savePreset('lora', 'base', { lora_slot: [] }), { ok: true, name: 'base' });
    assert.deepEqual(store.listPresets('lora'), ['base', 'Detail v4 x']);
    assert.deepEqual(store.loadPreset('lora', 'Detail v4 x'), { lora_slot: [['detail', 0.5, 0.5, 'ALL']] });
    assert.equal(store.loadPreset('lora', 'nope'), null);
    assert.equal(store.loadPreset('prompt', 'base'), null);
    assert.deepEqual(store.savePreset('app', 'x', {}), { ok: false, name: null });
    assert.deepEqual(store.savePreset('bundle', 'x', {}), { ok: false, name: null });
    assert.deepEqual(store.savePreset('lora', '   ', {}), { ok: false, name: null });
    assert.equal(store.deletePreset('lora', 'base'), true);
    assert.equal(store.deletePreset('lora', 'base'), false);
    assert.deepEqual(store.listPresets('lora'), ['Detail v4 x']);
    assert.ok(fs.existsSync(path.join(dir, 'presets', 'lora', 'Detail v4 x.json')));
});

test('stashLegacy moves pre-split files to legacy/ once and reads nothing from them', () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ version: '2.8.9', api_prompt: 'legacy', api_addr: '127.0.0.1:8189' }), 'utf8');
    fs.writeFileSync(path.join(dir, 'Base.json'), '{}', 'utf8');
    fs.writeFileSync(path.join(dir, 'settings.json.20260825.bak'), '{}', 'utf8');
    fs.mkdirSync(path.join(dir, 'MiraITU'));
    fs.writeFileSync(path.join(dir, 'MiraITU', 'settings.json'), '{}', 'utf8');
    const store = createSettingsStore({ rootDir: dir, log: quiet });
    assert.deepEqual(store.stashLegacy().sort(), ['Base.json', 'settings.json', 'settings.json.20260825.bak']);
    assert.ok(fs.existsSync(path.join(dir, 'legacy', 'settings.json')));
    assert.ok(!fs.existsSync(path.join(dir, 'settings.json')));
    assert.ok(fs.existsSync(path.join(dir, 'MiraITU', 'settings.json')));
    assert.equal(store.getMerged().api_prompt, DEFAULT_SETTINGS.api_prompt);
    store.saveApp({ language: 'ja-JP' });
    fs.writeFileSync(path.join(dir, 'late.json'), '{}', 'utf8');
    assert.deepEqual(store.stashLegacy(), []);
});
