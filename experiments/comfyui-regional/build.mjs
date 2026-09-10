// Writes the two comparison graphs to disk. See README.md.
//
//   node build.mjs [--host=…] [--out=<dir>] [--only=A|B] [--seed=…] [--sampler=…] …

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { DEFAULT_PROMPT, DEFAULT_SETTINGS, buildApi, buildWorkflow, fetchSpecs, selectNodes, validate } from './graph.mjs';

const arg = (name, fallback) => process.argv.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const num = (name, fallback) => Number(arg(name, fallback));

const HOST = arg('host', 'http://127.0.0.1:8189').replace(/\/$/, '');
const OUT = arg('out', path.dirname(fileURLToPath(import.meta.url)));
const ONLY = arg('only', '');

const settings = {
    model: arg('model', DEFAULT_SETTINGS.model),
    width: num('width', DEFAULT_SETTINGS.width),
    height: num('height', DEFAULT_SETTINGS.height),
    steps: num('steps', DEFAULT_SETTINGS.steps),
    cfg: num('cfg', DEFAULT_SETTINGS.cfg),
    sampler: arg('sampler', DEFAULT_SETTINGS.sampler),
    scheduler: arg('scheduler', DEFAULT_SETTINGS.scheduler),
    seed: num('seed', DEFAULT_SETTINGS.seed),
    layout: arg('layout', DEFAULT_SETTINGS.layout),
    maskStrength: num('mask-strength', DEFAULT_SETTINGS.maskStrength),
    baseOnlySteps: num('base-only-steps', DEFAULT_SETTINGS.baseOnlySteps),
    overlapFactor: num('overlap-factor', DEFAULT_SETTINGS.overlapFactor),
    additionalMode: arg('additional-mode', DEFAULT_SETTINGS.additionalMode),
    additionalSampler: arg('additional-sampler', DEFAULT_SETTINGS.additionalSampler),
};

const prompt = {
    base: arg('base', DEFAULT_PROMPT.base),
    left: arg('left', DEFAULT_PROMPT.left),
    right: arg('right', DEFAULT_PROMPT.right),
    negative: arg('negative', DEFAULT_PROMPT.negative),
};

const specs = await fetchSpecs(HOST);
const nodes = validate(specs, selectNodes({ settings, prompt, only: ONLY }));

fs.mkdirSync(OUT, { recursive: true });
const api = path.join(OUT, 'regional-compare.api.json');
const wf = path.join(OUT, 'regional-compare.workflow.json');
fs.writeFileSync(api, `${JSON.stringify(buildApi(specs, nodes), null, 2)}\n`);
fs.writeFileSync(wf, `${JSON.stringify(buildWorkflow(specs, nodes), null, 2)}\n`);
console.log(`${nodes.length} nodes validated against ${HOST}`);
console.log(`wrote ${api}`);
console.log(`wrote ${wf}`);
