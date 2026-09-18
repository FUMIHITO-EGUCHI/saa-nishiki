import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// The Prose queue step end to end, with the LLM replaced at globalThis.api.localAI (the
// IPC call remoteAI.js makes): the job taken at queue time, the cache, the card's edit /
// Revert / Regenerate, cancellation and the fallback to tags.

globalThis.document ??= new EventTarget();
globalThis.generate = { cancelClicked: false };

const {
    applyProse,
    captureProseJob,
    describeProse,
    proseState,
    regenerateProse,
    resetProseCache,
    revertProseParagraph,
    setProseParagraph,
} = await import('../scripts/renderer/prosePipeline.js');
const { createPromptMaterials } = await import('../scripts/renderer/tools/promptMaterials.js');
const { processRandomString } = await import('../scripts/renderer/tools/nestedBraceParsing.js');
const { createPlanWeigher } = await import('../scripts/renderer/tools/promptBatchExpansion.js');

const LANG = { cast_default_alias: 'char' };
const calls = [];
let answer = () => '{"prompt": "masterpiece, A paragraph."}';
globalThis.api = {
    localAI: async options => {
        calls.push(options);
        const reply = await answer(options);
        const { content, finish_reason } = typeof reply === 'string' ? { content: reply } : reply;
        return content.startsWith('Error:') ? content : JSON.stringify({ choices: [{ message: { content }, ...(finish_reason ? { finish_reason } : {}) }] });
    },
};

function diffusion(extra = {}) {
    return {
        api_model_type: 'Diffusion',
        ai_prose_enable: true,
        ai_prose_scope: 'all',
        ai_interface: 'Local',
        ai_local_addr: 'http://127.0.0.1:11434/api/chat',
        ai_local_model_mode: 'Auto',
        character_slots: [{ key: 'A', weight: 1, alias: 'hime' }, { key: 'B', weight: 1 }],
        prompt_custom_fields: [
            { id: 'cf_cast1', name: '@hime', polarity: 'positive', text: '' },
            { id: 'cf_cast2', name: '@char2', polarity: 'positive', text: '' },
            { id: 'cf_action', name: 'Action', polarity: 'positive', text: '' },
        ],
        artist_slots: [{ key: 'wlop', weight: 1 }],
        ...extra,
    };
}

function context(action, positive = 'smile, ') {
    return {
        chain: [
            { id: 'common', text: 'masterpiece, ' },
            { id: 'artist', text: '@wlop, ' },
            { id: 'ai', text: '_|REPLACE_AI_PROMPT|_, ' },
            { id: 'characters', text: 'reimu, marisa, ' },
            { id: 'cf_cast1', text: 'red bow, ' },
            { id: 'cf_cast2', text: 'witch hat, ' },
            { id: 'positive', text: positive },
            { id: 'cf_action', text: action },
        ],
        characterTags: ['reimu, ', 'marisa, '],
        beforePrompts: '',
        beforeCharacters: '',
        afterCharacters: '',
        afterPrompts: '',
        exclude: '',
    };
}

// generate.js's globalThis.generate.lastPos: the tag prompt "Same" repeats
let lastPos = '';

async function queue(settings, action, { runSame = false, run = 'run-a', positive, resolveText, weighText } = {}) {
    globalThis.globalSettings = settings;
    const tagPrompt = runSame ? lastPos : `tags for ${action}`;
    const job = await captureProseJob({
        settings, LANG, refineContext: runSame ? null : context(action, positive), runSame, tagPrompt, lastTagPrompt: lastPos, run, resolveText, weighText,
    });
    lastPos = tagPrompt;
    return job;
}

async function dequeue(job, options = {}) {
    const { positive = 'masterpiece, @wlop, reimu, @hime hugs @char2\n<lora:x:1:1>', aiText = '', isCancelled } = options;
    // generate.js passes undefined for a Remote request, which carries no prompt mode
    const aiMode = 'aiMode' in options ? options.aiMode : 'off';
    const generateData = { positive };
    const report = await applyProse(generateData, { job, aiMode, aiText, LANG, ...(isCancelled ? { isCancelled } : {}) });
    return { report, positive: generateData.positive };
}

