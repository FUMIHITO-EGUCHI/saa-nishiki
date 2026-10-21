import test from 'node:test';
import assert from 'node:assert/strict';
import { requestedSettings, describeWorkflow, withStagePreviews } from '../scripts/shared/workflowRecord.js';

const graph = {
    '1': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'base.safetensors' } },
    '2': { class_type: 'KSampler', inputs: { model: ['1', 0], seed: 7, steps: 20, cfg: 5 } },
    '3': { class_type: 'VAEDecode', inputs: { samples: ['2', 0], vae: ['1', 2] } },
    '4': { class_type: 'KSampler', inputs: { model: ['1', 0], seed: 8 } },
    '29': { class_type: 'ImageSaverMira', inputs: { images: ['3', 0] } },
};
test('requested settings exclude credentials and queue secrets', () => {
    const result = requestedSettings({ seed: 7, auth: 'secret', queueManager: { aiOptions: { apiKey: 'secret' } }, positive: 'basket' });
    assert.deepEqual(result, { seed: 7, positive: 'basket' });
});
test('graph provenance distinguishes connected settings from execution evidence', () => {
    const result = describeWorkflow(graph, '29');
    assert.equal(result.nodes['4'].onOutputPath, false);
    assert.equal(result.nodes['2'].state, 'unknown');
    assert.equal(result.nodes['2'].inputs.seed, 7);
    assert.deepEqual(result.nodes['2'].sources.model, ['1']);
});
test('diagnostic previews cannot activate a disconnected sampler', () => {
    const { workflow, stages } = withStagePreviews(graph, '29');
    assert.deepEqual(stages.map(s => s.source), ['3']);
    assert.equal(Object.keys(graph).length, 5);
    assert.deepEqual(workflow['29'], graph['29']);
});
