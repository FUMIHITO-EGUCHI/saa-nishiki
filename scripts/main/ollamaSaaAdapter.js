import {
    PROMPT_MODE_REFINE,
    REFINE_SYSTEM_PROMPT,
    buildRefineUserContent,
    normalizePromptMode,
} from '../aiPromptRefiner.js';

const SMALL_MODEL = 'gemma4-12b-uncensored-comfy:latest';
const LARGE_MODEL = 'hf.co/HauhauCS/Qwen3.5-35B-A3B-Uncensored-HauhauCS-Aggressive:Q4_K_M';

const MODEL_BY_USE = Object.freeze({
    prompt: SMALL_MODEL,
    preview: SMALL_MODEL,
    regional: LARGE_MODEL,
});

function normalizeMode(mode) {
    const value = String(mode ?? 'Auto').trim().toLowerCase();
    if (value === 'small') return 'Small';
    if (value === 'large') return 'Large';
    return 'Auto';
}

function normalizeUse(use) {
    const value = String(use ?? 'prompt').trim().toLowerCase();
    return Object.hasOwn(MODEL_BY_USE, value) ? value : 'prompt';
}

export function resolveSaaOllamaModel({ mode = 'Auto', use = 'prompt' } = {}) {
    const normalizedMode = normalizeMode(mode);
    if (normalizedMode === 'Small') return SMALL_MODEL;
    if (normalizedMode === 'Large') return LARGE_MODEL;
    return MODEL_BY_USE[normalizeUse(use)];
}

export function buildOllamaChatRequest({
    mode = 'Auto',
    use = 'prompt',
    promptMode = 'Expand',
    systemPrompt = '',
    refineSystemPrompt = REFINE_SYSTEM_PROMPT,
    userPrompt = '',
    existingPositive = '',
    existingNegative = '',
    existingPositiveRight = '',
    temperature = 0.7,
    n_predict = 768,
} = {}) {
    if (typeof systemPrompt !== 'string' || typeof userPrompt !== 'string') {
        throw new TypeError('Ollama prompts must be strings');
    }

    const safeTemperature = Number.isFinite(Number(temperature))
        ? Math.min(2, Math.max(0.1, Number(temperature)))
        : 0.7;
    const safePredict = Number.isInteger(Number(n_predict))
        ? Math.min(4096, Math.max(256, Number(n_predict)))
        : 768;

    const useRefine = normalizePromptMode(promptMode) === PROMPT_MODE_REFINE;
    const request = {
        model: resolveSaaOllamaModel({ mode, use }),
        messages: useRefine
            ? [
                { role: 'system', content: refineSystemPrompt || REFINE_SYSTEM_PROMPT },
                {
                    role: 'user',
                    content: buildRefineUserContent({
                        instruction: userPrompt,
                        positive: existingPositive,
                        negative: existingNegative,
                        positiveRight: existingPositiveRight,
                    }),
                },
            ]
            : [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: `${userPrompt};Response in English` },
            ],
        temperature: safeTemperature,
        stream: false,
        think: false,
        options: { num_predict: safePredict },
        keep_alive: 0,
    };

    if (useRefine) request.format = 'json';
    return request;
}

export function normalizeOllamaChatResponse(responseText) {
    let response;
    try {
        response = JSON.parse(responseText);
    } catch {
        throw new Error('Ollama returned invalid JSON');
    }

    const content = response?.message?.content;
    if (typeof content !== 'string') {
        throw new Error('Ollama response did not contain message content');
    }

    return {
        model: typeof response.model === 'string' ? response.model : '',
        choices: [{
            message: {
                role: response.message.role || 'assistant',
                content,
            },
        }],
    };
}

export function isOllamaChatUrl(apiUrl) {
    try {
        const url = new URL(apiUrl);
        return url.protocol === 'http:'
            && (url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '[::1]')
            && url.port === '11434'
            && url.pathname.replace(/\/$/, '') === '/api/chat';
    } catch {
        return false;
    }
}

export { LARGE_MODEL, SMALL_MODEL };