const sentFields = () => JSON.parse(calls.at(-1).userPrompt);

// Every test gets an end of its own: a step that never comes back fails this test instead of
// leaving `node --test` running for good (in CI that is no red build, just a job that never
// finishes).
const opts = { timeout: 10_000 };

// An LLM answer the test releases by hand, to hold a paragraph half-written. Every hold is
// released after the test whatever happened in it: applyProse watches Cancel on an interval
// while it waits, and an answer that never comes back would keep that interval — and the
// whole run — alive long after the test that asked for it failed.
const holds = [];

function heldAnswer(content) {
    const waiting = [];
    answer = () => new Promise(resolve => waiting.push(() => resolve(content)));
    const release = () => { while (waiting.length > 0) waiting.shift()(); };
    holds.push(release);
    return release;
}

async function releaseHolds() {
    for (const release of holds.splice(0)) release();
    await new Promise(resolve => setImmediate(resolve));
}

test.beforeEach(() => {
    resetProseCache();
    calls.length = 0;
    answer = () => '{"prompt": "masterpiece, A paragraph."}';
    globalThis.generate.cancelClicked = false;
});

test.afterEach(async () => {
    await releaseHolds();
    globalThis.generate.cancelClicked = false;
    delete globalThis.queueManager;
});

test('the decision travels with the job: a Checkpoint job stays tags after a switch, a Diffusion job keeps its paragraph', opts, async () => {
    const checkpoint = await queue({ ...diffusion(), api_model_type: 'Checkpoint' }, '@hime hugs @char2');
    assert.equal(checkpoint, null);
    globalThis.globalSettings = diffusion();
    assert.deepEqual(await dequeue(checkpoint, { positive: 'tags' }), { report: null, positive: 'tags' });

    const job = await queue(diffusion(), '@hime hugs @char2');
    globalThis.globalSettings = { ...diffusion(), api_model_type: 'Checkpoint', ai_prose_enable: false, character_slots: [] };
    const { report, positive } = await dequeue(job);
    assert.equal(report.applied, true);
    assert.equal(positive, 'masterpiece, A paragraph.\n<lora:x:1:1>');
    assert.deepEqual(sentFields().characters, [{ ref: '@1', tags: 'reimu, red bow' }, { ref: '@2', tags: 'marisa, witch hat' }], 'the cast of the queued job');
});

test('the units reach the LLM resolved like the tag prompt: Exclude, wildcards, random choices, weights and JSON slots', opts, async () => {
    const settings = diffusion();
    globalThis.globalSettings = settings;
    const refineContext = {
        ...context('@hime hugs @char2', 'nsfw, __hair__, {red|blue} dress, smile, '),
        beforePrompts: 'bop, ',
        beforeCharacters: 'boc, ',
        afterCharacters: 'eoc, ',
        afterPrompts: 'eop, ',
    };
    const job = await captureProseJob({
        settings, LANG, refineContext, run: 'run-b',
        resolveText: async text => text.replace('nsfw, ', '').replace('__hair__', 'long hair').replace('{red|blue}', 'red'),
        weighText: text => text.replace('smile', '(smile:1.20)'),
    });
    await dequeue(job);
    const fields = sentFields();
    assert.equal(fields.common, 'bop, masterpiece, @wlop');
    assert.equal(fields.positive, 'long hair, red dress, (smile:1.20), boc, eoc, eop');
    assert.ok(!JSON.stringify(fields).includes('nsfw'), 'an excluded tag never reaches the LLM');
});

