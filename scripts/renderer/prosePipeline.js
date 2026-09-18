// Prose step of the generation queue: for the Diffusion model type with Prose switched
// on, the assembled tag prompt is rewritten as one English paragraph by the local / pod
// LLM before the image request goes out. The paragraph is cached by its input fields, so
// a batch, or a re-run with the same fields, pays for one LLM call.
//
// Whether an image gets a paragraph, and what it is written from, is decided when the
// image is queued (captureProseJob): a job queued as Checkpoint stays tags after a switch
// to Diffusion, and the reverse. The units are resolved the way the tag prompt resolves
// them (Exclude, wildcards, random choices, weight plans), so the paragraph describes the
// image's own prompt.
//
// The last paragraph is kept for the Prose card: the user can edit it (the edit replaces
// the cached paragraph, so the next image with the same fields sends their text), revert
// to the LLM's text, or ask for a new one.
//
// Failures never block a picture: an unreachable LLM, an empty, cut-off or declining
// answer, or a paragraph that still carries non-English characters (which Anima's T5 side
// cannot read) leaves the tag prompt as it was and says so in the image info.

import { AI_REPLY_CUT_OFF, requestLocalAi } from './remoteAI.js';
import { POD_SSH_CHAT_URL, isPodSshLlm, resolveLlmEndpoint } from '../shared/llmEndpoint.js';
import { castEnabled, castPlainReferences, castRoster, unknownCastReferences } from '../shared/castMembers.js';
import { artistToken, filledArtistSlots } from '../shared/artistSlots.js';
import { normalizeCustomFields } from '../shared/promptFieldOrder.js';
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
    proseRefs,
    proseVerbatimText,
    splitLoraLines,
} from '../shared/prosePrompt.js';

const CAT = '[Prose]';
const CACHE_LIMIT = 64;
const CHANGE_EVENT = 'saa:prose-changed';
const CANCEL_POLL_MS = 200;
const CANCELLED = Symbol('cancelled');
const cache = new Map();     // key -> { prompt, original }
const failed = new Map();    // run + key -> reason: one generate click asks once per fields
const inflight = new Map();  // key -> promise of the parse result

// The paragraph of the last image: { key, fields, prompt, original, edited }
let last = null;
// The resolved units of the last queued image that was not a "Same" run
let lastSource = null;

function remember(map, key, value) {
    map.delete(key);
    map.set(key, value);
    if (map.size > CACHE_LIMIT) map.delete(map.keys().next().value);
}

function notify() {
    document.dispatchEvent(new CustomEvent(CHANGE_EVENT));
}

/** Forget every paragraph (the system prompt or model changed). */
export function resetProseCache() {
    cache.clear();
    failed.clear();
    last = null;
    notify();
}

// The Artist card's "@name" tokens: they keep their "@" when references lose theirs
function artistTokens(settings = {}) {
    return filledArtistSlots(settings.artist_slots).map(slot => artistToken(slot.key)).filter(Boolean);
}

/**
 * The units of one image, resolved the way its tag prompt was (Exclude, wildcards, random
 * choices). They are walked in the order the tag prompt puts them in - BOP, the chain with
 * the characters block (BOC, the slot tags, EOC) in its place, EOP - so a replayed "{a|b}"
 * lands on the option that prompt took (generate.js hands `resolveText` the image's own
 * materials).
 */
async function resolveSource(context, resolveText) {
    const resolve = async value => String((await resolveText(String(value ?? ''))) ?? '');
    const jsonSlots = { before: await resolve(context?.beforePrompts), beforeCharacters: '', afterCharacters: '', after: '' };
    const characterTags = [];
    const slotTags = Array.isArray(context?.characterTags) ? context.characterTags : [];
    const resolveCharacters = async () => {
        jsonSlots.beforeCharacters = await resolve(context?.beforeCharacters);
        for (const tags of slotTags) characterTags.push(await resolve(tags));
        jsonSlots.afterCharacters = await resolve(context?.afterCharacters);
        // the characters unit is exactly those pieces joined: rebuild it from them
        return `${jsonSlots.beforeCharacters}${characterTags.join('')}${jsonSlots.afterCharacters}`;
    };
    const chain = [];
    let seenCharacters = false;
    for (const entry of Array.isArray(context?.chain) ? context.chain : []) {
        if (entry?.id === 'characters') {
            seenCharacters = true;
            chain.push({ id: 'characters', text: await resolveCharacters() });
            continue;
        }
        // the AI marker stays: the Expand answer takes its place when the job runs
        chain.push({ id: entry?.id, text: entry?.id === 'ai' ? String(entry?.text ?? '') : await resolve(entry?.text) });
    }
    if (!seenCharacters) await resolveCharacters();
    jsonSlots.after = await resolve(context?.afterPrompts);
    return { chain, characterTags, jsonSlots };
}

