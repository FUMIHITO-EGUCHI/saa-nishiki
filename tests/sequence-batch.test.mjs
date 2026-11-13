import assert from 'node:assert/strict';
import test from 'node:test';

import {
  candidateSeed,
  expandSequenceRows,
  moveScene,
  normalizeScenes,
  normalizeSequenceDocument,
  patchRecipePrompt,
  pickRandomCharacters,
  readSceneText,
  sanitizeName,
  sequenceQueueLabel,
  sequenceRunId,
  sequenceSaveTarget,
  sequenceStartBlockers,
} from '../scripts/shared/sequenceBatch.js';

const scenes = [
  { id: 'a', name: '起床', text: 'waking up' },
  { id: 'b', name: '外出', text: 'walking, street' },
];

test('rows run character by character, then scene, then candidate', () => {
  const rows = expandSequenceRows({ characters: ['A', 'B'], scenes, candidates: 2, baseSeed: 10 });
  assert.equal(rows.length, 2 * 2 * 2);
  assert.deepEqual(rows.map(row => `${row.characterKey}${row.sceneIndex}${row.candidate}`),
    ['A00', 'A01', 'A10', 'A11', 'B00', 'B01', 'B10', 'B11']);
  assert.equal(rows[2].sceneText, 'walking, street');
  assert.equal(rows[2].sceneName, '外出');
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
    { path: 'seq-20261114-101500', filename: 'Frieren_s02-外出_朝_c3' });
  assert.equal(sequenceQueueLabel({ characterName: 'Frieren', sceneName: '外出', candidate: 0 }), '[Seq] Frieren / 外出 #1');
  assert.equal(sequenceRunId(new Date(2026, 10, 14, 9, 5, 7)), '20261114-090507');
});

test('recipe patch: slot 1 is the row character, the others None, the scene field holds the scene', () => {
  const prompt = {
    character_slots: [{ key: 'X', weight: 0.8 }, { key: 'Y', weight: 1 }, { key: 'Random', weight: 1 }],
    character1: 'X', character2: 'Y', character3: 'Random',
    prompt_background: 'room',
    prompt_custom_fields: [{ id: 'cf_a', name: 'Action', polarity: 'positive', text: 'old' }, { id: 'cf_b', name: 'B', polarity: 'positive', text: 'keep' }],
  };
  const custom = patchRecipePrompt(prompt, { characterKey: 'K', sceneText: 'new', fieldKey: 'cf_a' });
  assert.deepEqual(custom.character_slots, [{ key: 'K', weight: 0.8 }, { key: 'None', weight: 1 }, { key: 'None', weight: 1 }]);
  assert.equal(custom.character1, 'K');
  assert.equal(custom.character2, 'None');
  assert.equal(custom.prompt_custom_fields[0].text, 'new');
  assert.equal(custom.prompt_custom_fields[1].text, 'keep');
  assert.equal(custom.prompt_background, 'room');
  assert.equal(prompt.prompt_custom_fields[0].text, 'old', 'the input is not changed');
  const builtin = patchRecipePrompt(prompt, { characterKey: 'K', sceneText: 'street', fieldKey: 'background' });
  assert.equal(builtin.prompt_background, 'street');
  assert.equal(builtin.prompt_custom_fields[0].text, 'old');
});

test('scene text from a recipe: custom field, built-in field, missing field', () => {
  const prompt = { prompt_style: 'flat color', prompt_custom_fields: [{ id: 'cf_a', text: 'walking' }] };
  assert.equal(readSceneText(prompt, 'cf_a'), 'walking');
  assert.equal(readSceneText(prompt, 'style'), 'flat color');
  assert.equal(readSceneText(prompt, 'cf_missing'), null);
  assert.equal(readSceneText(prompt, 'background'), null);
  assert.equal(readSceneText(null, 'cf_a'), null);
});