test('"Same" writes from the last image\'s units; with no Diffusion image before it, the tags go out as written', opts, async () => {
    const job = await queue(diffusion(), '@hime hugs @char2');
    await dequeue(job);
    const same = await queue(diffusion(), '', { runSame: true });
    assert.deepEqual(same.source, job.source);
    const { report } = await dequeue(same);
    assert.equal(report.applied, true);
    assert.equal(report.cached, true);
    assert.equal(calls.length, 1);
    const sameAgain = await queue(diffusion(), '', { runSame: true });
    assert.deepEqual(sameAgain.source, job.source, 'a second "Same" still has them');

    // a Regional run (generate_regional.js) wrote the prompt "Same" repeats in between
    lastPos = 'regional left prompt';
    assert.equal((await queue(diffusion(), '', { runSame: true })).source, null);

    await queue(diffusion(), '@hime hugs @char2');
    await queue({ ...diffusion(), api_model_type: 'Checkpoint' }, 'x');
    const orphan = await queue(diffusion(), '', { runSame: true });
    const fallback = await dequeue(orphan, { positive: 'reimu, @hime hugs @char2' });
    assert.equal(fallback.report.reason, 'no-fields');
    assert.equal(fallback.positive, 'reimu, hime hugs char2');
    assert.equal(calls.length, 1, 'no LLM call with nothing to write from');
});

test('a Remote Expand (no prompt mode) keeps the AI tags; Off drops the marker only', opts, async () => {
    const job = await queue(diffusion(), '');
    await dequeue(job, { aiMode: undefined, aiText: 'soft lighting' });
    assert.match(sentFields().positive, /soft lighting/);
    await dequeue(job, { aiMode: 'off', aiText: 'soft lighting' });
    assert.doesNotMatch(sentFields().positive, /soft lighting/);
});

test('an edit survives a trip to other fields and back, and Revert returns the LLM text', opts, async () => {
    answer = options => (JSON.parse(options.userPrompt).action.includes('hugs') ? '{"prompt": "P1 original"}' : '{"prompt": "P2"}');
    const hug = await queue(diffusion(), '@hime hugs @char2');
    await dequeue(hug);
    setProseParagraph('P1 edited');
    assert.equal(proseState().edited, true);
    await dequeue(await queue(diffusion(), '@hime kisses @char2'));
    assert.equal(proseState().prompt, 'P2');
    const back = await dequeue(hug);
    assert.equal(back.positive, 'P1 edited\n<lora:x:1:1>');
    assert.equal(back.report.edited, true);
    assert.equal(proseState().edited, true);
    assert.equal(proseState().original, 'P1 original');
    revertProseParagraph();
    assert.equal((await dequeue(hug)).positive, 'P1 original\n<lora:x:1:1>');
    assert.equal(calls.length, 2);
});

test('a blank edit never sends an empty prompt', opts, async () => {
    const job = await queue(diffusion(), '@hime hugs @char2');
    await dequeue(job);
    setProseParagraph('   ');
    const { positive, report } = await dequeue(job);
    assert.equal(positive, 'masterpiece, A paragraph.\n<lora:x:1:1>');
    assert.equal(report.edited, false);
});

test('an edit that began on an older paragraph stays with it when a newer one arrives', opts, async () => {
    answer = options => `{"prompt": "for ${JSON.parse(options.userPrompt).action.replaceAll('@', 'ref ')}"}`;
    const first = await queue(diffusion(), '@hime hugs @char2');
    await dequeue(first);
    const editingKey = proseState().key;
    const second = await queue(diffusion(), '@hime waves');
    await dequeue(second);
    setProseParagraph('typed into the first', { key: editingKey });
    assert.equal(proseState().prompt, 'for ref 1 waves', 'the newer paragraph is untouched');
    assert.equal((await dequeue(second)).positive, 'for ref 1 waves\n<lora:x:1:1>');
    assert.equal((await dequeue(first)).positive, 'typed into the first\n<lora:x:1:1>');
});

test('Regenerate replaces the paragraph; an image queued meanwhile waits for it instead of asking again', opts, async () => {
    const job = await queue(diffusion(), '@hime hugs @char2');
    await dequeue(job);
    const release = heldAnswer('{"prompt": "masterpiece, A new paragraph."}');
    const regenerating = regenerateProse();
    assert.equal(proseState().writing, true);
    assert.equal(await regenerateProse(), null, 'a second Regenerate while one runs does nothing');
    const image = dequeue(job);
    await new Promise(resolve => setImmediate(resolve));
    release();
    assert.equal((await regenerating).ok, true);
    const { positive, report } = await image;
    assert.equal(positive, 'masterpiece, A new paragraph.\n<lora:x:1:1>');
    assert.equal(report.edited, false);
    assert.equal(calls.length, 2, 'one call for the image, one for Regenerate');
    assert.equal(proseState().writing, false);
});

