import assert from 'node:assert/strict';
import test from 'node:test';

import {
    PROSE_MODE,
    PROSE_RESPONSE_FORMAT,
    buildProseFields,
    buildProseFieldsFromPositive,
    buildProseUserContent,
    composeProsePositive,
    hasNonEnglish,
    isProseMode,
    normalizeProseScope,
    parseProseResponse,
    proseCacheKey,
    proseEnabled,
    proseRefs,
    proseVerbatimText,
    splitLoraLines,
} from '../scripts/shared/prosePrompt.js';
import { buildOllamaChatRequest } from '../scripts/main/ollamaSaaAdapter.js';
import { PROSE_SYSTEM_PROMPT } from '../scripts/shared/prosePrompt.js';

const CHAIN = [
    { id: 'common', text: 'masterpiece, best quality, 2girls, ' },
    { id: 'views', text: 'full body, ' },
    { id: 'background', text: 'indoors, ' },
    { id: 'style', text: '' },
    { id: 'ai', text: '_|REPLACE_AI_PROMPT|_, ' },
    { id: 'characters', text: 'long blonde hair, blue eyes, white dress, short black hair, red eyes, black suit, ' },
    { id: 'positive', text: 'smile, ' },
    { id: 'cf_1', text: '黒髪の子が金髪の子をお姫様抱っこしている' },
    { id: 'cf_2', text: 'sparkles, ' },
];
const CUSTOMS = [
    { id: 'cf_1', name: 'Action', polarity: 'positive', text: '' },
    { id: 'cf_2', name: 'Extra', polarity: 'positive', text: '' },
];

test('Prose applies only to Diffusion with the switch on', () => {
    assert.equal(proseEnabled({ api_model_type: 'Diffusion', ai_prose_enable: true }), true);
    assert.equal(proseEnabled({ api_model_type: 'Checkpoint', ai_prose_enable: true }), false);
    assert.equal(proseEnabled({ api_model_type: 'Diffusion', ai_prose_enable: false }), false);
    assert.equal(proseEnabled({}), false);
});

test('fields come from the ordered units, one character per entry, the Action on its own', () => {
    const fields = buildProseFields({
        chain: CHAIN,
        characterTags: ['long blonde hair, blue eyes, white dress, ', 'short black hair, red eyes, black suit, '],
        customFields: CUSTOMS,
        aiText: 'soft lighting',
    });
    assert.deepEqual(fields, {
        common: 'masterpiece, best quality, 2girls',
        characters: ['long blonde hair, blue eyes, white dress', 'short black hair, red eyes, black suit'],
        view: 'full body',
        background: 'indoors',
        style: '',
        positive: 'smile, soft lighting, sparkles',
        action: '黒髪の子が金髪の子をお姫様抱っこしている',
    });
});

test('with a cast each character is {ref, tags}: slot tags plus its "@alias" row, the action by "@<slot>"', () => {
    const roster = [
        { index: 1, alias: '姫', key: 'A', weight: 1, fieldId: 'cf_cast1' },
        { index: 2, alias: '執事', key: 'None', weight: 1, fieldId: 'cf_cast2' },
        { index: 3, alias: 'char3', key: 'None', weight: 1, fieldId: 'cf_cast3' },
    ];
    const chain = [
        ...CHAIN.filter(entry => entry.id !== 'cf_1'),
        { id: 'cf_cast1', text: 'black suit, red eyes, ' },
        { id: 'cf_cast2', text: 'blonde hair, white dress, ' },
        { id: 'cf_cast3', text: '' },
        { id: 'cf_1', text: '@姫が@執事をお姫様抱っこしている' },
    ];
    const fields = buildProseFields({
        chain,
        characterTags: ['hakurei reimu, ', '', ''],
        customFields: [...CUSTOMS, { id: 'cf_cast1', name: '@姫', polarity: 'positive', text: '' }],
        cast: roster,
    });
    assert.deepEqual(fields.characters, [
        { ref: '@1', tags: 'hakurei reimu, black suit, red eyes' },
        { ref: '@2', tags: 'blonde hair, white dress' },
    ]);
    assert.equal(fields.action, '@1が@2をお姫様抱っこしている');
    assert.equal(fields.positive, 'smile, sparkles', 'cast rows never leak into positive');
    assert.match(PROSE_SYSTEM_PROMPT, /never write a ref such as "@1"/);
});

