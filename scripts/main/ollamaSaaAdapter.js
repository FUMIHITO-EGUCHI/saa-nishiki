import {
    PROMPT_MODE_REFINE,
    REFINE_SYSTEM_PROMPT,
    buildRefineUserContent,
    buildRefineV2UserContent,
    buildRefineV3UserContent,
    normalizePromptMode,
} from '../aiPromptRefiner.js';
import { isOllamaChatUrl } from '../shared/ollamaUrl.js';

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

// Which structured Refine schema the saved system prompt asks for. A customized prompt
// that never mentions schema_version keeps the legacy generation-only request.
function structuredRefineVersion(systemPrompt) {
    const text = String(systemPrompt ?? '');
    const declared = /schema_version\D{0,4}(\d+)/i.exec(text);
    const version = declared ? Number(declared[1]) : 0;
    if (version === 2 || version === 3) return version;
    return /schema_version/i.test(text) ? 2 : 0;
}

function refineUserContent(version, { instruction, editorFields, generationContext, positive, negative, positiveRight }) {
    if (version === 3) return buildRefineV3UserContent({ instruction, editorFields, generationContext });
    if (version === 2) return buildRefineV2UserContent({ instruction, editorFields, generationContext });
    return buildRefineUserContent({ instruction, positive, negative, positiveRight });
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
    editorFields = null,
    generationContext = null,
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
    const structuredVersion = useRefine
        && editorFields && typeof editorFields === 'object'
        && generationContext && typeof generationContext === 'object'
        ? structuredRefineVersion(refineSystemPrompt || REFINE_SYSTEM_PROMPT)
        : 0;
    const request = {
        model: resolveSaaOllamaModel({ mode, use }),
        messages: useRefine
            ? [
                { role: 'system', content: refineSystemPrompt || REFINE_SYSTEM_PROMPT },
                {
                    role: 'user',
                    content: refineUserContent(structuredVersion, {
                        instruction: userPrompt,
                        editorFields,
                        generationContext,
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

export { isOllamaChatUrl, LARGE_MODEL, SMALL_MODEL };