test('a rejected reply is kept out of the prompt, not retried in the same run, and asked again in the next', opts, async () => {
    answer = () => '{"prompt": "masterpiece, 金髪の少女"}';
    const job = await queue(diffusion(), '@hime hugs @char2', { run: 'run-fail' });
    const first = await dequeue(job);
    assert.equal(first.report.reason, 'non-english');
    assert.equal(first.positive, 'masterpiece, @wlop, reimu, hime hugs char2\n<lora:x:1:1>', 'the tags lose the reference marks, the artist keeps its @');
    const second = await dequeue(job);
    assert.equal(second.report.retried, false);
    assert.equal(calls.length, 1);
    assert.match(describeProse(second.report, { LANG: {} }), /not asked again in this run/);
    const next = await queue(diffusion(), '@hime hugs @char2', { run: 'run-next' });
    await dequeue(next);
    assert.equal(calls.length, 2);
});

test('a reply cut off at n_predict never reaches the prompt, even when what came back parses', opts, async () => {
    answer = () => ({ content: '{"prompt": "masterpiece, The girl hugs the witch."}', finish_reason: 'length' });
    const job = await queue(diffusion(), '@hime hugs @char2', { run: 'run-cut' });
    const { report, positive } = await dequeue(job);
    assert.equal(calls.at(-1).rejectTruncated, true);
    assert.notEqual(report.ok, true);
    assert.doesNotMatch(positive, /The girl hugs the witch/);
    // and the image info says which failure it was: cut off, not "nothing came back"
    assert.equal(report.reason, 'truncated');
    assert.match(describeProse(report, { LANG: {} }), /stopped at the token limit/);
    assert.match(describeProse(report, { LANG: { ai_prose_fail_truncated: '截断' } }), /截断/);
});

test('the paragraph is written from the picture the tags describe: one roll of the dice per image', opts, async () => {
    const settings = diffusion();
    globalThis.globalSettings = settings;
    const refineContext = {
        chain: [
            { id: 'common', text: 'masterpiece, {red|blue|green} background, ' },
            { id: 'characters', text: 'boc, {short|long} hair miko, {short|long} hair witch, eoc, ' },
            { id: 'cf_cast1', text: '{red|blue|green} bow, ' },
            { id: 'positive', text: '{red|blue|green} dress, ' },
            { id: 'cf_action', text: '@hime hugs @char2' },
        ],
        characterTags: ['{short|long} hair miko, ', '{short|long} hair witch, '],
        beforePrompts: '{dawn|dusk} bop, ',
        beforeCharacters: 'boc, ',
        afterCharacters: 'eoc, ',
        afterPrompts: '{dawn|dusk} eop',
        exclude: '',
    };
    // the tag prompt: BOP, the units in order (the characters block in its place), EOP
    const joined = `${refineContext.beforePrompts}${refineContext.chain.map(entry => entry.text).join('')}${refineContext.afterPrompts}`;
    for (let image = 0; image < 20; image++) {
        // createPrompt records what this image drew; the Prose units replay it
        const materials = createPromptMaterials();
        const tagPrompt = processRandomString(joined, materials);
        materials.replay();
        const job = await captureProseJob({
            settings, LANG, refineContext, tagPrompt, run: `run-dice-${image}`,
            resolveText: async text => processRandomString(text, materials),
        });
        const units = job.source.jsonSlots.before + job.source.chain.map(entry => entry.text).join('') + job.source.jsonSlots.after;
        assert.equal(units, tagPrompt, 'the LLM is told about the image that is being made');
        assert.equal(`${job.source.jsonSlots.beforeCharacters}${job.source.characterTags.join('')}${job.source.jsonSlots.afterCharacters}`,
            job.source.chain.find(entry => entry.id === 'characters').text, 'the slot tags are the characters block');
    }
});

