import {
    PROMPT_MODE_REFINE,
    REFINE_SYSTEM_PROMPT,
    buildRefineUserContent,
    buildRefineV2UserContent,
    buildRefineV3UserContent,
    normalizePromptMode,
    refineRequestSchema,
} from '../aiPromptRefiner.js';
import { isOllamaChatUrl } from '../shared/ollamaUrl.js';
import { PROSE_RESPONSE_FORMAT, PROSE_SYSTEM_PROMPT, isProseMode } from '../shared/prosePrompt.js';

const SMALL_MODEL = 'gemma4-12b-uncensored-comfy:latest';
const LARGE_MODEL = 'hf.co/HauhauCS/Qwen3.5-35B-A3B-Uncensored-HauhauCS-Aggressive:Q4_K_M';

// prose: the 35B MoE scored best on the regional bench (14/15 from a Japanese action)
// and answers in ~8 s on the CPU; Small forces the 12B when its 21 GB of RAM is too much.
const MODEL_BY_USE = Object.freeze({
    prompt: SMALL_MODEL,
    preview: SMALL_MODEL,
    regional: LARGE_MODEL,
    prose: LARGE_MODEL,
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
// that never mentions schema_version keeps the legacy generation-only request. The
// renderer reads the answer against the same schema (refineRequestContext).
function structuredRefineVersion(systemPrompt) {
    return refineRequestSchema(systemPrompt);
}

// A structured answer repeats every editable field (six with the Regional negatives) as
// JSON; cut off at the Expand-sized default it is invalid and the Refine is lost. A
// complete answer stops at its closing brace, so the floor only matters for long ones.
const STRUCTURED_REFINE_MIN_PREDICT = 1536;

// The same answer needs the time to write those tokens. On a CPU the large model runs at a
// few tokens a second, so the AI card's timeout (10-300 s, meant for an Expand of a few
// dozen tokens) can cut a Refine that was going to arrive - and a cut Refine loses the
// whole edit, while a slow one only makes the user wait. A structured request therefore
// gets at least this long, whatever the card says; everything else keeps the card's value.
export const STRUCTURED_REFINE_MIN_TIMEOUT = 300000;

/**
 * How long to wait for one chat request. `timeout` is the AI card's value in ms; a
 * structured Refine (editor fields plus generation context) is floored, as above.
 * 0 / not a number means no limit, as it did before the limit was armed at all.
 */
export function resolveChatTimeout({ timeout, promptMode = 'Expand', editorFields = null, generationContext = null } = {}) {
    const ms = Number(timeout);
    if (!Number.isFinite(ms) || ms <= 0) return 0;
    const structured = normalizePromptMode(promptMode) === PROMPT_MODE_REFINE
        && editorFields && typeof editorFields === 'object'
        && generationContext && typeof generationContext === 'object';
    return structured ? Math.max(ms, STRUCTURED_REFINE_MIN_TIMEOUT) : ms;
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
    keepAlive = 0,
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

    // Prose: the fields JSON is the user message and the answer is schema-constrained.
    // The model stays loaded between images (keepAlive) because the paragraph is
    // rewritten whenever the fields change, and a CPU-side reload costs 10-25 s.
    if (isProseMode(promptMode)) {
        return {
            model: resolveSaaOllamaModel({ mode, use: 'prose' }),
            messages: [
                { role: 'system', content: PROSE_SYSTEM_PROMPT },
                { role: 'user', content: userPrompt },
            ],
            stream: false,
            think: false,
            format: PROSE_RESPONSE_FORMAT,
            options: { temperature: safeTemperature, seed: 1, num_predict: safePredict, num_ctx: 4096 },
            keep_alive: keepAlive,
        };
    }

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
        options: { num_predict: structuredVersion ? Math.max(safePredict, STRUCTURED_REFINE_MIN_PREDICT) : safePredict },
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
            // an answer cut off at num_predict, in the OpenAI form llama.cpp already reports
            ...(response.done_reason === 'length' ? { finish_reason: 'length' } : {}),
        }],
    };
}

export { isOllamaChatUrl, LARGE_MODEL, SMALL_MODEL };
