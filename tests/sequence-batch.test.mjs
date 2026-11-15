import assert from 'node:assert/strict';
import test from 'node:test';

import {
  SCENE_KEYS,
  addToHistory,
  applyLegacyTexts,
  candidateSeed,
  expandSequenceRows,
  moveScene,
  normalizeEditBackup,
  normalizeScenes,
  normalizeSequence,
  normalizeSequenceDocument,
  patchRecipePrompt,
  pickRandomCharacters,
  pickSceneSettings,
  readSceneText,
  sanitizeName,
  sequenceQueueLabel,
  sequenceRunId,
  sequenceSaveTarget,
  sequenceStartBlockers,
} from '../scripts/shared/sequenceBatch.js';

const settingsA = { prompt: { api_prompt: 'waking up' }, generation: { width: 832 }, lora: { lora_slot: [] } };
const settingsB = { prompt: { api_prompt: 'walking' }, generation: { width: 1024 }, lora: { lora_slot: [['city.safetensors', '0.6', '0.6', 'ALL']] } };
const scenes = [
  { id: 'a', name: '起床', settings: settingsA },
  { id: 'b', name: '外出', settings: settingsB },
];

test('rows run scene by scene, then character, then candidate', () => {
  const rows = expandSequenceRows({ characters: ['A', 'B'], scenes, candidates: 2, baseSeed: 10 });
  assert.equal(rows.length, 2 * 2 * 2);
  assert.deepEqual(rows.map(row => `${row.sceneIndex}${row.characterKey}${row.candidate}`),
    ['0A0', '0A1', '0B0', '0B1', '1A0', '1A1', '1B0', '1B1']);
  assert.equal(rows[4].sceneName, '外出');
  assert.equal(rows[4].sceneId, 'b');
  assert.equal(rows[2].characterIndex, 1);
});

test('candidate seeds match across characters and scenes and wrap at 2^32', () => {
  const rows = expandSequenceRows({ characters: ['A', 'B'], scenes, candidates: 3, baseSeed: 2 ** 32 - 2 });
  for (const row of rows) assert.equal(row.seed, candidateSeed(2 ** 32 - 2, row.candidate));
  assert.deepEqual([0, 1, 2].map(c => candidateSeed(2 ** 32 - 2, c)), [4294967294, 4294967295, 0]);
});

test('candidates are clamped to 1..16', () => {
  assert.equal(expandSequenceRows({ characters: ['A'], scenes, candidates: 0 }).length, 2);
  assert.equal(expandSequenceRows({ characters: ['A'], scenes, candidates: 99 }).length, 32);
});

test('random pick: distinct, capped at the pool, deterministic with an injected rng', () => {
  const pool = ['a', 'b', 'c', 'd', 'e'];
  let seed = 1;
  const rng = () => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; };
  const picked = pickRandomCharacters(pool, 3, rng);
  assert.equal(new Set(picked).size, 3);
  assert.ok(picked.every(key => pool.includes(key)));
  seed = 1;
  assert.deepEqual(pickRandomCharacters(pool, 3, rng), picked);
  assert.equal(pickRandomCharacters(pool, 99).length, 5);
  assert.equal(pickRandomCharacters(pool, 0).length, 0);
});

test('names lose Windows-forbidden characters and are cut at 40', () => {
  assert.equal(sanitizeName('a/b:c*d?"e<f>g|h\\i'), 'a_b_c_d__e_f_g_h_i');
  assert.equal(sanitizeName('x'.repeat(60)).length, 40);
  assert.equal(sanitizeName('   '), '_');
  assert.equal(sanitizeName('name. '), 'name');
});

test('save prefix and queue label', () => {
  assert.deepEqual(sequenceSaveTarget({ runId: '20261114-101500', characterName: 'Frieren', sceneIndex: 1, sceneName: '外出/朝', candidate: 2 }),
    { path: 'seq-20261114-101500', filename: 'Frieren_p03_s02-外出_朝' });
  // by name: character, then pattern (candidate), then scene
  const names = [];
  for (const characterName of ['Fern', 'Frieren']) {
    for (let sceneIndex = 0; sceneIndex < 2; sceneIndex++) {
      for (let candidate = 0; candidate < 2; candidate++) names.push(sequenceSaveTarget({ runId: 'x', characterName, sceneIndex, sceneName: `S${sceneIndex}`, candidate }).filename);
    }
  }
  assert.deepEqual([...names].sort(), ['Fern_p01_s01-S0', 'Fern_p01_s02-S1', 'Fern_p02_s01-S0', 'Fern_p02_s02-S1', 'Frieren_p01_s01-S0', 'Frieren_p01_s02-S1', 'Frieren_p02_s01-S0', 'Frieren_p02_s02-S1']);
  assert.equal(sequenceQueueLabel({ characterName: 'Frieren', sceneName: '外出', candidate: 0 }), '[Seq] Frieren / 外出 #1');
  assert.equal(sequenceRunId(new Date(2026, 10, 14, 9, 5, 7)), '20261114-090507');
});

