// Generation time (scripts/shared/runTiming.js): ComfyUI's "executing" messages, timed in
// the main process on the renderer's clock, become the segments the Info panel draws.
import assert from 'node:assert/strict';
import test from 'node:test';

import { createRunTimeline, formatDuration, nodeRole, parseRunTiming, summarizeRunTiming } from '../scripts/shared/runTiming.js';

// node ids and classes as comfyui_workflow.js builds a Checkpoint run with Hires fix,
// the refiner and a face detailer
const workflow = {
    43: { class_type: 'CheckpointLoaderSimple' },
    34: { class_type: 'LoRAfromText' },
    2: { class_type: 'CLIPTextEncode' },
    36: { class_type: 'KSamplerAdvanced' },
    37: { class_type: 'KSamplerAdvanced' },
    46: { class_type: 'LatentUpscaleBy' },
    20: { class_type: 'KSampler' },
    6: { class_type: 'VAEDecode' },
    60: { class_type: 'FaceDetailer' },
    29: { class_type: 'ImageSaverMira' },
};

function clock(times) {
    let index = 0;
    return () => times[Math.min(index++, times.length - 1)];
}

test('the nodes of a run add up to their segments', () => {
    // posted at 1000, then each node's start, the end of the prompt and the image fetched
    const recorder = createRunTimeline(clock([1000, 1100, 1300, 1400, 1500, 4500, 5500, 5700, 7700, 7900, 8900, 9000, 9200]));
    for (const id of ['43', '34', '2', '36', '37', '46', '20', '6', '60', '29']) recorder.node(id);
    recorder.end();
    recorder.fetched();
    const timing = summarizeRunTiming({ timeline: recorder.timeline, workflow, before: { jobStart: 0, ai: 0, prose: 600 } });
    assert.deepEqual(timing.segments, [
        { id: 'prose', ms: 600 },
        { id: 'prepare', ms: 400 },    // job start to the POST, less the Prose paragraph
        { id: 'queue', ms: 100 },
        { id: 'load', ms: 300 },       // checkpoint 200 + LoRA 100
        { id: 'base', ms: 3000 },
        { id: 'refiner', ms: 1000 },
        { id: 'hires', ms: 2200 },     // latent upscale 200 + KSampler 2000
        { id: 'detailer', ms: 1000 },
        { id: 'finish', ms: 400 },     // text encode 100 + VAE decode 200 + saver 100
        { id: 'transfer', ms: 200 },
    ]);
    assert.equal(timing.total, 9200);
});

test('a run without node messages is one backend segment', () => {
    const timing = summarizeRunTiming({
        timeline: { posted: 2000, nodes: [], ended: 12000, fetched: 12500 },
        before: { jobStart: 1500, ai: 0, prose: 0 },
    });
    assert.deepEqual(timing.segments, [{ id: 'prepare', ms: 500 }, { id: 'backend', ms: 10000 }, { id: 'transfer', ms: 500 }]);
    assert.equal(timing.total, 11000);
});

test('the first KSamplerAdvanced is the base pass, the next the refiner', () => {
    assert.equal(nodeRole('KSamplerAdvanced'), 'base');
    assert.equal(nodeRole('KSamplerAdvanced', { advancedSeen: 1 }), 'refiner');
    assert.equal(nodeRole('UpscaleImageByModelThenResize'), 'hires');
    assert.equal(nodeRole('UNETLoader'), 'load');
    assert.equal(nodeRole('UltralyticsDetectorProvider'), 'load');
    assert.equal(nodeRole('FaceDetailer'), 'detailer');
    assert.equal(nodeRole('TextBoxMira'), 'finish');
});

test('the recorder ignores repeats and anything after the end', () => {
    const recorder = createRunTimeline(clock([0, 10, 20, 30, 40]));
    recorder.node('36');
    recorder.node('36');
    recorder.node(null);
    recorder.end();
    recorder.node('29');
    assert.deepEqual(recorder.timeline.nodes, [{ id: '36', t: 10 }]);
    assert.equal(recorder.timeline.ended, 20);
});

test('a stored timing parses back; junk does not', () => {
    const timing = { v: 1, total: 10234.4, segments: [{ id: 'base', ms: 5800 }, { id: 'nope', ms: 3 }, { id: 'prose', ms: -1 }] };
    assert.deepEqual(parseRunTiming(JSON.stringify(timing)), { v: 1, total: 10234, segments: [{ id: 'base', ms: 5800 }] });
    assert.equal(parseRunTiming('{"total":"x"}'), null);
});

test('durations read as seconds, then minutes', () => {
    assert.equal(formatDuration(10234), '10.2 s');
    assert.equal(formatDuration(900), '0.9 s');
    assert.equal(formatDuration(64400), '1 min 04 s');
    assert.equal(formatDuration(Number.NaN), '—');
});
