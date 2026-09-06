import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { WORKFLOW, WORKFLOW_REGIONAL, WORKFLOW_REIONAL_UNET, WORKFLOW_UNET } from '../scripts/main/comfyui_workflow.js';

const projectRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const backend = fs.readFileSync(path.join(projectRoot, 'scripts/main/generate_backend_comfyui.js'), 'utf8');

// Source of one builder method: from its signature to the next `…(generateData) {` method.
function builderBody(name) {
    const start = backend.indexOf(`  ${name}(generateData) {`);
    assert.ok(start >= 0, `${name} exists`);
    const rest = backend.slice(start + 10);
    const next = rest.search(/\n {2}(?:async )?\w+\(generateData\)\s*\{/);
    return next >= 0 ? backend.slice(start, start + 10 + next) : backend.slice(start);
}

function builderRefs(name) {
    const ids = (builderBody(name).match(/workflow\["(\d+)"\]/g) ?? []).map(ref => ref.match(/\d+/)[0]);
    return [...new Set(ids)].sort((a, b) => a - b);
}

// Nodes a builder creates itself (workflow["59"] = structuredClone(VAE_LOADER)) are
// not expected in the template.
function created(name) {
    return new Set((builderBody(name).match(/workflow\["(\d+)"\] = /g) ?? []).map(ref => ref.match(/\d+/)[0]));
}

function missingNodes(name, template) {
    const skip = created(name);
    return builderRefs(name).filter(id => !skip.has(id) && !template[id]);
}

test('the checkpoint regional builder finds every node it touches in WORKFLOW_REGIONAL', () => {
    // Upstream 2.8.6 overwrote WORKFLOW_REGIONAL with the UNET regional graph while
    // the checkpoint builder kept addressing the checkpoint nodes (43/45 loaders,
    // 35/44 sampling, 18/19 tiled VAE, 37 refiner, 55-58 masks / latent upscale):
    // "Cannot read properties of undefined (reading 'inputs')" on every regional run.
    assert.deepEqual(missingNodes('createWorkflowRegional', WORKFLOW_REGIONAL), []);
    assert.equal(WORKFLOW_REGIONAL['45'].class_type, 'CheckpointLoaderSimple');
    assert.equal(WORKFLOW_REGIONAL['43'].class_type, 'CheckpointLoaderSimple');
    assert.equal(WORKFLOW_REGIONAL['29'].class_type, 'ImageSaverMira');
    assert.equal(WORKFLOW_REGIONAL['59'], undefined, 'no UNET loader in the checkpoint graph');
});

test('the UNET regional and plain builders find their nodes too', () => {
    for (const [name, template] of [
        ['createWorkflowRegionalUnet', WORKFLOW_REIONAL_UNET],
        ['createWorkflow', WORKFLOW],
        ['createWorkflowUNet', WORKFLOW_UNET],
    ]) {
        assert.deepEqual(missingNodes(name, template), [], name);
    }
});

test('Positive (right) is a real field-list entry that follows the Regional switch', () => {
    const manager = fs.readFileSync(path.join(projectRoot, 'scripts/renderer/components/promptFieldManager.js'), 'utf8');
    assert.match(manager, /positive_right: '\.prompt-positive-right',/, 'container selector uses the hyphenated class the markup has');
    assert.match(manager, /exclude: '\.prompt-exclude',/);
    const callbacks = fs.readFileSync(path.join(projectRoot, 'scripts/renderer/callbacks.js'), 'utf8');
    const body = callbacks.slice(callbacks.indexOf('export function callback_regional_condition'), callbacks.indexOf('export function callback_controlnet'));
    assert.match(body, /globalThis\.prompt\.fieldManager\?\.refresh\?\.\(\);/);
});
