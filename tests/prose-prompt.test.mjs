import assert from 'node:assert/strict';
import test from 'node:test';

import {
    buildProseFields,
    buildProseFieldsFromPositive,
    composeProsePositive,
    hasNonEnglish,
    normalizeProseScope,
    parseProseResponse,
    proseEnabled,
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
