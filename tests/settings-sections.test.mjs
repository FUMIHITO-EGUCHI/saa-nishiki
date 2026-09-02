import assert from 'node:assert/strict';
import test from 'node:test';
import {
    DEFAULT_SETTINGS, SECTION_KEYS, SECTIONS, PRESET_SECTIONS, KEY_ALIASES,
    sectionOf, normalizeSection, pickSection, splitFlat, mergeSections,
    makeEnvelope, readEnvelope, sanitizePresetName, SCHEMA_VERSION,
} from '../scripts/shared/settingsSections.js';

test('every default key belongs to exactly one section and vice versa', () => {
    const seen = new Map();
    for (const section of SECTIONS) {
        for (const key of SECTION_KEYS[section]) {
            assert.ok(!seen.has(key), `${key} listed twice (${seen.get(key)} and ${section})`);
            seen.set(key, section);
            assert.ok(Object.hasOwn(DEFAULT_SETTINGS, key), `${key} in ${section} has no default`);
        }
    }
    for (const key of Object.keys(DEFAULT_SETTINGS)) {
        assert.ok(seen.has(key), `${key} has a default but no section`);
    }
    assert.deepEqual(PRESET_SECTIONS, ['prompt', 'generation', 'lora', 'adetailer', 'controlnet']);
});

test('sectionOf resolves aliases the renderer used to write', () => {
    assert.equal(sectionOf('api_addr'), 'app');
    assert.equal(sectionOf('api_prompt'), 'prompt');
    assert.equal(sectionOf('cfg'), 'generation');
    assert.equal(sectionOf('lora_slot'), 'lora');
    assert.equal(sectionOf('ad_slot'), 'adetailer');
    assert.equal(sectionOf('controlnet_slot'), 'controlnet');
    for (const [alias, key] of Object.entries(KEY_ALIASES)) assert.equal(sectionOf(alias), sectionOf(key), alias);
    assert.equal(sectionOf('lastLoadedSettings'), null);
});

test('normalizeSection fills defaults, coerces types, resolves aliases and drops foreign keys', () => {
    const warnings = [];
    const generation = normalizeSection('generation', {
        cfg: '5.5', step: 'abc', width: 832, api_hf_enable: 'true', api_prompt: 'foreign', regional_option_left: 42,
    }, { warn: message => warnings.push(message) });
    assert.equal(generation.cfg, 5.5);
    assert.equal(generation.step, DEFAULT_SETTINGS.step);
    assert.equal(generation.width, 832);
    assert.equal(generation.api_hf_enable, true);
    assert.equal(generation.regional_option_left, '42');
    assert.ok(!('api_prompt' in generation));
    assert.deepEqual(Object.keys(generation).sort(), [...SECTION_KEYS.generation].sort());
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /api_prompt/);

    const app = normalizeSection('app', { remote_ai_webui_auth: 'me:secret', diffusion_model_weight_dtype: 'fp8' });
    assert.equal(app.webui_auth, 'me:secret');
    assert.equal(app.api_model_file_diffusion_weight_dtype, 'fp8');
});

test('normalizeSection keeps weights4dropdownlist numeric and batch objects well-formed', () => {
    const prompt = normalizeSection('prompt', {
        weights4dropdownlist: ['1.2', 'x', 0.5],
        positive_batch: { enabled: true, count: '8' },
        negative_batch: 'nope',
        positive_weight_plans: [{ tag: 'a' }],
    });
    // slots 2-3 belonged to the retired Background / Style dropdowns and are pinned to 1
    assert.deepEqual(prompt.weights4dropdownlist, [1.2, 1, 1, 1, 1, 1, 1, 1, 1]);
    assert.deepEqual(prompt.positive_batch, { enabled: true, count: 8 });
    assert.deepEqual(prompt.negative_batch, { enabled: false, count: 4 });
    assert.deepEqual(prompt.positive_weight_plans, [{ tag: 'a' }]);
    assert.throws(() => normalizeSection('bundle', {}), /Unknown settings section/);
});

test('prompt migration converts view background / style selections into the prompt fields', () => {
    const migrated = normalizeSection('prompt', {
        view_background: 'Cafe (Terrace)',
        view_style: 'Random',
        weights4dropdownlist: [1, 1, 1.3, 0.8, 1, 1, 1, 1, 1],
        prompt_background: 'sunset,',
    });
    assert.equal(migrated.prompt_background, 'sunset, (cafe \\(terrace\\):1.3)');
    assert.equal(migrated.prompt_style, 'random');
    assert.equal(migrated.view_background, 'None');
    assert.equal(migrated.view_style, 'None');
    assert.deepEqual(migrated.weights4dropdownlist.slice(2, 4), [1, 1]);

    // already-migrated data passes through unchanged (idempotent)
    const again = normalizeSection('prompt', migrated);
    assert.equal(again.prompt_background, migrated.prompt_background);
    assert.equal(again.prompt_style, migrated.prompt_style);

    const clean = normalizeSection('prompt', { view_background: 'None', view_style: 'none' });
    assert.equal(clean.prompt_background, '');
    assert.equal(clean.prompt_style, '');
});

