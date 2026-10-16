// The LoRA catalog: trigger words and suggested tags guessed from the training captions
// (shared/loraCatalog.js), the store of what the user sets and the sample images, and the
// header-only read of a .safetensors file (main/loraCatalog.js).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
    applyLoraChange, defaultCell, deriveWords, loraBase, loraFitsModel, loraSamplePrompt, loraView, normalizeLoraDoc, sampleWeights, samplesForModel, tagFrequency,
} from '../scripts/shared/loraCatalog.js';
import { civitaiFacts, createLoraCatalog, readSafetensorsMetadata, sampleFolderName } from '../scripts/main/loraCatalog.js';

// tag key -> post count, as the dictionary has them
const known = new Map([
    ['1girl', 6000000], ['solo', 5000000], ['multiple views', 70000], ['turnaround', 3444], ['reference sheet', 20000],
    ['side', 99], ['after sex', 150000], ['completely nude', 180000], ['long hair', 4300000],
]);

test('caption counts summed over the datasets, filler words left out of the guesses', () => {
    const frequency = tagFrequency(JSON.stringify({ a: { '1girl': 10, charturn: 9, best_quality: 12 }, b: { charturn: 1, 'multiple_views': 6 } }));
    assert.deepEqual(frequency, [['best quality', 12], ['1girl', 10], ['charturn', 10], ['multiple views', 6]]);
    assert.deepEqual(tagFrequency('not json'), []);
});

test('the trigger is the common word the file name spells, else a word that is no tag', () => {
    const turn = deriveWords([['odinturn', 90], ['side', 80], ['charturn', 70], ['1girl', 95], ['multiple views', 40], ['turnaround', 35]], known, { name: 'CharTurnIL_Dim32Alpha16.safetensors' });
    assert.deepEqual(turn.triggers, ['charturn']);
    assert.ok(turn.candidates.includes('odinturn'));
    assert.ok(!turn.candidates.includes('1girl'), 'a generic tag is never offered');
    assert.deepEqual(turn.linked, ['multiple views', 'turnaround'], '"side" is too rare to mean anything; 1girl too common');
    const concept = deriveWords([['after sex', 100], ['1girl', 100], ['completely nude', 60]], known, { name: 'after-sex-v6.safetensors' });
    assert.deepEqual(concept.triggers, ['after sex']);
    assert.deepEqual(concept.linked, ['after sex', 'completely nude']);
    const unnamed = deriveWords([['best quality', 50], ['zzword', 40], ['1girl', 45]], known, { name: 'style.safetensors' });
    assert.deepEqual(unnamed.triggers, ['zzword'], 'quality words are filler, not triggers');
    assert.deepEqual(deriveWords([], known), { triggers: [], candidates: [], linked: [] });
});

test('the base a file names, and which model type it belongs with', () => {
    assert.equal(loraBase({ ss_base_model_version: 'sdxl_base_v1-0' }, 'x'), 'sdxl');
    assert.equal(loraBase({}, 'anima-turbo-lora-v0.2.safetensors'), 'anima');
    assert.equal(loraBase({}, 'dmd2.safetensors'), 'unknown');
    assert.equal(loraFitsModel('sdxl', 'Checkpoint'), true);
    assert.equal(loraFitsModel('sdxl', 'Diffusion'), false);
    assert.equal(loraFitsModel('unknown', 'Diffusion'), true);
});

test('the sample grid: off and five even weights, the default ringed', () => {
    assert.deepEqual(sampleWeights({ min: 0.2, max: 1 }), [0, 0.2, 0.4, 0.6, 0.8, 1]);
    assert.deepEqual(sampleWeights({ min: 0.4, max: 1.2 }), [0, 0.4, 0.6, 0.8, 1, 1.2]);
    assert.equal(defaultCell({ min: 0.2, max: 1, def: 0.8 }), 4);
    assert.equal(defaultCell({ min: -1, max: 1, def: 0 }), 3);
    const prompt = loraSamplePrompt({ modelType: 'Checkpoint', name: 'a.safetensors', triggers: ['charturn'], linked: ['turnaround'], weight: 0.6 });
    assert.match(prompt.positive, /full body, standing.*charturn, turnaround/);
    assert.match(prompt.positive, /\n<lora:a\.safetensors:0\.6:0\.6>$/);
    assert.doesNotMatch(loraSamplePrompt({ modelType: 'Checkpoint', name: 'a', weight: 0 }).positive, /<lora:/, 'off has no LoRA');
});