test('a scene owns the prompts, the LoRA rows and the generation settings, not the characters or the model', () => {
  const picked = pickSceneSettings({
    prompt: { api_prompt: 'p', api_neg_prompt: 'n', prompt_custom_fields: [{ id: 'cf_a', text: 'x' }], character_slots: [{ key: 'K' }], ai_prompt_role: 'x' },
    generation: { width: 832, step: 28, api_hf_enable: true, api_model_file_select: 'model.safetensors', random_seed: 5, regional_condition: true },
    lora: { lora_slot: [['a.safetensors', '1', '1', 'ALL']] },
    adetailer: { api_adetailer_enable: true },
  });
  assert.deepEqual(picked, {
    prompt: { api_prompt: 'p', api_neg_prompt: 'n', prompt_custom_fields: [{ id: 'cf_a', text: 'x' }] },
    generation: { width: 832, step: 28, api_hf_enable: true },
    lora: { lora_slot: [['a.safetensors', '1', '1', 'ALL']] },
  });
  assert.equal(pickSceneSettings({ adetailer: { api_adetailer_enable: true } }), null, 'nothing of a scene');
  assert.equal(pickSceneSettings(null), null);
  for (const key of ['character_slots', 'character1']) assert.ok(!SCENE_KEYS.prompt.includes(key));
  for (const key of ['api_model_file_select', 'random_seed', 'batch', 'regional_condition']) assert.ok(!SCENE_KEYS.generation.includes(key));
});

test('old scene texts are written over settings: built-in fields and custom fields', () => {
  const base = { prompt: { api_prompt: 'mine', prompt_background: 'room', prompt_custom_fields: [{ id: 'cf_a', text: 'old' }, { id: 'cf_b', text: 'keep' }] }, generation: {}, lora: {} };
  const out = applyLegacyTexts(base, { cf_a: 'walking', background: 'street', cf_gone: 'x' });
  assert.equal(out.prompt.prompt_background, 'street');
  assert.equal(out.prompt.api_prompt, 'mine');
  assert.deepEqual(out.prompt.prompt_custom_fields.map(field => field.text), ['walking', 'keep']);
  assert.equal(base.prompt.prompt_custom_fields[0].text, 'old', 'the input is not changed');
});

test('recipe patch: slot 1 is the row character, the others None', () => {
  const prompt = {
    character_slots: [{ key: 'X', weight: 0.8 }, { key: 'Y', weight: 1 }, { key: 'Random', weight: 1 }],
    character1: 'X', character2: 'Y', character3: 'Random', api_prompt: 'keep',
  };
  const patched = patchRecipePrompt(prompt, { characterKey: 'K' });
  assert.deepEqual(patched.character_slots, [{ key: 'K', weight: 0.8 }, { key: 'None', weight: 1 }, { key: 'None', weight: 1 }]);
  assert.equal(patched.character1, 'K');
  assert.equal(patched.character2, 'None');
  assert.equal(patched.api_prompt, 'keep');
  assert.equal(prompt.character1, 'X', 'the input is not changed');
});

test('a field\'s text from a prompt section: custom field, built-in field, missing field', () => {
  const prompt = { prompt_style: 'flat color', api_prompt: '1girl', prompt_custom_fields: [{ id: 'cf_a', text: 'walking' }] };
  assert.equal(readSceneText(prompt, 'cf_a'), 'walking');
  assert.equal(readSceneText(prompt, 'style'), 'flat color');
  assert.equal(readSceneText(prompt, 'positive'), '1girl');
  assert.equal(readSceneText(prompt, 'cf_missing'), null);
  assert.equal(readSceneText(prompt, 'background'), null);
  assert.equal(readSceneText(null, 'cf_a'), null);
});

