// How long one image took, and where the time went: the steps before the backend (the
// AI prompt, the Prose paragraph, getting the run ready), the wait in ComfyUI's queue,
// and the nodes of the workflow grouped by what they do (loading, the base pass, the
// refiner, Hires fix, the detailer, the rest). The main process records ComfyUI's
// "executing" messages on one clock with the renderer's job start (both Date.now on one
// machine); summarizeRunTiming turns them into the segments the Info panel draws.
//
// Pure: no I/O.

export const TIME_VERSION = 1;

// in the order they happen, which is the order they are drawn in
export const TIME_SEGMENTS = Object.freeze(['ai', 'prose', 'prepare', 'queue', 'load', 'base', 'refiner', 'hires', 'detailer', 'finish', 'backend', 'transfer']);

const LOADERS = /Loader|LoRAfromText|UltralyticsDetectorProvider/;
const DETAILER = /Detailer|SEGS|Segs|BboxDetector|SAMDetector/;
const UPSCALE = /Upscale|ImageScale|LatentUpscale/;

/**
 * What one node does, by its class. A workflow's first KSamplerAdvanced is the base pass
 * and its second the refiner (comfyui_workflow.js); the plain KSampler is Hires fix's
 * second pass, beside the upscale nodes.
 */
export function nodeRole(classType, { advancedSeen = 0 } = {}) {
    const type = String(classType ?? '');
    if (type === 'KSamplerAdvanced' || type === 'SamplerCustomAdvanced') return advancedSeen === 0 ? 'base' : 'refiner';
    if (type === 'KSampler' || UPSCALE.test(type)) return 'hires';
    if (DETAILER.test(type)) return 'detailer';
    if (LOADERS.test(type)) return 'load';
    return 'finish';
}

/** A recorder for one ComfyUI run: `node(id)` on every "executing" message, `end()` once. */
export function createRunTimeline(now = () => Date.now()) {
    const timeline = { posted: now(), nodes: [], ended: null, fetched: null };
    return {
        timeline,
        node(id) {
            const last = timeline.nodes.at(-1);
            if (id === null || id === undefined || timeline.ended !== null) return;
            if (last?.id === String(id)) return;
            timeline.nodes.push({ id: String(id), t: now() });
        },
        end() { if (timeline.ended === null) timeline.ended = now(); },
        fetched() { timeline.fetched = now(); },
    };
}

function positive(ms) {
    return Number.isFinite(ms) && ms > 0 ? Math.round(ms) : 0;
}

/**
 * The segments of one image. `before` is what the renderer measured ahead of the backend:
 * { jobStart, ai, prose } (ms; jobStart an epoch time). A timeline without node messages
 * (a pod run, a cached one) leaves the backend's time as one 'backend' segment.
 */
export function summarizeRunTiming({ timeline, workflow = {}, before = {}, end = null } = {}) {
    const totals = Object.fromEntries(TIME_SEGMENTS.map(id => [id, 0]));
    totals.ai = positive(before.ai);
    totals.prose = positive(before.prose);
    const posted = timeline?.posted ?? null;
    const ended = timeline?.ended ?? end ?? null;
    const finished = timeline?.fetched ?? ended;
    const jobStart = Number.isFinite(before.jobStart) ? before.jobStart : null;
    if (jobStart !== null && posted !== null) totals.prepare = positive(posted - jobStart - totals.ai - totals.prose);

    const nodes = timeline?.nodes ?? [];
    if (posted !== null && nodes.length > 0) {
        totals.queue = positive(nodes[0].t - posted);
        let advancedSeen = 0;
        nodes.forEach((entry, index) => {
            const next = nodes[index + 1]?.t ?? ended ?? entry.t;
            const classType = workflow?.[entry.id]?.class_type;
            const role = nodeRole(classType, { advancedSeen });
            if (classType === 'KSamplerAdvanced' || classType === 'SamplerCustomAdvanced') advancedSeen += 1;
            totals[role] += positive(next - entry.t);
        });
    } else if (posted !== null && ended !== null) {
        totals.backend = positive(ended - posted);
    }
    if (ended !== null && finished !== null) totals.transfer = positive(finished - ended);

    const sum = TIME_SEGMENTS.reduce((acc, id) => acc + totals[id], 0);
    const total = jobStart !== null && finished !== null ? Math.max(sum, positive(finished - jobStart)) : sum;
    return {
        v: TIME_VERSION,
        total,
        segments: TIME_SEGMENTS.filter(id => totals[id] > 0).map(id => ({ id, ms: totals[id] })),
    };
}

/** The timing a text chunk holds, or null. */
export function parseRunTiming(value) {
    let data = value;
    if (typeof value === 'string') {
        try { data = JSON.parse(value); } catch { return null; }
    }
    if (!data || typeof data !== 'object' || !Number.isFinite(data.total) || !Array.isArray(data.segments)) return null;
    const known = new Set(TIME_SEGMENTS);
    return {
        v: Number.isInteger(data.v) ? data.v : TIME_VERSION,
        total: Math.max(0, Math.round(data.total)),
        segments: data.segments
            .filter(segment => known.has(segment?.id) && Number.isFinite(segment.ms) && segment.ms > 0)
            .map(segment => ({ id: segment.id, ms: Math.round(segment.ms) })),
    };
}

/** "10.2 s", "1 min 04 s". */
export function formatDuration(ms) {
    if (!Number.isFinite(ms) || ms < 0) return '—';
    const seconds = ms / 1000;
    if (seconds < 59.95) return `${seconds.toFixed(1)} s`;
    const whole = Math.round(seconds);
    return `${Math.floor(whole / 60)} min ${String(whole % 60).padStart(2, '0')} s`;
}
