import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

import {
    applyPartsChange,
    expandOnePart,
    expandPartTokens,
    listParts,
    normalizePartsDoc,
    partFolderName,
    partId,
    partIdsIn,
    partNameOf,
    partToken,
    pickSample,
    renamePartTokens,
    sampleModelLabels,
    samplePrompt,
    SAMPLE_PROMPT_VERSION,
    partsDefaultsDoc,
    mergePartsDefaults,
} from '../scripts/shared/parts.js';

const doc = normalizePartsDoc({
    parts: {
        'sailor uniform': { name: 'Sailor Uniform', category: 'outfit', tags: 'serafuku, pleated skirt, (red neckerchief:1.2), ~loafers' },
        'twin tails long': { name: 'twin tails long', category: 'hair', tags: 'twin tails, very long hair' },
        'school look': { name: 'school look', category: 'other', tags: 'parts:sailor uniform, (parts:twin tails long:0.5), smile' },
        'loop a': { name: 'loop a', category: 'other', tags: 'parts:loop b, a' },
        'loop b': { name: 'loop b', category: 'other', tags: 'parts:loop a, b' },
    },
});
const resolve = id => doc.parts[id] ?? null;

test('a part token is the prefix and a name; the id is the normalized name', () => {
    assert.equal(partNameOf('parts:sailor uniform'), 'sailor uniform');
    assert.equal(partNameOf('Parts:  Sailor Uniform '), 'Sailor Uniform');
    assert.equal(partNameOf('parts:'), null);
    assert.equal(partNameOf('particles'), null);
    assert.equal(partNameOf('@ciloranko'), null);
    assert.equal(partId('  Sailor   Uniform '), 'sailor uniform');
    assert.equal(partToken('sailor uniform'), 'parts:sailor uniform');
    assert.equal(partToken('sailor uniform', 0.8), '(parts:sailor uniform:0.8)');
});

test('expansion replaces the token with the members, dropping disabled members', () => {
    assert.equal(
        expandPartTokens('1girl, parts:sailor uniform, smile', resolve),
        '1girl, serafuku, pleated skirt, (red neckerchief:1.2), smile');
});

test('a weighted token scales every member; a disabled token vanishes', () => {
    assert.equal(
        expandPartTokens('(parts:Sailor Uniform:0.5), ~parts:twin tails long, solo', resolve),
        '(serafuku:0.5), (pleated skirt:0.5), (red neckerchief:0.6), solo');
});

test('a part inside a part expands too, and a cycle stops', () => {
    assert.equal(
        expandPartTokens('parts:school look', resolve),
        'serafuku, pleated skirt, (red neckerchief:1.2), (twin tails:0.5), (very long hair:0.5), smile');
    const looped = expandPartTokens('parts:loop a', resolve);
    assert.match(looped, /^a|b/);
    assert.ok(!looped.includes('parts:'), looped);
});

test('an unknown part becomes its bare name; text without parts is untouched', () => {
    assert.equal(expandPartTokens('parts:red dress, (parts:cape:1.3)', resolve), 'red dress, (cape:1.3)');
    const plain = '1girl, (smile:1.1)\n~long hair, blue eyes';
    assert.equal(expandPartTokens(plain, resolve), plain);
});

test('partIdsIn lists the parts a text refers to; rename and expand-one rewrite tokens in place', () => {
    const text = 'solo, (parts:sailor uniform:0.9), ~parts:twin tails long, parts:sailor uniform';
    assert.deepEqual(partIdsIn(text), ['sailor uniform', 'twin tails long']);
    assert.equal(
        renamePartTokens(text, 'sailor uniform', 'seifuku'),
        'solo, (parts:seifuku:0.9), ~parts:twin tails long, parts:seifuku');
    assert.equal(
        expandOnePart(text, 'twin tails long', doc.parts['twin tails long']),
        'solo, (parts:sailor uniform:0.9), parts:sailor uniform');
    assert.equal(
        expandOnePart('parts:sailor uniform', 'sailor uniform', doc.parts['sailor uniform']),
        'serafuku, pleated skirt, (red neckerchief:1.2)');
});

