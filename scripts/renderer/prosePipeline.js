// Prose step of the generation queue: for the Diffusion model type with Prose switched
// on, the assembled tag prompt is rewritten as one English paragraph by the local / pod
// LLM before the image request goes out. The paragraph is cached by its input fields, so
// a batch, or a re-run with the same fields, pays for one LLM call.
//
// The last paragraph is kept for the Prose card: the user can edit it (the edit replaces
// the cached paragraph, so the next image with the same fields sends their text), revert
// to the LLM's text, or ask for a new one.
//
// Failures never block a picture: an unreachable LLM, an empty answer or a paragraph that
// still carries non-English characters (which Anima's T5 side cannot read) leaves the tag
// prompt as it was and says so in the image info.

import { currentLocalLlmEndpoint, requestLocalAi } from './remoteAI.js';
import { POD_SSH_CHAT_URL, isPodSshLlm } from '../shared/llmEndpoint.js';
import { castEnabled, castRoster } from '../shared/castMembers.js';
import {
    PROSE_MODE,
    PROSE_SYSTEM_PROMPT,
    buildProseFields,
    buildProseFieldsFromPositive,
    buildProseUserContent,
    composeProsePositive,
    normalizeProseScope,
    parseProseResponse,
    proseCacheKey,
    proseEnabled,
    splitLoraLines,
} from '../shared/prosePrompt.js';

const CAT = '[Prose]';
const CACHE_LIMIT = 64;
const CHANGE_EVENT = 'saa:prose-changed';
const cache = new Map();   // fields JSON -> paragraph

// The paragraph of the last image: { key, fields, prompt, original, edited }
let last = null;
let writing = false;

function remember(key, prompt) {
    cache.delete(key);
    cache.set(key, prompt);
    if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value);
}

function notify() {
    document.dispatchEvent(new CustomEvent(CHANGE_EVENT));
}

/** Forget every paragraph (the system prompt or model changed). */
export function resetProseCache() {
    cache.clear();
    last = null;
    notify();
}

function fieldsFor({ positive, refineContext, aiMode, aiText, settings, LANG }) {
    const customFields = settings.prompt_custom_fields;
    const cast = castEnabled(settings) ? castRoster(settings, LANG) : [];
    const scope = normalizeProseScope(settings.ai_prose_scope);
    // Refine rewrote the whole positive prompt; the ordered units no longer describe it.
    if (String(aiMode ?? '').toLowerCase() === 'refine') {
        return buildProseFieldsFromPositive(positive, { customFields, chain: refineContext?.chain ?? [], cast });
    }
    return buildProseFields({
        chain: refineContext?.chain ?? [],
        characterTags: refineContext?.characterTags ?? [],
        customFields,
        aiText: String(aiMode ?? '').toLowerCase() === 'expand' ? aiText : '',
        cast,
        scope,
    });
}

// Where the paragraph is written: the pod, whenever its SSH relay is configured (the
// images go there too, and its GPU takes the LLM), unless the AI card explicitly says
// Local; otherwise the local Ollama. Independent of the card's Off / Expand / Refine.
export function proseEndpoint(settings = {}) {
    const explicitLocal = String(settings.ai_interface ?? '') === 'Local';
    if (!explicitLocal && isPodSshLlm(settings)) return { apiUrl: POD_SSH_CHAT_URL, apiAuth: '' };
    return currentLocalLlmEndpoint();
}

/** A short label of where the paragraph is written, for the Prose card. */
export function describeProseEndpoint(settings = {}) {
    const explicitLocal = String(settings.ai_interface ?? '') === 'Local';
    if (!explicitLocal && isPodSshLlm(settings)) {
        const model = String(settings.ai_pod_model ?? '').split('/').pop();
        return model ? `Pod · ${model}` : 'Pod';
    }
    return `Local · ${settings.ai_local_model_mode ?? 'Auto'}`;
}

