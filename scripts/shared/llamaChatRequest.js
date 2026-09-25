// The request body for a llama.cpp server (or any OpenAI-style /v1/chat/completions
// endpoint) that is not Ollama. Pure; shared by the main-process backend and its tests.
//
// Expand / Refine keep the historical shape (the user text gets ";Response in English",
// the answer stops at the chat end token). Prose is different: the user message is the
// fields JSON the model was trained on and must go out untouched, the answer is the
// paragraph's JSON, and the distilled student runs without a schema (its answers parse
// as they are; a grammar would only slow the 250k-token vocabulary down).
import { isProseMode } from './prosePrompt.js';

export function buildLlamaChatRequest({ promptMode, systemPrompt, userPrompt, temperature, n_predict } = {}) {
    if (isProseMode(promptMode)) {
        return {
            temperature,
            seed: 1,
            max_tokens: n_predict,
            n_predict,
            cache_prompt: true,
            stream: false,
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: userPrompt },
            ],
        };
    }
    return {
        temperature,
        n_predict,
        cache_prompt: true,
        stop: ['<|im_end|>'],
        messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: `${userPrompt};Response in English` },
        ],
    };
}