test('a weight plan reaches the row it was set on, and no other', opts, async () => {
    const settings = diffusion();
    globalThis.globalSettings = settings;
    // "smile" stands in three rows: the Positive plan is for the Positive row's first one
    const weights = { 'positive/smile#0': 1.3, 'positive/smile#1': 0.7, 'cf_cast1/red bow#0': 0.8, 'common/masterpiece#0': 1.1 };
    const weigher = createPlanWeigher(weights);
    const refineContext = {
        chain: [
            { id: 'common', text: 'masterpiece, ' },
            { id: 'characters', text: 'reimu, smile, marisa, ' },
            { id: 'cf_cast1', text: 'red bow, ' },
            { id: 'cf_cast2', text: 'witch hat, ' },
            { id: 'positive', text: 'smile, standing, smile, ' },
            { id: 'cf_action', text: '@hime hugs @char2' },
        ],
        characterTags: ['reimu, smile, ', 'marisa, '],
        beforePrompts: '', beforeCharacters: '', afterCharacters: '', afterPrompts: '', exclude: '',
    };
    const job = await captureProseJob({
        settings, LANG, refineContext, run: 'run-weights',
        // generate.js's wiring: one weigher for the chain, each unit weighed as its own row
        weighText: (text, field) => (field ? weigher(text, field) : text),
    });
    await dequeue(job);
    const fields = sentFields();
    assert.equal(fields.positive, '(smile:1.30), standing, (smile:0.70)', 'the Positive row: first and second "smile" by their own plans');
    assert.equal(fields.common, '(masterpiece:1.10)');
    // the characters block is no prompt row: the Positive plan must not reach its "smile"
    assert.deepEqual(fields.characters, [
        { ref: '@1', tags: 'reimu, smile, (red bow:0.80)' },
        { ref: '@2', tags: 'marisa, witch hat' },
    ]);
});

test('the "@" strip leaves the LoRA lines alone: a file name is not a reference', opts, async () => {
    const job = await queue({ ...diffusion(), ai_prose_enable: false }, '@hime hugs @char2');
    const positive = 'masterpiece, @wlop, @hime hugs @char2\n<lora:anime_style@1.5_v2:1:1>\n<lora:plain@hime:1:1>';
    const result = await dequeue(job, { positive });
    assert.equal(result.positive, 'masterpiece, @wlop, hime hugs char2\n<lora:anime_style@1.5_v2:1:1>\n<lora:plain@hime:1:1>');
});

test('Cancel while the paragraph is written stops the image; the answer still lands in the cache', opts, async () => {
    const release = heldAnswer('{"prompt": "masterpiece, Late paragraph."}');
    const job = await queue(diffusion(), '@hime hugs @char2');
    const pending = dequeue(job, { positive: 'tags', isCancelled: () => globalThis.generate.cancelClicked });
    globalThis.generate.cancelClicked = true;
    const { report, positive } = await pending;
    assert.equal(report.cancelled, true);
    assert.equal(positive, 'tags');
    assert.equal(describeProse(report), '');
    release();
    await new Promise(resolve => setImmediate(resolve));
    globalThis.generate.cancelClicked = false;
    const again = await dequeue(job);
    assert.equal(again.report.cached, true);
    assert.equal(again.positive, 'masterpiece, Late paragraph.\n<lora:x:1:1>');
});

test('another model writes its own paragraph', opts, async () => {
    const job = await queue(diffusion(), '@hime hugs @char2');
    await dequeue(job);
    globalThis.globalSettings = { ...diffusion(), ai_local_model_mode: 'Small' };
    const { report } = await dequeue(job);
    assert.equal(report.cached, false);
    assert.equal(calls.length, 2);
});

test('Prose off: no LLM call, and the references lose their "@" so Anima does not read them as artists', opts, async () => {
    const job = await queue({ ...diffusion(), ai_prose_enable: false }, '@hime hugs @char2');
    assert.equal(job.enabled, false);
    const { report, positive } = await dequeue(job, { positive: '@wlop, reimu, @hime hugs @char2, @2 smiles' });
    assert.equal(report, null);
    assert.equal(positive, '@wlop, reimu, hime hugs char2, char2 smiles');
    assert.equal(calls.length, 0);
});