async function requestParagraph(fields) {
    const SETTINGS = globalThis.globalSettings;
    const endpoint = proseEndpoint(SETTINGS);
    const content = await requestLocalAi({
        apiUrl: endpoint.apiUrl,
        apiAuth: endpoint.apiAuth,
        userPrompt: buildProseUserContent(fields),
        systemPrompt: PROSE_SYSTEM_PROMPT,
        modelMode: globalThis.ai?.local_model_mode?.getValue?.() ?? SETTINGS.ai_local_model_mode,
        aiUse: 'prose',
        promptMode: PROSE_MODE,
        temperature: 0.3,
        n_predict: 512,
        keepAlive: SETTINGS.ai_pod_keep_alive ?? '10m',
        timeout: (globalThis.ai?.local_timeout?.getValue?.() ?? SETTINGS.ai_local_timeout ?? 120) * 1000,
    });
    return parseProseResponse(content);
}

/**
 * Rewrites `generateData.positive` in place when Prose applies. Returns a report for the
 * image info: `{ applied, prompt, reason, cached, edited }`, or null when Prose is off.
 */
export async function applyProse(generateData, { refineContext, aiMode, aiText, LANG } = {}) {
    const SETTINGS = globalThis.globalSettings ?? {};
    if (!proseEnabled(SETTINGS)) return null;

    const fields = fieldsFor({ positive: generateData.positive, refineContext, aiMode, aiText, settings: SETTINGS, LANG });
    const key = proseCacheKey(fields);
    const { loraLines } = splitLoraLines(generateData.positive);

    let prompt = cache.get(key);
    let cached = prompt !== undefined;
    let reason = '';
    if (!cached) {
        if (globalThis.generate) globalThis.generate.loadingMessage = LANG?.generate_prose ?? 'Writing the prompt as a paragraph…';
        console.debug(CAT, 'fields', JSON.stringify(fields));
        writing = true;
        notify();
        try {
            const result = await requestParagraph(fields);
            if (result.ok) {
                prompt = result.prompt;
                remember(key, prompt);
                last = { key, fields, prompt, original: prompt, edited: false };
            } else {
                reason = result.reason;
                console.warn(CAT, 'kept the tag prompt:', reason, result.prompt ? `(${result.prompt.slice(0, 120)}…)` : '');
            }
        } finally {
            writing = false;
            notify();
        }
    } else if (last?.key !== key) {
        last = { key, fields, prompt, original: prompt, edited: false };
        notify();
    }

    if (prompt === undefined) return { applied: false, prompt: '', reason, cached: false, edited: false };
    const edited = Boolean(last && last.key === key && last.edited);
    generateData.positive = composeProsePositive(prompt, loraLines);
    return { applied: true, prompt, reason: '', cached, edited };
}

/** The paragraph of the last image, for the Prose card (null before the first one). */
export function proseState() {
    return last ? { ...last, writing } : { writing };
}

/** The user's edit of the last paragraph: sent as it is while the fields stay the same. */
export function setProseParagraph(text) {
    if (!last) return;
    const prompt = String(text ?? '');
    last.prompt = prompt;
    last.edited = prompt !== last.original;
    remember(last.key, prompt);
    notify();
}

export function revertProseParagraph() {
    if (!last) return;
    setProseParagraph(last.original);
}

/** Asks the LLM for a new paragraph from the last fields. Returns the parse result, or null. */
export async function regenerateProse() {
    if (!last || writing) return null;
    const { key, fields } = last;
    writing = true;
    notify();
    try {
        const result = await requestParagraph(fields);
        if (result.ok) {
            remember(key, result.prompt);
            last = { key, fields, prompt: result.prompt, original: result.prompt, edited: false };
        } else {
            console.warn(CAT, 'regenerate kept the previous paragraph:', result.reason);
        }
        return result;
    } finally {
        writing = false;
        notify();
    }
}

export function onProseChange(listener) {
    document.addEventListener(CHANGE_EVENT, listener);
}

/** The image-info lines for a prose report (BBCode colours, like the rest of the info). */
export function describeProse(report, { LANG, dark } = {}) {
    if (!report) return '';
    const color = dark ? 'hotpink' : 'Purple';
    if (!report.applied) {
        const why = report.reason === 'non-english'
            ? (LANG?.ai_prose_fail_non_english ?? 'the paragraph still contained non-English text')
            : (LANG?.ai_prose_fail ?? 'no paragraph came back');
        return `Prose: [color=${color}]${LANG?.ai_prose_kept_tags ?? 'tags sent as written'} (${why})[/color]\n`;
    }
    const mark = report.edited ? ' (edited)' : report.cached ? ' (cached)' : '';
    return `Prose${mark}:\n[color=${color}]${report.prompt}[/color]\n`;
}