test('prompt migration builds character_slots from character1-3 and retires weights 4-6', () => {
    const migrated = normalizeSection('prompt', {
        character1: 'gawr gura', character2: 'Random', character3: 'None',
        weights4dropdownlist: [1, 1, 1, 1, 1.2, 0.9, 1, 1.5, 1],
    });
    assert.deepEqual(migrated.character_slots, [
        { key: 'gawr gura', weight: 1.2 },
        { key: 'Random', weight: 0.9 },
        { key: 'None', weight: 1 },
    ]);
    assert.deepEqual(migrated.weights4dropdownlist.slice(4, 7), [1, 1, 1]);
    assert.equal(migrated.weights4dropdownlist[7], 1.5); // regional untouched
    // mirrors follow the slots
    assert.equal(migrated.character1, 'gawr gura');

    // data that already has slots is not rebuilt, and mirrors track the slots
    const kept = normalizeSection('prompt', {
        character_slots: [{ key: 'A', weight: 1 }, { key: 'B', weight: 2 }, { key: 'C', weight: 1 }, { key: 'D', weight: 1 }],
        character1: 'stale',
    });
    assert.equal(kept.character_slots.length, 4);
    assert.equal(kept.character1, 'A');
    assert.equal(kept.character2, 'B');

    // malformed slots fall back to the default trio
    const fallback = normalizeSection('prompt', { character_slots: 'nope' });
    assert.equal(fallback.character_slots.length, 3);
    assert.equal(fallback.character_slots[0].key, 'Random');
});

test('splitFlat / mergeSections round-trip a flat settings object', () => {
    const flat = { ...DEFAULT_SETTINGS, api_addr: '127.0.0.1:8189', api_prompt: '1girl', cfg: 4, lora_slot: [['x', 0.5, 0.5, 'ALL']], ad_slot: [['face_yolov8n.pt']], controlnet_slot: [], junk: 1 };
    const { app, state } = splitFlat(flat);
    assert.equal(app.api_addr, '127.0.0.1:8189');
    assert.equal(state.prompt.api_prompt, '1girl');
    assert.equal(state.generation.cfg, 4);
    assert.deepEqual(state.lora.lora_slot, [['x', 0.5, 0.5, 'ALL']]);
    assert.ok(!('junk' in app));
    const merged = mergeSections(app, state);
    for (const key of Object.keys(DEFAULT_SETTINGS)) assert.ok(key in merged, key);
    assert.equal(merged.api_prompt, '1girl');
    assert.equal(merged.cfg, 4);
    assert.deepEqual(pickSection(merged, 'adetailer'), { api_adetailer_enable: false, ad_slot: [['face_yolov8n.pt']] });
});

test('envelope carries schema / section / version and rejects mismatches', () => {
    const envelope = makeEnvelope('lora', { lora_slot: [] }, { saaVersion: '2.8.9', now: () => new Date('2026-08-30T03:00:00Z') });
    assert.deepEqual(envelope, { schema: SCHEMA_VERSION, section: 'lora', saa_version: '2.8.9', saved_at: '2026-08-30T03:00:00.000Z', data: { lora_slot: [] } });
    assert.deepEqual(readEnvelope('lora', envelope), { lora_slot: [] });
    const warnings = [];
    assert.equal(readEnvelope('prompt', envelope, { warn: m => warnings.push(m) }), null);
    assert.equal(readEnvelope('lora', { ...envelope, schema: SCHEMA_VERSION + 1 }, { warn: m => warnings.push(m) }), null);
    assert.equal(readEnvelope('lora', { version: '2.8.9', api_prompt: 'flat legacy file' }), null);
    assert.equal(warnings.length, 2);
});

test('sanitizePresetName strips path characters and the .json suffix', () => {
    assert.equal(sanitizePresetName('  My Preset.json '), 'My Preset');
    assert.equal(sanitizePresetName('a/b\\c:d*e?f"g<h>i|j'), 'a b c d e f g h i j');
    assert.equal(sanitizePresetName('..hidden'), 'hidden');
    assert.equal(sanitizePresetName('   '), null);
    assert.equal(sanitizePresetName(null), null);
    assert.equal(sanitizePresetName('x'.repeat(100)).length, 64);
});