test('references the action makes to no character are named in the image info', opts, async () => {
    const settings = diffusion({ character_slots: [{ key: 'A', alias: 'hime' }, { key: 'None' }, { key: 'None' }] });
    globalThis.globalSettings = settings;
    const refineContext = { ...context('@hime hugs @char3 and @old'), chain: context('@hime hugs @char3 and @old').chain.filter(entry => entry.id !== 'cf_cast2') };
    refineContext.characterTags = ['reimu, ', '', ''];
    const job = await captureProseJob({ settings, LANG, refineContext, run: 'run-refs' });
    const { report } = await dequeue(job);
    assert.deepEqual(report.unknown, ['@3', '@old']);
    assert.match(describeProse(report, { LANG: {} }), /unknown cast references: @3, @old/);
});

test('an edit typed while Regenerate runs is kept; the new paragraph becomes what Revert returns', opts, async () => {
    const job = await queue(diffusion(), '@hime hugs @char2');
    await dequeue(job);
    const release = heldAnswer('{"prompt": "masterpiece, A new paragraph."}');
    const regenerating = regenerateProse();
    await new Promise(resolve => setImmediate(resolve));
    setProseParagraph('typed while it was writing');
    release();
    assert.equal((await regenerating).ok, true);
    assert.equal(proseState().prompt, 'typed while it was writing', 'the keystrokes are not thrown away');
    assert.equal(proseState().original, 'masterpiece, A new paragraph.');
    assert.equal(proseState().edited, true);
    assert.equal((await dequeue(job)).positive, 'typed while it was writing\n<lora:x:1:1>');
    revertProseParagraph();
    assert.equal((await dequeue(job)).positive, 'masterpiece, A new paragraph.\n<lora:x:1:1>');
});

test('the queue row\'s "−" on the image being written stops it, like Cancel does', opts, async () => {
    heldAnswer('{"prompt": "masterpiece, Dropped paragraph."}');
    const job = await queue(diffusion(), '@hime hugs @char2');
    globalThis.queueManager = { cancelFirst: false };
    // no isCancelled passed: applyProse watches Cancel and the queue row on its own
    const pending = dequeue(job, { positive: 'tags' });
    globalThis.queueManager.cancelFirst = true;
    const { report, positive } = await pending;
    assert.equal(report.cancelled, true);
    assert.equal(positive, 'tags', 'the image the user dropped never gets the paragraph');
});

test('generate.js takes the job at queue time and does not start the backend after a Cancel', opts, () => {
    const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
    const generate = fs.readFileSync(path.join(root, 'scripts/renderer/generate.js'), 'utf8').replace(/\r\n/g, '\n');
    assert.match(generate, /const proseJob = await captureProseJob\(\{[\s\S]*?runSame,[\s\S]*?resolveText:[\s\S]*?replaceWildcardsAsync\([\s\S]*?filterPrompts\([\s\S]*?weighText:/);
    assert.match(generate, /generateData\.queueManager\.prose = proseJob;/);
    assert.match(generate, /applyProse\(generateData, \{\n\s*job: queueManager\.prose,/);
    // a Cancel ends the run; a queue-row delete ("−", jobDropped) drops this job only, so
    // the loop goes on (tests/queue-loop.test.mjs covers the row side)
    assert.match(generate, /result = \(prose\?\.cancelled \|\| globalThis\.generate\.cancelClicked \|\| jobDropped\(generateData\)\)\n\s*\? \{ ret: 'success', retCopy: '', breakNow: globalThis\.generate\.cancelClicked === true, cancelled: true \}\n\s*: await seartGenerate\(/);
    // the units are resolved with this image's own choices, not a second roll of the dice
    assert.match(generate, /const proseMaterials = createPromptResult\.materials\?\.replay\?\.\(\) \?\? null;/);
    assert.match(generate, /replaceWildcardsAsync\(\n\s*filterPrompts\([\s\S]*?createPromptResult\.randomSeed, proseMaterials\), proseMaterials\)/);
    assert.match(generate, /materials = createPromptMaterials\(\);\n\s*pos = await replaceWildcardsAsync\(pos, randomSeed, materials\);\n\s*pos = processRandomString\(pos, materials\);/);

});