// Each unit is weighed as the prompt field it is: a weight plan belongs to the row it was
// set on, so the Positive row's "smile" plan cannot land on a "smile" inside the characters
// block, and a cast / Action row takes the plan of its own row. The characters block and
// the JSON slots are no prompt fields and carry no plans at all.
function weighSource(source, weighText) {
    const weigh = (value, field) => String(weighText(String(value ?? ''), field) ?? '');
    // the job carries the units only (tagPrompt is lastSource's own bookkeeping)
    return {
        chain: source.chain.map(entry => ({ ...entry, text: entry.id === 'ai' ? entry.text : weigh(entry.text, entry.id) })),
        characterTags: [...source.characterTags],
        jsonSlots: { ...source.jsonSlots },
    };
}

/**
 * What Prose needs from one image, taken when it is queued (generate.js): whether Prose
 * applies (the model type and the switch at that moment), the cast, scope, Action fields
 * and Artist tokens, and the prompt units (`refineContext`) as this image resolved them.
 * `resolveText` gives a unit the tag prompt's own treatment (Exclude, wildcards, random
 * choices), `weighText(text, fieldId)` the weight plans of that unit's own prompt row
 * (createPlanWeigher). A "Same" run (`runSame`) has no units of its own and reuses those of
 * the last image, as long as `lastTagPrompt` (the prompt "Same" repeats) is still the one
 * they were taken with. `tagPrompt` is this image's tag prompt.
 * `run` is shared by the images of one click. Returns null for a Checkpoint job.
 */
export async function captureProseJob({
    settings = {},
    LANG = {},
    refineContext = null,
    runSame = false,
    tagPrompt = '',
    lastTagPrompt = '',
    run = '',
    resolveText = async text => text,
    weighText = text => text,
} = {}) {
    if (runSame) {
        // another run (a Regional one, say) wrote the prompt "Same" repeats
        if (lastSource && lastSource.tagPrompt !== lastTagPrompt) lastSource = null;
        if (lastSource) lastSource.tagPrompt = tagPrompt;
    }
    if (!castEnabled(settings)) {
        if (!runSame) lastSource = null;
        return null;
    }
    if (!runSame) lastSource = refineContext ? { ...await resolveSource(refineContext, resolveText), tagPrompt } : null;
    return {
        enabled: proseEnabled(settings),
        run: String(run ?? ''),
        cast: castRoster(settings, LANG),
        scope: normalizeProseScope(settings.ai_prose_scope),
        customFields: normalizeCustomFields(settings.prompt_custom_fields).map(field => ({ id: field.id, name: field.name })),
        artists: artistTokens(settings),
        source: lastSource ? weighSource(lastSource, weighText) : null,
    };
}

function fieldsFor(job, { positive, aiMode, aiText }) {
    const { source } = job;
    // 'off' when no AI request was made; a Remote request carries no mode and is an
    // Expand, as resolveQueuedAiPrompt reads it
    const mode = String(aiMode ?? '').trim().toLowerCase();
    // Refine rewrote the whole positive prompt; the ordered units no longer describe it.
    if (mode === 'refine') {
        return buildProseFieldsFromPositive(positive, { customFields: job.customFields, chain: source.chain, cast: job.cast });
    }
    return buildProseFields({
        chain: source.chain,
        characterTags: source.characterTags,
        customFields: job.customFields,
        aiText: mode === 'off' ? '' : aiText,
        cast: job.cast,
        scope: job.scope,
        jsonSlots: source.jsonSlots,
    });
}