test('the document normalizes loose input and lists by category', () => {
    const loose = normalizePartsDoc({ parts: {
        junk: null,
        '  Maid  Dress ': { category: 'Outfit', tags: ' maid, apron ', samples: [{ id: 's1', file: 's1.png', modelType: 'Diffusion' }, { file: 'no-id.png' }], pinned: 's1' },
        'no category': { tags: 'x' },
    } });
    assert.deepEqual(Object.keys(loose.parts), ['maid dress', 'no category']);
    assert.equal(loose.parts['maid dress'].category, 'outfit');
    assert.equal(loose.parts['maid dress'].tags, 'maid, apron');
    assert.equal(loose.parts['maid dress'].samples.length, 1);
    assert.equal(loose.parts['maid dress'].pinned, 's1');
    assert.equal(loose.parts['no category'].category, 'other');
    assert.deepEqual(listParts(doc, 'hair').map(entry => entry.id), ['twin tails long']);
    assert.equal(listParts(doc).length, 5);
});

test('set creates or renames a part and keeps its samples; a taken name is refused', () => {
    let clock = 0;
    const now = () => `2026-09-22T00:00:0${clock++}Z`;
    let next = applyPartsChange(doc, { action: 'set', entry: { name: 'Gym Uniform', category: 'outfit', tags: 'gym uniform, buruma' } }, now);
    assert.equal(next.parts['gym uniform'].created, '2026-09-22T00:00:00Z');
    next = applyPartsChange(next, { action: 'add-sample', id: 'gym uniform', sample: { id: 'a', file: 'a.png', modelType: 'Diffusion', seed: 3 } }, now);
    assert.equal(next.parts['gym uniform'].samples.length, 1);
    next = applyPartsChange(next, { action: 'set', id: 'gym uniform', entry: { name: 'PE uniform', category: 'outfit', tags: 'gym uniform' } }, now);
    assert.equal(next.parts['gym uniform'], undefined);
    assert.equal(next.parts['pe uniform'].samples.length, 1);
    assert.equal(next.parts['pe uniform'].created, '2026-09-22T00:00:00Z');
    assert.equal(applyPartsChange(next, { action: 'set', id: 'pe uniform', entry: { name: 'sailor uniform', tags: 'x' } }, now), null);
    assert.equal(applyPartsChange(next, { action: 'set', entry: { name: '', tags: 'x' } }, now), null);
    assert.equal(applyPartsChange(next, { action: 'remove', id: 'nope' }, now), null);
    assert.equal(applyPartsChange(next, { action: 'remove', id: 'PE Uniform' }, now).parts['pe uniform'], undefined);
});

test('samples pin, unpin and remove; the tile picks pinned, then the current model', () => {
    const now = () => '2026-09-22T01:00:00Z';
    let next = applyPartsChange(doc, { action: 'add-sample', id: 'sailor uniform', sample: { id: 'ill', file: 'ill.png', modelType: 'Checkpoint', created: '2026-09-20T00:00:00Z' } }, now);
    next = applyPartsChange(next, { action: 'add-sample', id: 'sailor uniform', sample: { id: 'ani-char', file: 'c.png', modelType: 'Diffusion', base: 'character', created: '2026-09-22T00:00:00Z' } }, now);
    next = applyPartsChange(next, { action: 'add-sample', id: 'sailor uniform', sample: { id: 'ani', file: 'ani.png', modelType: 'Diffusion', created: '2026-09-21T00:00:00Z' } }, now);
    const entry = next.parts['sailor uniform'];
    assert.deepEqual(sampleModelLabels(entry), ['Illustrious', 'Anima']);
    assert.equal(pickSample(entry, 'Diffusion').id, 'ani'); // mannequin beats the newer character sample
    assert.equal(pickSample(entry, 'Checkpoint').id, 'ill');
    assert.equal(pickSample(entry, 'Checkpoint').foreign, false);
    next = applyPartsChange(next, { action: 'pin', id: 'sailor uniform', sampleId: 'ani-char' }, now);
    assert.equal(pickSample(next.parts['sailor uniform'], 'Checkpoint').id, 'ani-char');
    assert.equal(pickSample(next.parts['sailor uniform'], 'Checkpoint').foreign, true);
    assert.equal(applyPartsChange(next, { action: 'pin', id: 'sailor uniform', sampleId: 'missing' }, now), null);
    next = applyPartsChange(next, { action: 'remove-sample', id: 'sailor uniform', sampleId: 'ani-char' }, now);
    assert.equal(next.parts['sailor uniform'].pinned, null);
    assert.equal(next.parts['sailor uniform'].samples.length, 2);
    next = applyPartsChange(next, { action: 'remove-sample', id: 'sailor uniform', sampleId: 'ill' }, now);
    next = applyPartsChange(next, { action: 'remove-sample', id: 'sailor uniform', sampleId: 'ani' }, now);
    assert.equal(pickSample(next.parts['sailor uniform'], 'Diffusion'), null);
    assert.deepEqual(sampleModelLabels(next.parts['sailor uniform']), []);
});

