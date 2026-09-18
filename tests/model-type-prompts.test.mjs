import assert from 'node:assert/strict';
import test from 'node:test';

import {
    PROMPT_STATE_KEYS,
    hasStoredPrompts,
    promptsFor,
    rememberPrompts,
    snapshotPrompts,
} from '../scripts/shared/modelTypePrompts.js';
import { DEFAULT_SETTINGS, SECTION_KEYS, normalizeSection } from '../scripts/shared/settingsSections.js';

const CHECKPOINT = {
    api_prompt: '1girl, solo',
    prompt_style: 'pale color',
    view_angle: 'from above',
    character_slots: [{ key: 'hakurei_reimu', weight: 1 }],
    artist_slots: [{ key: '', weight: 1 }],
    prompt_custom_fields: [{ id: 'cf_face', name: 'Face', text: 'smile' }],
    unrelated: 'stays out of the snapshot',
};

test('a snapshot holds the card and nothing else', () => {
    const snapshot = snapshotPrompts(CHECKPOINT);
    assert.equal(snapshot.api_prompt, '1girl, solo');
    assert.equal(snapshot.prompt_style, 'pale color');
    assert.equal(snapshot.unrelated, undefined);
    for (const key of Object.keys(snapshot)) assert.ok(PROMPT_STATE_KEYS.includes(key), `${key} is part of the card`);
});

test('the snapshot is a copy, not a view of live settings', () => {
    const settings = { character_slots: [{ key: 'a', weight: 1 }] };
    const snapshot = snapshotPrompts(settings);
    settings.character_slots[0].key = 'b';
    assert.equal(snapshot.character_slots[0].key, 'a');
});

test('leaving a type stores that type, and only that type', () => {
    const store = rememberPrompts({}, 'Checkpoint', CHECKPOINT);
    assert.deepEqual(Object.keys(store), ['Checkpoint']);
    assert.equal(store.Checkpoint.api_prompt, '1girl, solo');
    assert.deepEqual(rememberPrompts(store, 'Nonsense', CHECKPOINT), store, 'an unknown type writes nothing');
});

test('entering a type with nothing stored clears the card', () => {
    const patch = promptsFor({}, 'Diffusion', CHECKPOINT);
    assert.equal(patch.api_prompt, '');
    assert.equal(patch.prompt_style, '');
    assert.equal(patch.view_angle, 'None');
    assert.deepEqual(patch.prompt_custom_fields.map(field => field.text), [''], 'rows stay, text goes');
    assert.equal(patch.character_slots, undefined, 'a clear does not touch the slot lists');
});

test('entering a type with a stored card puts it back', () => {
    const store = rememberPrompts({}, 'Checkpoint', CHECKPOINT);
    const patch = promptsFor(store, 'Checkpoint', { api_prompt: 'whatever is there now' });
    assert.equal(patch.api_prompt, '1girl, solo');
    assert.deepEqual(patch.character_slots, [{ key: 'hakurei_reimu', weight: 1 }]);
    assert.equal(patch.prompt_custom_fields[0].name, 'Face');
});

test('a restore is a copy too: applying it cannot rewrite the store', () => {
    const store = rememberPrompts({}, 'Diffusion', { artist_slots: [{ key: 'ciloranko', weight: 1 }] });
    const patch = promptsFor(store, 'Diffusion');
    patch.artist_slots[0].key = 'someone else';
    assert.equal(store.Diffusion.artist_slots[0].key, 'ciloranko');
});

test('a round trip through both types keeps each card', () => {
    let store = rememberPrompts({}, 'Checkpoint', CHECKPOINT);
    const diffusion = { api_prompt: '', prompt_style: '', artist_slots: [{ key: 'nnn_yryr', weight: 0.8 }] };
    store = rememberPrompts(store, 'Diffusion', diffusion);
    assert.deepEqual(promptsFor(store, 'Diffusion').artist_slots, [{ key: 'nnn_yryr', weight: 0.8 }]);
    assert.equal(promptsFor(store, 'Checkpoint').api_prompt, '1girl, solo');
});

test('hasStoredPrompts says whether a switch would restore or clear', () => {
    const store = rememberPrompts({}, 'Checkpoint', CHECKPOINT);
    assert.equal(hasStoredPrompts(store, 'Checkpoint'), true);
    assert.equal(hasStoredPrompts(store, 'Diffusion'), false);
    assert.equal(hasStoredPrompts(null, 'Checkpoint'), false);
});

test('the card owner sits in the app section beside the store', () => {
    // a switch forced by the interface parks a card on the other type; the owner says where
    // it goes back to (scripts/renderer/callbacks.js applyModelType)
    assert.equal(DEFAULT_SETTINGS.model_type_prompt_owner, '');
    assert.ok(SECTION_KEYS.app.includes('model_type_prompt_owner'));
    assert.ok(!SECTION_KEYS.prompt.includes('model_type_prompt_owner'), 'an undo must not rewind it');
    // it outlives a restart, so the parked card still goes back to its own type afterwards
    assert.equal(normalizeSection('app', { model_type_prompt_owner: 'Diffusion' }).model_type_prompt_owner, 'Diffusion');
});