test('scenes get ids and names; a thumb that is not a JPEG data URL is dropped', () => {
  let n = 0;
  const list = normalizeScenes([
    { id: 'a', name: '起床', text: 'x', thumb: 'data:image/jpeg;base64,AAAA' },
    { id: 'a', name: '', text: 5, thumb: 'https://example.com/x.jpg' },
    'junk',
  ], { makeId: () => `new${++n}` });
  assert.equal(list.length, 2);
  assert.deepEqual(list[0], { id: 'a', name: '起床', text: 'x', thumb: 'data:image/jpeg;base64,AAAA' });
  assert.deepEqual(list[1], { id: 'new1', name: 'Scene 2', text: '', thumb: '' });
});

test('store document normalizes saved sequences, the current one and the edit backup', () => {
  const doc = normalizeSequenceDocument({
    sequences: { '一日の流れ': { field: 'cf_a', scenes }, '': { field: 'x' } },
    current: { name: '一日の流れ', field: 'cf_a', scenes: [scenes[0]] },
    editBackup: { fieldKey: 'cf_a', text: 'mine' },
  });
  assert.deepEqual(Object.keys(doc.sequences), ['一日の流れ']);
  assert.equal(doc.sequences['一日の流れ'].scenes.length, 2);
  assert.equal(doc.current.name, '一日の流れ');
  assert.equal(doc.current.scenes.length, 1);
  assert.deepEqual(doc.editBackup, { fieldKey: 'cf_a', text: 'mine' });
  assert.deepEqual(normalizeSequenceDocument(null), { sequences: {}, current: { name: '', field: '', scenes: [] }, editBackup: null });
});

test('start blockers: each condition gives its own reason only', () => {
  const ok = { characters: 2, scenes };
  assert.deepEqual(sequenceStartBlockers(ok), []);
  assert.deepEqual(sequenceStartBlockers({ ...ok, characters: 0 }), ['no-characters']);
  assert.deepEqual(sequenceStartBlockers({ ...ok, scenes: [] }), ['no-scenes']);
  assert.deepEqual(sequenceStartBlockers({ ...ok, scenes: [...scenes, { id: 'c', name: 'c', text: '  ' }] }), ['empty-scene']);
  assert.deepEqual(sequenceStartBlockers({ ...ok, fieldExists: false, fieldMuted: true }), ['no-field']);
  assert.deepEqual(sequenceStartBlockers({ ...ok, fieldMuted: true }), ['field-muted']);
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

test('a sequence row override: scene field text, row seed, slot 1 character, base fields kept', async () => {
  const { beginSequenceOverride, endImageOverride, getActiveOverride, overrideSeed, readPromptValue } = await import('../scripts/renderer/tools/promptBatchExpansion.js');
  globalThis.globalSettings = { prompt_field_muted: [], prompt_custom_fields: [{ id: 'cf_a', name: 'Action', polarity: 'positive', text: 'screen text' }] };
  globalThis.prompt = { cf_a: { getValue: () => 'screen text' }, common: { getValue: () => 'live common' } };
  try {
    beginSequenceOverride({ baseFields: { common: 'frozen common' }, fieldKey: 'cf_a', row: { sceneText: 'walking, ~hat, street', seed: 77, characterKey: 'K' }, imageIndex: 3 });
    assert.equal(readPromptValue('cf_a'), 'walking, street', 'the scene text, with a toggled-off tag dropped');
    assert.equal(readPromptValue('common'), 'frozen common');
    assert.equal(overrideSeed(-1), 77);
    assert.deepEqual(getActiveOverride().characters, ['K']);
    endImageOverride();
    assert.equal(readPromptValue('cf_a'), 'screen text');
  } finally {
    endImageOverride();
    delete globalThis.globalSettings;
    delete globalThis.prompt;
  }
});

test('a recipe keeps the run.sequence facts and drops them when absent', async () => {
  const { buildRecipe } = await import('../scripts/shared/recipe.js');
  const sequence = { runId: '20261114-101500', sequenceName: '一日の流れ', field: 'cf_a', characterKey: 'K', characterIndex: 1, sceneIndex: 2, sceneName: '外出', candidate: 0, candidates: 3, total: 18 };
  assert.deepEqual(buildRecipe({ run: { seed: 1, sequence } }).run.sequence, sequence);
  assert.equal('sequence' in buildRecipe({ run: { seed: 1 } }).run, false);
});