test('the sample prompt is the fixed base of the category and model plus the tags', () => {
    const anima = samplePrompt({ category: 'outfit', tags: 'serafuku', modelType: 'Diffusion' });
    assert.match(anima.positive, /^masterpiece, best quality, score_7, safe, 1girl, faceless, bald, white skin, colored skin, .*, serafuku$/);
    assert.match(anima.negative, /dress form/);
    assert.equal(anima.base, 'mannequin');
    const ill = samplePrompt({ category: 'hair', tags: 'twin tails', modelType: 'Checkpoint' });
    assert.match(ill.positive, /faceless, white skin, colored skin, white shirt, upper body/);
    assert.ok(!ill.positive.includes('mannequin'));
    // the starter-set run (design/parts/defaults/SEEDING.md): a hair figure wears a shirt,
    // a composition part is not overridden by "full body"
    assert.match(samplePrompt({ category: 'hair', tags: 'ponytail', modelType: 'Diffusion' }).positive, /faceless, white skin, colored skin, white shirt, upper body/);
    for (const modelType of ['Diffusion', 'Checkpoint']) {
        const other = samplePrompt({ category: 'other', tags: 'cowboy shot', modelType });
        assert.doesNotMatch(other.positive, /full body/, `${modelType}: the composition tags decide the framing`);
        assert.match(other.positive, /standing, .*cowboy shot$/);
    }
    assert.equal(SAMPLE_PROMPT_VERSION, 4, 'the bases changed, so samples of the old bases are told apart');
    const scenery = samplePrompt({ category: 'background', tags: 'classroom', modelType: 'Diffusion' });
    assert.match(scenery.positive, /no humans, scenery, classroom$/);
    const onChar = samplePrompt({ category: 'outfit', tags: 'serafuku', modelType: 'Diffusion', character: 'hatsune miku, aqua hair' });
    assert.match(onChar.positive, /hatsune miku, aqua hair, solo, standing/);
    assert.equal(onChar.base, 'character');
    assert.equal(partFolderName('Sailor  Uniform!'), 'sailor-uniform');
    assert.equal(partFolderName('日本'), 'part');
});

