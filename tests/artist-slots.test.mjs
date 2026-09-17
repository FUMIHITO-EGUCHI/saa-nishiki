import assert from 'node:assert/strict';
import test from 'node:test';

import {
    MAX_ARTIST_SLOTS,
    artistEnabled,
    artistPrompt,
    artistToken,
    filledArtistSlots,
    normalizeArtistSlots,
    signatureGuard,
} from '../scripts/shared/artistSlots.js';

test('the artist card belongs to the Diffusion model type', () => {
    assert.equal(artistEnabled({ api_model_type: 'Diffusion' }), true);
    assert.equal(artistEnabled({ api_model_type: 'Checkpoint' }), false);
    assert.equal(artistEnabled({}), false);
});

test('slots normalize to at least one and at most three', () => {
    assert.deepEqual(normalizeArtistSlots(undefined), [{ key: '', weight: 1 }]);
    assert.deepEqual(normalizeArtistSlots([]), [{ key: '', weight: 1 }]);
    assert.equal(normalizeArtistSlots([{}, {}, {}, {}, {}]).length, MAX_ARTIST_SLOTS);
    assert.deepEqual(
        normalizeArtistSlots([{ key: ' ciloranko ', weight: '1.205' }]),
        [{ key: 'ciloranko', weight: 1.21 }],
    );
    assert.deepEqual(normalizeArtistSlots(['wlop']), [{ key: 'wlop', weight: 1 }], 'a bare string is a key');
    assert.deepEqual(normalizeArtistSlots([{ key: 'None' }]), [{ key: '', weight: 1 }], 'the empty slot reads None');
    assert.deepEqual(normalizeArtistSlots([{ key: 'x', weight: -3 }]), [{ key: 'x', weight: 1 }], 'a bad weight falls back to 1');
});

test('only filled slots reach the prompt, and never the same artist twice', () => {
    const slots = [{ key: 'ciloranko' }, { key: '' }, { key: 'Ciloranko' }];
    assert.deepEqual(filledArtistSlots(slots).map(slot => slot.key), ['ciloranko']);
});

test('a token is the Anima spelling: @, spaces, escaped parentheses', () => {
    assert.equal(artistToken('ciloranko'), '@ciloranko');
    assert.equal(artistToken('nnn_yryr'), '@nnn yryr');
    assert.equal(artistToken('hammer_(sunset_beach)'), String.raw`@hammer \(sunset beach\)`);
    assert.equal(artistToken(''), '', 'an empty slot writes nothing');
    assert.equal(artistToken('none'), '');
});

test('a weight wraps the whole token, @ included', () => {
    assert.equal(artistToken('ciloranko', 1), '@ciloranko');
    assert.equal(artistToken('ciloranko', 1.2), '(@ciloranko:1.2)');
    assert.equal(artistToken('nnn_yryr', 0.8), '(@nnn yryr:0.8)');
});

test('the unit text is the filled slots, comma separated', () => {
    const settings = {
        api_model_type: 'Diffusion',
        artist_slots: [{ key: 'ciloranko', weight: 1.2 }, { key: 'nnn_yryr', weight: 0.8 }, { key: '' }],
    };
    assert.equal(artistPrompt(settings), '(@ciloranko:1.2), (@nnn yryr:0.8)');
    assert.equal(artistPrompt({ ...settings, api_model_type: 'Checkpoint' }), '', 'Checkpoint sends no artist');
    assert.equal(artistPrompt({ api_model_type: 'Diffusion', artist_slots: [] }), '');
});

test('the signature guard rides along only while an artist is set', () => {
    const settings = { api_model_type: 'Diffusion', artist_slots: [{ key: 'nnn_yryr' }] };
    assert.equal(signatureGuard(settings), 'artist name, signature, watermark');
    assert.equal(signatureGuard({ ...settings, artist_signature_guard: false }), '', 'the user can turn it off');
    assert.equal(signatureGuard({ ...settings, artist_slots: [] }), '', 'no artist, no guard');
    assert.equal(signatureGuard({ ...settings, api_model_type: 'Checkpoint' }), '');
});