test('the scope keeps view / background / style / positive as tags in common, or dissolves them', () => {
    const base = { chain: CHAIN, characterTags: ['a, ', 'b, '], customFields: CUSTOMS, aiText: 'soft lighting' };
    const cast = buildProseFields({ ...base, scope: 'cast' });
    assert.equal(cast.common, 'masterpiece, best quality, 2girls, full body, indoors, smile, soft lighting, sparkles');
    assert.deepEqual([cast.view, cast.background, cast.style, cast.positive], ['', '', '', '']);
    assert.equal(cast.action, '黒髪の子が金髪の子をお姫様抱っこしている');
    const scene = buildProseFields({ ...base, scope: 'scene' });
    assert.equal(scene.common, 'masterpiece, best quality, 2girls, full body, smile, soft lighting, sparkles');
    assert.equal(scene.background, 'indoors');
    const all = buildProseFields({ ...base, scope: 'all' });
    assert.equal(all.common, 'masterpiece, best quality, 2girls');
    assert.equal(all.view, 'full body');
    assert.equal(normalizeProseScope('nope'), 'cast');
});

test('the Artist unit stays a tag in common whatever the scope', () => {
    const chain = [...CHAIN.slice(0, 4), { id: 'artist', text: '@ciloranko, (@wlop:0.8), ' }, ...CHAIN.slice(4)];
    const base = { chain, characterTags: ['a, ', 'b, '], customFields: CUSTOMS };
    for (const scope of ['all', 'scene', 'cast']) {
        const fields = buildProseFields({ ...base, scope });
        assert.ok(fields.common.startsWith('masterpiece, best quality, 2girls, @ciloranko, (@wlop:0.8)'), `${scope}: ${fields.common}`);
        assert.ok(!fields.positive.includes('@'), `${scope}: the artist never reaches positive`);
    }
});

test('without per-character tags the characters unit is one entry; the AI marker is never sent', () => {
    const fields = buildProseFields({ chain: CHAIN, customFields: CUSTOMS });
    assert.deepEqual(fields.characters, ['long blonde hair, blue eyes, white dress, short black hair, red eyes, black suit']);
    assert.equal(fields.positive, 'smile, sparkles');
    assert.ok(!JSON.stringify(fields).includes('REPLACE_AI_PROMPT'));
});

test('after Refine the finished tag list goes as positive, LoRA lines and the Action kept apart', () => {
    const fields = buildProseFieldsFromPositive('masterpiece, 2girls, hugging\n<lora:style.safetensors:0.6:0.6>', { customFields: CUSTOMS, chain: CHAIN });
    assert.equal(fields.positive, 'masterpiece, 2girls, hugging');
    assert.equal(fields.action, '黒髪の子が金髪の子をお姫様抱っこしている');
    assert.deepEqual(fields.characters, []);
});

test('LoRA lines survive the rewrite below the paragraph', () => {
    const { text, loraLines } = splitLoraLines('masterpiece, 1girl\n<lora:a.safetensors:0.8:0.8>\n<lora:b.safetensors:1:1>');
    assert.equal(text, 'masterpiece, 1girl');
    assert.deepEqual(loraLines, ['<lora:a.safetensors:0.8:0.8>', '<lora:b.safetensors:1:1>']);
    assert.equal(composeProsePositive('masterpiece, A girl stands.', loraLines), 'masterpiece, A girl stands.\n<lora:a.safetensors:0.8:0.8>\n<lora:b.safetensors:1:1>');
    assert.equal(composeProsePositive('masterpiece, A girl stands.', []), 'masterpiece, A girl stands.');
});

test('the reply is the JSON prompt, or the raw text, and never non-English', () => {
    assert.deepEqual(parseProseResponse('{"prompt": "masterpiece, Two girls are indoors."}'), { ok: true, reason: '', prompt: 'masterpiece, Two girls are indoors.' });
    assert.deepEqual(parseProseResponse('<think>hmm</think>masterpiece, Two girls.'), { ok: true, reason: '', prompt: 'masterpiece, Two girls.' });
    assert.equal(parseProseResponse('').ok, false);
    assert.equal(parseProseResponse('{"prompt": ""}').reason, 'empty');
    const japanese = parseProseResponse('{"prompt": "masterpiece, 金髪の少女"}');
    assert.equal(japanese.ok, false);
    assert.equal(japanese.reason, 'non-english');
    assert.equal(hasNonEnglish('café, naïve, 2girls'), false, 'Latin accents are not the T5 problem');
});