test('the bundled starter set is 175 parts in nine categories, and merging never touches a part the user has', () => {
    const raw = JSON.parse(readFileSync(new URL('../data/parts_defaults.json', import.meta.url), 'utf8'));
    const defaults = partsDefaultsDoc(raw, () => '2026-09-27T00:00:00.000Z');
    const ids = Object.keys(defaults.parts);
    assert.equal(ids.length, 175);
    const byCategory = {};
    for (const entry of Object.values(defaults.parts)) byCategory[entry.category] = (byCategory[entry.category] ?? 0) + 1;
    assert.deepEqual(byCategory, { outfit: 28, hair: 17, body: 12, background: 18, camera: 24, composition: 14, tone: 24, pose: 20, expression: 18 });
    assert.equal(defaults.parts['sailor uniform'].category, 'outfit');
    assert.match(defaults.parts['sailor uniform'].tags, /^serafuku, /);
    assert.deepEqual(defaults.parts['sailor uniform'].samples, []);
    assert.equal(defaults.parts['sailor uniform'].created, '2026-09-27T00:00:00.000Z');
    assert.ok(!('note' in defaults.parts['sailor uniform']), 'the draft\'s notes are not part of an entry');
    for (const entry of Object.values(defaults.parts)) assert.ok(entry.tags, `${entry.name} has tags`);

    // a user's "sailor uniform" (other tags, a sample, a pin) survives a merge; the rest is added
    const mine = { parts: { 'sailor uniform': { name: 'Sailor Uniform', category: 'outfit', tags: 'serafuku, ~loafers', samples: [{ id: 's1', file: 's1.png' }], pinned: 's1', created: '2026-01-01T00:00:00.000Z', updated: '2026-01-02T00:00:00.000Z' } } };
    const merged = mergePartsDefaults(mine, raw, () => '2026-09-27T00:00:00.000Z');
    assert.equal(merged.added, 174);
    assert.equal(merged.skipped, 1);
    assert.equal(Object.keys(merged.doc.parts).length, 175);
    assert.equal(merged.doc.parts['sailor uniform'].tags, 'serafuku, ~loafers');
    assert.equal(merged.doc.parts['sailor uniform'].pinned, 's1');
    assert.equal(merged.doc.parts['sailor uniform'].updated, '2026-01-02T00:00:00.000Z');
    assert.equal(merged.doc.parts['blazer uniform'].created, '2026-09-27T00:00:00.000Z');
    // a second merge adds nothing
    const again = mergePartsDefaults(merged.doc, raw);
    assert.deepEqual([again.added, again.skipped], [0, 175]);
    // an entry without a name or tags, or a repeated name, is left out of the set
    const odd = partsDefaultsDoc({ parts: [{ name: 'a', category: 'hair', tags: 'bob cut' }, { name: 'A', category: 'hair', tags: 'other' }, { name: '', tags: 'x' }, { name: 'b', category: 'body' }] });
    assert.deepEqual(Object.keys(odd.parts), ['a']);
    assert.equal(odd.parts.a.tags, 'bob cut');
    assert.deepEqual(partsDefaultsDoc(null).parts, {});
});

test('the five template categories have a mannequin base that lets the part decide, and unique starter names', async () => {
    const { PART_CATEGORIES, samplePrompt, partsDefaultsDoc } = await import('../scripts/shared/parts.js');
    assert.deepEqual(PART_CATEGORIES, ['outfit', 'hair', 'body', 'background', 'camera', 'composition', 'tone', 'pose', 'expression', 'other']);
    for (const modelType of ['Diffusion', 'Checkpoint']) {
        const camera = samplePrompt({ category: 'camera', tags: 'from above', modelType }).positive;
        assert.doesNotMatch(camera, /facing viewer|looking at viewer/, 'the camera part decides the gaze and the angle');
        assert.match(camera, /wooden floor/, 'a floor so the angle reads');
        const composition = samplePrompt({ category: 'composition', tags: 'multiple views', modelType });
        assert.doesNotMatch(composition.positive, /full body|upper body|solo/, 'no framing and no single-view tag for a composition part');
        assert.doesNotMatch(composition.negative, /multiple views|2girls|multiple girls/, 'the composition negative does not refuse a second view');
        assert.match(samplePrompt({ category: 'outfit', tags: 'x', modelType }).negative, /multiple views/, 'every other category keeps it');
        const pose = samplePrompt({ category: 'pose', tags: 'kneeling', modelType }).positive;
        assert.doesNotMatch(pose, /standing|arms at sides/, 'the pose part decides the pose');
        const expression = samplePrompt({ category: 'expression', tags: 'smile', modelType }).positive;
        assert.doesNotMatch(expression, /faceless/, 'an expression needs a face');
        assert.match(expression, /upper body/);
        assert.match(samplePrompt({ category: 'tone', tags: 'sepia', modelType }).positive, /white leotard/, 'the tone sample keeps the figure fixed so only the colour changes');
    }
    const raw = JSON.parse(readFileSync(new URL('../data/parts_defaults.json', import.meta.url), 'utf8'));
    const names = raw.parts.map(part => part.name.toLowerCase());
    assert.equal(new Set(names).size, names.length, 'starter names are unique across categories');
    assert.equal(Object.keys(partsDefaultsDoc(raw).parts).length, 175);
    assert.ok(raw.parts.some(part => part.name === 'split screen' && part.tags === 'split screen, 2koma, two panels'), 'the bench-proven split tags ship as written');
});