test('the user\'s choices over the guesses; a change and its undoing', () => {
    let doc = normalizeLoraDoc({});
    doc = applyLoraChange(doc, { action: 'set', name: 'a.safetensors', patch: { triggers: ['Charturn'], favorite: true, range: { min: 0.4, max: 1.2, def: 0.8, src: 'custom' } } });
    assert.deepEqual(doc.loras['a.safetensors'].triggers, ['charturn']);
    const view = loraView({ name: 'a.safetensors', base: 'sdxl', frequency: [['odinturn', 9], ['charturn', 8]] }, doc.loras['a.safetensors'], { known });
    assert.deepEqual([view.label, view.triggers, view.favorite, view.range.min, view.category], ['a', ['charturn'], true, 0.4, 'Unsorted']);
    assert.ok(view.candidates.includes('odinturn'));
    doc = applyLoraChange(doc, { action: 'set', name: 'a.safetensors', patch: { favorite: false } });
    assert.equal(doc.loras['a.safetensors'].favorite, undefined);
    doc = applyLoraChange(doc, { action: 'clear', name: 'a.safetensors' });
    assert.equal(doc.loras['a.safetensors'], undefined, 'nothing left to keep');
    assert.equal(applyLoraChange(doc, { action: 'set', name: 'b', patch: { range: { min: 1, max: 0.5 } } }).loras.b, undefined, 'a range upside down is dropped');
    assert.equal(loraView({ name: 'dmd2_sdxl_4step.safetensors' }, {}).category, 'Speed');
});

test('samples: one per weight and model, the model in use first', () => {
    const entry = { samples: [
        { id: '1', weight: 0.2, model: 'v170', created: '2026-10-17T01:00:00Z' },
        { id: '2', weight: 0.2, model: 'v170', created: '2026-10-17T02:00:00Z' },
        { id: '3', weight: 0.4, model: 'v160', created: '2026-10-17T01:00:00Z' },
    ] };
    assert.deepEqual([...samplesForModel(entry, 'v170').samples.entries()].map(([weight, sample]) => [weight, sample.id]), [[0.2, '2']]);
    const other = samplesForModel(entry, 'anima');
    assert.equal(other.foreign, true);
    assert.equal(other.samples.size, 2);
});

test('Civitai\'s answer: trigger words split, the page, a range when it names one', () => {
    const facts = civitaiFacts({ id: 22, modelId: 11, model: { name: 'CharTurn' }, baseModel: 'Illustrious', trainedWords: ['charturn, odinturn'], settings: { minStrength: 0.4, maxStrength: 1.2, strength: 0.8 } });
    assert.deepEqual(facts.triggers, ['charturn', 'odinturn']);
    assert.equal(facts.url, 'https://civitai.com/models/11?modelVersionId=22');
    assert.deepEqual(facts.range, { min: 0.4, max: 1.2, def: 0.8, src: 'Civitai' });
    assert.equal(civitaiFacts({ id: 1 }), null);
});

function safetensors(metadata, body = Buffer.alloc(1024)) {
    const header = Buffer.from(JSON.stringify({ __metadata__: metadata, w: { dtype: 'F16', shape: [1], data_offsets: [0, 2] } }), 'utf8');
    const length = Buffer.alloc(8);
    length.writeBigUInt64LE(BigInt(header.length));
    return Buffer.concat([length, header, body]);
}

test('a .safetensors header is read without the weights; the store keeps choices and samples', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'saa-lora-'));
    try {
        const file = path.join(dir, 'CharTurnIL.safetensors');
        fs.writeFileSync(file, safetensors({ ss_base_model_version: 'sdxl_base_v1-0', ss_network_dim: '32', ss_tag_frequency: JSON.stringify({ d: { charturn: 5, '1girl': 5 } }) }));
        assert.equal((await readSafetensorsMetadata(file)).ss_network_dim, '32');
        let reads = 0;
        const catalog = createLoraCatalog({ rootDir: dir, log: null, readMetadata: async target => { reads += 1; return readSafetensorsMetadata(target); } });
        const [facts] = await catalog.facts([{ name: 'CharTurnIL.safetensors', path: file }]);
        assert.deepEqual([facts.base, facts.dim, facts.frequency[0][0]], ['sdxl', 32, '1girl']);
        await catalog.facts([{ name: 'CharTurnIL.safetensors', path: file }]);
        assert.equal(reads, 1, 'the second look comes from the cache');
        const [remote] = await catalog.facts([{ name: 'pod-only.safetensors', path: '' }]);
        assert.equal(remote.base, 'unknown');

        catalog.apply({ action: 'set', name: 'CharTurnIL.safetensors', patch: { triggers: ['charturn'] } });
        catalog.addSample('CharTurnIL.safetensors', { weight: 0.8, model: 'v170', modelType: 'Checkpoint' }, Buffer.from('png-a'));
        const first = catalog.get().loras['CharTurnIL.safetensors'].samples[0];
        catalog.addSample('CharTurnIL.safetensors', { weight: 0.8, model: 'v170', modelType: 'Checkpoint' }, Buffer.from('png-b'));
        const samples = catalog.get().loras['CharTurnIL.safetensors'].samples;
        assert.equal(samples.length, 1, 'a retake replaces the sample of that weight');
        assert.equal(catalog.readSample('CharTurnIL.safetensors', samples[0].id).toString(), 'png-b');
        assert.equal(fs.existsSync(path.join(catalog.sampleRoot, sampleFolderName('CharTurnIL.safetensors'), first.file)), false, 'its file went too');
        const again = createLoraCatalog({ rootDir: dir, log: null });
        assert.deepEqual(again.get().loras['CharTurnIL.safetensors'].triggers, ['charturn']);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