test('the Ollama Prose request is schema-constrained and keeps the model loaded', () => {
    const request = buildOllamaChatRequest({
        mode: 'Auto',
        use: 'prose',
        promptMode: 'Prose',
        systemPrompt: 'ignored',
        userPrompt: '{"common":"masterpiece"}',
        temperature: 0.3,
        n_predict: 512,
        keepAlive: '10m',
    });
    assert.equal(request.model, 'hf.co/HauhauCS/Qwen3.5-35B-A3B-Uncensored-HauhauCS-Aggressive:Q4_K_M');
    assert.equal(request.messages[0].content, PROSE_SYSTEM_PROMPT);
    assert.equal(request.messages[1].content, '{"common":"masterpiece"}');
    assert.equal(request.format.required[0], 'prompt');
    assert.equal(request.options.temperature, 0.3);
    assert.equal(request.options.num_predict, 512);
    assert.equal(request.keep_alive, '10m');
    assert.equal(request.think, false);
    assert.equal(buildOllamaChatRequest({ mode: 'Small', use: 'prose', promptMode: 'Prose', systemPrompt: '', userPrompt: '{}' }).model, 'gemma4-12b-uncensored-comfy:latest');
});

test('a reply that is cut off, not the JSON asked for, or a refusal is rejected, not sent as the prompt', () => {
    const cases = [
        ['{"prompt": "masterpiece, best quality, Two girls sit, the girl with long', 'invalid'],
        ['{"prompt": 42}', 'invalid'],
        ['{"text": "masterpiece, Two girls."}', 'invalid'],
        ['<think>Let me think about the girls', 'invalid'],
        ["I'm sorry, but I can't help with that request.", 'refusal'],
        ['I cannot write this.', 'refusal'],
        ['{"prompt": "masterpiece, девушка обнимает"}', 'non-english'],
        ['{"prompt": "masterpiece, สวัสดี"}', 'non-english'],
        ['{"prompt": "masterpiece, 𠀋"}', 'non-english'],
    ];
    for (const [reply, reason] of cases) {
        const parsed = parseProseResponse(reply);
        assert.equal(parsed.ok, false, reply);
        assert.equal(parsed.reason, reason, reply);
    }
    // an object that closes but does not parse (a trailing comma, an unquoted value)
    assert.equal(parseProseResponse('{"prompt": "masterpiece, Two girls.",}').reason, 'invalid');
    assert.equal(parseProseResponse('{"prompt": masterpiece}').reason, 'invalid');
    // the refusal is read at the start of the answer only: a paragraph may say the words
    assert.equal(parseProseResponse('{"prompt": "masterpiece, a girl who cannot stop smiling, sorry eyes."}').ok, true);
    // a fenced JSON answer is still the JSON
    assert.deepEqual(parseProseResponse('```json\n{"prompt": "masterpiece, Two girls."}\n```'), { ok: true, reason: '', prompt: 'masterpiece, Two girls.' });
    assert.equal(hasNonEnglish("μ's (love live!), 2girls"), false, 'Greek stays: it is in tags');
});

test('non-English text the LLM had to copy (common, a character entry) does not reject the paragraph', () => {
    const fields = { common: 'masterpiece, emilia・x', characters: [{ ref: '@1', tags: 'miku（vocaloid）, long hair' }], action: '@1 waves' };
    const verbatim = proseVerbatimText(fields);
    assert.equal(parseProseResponse('{"prompt": "masterpiece, emilia・x, miku（vocaloid）, a girl with long hair, waves."}', { verbatim }).ok, true);
    assert.equal(parseProseResponse('{"prompt": "masterpiece, emilia・x, the girl waves in 教室."}', { verbatim }).reason, 'non-english', 'untranslated text is still rejected');
});