// Where the paragraph is written: the pod, whenever its SSH relay is configured (the
// images go there too, and its GPU takes the LLM), unless the AI card explicitly says
// Local; otherwise the AI card's local / pod Ollama. Independent of Off / Expand / Refine.
export function proseEndpoint(settings = {}) {
    const explicitLocal = String(settings.ai_interface ?? '') === 'Local';
    if (!explicitLocal && isPodSshLlm(settings)) return { apiUrl: POD_SSH_CHAT_URL, apiAuth: '' };
    return resolveLlmEndpoint(settings);
}

/** A short label of where the paragraph is written, for the Prose card. */
export function describeProseEndpoint(settings = {}) {
    const explicitLocal = String(settings.ai_interface ?? '') === 'Local';
    if (!explicitLocal && isPodSshLlm(settings)) {
        const model = String(settings.ai_pod_model ?? '').split('/').pop();
        return model ? `Pod · ${model}` : 'Pod';
    }
    // a Pod AI card without the SSH relay still sends to the pod (its HTTPS address)
    const where = String(settings.ai_interface ?? '') === 'Pod' ? 'Pod' : 'Local';
    return `${where} · ${settings.ai_local_model_mode ?? 'Auto'}`;
}

function modelMode(settings = {}) {
    return globalThis.ai?.local_model_mode?.getValue?.() ?? settings.ai_local_model_mode ?? 'Auto';
}

// The endpoint and model a paragraph is written with: part of its cache key
function proseTarget(settings = {}) {
    const { apiUrl } = proseEndpoint(settings);
    return [apiUrl, modelMode(settings), apiUrl === POD_SSH_CHAT_URL ? String(settings.ai_pod_model ?? '') : ''].join('|');
}

async function requestParagraph(fields) {
    const SETTINGS = globalThis.globalSettings ?? {};
    const endpoint = proseEndpoint(SETTINGS);
    const content = await requestLocalAi({
        apiUrl: endpoint.apiUrl,
        apiAuth: endpoint.apiAuth,
        userPrompt: buildProseUserContent(fields),
        systemPrompt: PROSE_SYSTEM_PROMPT,
        modelMode: modelMode(SETTINGS),
        aiUse: 'prose',
        promptMode: PROSE_MODE,
        temperature: 0.3,
        // six characters plus the tags kept in common overflowed 512 and came back cut off
        n_predict: 1024,
        rejectTruncated: true,
        keepAlive: SETTINGS.ai_pod_keep_alive ?? '10m',
        timeout: (globalThis.ai?.local_timeout?.getValue?.() ?? SETTINGS.ai_local_timeout ?? 120) * 1000,
    });
    // half a paragraph is no paragraph, but the image info says which of the two it was
    if (content === AI_REPLY_CUT_OFF) return { ok: false, reason: 'truncated', prompt: '' };
    return parseProseResponse(content, { verbatim: proseVerbatimText(fields), refs: proseRefs(fields) });
}

// One LLM call per key at a time: a second asker (the queue while Regenerate runs, or
// the reverse) waits for the same answer. A good answer is cached as it arrives, even
// when the image that asked was cancelled meanwhile. Text typed into the card while the
// answer was on its way is kept as the paragraph - the new one becomes what Revert
// returns, so an edit is never dropped without the user seeing it.
function writeParagraph(key, fields) {
    if (!inflight.has(key)) {
        const before = cache.get(key);
        const request = requestParagraph(fields)
            .catch(error => {
                console.warn(CAT, 'request failed:', error?.message ?? error);
                return { ok: false, reason: 'empty', prompt: '' };
            })
            .then(result => {
                if (result.ok) {
                    const current = cache.get(key);
                    const typed = current && current !== before && current.prompt !== current.original ? current.prompt : result.prompt;
                    remember(cache, key, { prompt: typed, original: result.prompt });
                    for (const failure of [...failed.keys()]) if (failure.endsWith(`\n${key}`)) failed.delete(failure);
                }
                return result;
            })
            .finally(() => {
                inflight.delete(key);
                notify();
            });
        inflight.set(key, request);
        notify();
    }
    return inflight.get(key);
}

