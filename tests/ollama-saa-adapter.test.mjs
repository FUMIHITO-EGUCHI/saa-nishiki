import test from 'node:test';
import assert from 'node:assert/strict';

import {
    buildOllamaChatRequest,
    normalizeOllamaChatResponse,
    resolveSaaOllamaModel,
} from '../scripts/main/ollamaSaaAdapter.js';
import { REFINE_SYSTEM_PROMPT } from '../scripts/aiPromptRefiner.js';

const SMALL_MODEL = 'gemma4-12b-uncensored-comfy:latest';
const LARGE_MODEL = 'hf.co/HauhauCS/Qwen3.5-35B-A3B-Uncensored-HauhauCS-Aggressive:Q4_K_M';

test('Auto selects the 12B profile for ordinary SAA prompt work', () => {
    assert.equal(resolveSaaOllamaModel({ mode: 'Auto', use: 'prompt' }), SMALL_MODEL);
    assert.equal(resolveSaaOllamaModel({ mode: 'Auto', use: 'preview' }), SMALL_MODEL);
});

test('Auto selects the larger profile for regional SAA prompt work', () => {
    assert.equal(resolveSaaOllamaModel({ mode: 'Auto', use: 'regional' }), LARGE_MODEL);
});

test('Explicit Small and Large modes override the automatic use mapping', () => {
    assert.equal(resolveSaaOllamaModel({ mode: 'Small', use: 'regional' }), SMALL_MODEL);
    assert.equal(resolveSaaOllamaModel({ mode: 'Large', use: 'prompt' }), LARGE_MODEL);
});

test('Ollama chat requests include the selected model and unload after the request', () => {
    assert.deepEqual(
        buildOllamaChatRequest({
            mode: 'Auto',
            use: 'prompt',
            systemPrompt: 'system',
            userPrompt: 'user',
            temperature: 0.7,
            n_predict: 768,
        }),
        {
            model: SMALL_MODEL,
            messages: [
                { role: 'system', content: 'system' },
                { role: 'user', content: 'user;Response in English' },
            ],
            temperature: 0.7,
            stream: false,
            think: false,
            options: { num_predict: 768 },
            keep_alive: 0,
        },
    );
});

test('Refine requests send existing prompts as JSON and request structured output', () => {
    const request = buildOllamaChatRequest({
        mode: 'Small',
        use: 'prompt',
        promptMode: 'Refine',
        refineSystemPrompt: REFINE_SYSTEM_PROMPT,
        userPrompt: '顔と目を強調する',
        existingPositive: 'masterpiece, portrait, city background',
        existingNegative: 'worst quality, blurry',
        temperature: 0.3,
        n_predict: 768,
    });

    assert.equal(request.model, SMALL_MODEL);
    assert.equal(request.messages[0].content, REFINE_SYSTEM_PROMPT);
    assert.deepEqual(JSON.parse(request.messages[1].content), {
        instruction: '顔と目を強調する',
        positive: 'masterpiece, portrait, city background',
        negative: 'worst quality, blurry',
    });
    assert.equal(request.format, 'json');
    assert.equal(request.keep_alive, 0);
});

test('Ollama chat responses are normalized to the SAA response shape', () => {
    assert.deepEqual(
        normalizeOllamaChatResponse(JSON.stringify({
            model: SMALL_MODEL,
            message: { role: 'assistant', content: '1girl, portrait' },
        })),
        {
            model: SMALL_MODEL,
            choices: [{ message: { role: 'assistant', content: '1girl, portrait' } }],
        },
    );
});