test('a "@n" handle left in the paragraph is rejected; an artist "@name" copied from common is not', () => {
    const fields = { common: 'masterpiece, @ciloranko', characters: [{ ref: '@1', tags: 'a' }, { ref: '@2', tags: 'b' }], action: '@1 hugs @2' };
    const options = { verbatim: proseVerbatimText(fields), refs: proseRefs(fields) };
    assert.deepEqual(proseRefs(fields), ['@1', '@2']);
    assert.equal(parseProseResponse('{"prompt": "masterpiece, @ciloranko, @1 hugs the girl."}', options).reason, 'refs');
    assert.equal(parseProseResponse('{"prompt": "masterpiece, @ciloranko, a girl hugs another girl."}', options).ok, true);
    assert.equal(parseProseResponse('{"prompt": "masterpiece, @3 hugs the girl."}', options).ok, true, '@3 is no handle of these fields');
});

test('the JSON slots are not lost: BOP opens common, EOP closes positive, BOC / EOC join positive with a cast', () => {
    const roster = [{ index: 1, alias: 'hime', key: 'A', weight: 1, fieldId: 'cf_cast1' }];
    const jsonSlots = { before: 'bop tag, ', beforeCharacters: 'boc tag, ', afterCharacters: 'eoc tag, ', after: 'eop tag, ' };
    const chain = [
        { id: 'common', text: 'masterpiece, ' },
        { id: 'characters', text: 'boc tag, reimu, eoc tag, ' },
        { id: 'positive', text: 'smile, ' },
    ];
    const withCast = buildProseFields({ chain, characterTags: ['reimu, '], cast: roster, jsonSlots, scope: 'all' });
    assert.equal(withCast.common, 'bop tag, masterpiece');
    assert.equal(withCast.positive, 'smile, boc tag, eoc tag, eop tag');
    // without per-slot tags the characters unit already carries BOC / EOC
    const plain = buildProseFields({ chain, jsonSlots, scope: 'all' });
    assert.deepEqual(plain.characters, ['boc tag, reimu, eoc tag']);
    assert.equal(plain.positive, 'smile, eop tag');
});

test('after Refine, the "@alias" references inside the finished list become "@n" as well', () => {
    const roster = [{ index: 1, alias: 'hime', key: 'A', weight: 1, fieldId: 'cf_cast1' }, { index: 2, alias: 'maid', key: 'B', weight: 1, fieldId: 'cf_cast2' }];
    const fields = buildProseFieldsFromPositive('masterpiece, @hime hugs @maid', { cast: roster, chain: [{ id: 'cf_1', text: '@hime hugs @maid' }], customFields: CUSTOMS });
    assert.equal(fields.positive, 'masterpiece, @1 hugs @2');
    assert.equal(fields.action, '@1 hugs @2');
});

test('the cache key names the endpoint and model the paragraph is written with', () => {
    const fields = { common: 'masterpiece', characters: [], action: '' };
    assert.notEqual(proseCacheKey(fields, 'http://127.0.0.1:11434/api/chat|Large|'), proseCacheKey(fields, 'http://127.0.0.1:11434/api/chat|Small|'));
    assert.equal(proseCacheKey(fields, 'x'), proseCacheKey({ ...fields }, 'x'));
});

test('the JSON is taken wherever the model put it; one that stops early never becomes the prompt', () => {
    const paragraph = 'masterpiece, Two girls.';
    const object = `{"prompt": "${paragraph}"}`;
    // a line of chat before it, a fence around it, a note after it: the object is the answer
    for (const reply of [
        `Here is the prompt:\n${object}`,
        `\`\`\`json\n${object}\n\`\`\`\nHope this helps!`,
        `${object} and some words after`,
        `Sure. {"meta": {"model": "x"}, "prompt": "${paragraph}"}`,
    ]) {
        assert.deepEqual(parseProseResponse(reply), { ok: true, reason: '', prompt: paragraph }, reply);
    }
    // a quote inside the paragraph does not end the object early
    assert.equal(parseProseResponse('{"prompt": "masterpiece, a sign saying \\"hi\\"."}').prompt, 'masterpiece, a sign saying "hi".');
    // cut off at n_predict, in a fence or after a line of chat: never the paragraph
    for (const reply of [
        '```json\n{"prompt": "masterpiece, Two girls sit, the girl with long',
        'Here is the prompt:\n{"prompt": "masterpiece, Two girls sit,',
    ]) {
        assert.equal(parseProseResponse(reply).reason, 'invalid', reply);
    }
    // a brace inside a paragraph is not an answer in JSON: the text stays the text
    const braces = 'masterpiece, a girl holding a { sign.';
    assert.deepEqual(parseProseResponse(braces), { ok: true, reason: '', prompt: braces });
});

