// Queues every case in cases.mjs across several seeds and downloads the results, so a
// method can be judged on a batch instead of one lucky picture.
//
//   node sweep.mjs --only=A --seeds=1,2,3 --out=./out
//   node sweep.mjs --cases=princess-carry,headpat --base-only-steps=3
//
// Images land in <out>/<case>/s<seed>_<branch>.png and in ComfyUI's own output folder
// under regional/sweep/.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { CASE_SETS, NEGATIVE } from './cases.mjs';
import { DEFAULT_SETTINGS, buildApi, fetchSpecs, selectNodes, validate } from './graph.mjs';
import { uploadImage } from './upload.mjs';

const arg = (name, fallback) => process.argv.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const num = (name, fallback) => Number(arg(name, fallback));

const HOST = arg('host', 'http://127.0.0.1:8189').replace(/\/$/, '');
const OUT = arg('out', path.join(path.dirname(fileURLToPath(import.meta.url)), 'out'));
const ONLY = arg('only', '');
const SEEDS = arg('seeds', '1,2,3').split(',').map(Number);
const WANTED = arg('cases', '').split(',').filter(Boolean);
const LABEL = arg('label', '');

const settings = {
    steps: num('steps', DEFAULT_SETTINGS.steps),
    cfg: num('cfg', DEFAULT_SETTINGS.cfg),
    sampler: arg('sampler', DEFAULT_SETTINGS.sampler),
    scheduler: arg('scheduler', DEFAULT_SETTINGS.scheduler),
    width: num('width', DEFAULT_SETTINGS.width),
    height: num('height', DEFAULT_SETTINGS.height),
    layout: arg('layout', DEFAULT_SETTINGS.layout),
    columFirst: arg('colum-first', '1') !== '0',   // 0 = cut horizontally: "left" becomes the top region
    maskStrength: num('mask-strength', DEFAULT_SETTINGS.maskStrength),
    baseOnlySteps: num('base-only-steps', DEFAULT_SETTINGS.baseOnlySteps),
    overlapFactor: num('overlap-factor', DEFAULT_SETTINGS.overlapFactor),
};

// --pose-dir=<dir> drives every case that has <dir>/<case-id>.png through an OpenPose
// ControlNet built from that picture. Prompt tags cannot say who is acting; a skeleton can.
const POSE_DIR = arg('pose-dir', '');
const CONTROLNET = {
    model: arg('cn-model', 'control-lora-openposeXL2-rank256.safetensors'),
    strength: num('cn-strength', 0.8),
    startPercent: num('cn-start', 0),
    endPercent: num('cn-end', 0.8),
    resolution: num('cn-resolution', 1024),
    applyToRegions: arg('cn-regions', '') === '1',
};

// --set=split moves the directional tag off Base and onto one side only
const SET = arg('set', 'default');
const all = CASE_SETS[SET];
if (!all) throw new Error(`unknown case set "${SET}" (have ${Object.keys(CASE_SETS).join(', ')})`);
const cases = WANTED.length ? all.filter(entry => WANTED.includes(entry.id)) : all;
if (!cases.length) throw new Error(`no case matched ${WANTED.join(',')}`);

const specs = await fetchSpecs(HOST);
const clientId = `saa-sweep-${Date.now()}`;
const jobs = [];

for (const entry of cases) {
    let controlNet = null;
    if (POSE_DIR) {
        const file = path.join(POSE_DIR, `${entry.id}.png`);
        if (fs.existsSync(file)) {
            controlNet = { ...CONTROLNET, image: await uploadImage(HOST, file, `saa-pose-${entry.id}.png`) };
            console.log(`${entry.id}: pose from ${path.basename(file)}`);
        } else {
            console.log(`${entry.id}: no pose image, running unconstrained`);
        }
    }
    for (const seed of SEEDS) {
        const tag = LABEL ? `${entry.id}-${LABEL}` : entry.id;
        const nodes = validate(specs, selectNodes({
            settings: {
                ...settings,
                seed,
                controlNet,
                prefixA: `regional/sweep/${tag}/s${seed}_A`,
                prefixB: `regional/sweep/${tag}/s${seed}_B`,
                prefixPose: `regional/sweep/${tag}/pose`,
            },
            prompt: { base: entry.base, left: entry.left, right: entry.right, negative: NEGATIVE },
            only: ONLY,
        }));
        const response = await fetch(`${HOST}/prompt`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ prompt: buildApi(specs, nodes), client_id: clientId }),
        });
        const body = await response.json();
        if (!response.ok) {
            console.error(`${entry.id} s${seed}: ${JSON.stringify(body)}`);
            process.exit(1);
        }
        jobs.push({ id: entry.id, tag, seed, promptId: body.prompt_id });
    }
}
console.log(`queued ${jobs.length} jobs (${cases.length} cases x ${SEEDS.length} seeds${ONLY ? `, branch ${ONLY}` : ''})`);

const started = Date.now();
let done = 0;
for (const job of jobs) {
    for (;;) {
        const history = await (await fetch(`${HOST}/history/${job.promptId}`)).json();
        const entry = history[job.promptId];
        if (entry) {
            const status = entry.status?.status_str ?? 'unknown';
            if (status === 'error') {
                console.error(`${job.tag} s${job.seed}: ${JSON.stringify(entry.status?.messages ?? entry.status)}`);
                break;
            }
            const dir = path.join(OUT, job.tag);
            fs.mkdirSync(dir, { recursive: true });
            for (const output of Object.values(entry.outputs ?? {})) {
                for (const image of output.images ?? []) {
                    const query = new URLSearchParams({ filename: image.filename, subfolder: image.subfolder ?? '', type: image.type ?? 'output' });
                    const bytes = Buffer.from(await (await fetch(`${HOST}/view?${query}`)).arrayBuffer());
                    // filenames come from the prefixes above: s<seed>_A_…, s<seed>_B_…, pose_…
                    const name = /^pose_/.test(image.filename)
                        ? '_pose.png'
                        : `s${job.seed}_${/^s\d+_A_/.test(image.filename) ? 'A' : 'B'}.png`;
                    fs.writeFileSync(path.join(dir, name), bytes);
                }
            }
            done += 1;
            console.log(`[${done}/${jobs.length}] ${job.tag} s${job.seed} (${Math.round((Date.now() - started) / 1000)}s)`);
            break;
        }
        await new Promise(resolve => setTimeout(resolve, 2500));
        if (Date.now() - started > 60 * 60 * 1000) throw new Error('timed out');
    }
}
console.log(`images under ${OUT}`);