test('scenes get ids, names, settings, a JPEG thumb only, the adopted image and the history', () => {
  let n = 0;
  const list = normalizeScenes([
    { id: 'a', name: '起床', settings: { prompt: { api_prompt: 'x', character1: 'K' } }, thumb: 'data:image/jpeg;base64,AAAA' },
    { id: 'a', name: '', thumb: 'https://example.com/x.jpg', texts: { cf_a: 'sit', cf_b: 5 } },
    'junk',
  ], { makeId: () => `new${++n}` });
  assert.equal(list.length, 2);
  assert.deepEqual(list[0], { id: 'a', name: '起床', settings: { prompt: { api_prompt: 'x' }, generation: {}, lora: {} }, thumb: 'data:image/jpeg;base64,AAAA', image: '', history: [] });
  assert.deepEqual(list[1], { id: 'new1', name: 'Scene 2', settings: null, thumb: '', image: '', history: [], texts: { cf_a: 'sit' } }, 'an old scene keeps its texts until it gets settings');
});

test('a scene keeps its adopted image and its history: distinct paths, oldest first, the newest 60', () => {
  const [scene] = normalizeScenes([{ id: 'a', image: ' C:/out/b.png ', history: ['C:\\out\\a.png', 'C:/out/b.png', 'c:/OUT/A.png', '', 5] }]);
  assert.equal(scene.image, 'C:/out/b.png');
  assert.deepEqual(scene.history, ['C:/out/b.png', 'c:/OUT/A.png']);
  assert.deepEqual(addToHistory(['x.png', 'y.png'], 'X.PNG'), ['y.png', 'X.PNG']);
  const long = Array.from({ length: 70 }, (_, i) => `f${i}.png`);
  assert.equal(normalizeScenes([{ id: 'a', history: long }])[0].history.length, 60);
  assert.equal(normalizeScenes([{ id: 'a', history: long }])[0].history[0], 'f10.png');
});

test('a sequence of the one-field kind keeps each scene text under that field', () => {
  assert.deepEqual(normalizeSequence({ field: 'cf_a', scenes: [{ id: 'a', name: 'A', text: 'sit' }] }).scenes[0].texts, { cf_a: 'sit' });
  assert.deepEqual(normalizeSequence({ fields: ['cf_a', 'background'], scenes: [{ id: 'a', texts: { cf_a: 'sit', background: 'room' } }] }).scenes[0].texts, { cf_a: 'sit', background: 'room' });
});

test('store document normalizes saved sequences, the current one and the edit backup', () => {
  const doc = normalizeSequenceDocument({
    sequences: { '一日の流れ': { scenes }, '': { scenes: [] } },
    current: { name: '一日の流れ', scenes: [scenes[0]] },
    editBackup: { settings: settingsB, sceneId: 'b' },
  });
  assert.deepEqual(Object.keys(doc.sequences), ['一日の流れ']);
  assert.equal(doc.sequences['一日の流れ'].scenes.length, 2);
  assert.deepEqual(doc.sequences['一日の流れ'].scenes[1].settings, settingsB);
  assert.equal(doc.current.name, '一日の流れ');
  assert.equal(doc.current.scenes.length, 1);
  assert.deepEqual(doc.editBackup, { settings: settingsB, sceneId: 'b' }, 'the scene the mode had, to come back to');
  assert.deepEqual(normalizeSequenceDocument(null), { sequences: {}, current: { name: '', scenes: [] }, editBackup: null });
});

test('the edit backup: settings, or the texts of an older edit mode, else null', () => {
  assert.deepEqual(normalizeEditBackup({ settings: settingsA, sceneId: ' a ' }), { settings: settingsA, sceneId: 'a' });
  assert.deepEqual(normalizeEditBackup({ settings: settingsA }), { settings: settingsA, sceneId: '' });
  assert.deepEqual(normalizeEditBackup({ texts: { cf_a: 'mine' } }), { texts: { cf_a: 'mine' } });
  assert.deepEqual(normalizeEditBackup({ fieldKey: 'cf_a', text: 'mine' }), { texts: { cf_a: 'mine' } });
  assert.equal(normalizeEditBackup({ texts: {} }), null);
  assert.equal(normalizeEditBackup(null), null);
});

