// The recipe and timing each queued image carries (scripts/shared/recipe.js,
// scripts/shared/runTiming.js). The editor sections are collected once per Generate click
// and the run's own facts (seed, size, the characters picked) per image; what the queue
// decides later - the AI answer, the Prose paragraph and the time those took - is added
// when the job runs. When the image is in, the backend says where it was saved and how
// long it took (takeImageResult), and the gallery keeps all of it as the image's record.

import { RECIPE_SECTIONS, buildRecipe } from '../shared/recipe.js';
import { summarizeRunTiming } from '../shared/runTiming.js';
import { sendWebSocketMessage } from '../webserver/front/wsRequest.js';

/** The editor sections a recipe keeps, as they are now; null before persistence is up. */
export function captureRecipeSections() {
    const collect = globalThis.settingsPersistence?.collectSection;
    if (typeof collect !== 'function') return null;
    return Object.fromEntries(RECIPE_SECTIONS.map(section => [section, collect(section)]));
}

/** One queued image's recipe: the click's `sections` and this image's `run` facts. */
export function queuedRecipe(sections, run) {
    if (!sections) return null;
    const settings = globalThis.globalSettings ?? {};
    return buildRecipe({ sections, settings, run, saaVersion: settings.version ?? '' });
}

/** A stopwatch for one job of the queue: `lap()` is the time since the last lap. */
export function startJobClock(now = () => Date.now()) {
    const start = now();
    let last = start;
    return {
        start,
        lap() {
            const at = now();
            const ms = at - last;
            last = at;
            return ms;
        },
        reset() { last = now(); },
    };
}

/**
 * What the job decided before the backend: the prompts that go out, the AI answer, the
 * Prose report (prosePipeline.applyProse) and the time each step took. Written into the
 * job's recipe and timing, which travel to the backend with it.
 */
export function noteJobSteps(generateData, { positive, negative, ai = null, prose = null, timing = {} } = {}) {
    if (!generateData) return;
    generateData.timing = { jobStart: timing.jobStart ?? Date.now(), ai: timing.ai ?? 0, prose: timing.prose ?? 0 };
    const recipe = generateData.recipe;
    if (!recipe?.run) return;
    if (typeof positive === 'string') recipe.run.positive = positive;
    if (typeof negative === 'string') recipe.run.negative = negative;
    recipe.run.ai = ai && ai.mode && ai.mode !== 'off' ? { mode: String(ai.mode), text: String(ai.text ?? '') } : null;
    recipe.run.prose = prose ? {
        applied: prose.applied === true,
        paragraph: prose.applied ? String(prose.prompt ?? '') : '',
        writer: String(globalThis.globalSettings?.ai_prose_writer ?? ''),
        fields: prose.fields ?? null,
    } : null;
}

/** Where the backend saved the image it just returned, its timing and recipe, or null. */
export async function takeImageResult() {
    try {
        if (globalThis.inBrowser) return await sendWebSocketMessage({ type: 'API', method: 'takeComfyUIResult' });
        return await globalThis.api?.takeComfyUIResult?.() ?? null;
    } catch (error) {
        console.warn('[Recipe] could not read the run result:', error?.message ?? error);
        return null;
    }
}

/**
 * The gallery's record of an image: its recipe, timing and file. A backend that keeps no
 * timeline (WebUI) gets the time the renderer saw, from the job start to now, with the
 * request itself as one 'backend' segment posted at `posted`.
 */
export function imageRecord(generateData, result = null, { posted = null } = {}) {
    let timing = result?.timing ?? null;
    if (!timing && generateData?.timing && posted !== null) {
        timing = summarizeRunTiming({
            timeline: { posted, nodes: [], ended: Date.now(), fetched: null },
            before: generateData.timing,
        });
    }
    return {
        // the backend's copy also says what Fast mode sent
        recipe: result?.recipe ?? generateData?.recipe ?? null,
        timing,
        path: String(result?.path ?? ''),
        interface: String(generateData?.queueManager?.apiInterface ?? ''),
    };
}