// Two ways an image stops while its paragraph is being written: the Cancel button (the
// whole run), and the "−" of the queue row it belongs to, which the queue manager marks
// on the running row (myQueueSlot.js: cancelFirst on the first press, and `dropped` on the
// job itself, which generate.js reads back through jobDropped).
// Both have to reach the wait below, or the image the user dropped is still generated.
function stopWanted() {
    return Boolean(globalThis.generate?.cancelClicked)
        || globalThis.queueManager?.cancelFirst === true
        || globalThis.generate?.runningJob?.queueManager?.dropped === true;
}

// Resolves with the promise, or with CANCELLED as soon as `isCancelled` says so (the LLM
// call itself cannot be taken back; its answer still lands in the cache).
function unlessCancelled(promise, isCancelled) {
    if (typeof isCancelled !== 'function') return promise;
    return new Promise(resolve => {
        const timer = setInterval(() => {
            if (!isCancelled()) return;
            clearInterval(timer);
            resolve(CANCELLED);
        }, CANCEL_POLL_MS);
        promise.then(value => {
            clearInterval(timer);
            resolve(value);
        });
    });
}

// The tags go out as written: "@alias" / "@2" would reach Anima as an artist, so the
// references lose their "@" (the Artist card's own tokens keep it). Only the tags: a LoRA
// line is a file name, and "<lora:style@1.5_v2:1:1>" must reach ComfyUI as it is.
function dropReferenceMarks(generateData, job) {
    if (typeof generateData?.positive !== 'string' || !Array.isArray(job?.cast) || job.cast.length === 0) return;
    const { text, loraLines } = splitLoraLines(generateData.positive);
    generateData.positive = composeProsePositive(castPlainReferences(text, job.cast, { verbatim: job.artists ?? [] }), loraLines);
}

/**
 * Rewrites `generateData.positive` in place when the queued `job` (captureProseJob) has
 * Prose on. Returns a report for the image info: `{ applied, prompt, reason, cached,
 * edited, unknown, retried?, cancelled? }`, or null when the job has no Prose.
 */
export async function applyProse(generateData, {
    job = null,
    aiMode,
    aiText,
    LANG,
    isCancelled = () => stopWanted(),
} = {}) {
    if (!job) return null;
    if (!job.enabled) {
        dropReferenceMarks(generateData, job);
        return null;
    }
    const report = extra => ({ applied: false, prompt: '', reason: '', cached: false, edited: false, unknown: [], ...extra });
    if (!job.source) {
        dropReferenceMarks(generateData, job);
        return report({ reason: 'no-fields' });
    }

    const SETTINGS = globalThis.globalSettings ?? {};
    const fields = fieldsFor(job, { positive: generateData.positive, aiMode, aiText });
    const key = proseCacheKey(fields, proseTarget(SETTINGS));
    const characterRefs = fields.characters.map(entry => entry?.ref).filter(Boolean);
    const unknown = unknownCastReferences(fields.action, characterRefs.length > 0 ? characterRefs : job.cast.map(member => `@${member.index}`));
    const { loraLines } = splitLoraLines(generateData.positive);

    let entry = cache.get(key);
    const cached = entry !== undefined && !inflight.has(key);
    let reason = '';
    if (!cached) {
        const failure = `${job.run}\n${key}`;
        if (entry === undefined && job.run && failed.has(failure)) {
            dropReferenceMarks(generateData, job);
            return report({ reason: failed.get(failure), retried: false, unknown });
        }
        if (globalThis.generate) globalThis.generate.loadingMessage = LANG?.generate_prose ?? 'Writing the prompt as a paragraph…';
        console.debug(CAT, 'fields', JSON.stringify(fields));
        const result = await unlessCancelled(writeParagraph(key, fields), isCancelled);
        if (result === CANCELLED) return report({ reason: 'cancelled', cancelled: true, unknown });
        entry = cache.get(key);
        if (entry === undefined) {
            reason = result.reason || 'empty';
            if (job.run) remember(failed, failure, reason);
            console.warn(CAT, 'kept the tag prompt:', reason, result.prompt ? `(${result.prompt.slice(0, 120)}…)` : '');
        }
    }

    if (entry === undefined || entry.prompt.trim() === '') {
        dropReferenceMarks(generateData, job);
        return report({ reason: reason || 'empty', unknown });
    }
    const edited = entry.prompt !== entry.original;
    if (last?.key !== key || last.prompt !== entry.prompt || last.original !== entry.original) {
        last = { key, fields, prompt: entry.prompt, original: entry.original, edited };
        notify();
    }
    generateData.positive = composeProsePositive(entry.prompt, loraLines);
    return { applied: true, prompt: entry.prompt, reason: '', cached, edited, unknown };
}