test('a handle is matched whole: an artist token "@10" in common does not cover a leaked "@1"', () => {
    const fields = { common: 'masterpiece, @10', characters: [{ ref: '@1', tags: 'a' }], action: '@1 waves' };
    const options = { verbatim: proseVerbatimText(fields), refs: proseRefs(fields) };
    assert.equal(parseProseResponse('{"prompt": "masterpiece, @10, @1 waves."}', options).reason, 'refs');
    assert.equal(parseProseResponse('{"prompt": "masterpiece, @10, the girl waves."}', options).ok, true);
    // an artist whose name begins with digits is no handle at all
    assert.deepEqual(proseRefs({ characters: [], action: 'a @1041uuu drawing of @2' }), ['@2']);
});

test('the prompt mode name is read loosely, and the fields go out as indented JSON', () => {
    assert.equal(PROSE_MODE, 'Prose');
    assert.equal(isProseMode(PROSE_MODE), true);
    assert.equal(isProseMode(' prose '), true);
    assert.equal(isProseMode('PROSE'), true);
    assert.equal(isProseMode('Refine'), false);
    assert.equal(isProseMode('Prose mode'), false);
    assert.equal(isProseMode(''), false);
    assert.equal(isProseMode(undefined), false);

    const fields = { common: 'masterpiece', characters: [{ ref: '@1', tags: 'reimu' }], action: '@1 waves' };
    assert.deepEqual(JSON.parse(buildProseUserContent(fields)), fields);
    assert.match(buildProseUserContent(fields), /^\{\n {2}"common": "masterpiece",/, 'one field per line, so the model sees the names');
    assert.deepEqual(PROSE_RESPONSE_FORMAT.required, ['prompt']);
    assert.equal(PROSE_RESPONSE_FORMAT.properties.prompt.type, 'string');
});

test('the copied text covers a character entry that is a plain string, not a cast entry', () => {
    // without a cast the characters are strings; their non-English parts are copied too
    const fields = { common: 'masterpiece, 東方', characters: ['hakurei reimu, 巫女', 'kirisame marisa'], action: '' };
    assert.equal(proseVerbatimText(fields), 'masterpiece, 東方\nhakurei reimu, 巫女\nkirisame marisa');
    const reply = '{"prompt": "masterpiece, 東方, hakurei reimu, 巫女 stands beside kirisame marisa."}';
    assert.equal(parseProseResponse(reply, { verbatim: proseVerbatimText(fields) }).ok, true);
    assert.equal(parseProseResponse(reply).reason, 'non-english', 'nothing was copied, so the same answer is rejected');
    assert.equal(proseVerbatimText({}), '');
    assert.equal(proseVerbatimText(), '');
    assert.deepEqual(proseRefs({}), []);
    assert.deepEqual(proseRefs(), []);
});

test('only a field named exactly "Action" is the action; any other row is an ordinary tag row', () => {
    const chain = [
        { id: 'cf_a', text: 'she leans over him, ' },
        { id: 'cf_b', text: 'extra tag, ' },
        { id: 'cf_c', text: 'another tag, ' },
    ];
    const customFields = [
        { id: 'cf_a', name: '  action  ', polarity: 'positive', text: '' },
        { id: 'cf_b', name: 'Actions', polarity: 'positive', text: '' },
        { id: 'cf_c', name: 'Reaction', polarity: 'positive', text: '' },
    ];
    const fields = buildProseFields({ chain, customFields });
    assert.equal(fields.action, 'she leans over him');
    assert.equal(fields.positive, 'extra tag, another tag');
    // a chain with no Action row at all leaves the field empty rather than guessing one
    assert.equal(buildProseFields({ chain, customFields: [] }).action, '');
    assert.equal(buildProseFields({}).action, '');
    assert.deepEqual(buildProseFields({}).characters, []);
});