test('start blockers: each condition gives its own reason only', () => {
  const ok = { characters: 2, scenes };
  assert.deepEqual(sequenceStartBlockers(ok), []);
  assert.deepEqual(sequenceStartBlockers({ ...ok, characters: 0 }), ['no-characters']);
  assert.deepEqual(sequenceStartBlockers({ ...ok, scenes: [] }), ['no-scenes']);
  assert.deepEqual(sequenceStartBlockers({ ...ok, scenes: [...scenes, { id: 'c', name: 'c', settings: null }] }), ['empty-scene']);
  assert.deepEqual(sequenceStartBlockers({ ...ok, regional: true }), ['regional']);
  assert.deepEqual(sequenceStartBlockers({ ...ok, controlNet: 1 }), ['controlnet']);
  assert.deepEqual(sequenceStartBlockers({ ...ok, controlNet: 0 }), []);
  assert.deepEqual(sequenceStartBlockers({ ...ok, backend: 'WebUI' }), ['webui']);
  assert.deepEqual(sequenceStartBlockers({ ...ok, modelType: 'Diffusion' }), ['diffusion']);
  assert.deepEqual(sequenceStartBlockers({ ...ok, busy: true }), ['busy']);
});

test('moving a scene drops it before the target index', () => {
  const list = ['a', 'b', 'c', 'd'];
  assert.deepEqual(moveScene(list, 0, 2), ['b', 'a', 'c', 'd']);
  assert.deepEqual(moveScene(list, 3, 0), ['d', 'a', 'b', 'c']);
  assert.deepEqual(moveScene(list, 1, 4), ['a', 'c', 'd', 'b']);
  assert.deepEqual(moveScene(list, 1, 2), list);
  assert.deepEqual(moveScene(list, 9, 0), list);
});

test('a sequence row override: the row seed and slot 1 character; the fields come from the screen', async () => {
  const { beginSequenceOverride, endImageOverride, getActiveOverride, overrideSeed, readPromptValue } = await import('../scripts/renderer/tools/promptBatchExpansion.js');
  globalThis.globalSettings = { prompt_field_muted: [], prompt_custom_fields: [{ id: 'cf_a', name: 'Action', polarity: 'positive', text: 'screen text' }] };
  globalThis.prompt = { cf_a: { getValue: () => 'walking, ~hat, street' } };
  try {
    beginSequenceOverride({ row: { seed: 77, characterKey: 'K' }, imageIndex: 3 });
    assert.equal(readPromptValue('cf_a'), 'walking, street', 'the screen text, with a toggled-off tag dropped');
    assert.equal(overrideSeed(-1), 77);
    assert.deepEqual(getActiveOverride().characters, ['K']);
    endImageOverride();
    assert.equal(getActiveOverride(), null);
  } finally {
    endImageOverride();
    delete globalThis.globalSettings;
    delete globalThis.prompt;
  }
});

test('a recipe keeps the run.sequence facts and the edit-mode scene, and drops them when absent', async () => {
  const { buildRecipe } = await import('../scripts/shared/recipe.js');
  const sequence = { runId: '20261114-101500', sequenceName: '一日の流れ', sceneId: 'b', characterKey: 'K', characterIndex: 1, sceneIndex: 2, sceneName: '外出', candidate: 0, candidates: 3, total: 18 };
  assert.deepEqual(buildRecipe({ run: { seed: 1, sequence } }).run.sequence, sequence);
  assert.equal('sequence' in buildRecipe({ run: { seed: 1 } }).run, false);
  assert.equal(buildRecipe({ run: { seed: 1, sequenceScene: 's1' } }).run.sequenceScene, 's1');
  assert.equal('sequenceScene' in buildRecipe({ run: { seed: 1 } }).run, false);
});

test('a sequence run folder reads in file-name order in the Library: character, pattern, scene', async () => {
  const { isSequenceRunFolder } = await import('../scripts/shared/sequenceBatch.js');
  assert.equal(isSequenceRunFolder('seq-20261114-101500'), true);
  assert.equal(isSequenceRunFolder('2026-11-14'), false);
  assert.equal(isSequenceRunFolder('seq-notes'), false);
  const { sortEntriesByName } = await import('../scripts/renderer/libraryWindow.js');
  const names = ['Frieren_p01_s01-A.png', 'Fern_p02_s01-A.png', 'Fern_p01_s10-J.png', 'Fern_p01_s02-B.png', 'fern_p01_s01-A.png'];
  assert.deepEqual(sortEntriesByName(names.map(name => ({ name }))).map(entry => entry.name),
    ['fern_p01_s01-A.png', 'Fern_p01_s02-B.png', 'Fern_p01_s10-J.png', 'Fern_p02_s01-A.png', 'Frieren_p01_s01-A.png']);
});