/** The paragraph of the last image, for the Prose card (null before the first one). */
export function proseState() {
    const writing = inflight.size > 0;
    return last ? { ...last, writing } : { writing };
}

/**
 * The user's edit of a paragraph: the last image's, or the one `key` names (an edit that
 * began before a newer paragraph arrived stays with its own). Sent as it is while the
 * fields stay the same; a blank edit sends the LLM's text instead of an empty prompt.
 */
export function setProseParagraph(text, { key = last?.key } = {}) {
    if (!key) return;
    const entry = cache.get(key) ?? (last?.key === key ? { prompt: last.prompt, original: last.original } : null);
    if (!entry) return;
    const typed = String(text ?? '');
    const prompt = typed.trim() === '' ? entry.original : typed;
    remember(cache, key, { prompt, original: entry.original });
    if (last?.key === key) {
        last = { ...last, prompt, edited: prompt !== entry.original };
        notify();
    }
}

export function revertProseParagraph() {
    if (!last) return;
    setProseParagraph(last.original);
}

/** Asks the LLM for a new paragraph from the last fields. Returns the parse result, or null. */
export async function regenerateProse() {
    if (!last) return null;
    const { fields } = last;
    // the model the card names now writes it
    const key = proseCacheKey(fields, proseTarget(globalThis.globalSettings ?? {}));
    if (inflight.has(key)) return null;
    const result = await writeParagraph(key, fields);
    if (result.ok) {
        // what the cache now holds: the new paragraph, or the text typed while it was written
        const entry = cache.get(key) ?? { prompt: result.prompt, original: result.prompt };
        last = { key, fields, prompt: entry.prompt, original: entry.original, edited: entry.prompt !== entry.original };
    } else {
        console.warn(CAT, 'regenerate kept the previous paragraph:', result.reason);
    }
    notify();
    return result;
}

export function onProseChange(listener) {
    document.addEventListener(CHANGE_EVENT, listener);
}

const FAIL_REASONS = Object.freeze({
    'non-english': ['ai_prose_fail_non_english', 'the paragraph still contained non-English text'],
    invalid: ['ai_prose_fail_invalid', 'the reply was cut off or was not the JSON asked for'],
    truncated: ['ai_prose_fail_truncated', 'the reply stopped at the token limit'],
    refusal: ['ai_prose_fail_refusal', 'the LLM declined to write it'],
    refs: ['ai_prose_fail_refs', 'the paragraph still named a character by "@n"'],
    'no-fields': ['ai_prose_fail_no_fields', 'the last run left no fields to write from'],
});

/** The image-info lines for a prose report (BBCode colours, like the rest of the info). */
export function describeProse(report, { LANG, dark } = {}) {
    if (!report || report.cancelled) return '';
    const color = dark ? 'hotpink' : 'Purple';
    const unknown = report.unknown?.length > 0 ? ` (${LANG?.ai_prose_unknown_refs ?? 'unknown cast references'}: ${report.unknown.join(', ')})` : '';
    if (!report.applied) {
        const [langKey, fallback] = FAIL_REASONS[report.reason] ?? ['ai_prose_fail', 'no paragraph came back'];
        const again = report.retried === false ? `; ${LANG?.ai_prose_not_retried ?? 'not asked again in this run'}` : '';
        return `Prose: [color=${color}]${LANG?.ai_prose_kept_tags ?? 'tags sent as written'} (${LANG?.[langKey] ?? fallback}${again})${unknown}[/color]\n`;
    }
    const mark = report.edited ? ' (edited)' : report.cached ? ' (cached)' : '';
    return `Prose${mark}:${unknown}\n[color=${color}]${report.prompt}[/color]\n`;
}
