// What SAA's non-Regional path actually does with more than one character: every
// character tag is concatenated into ONE prompt (generate.js:getCharacters loops the
// slots and appends), with no regional masking at all. Up to 6 slots
// (characterSelectionModal.js: maxSlots = 6).
//
// This renders that exact shape so the result can be judged instead of assumed.
//
//   node plainchars.mjs --count=3 --seeds=1,2,3 --out=./out-chars

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildApi, fetchSpecs, validate } from './graph.mjs';
import { NEGATIVE } from './cases.mjs';

const arg = (name, fallback) => process.argv.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const num = (name, fallback) => Number(arg(name, fallback));

const HOST = arg('host', 'http://127.0.0.1:8189').replace(/\/$/, '');
const OUT = arg('out', path.join(path.dirname(fileURLToPath(import.meta.url)), 'out-chars'));
const SEEDS = arg('seeds', '1,2,3').split(',').map(Number);
const COUNT = num('count', 3);

// Escaped the way generate.js escapes them before they reach the backend.
const CHARACTERS = [
    'hatsune miku',
    'frieren',
    'artoria pendragon \\(fate\\)',
    'nero claudius \\(fate\\)',
    'ganyu \\(genshin impact\\)',
    'raiden shogun',
];

const S = {
    model: arg('model', 'waiIllustriousSDXL_v170.safetensors'),
    width: num('width', 1216),
    height: num('height', 832),
    steps: num('steps', 28),
    cfg: num('cfg', 5.0),
    sampler: arg('sampler', 'euler'),
    scheduler: arg('scheduler', 'normal'),
};

const picked = CHARACTERS.slice(0, COUNT);
const positive = `masterpiece, best quality, amazing quality, ${COUNT}girls, ${picked.join(', ')}, standing, indoors, full body`;
console.log(positive);

const nodes = seed => [
    { id: 1, type: 'CheckpointLoaderSimple', title: 'Checkpoint', col: 0, row: 0, widgets: { ckpt_name: S.model } },
    { id: 2, type: 'CLIPTextEncode', title: 'Positive', col: 1, row: 0, widgets: { text: positive }, to: { clip: [1, 1] } },
    { id: 3, type: 'CLIPTextEncode', title: 'Negative', col: 1, row: 1, widgets: { text: NEGATIVE }, to: { clip: [1, 1] } },
    { id: 4, type: 'EmptyLatentImage', title: 'Latent', col: 1, row: 2, widgets: { width: S.width, height: S.height, batch_size: 1 } },
    { id: 5, type: 'KSampler', title: 'sampler', col: 2, row: 0, widgets: { seed, steps: S.steps, cfg: S.cfg, sampler_name: S.sampler, scheduler: S.scheduler, denoise: 1 }, to: { model: [1, 0], positive: [2, 0], negative: [3, 0], latent_image: [4, 0] } },
    { id: 6, type: 'VAEDecode', title: 'decode', col: 3, row: 0, to: { samples: [5, 0], vae: [1, 2] } },
    { id: 7, type: 'SaveImage', title: 'result', col: 4, row: 0, widgets: { filename_prefix: `regional/chars/${COUNT}girls/s${seed}` }, to: { images: [6, 0] } },
];

const specs = await fetchSpecs(HOST);
const jobs = [];
for (const seed of SEEDS) {
    const response = await fetch(`${HOST}/prompt`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt: buildApi(specs, validate(specs, nodes(seed))), client_id: `chars-${Date.now()}` }),
    });
    const body = await response.json();
    if (!response.ok) { console.error(JSON.stringify(body, null, 2)); process.exit(1); }
    jobs.push({ seed, promptId: body.prompt_id });
}

const started = Date.now();
for (const job of jobs) {
    for (;;) {
        const history = await (await fetch(`${HOST}/history/${job.promptId}`)).json();
        const done = history[job.promptId];
        if (done) {
            const dir = path.join(OUT, `${COUNT}girls`);
            fs.mkdirSync(dir, { recursive: true });
            for (const output of Object.values(done.outputs ?? {})) {
                for (const image of output.images ?? []) {
                    const query = new URLSearchParams({ filename: image.filename, subfolder: image.subfolder ?? '', type: image.type ?? 'output' });
                    const bytes = Buffer.from(await (await fetch(`${HOST}/view?${query}`)).arrayBuffer());
                    fs.writeFileSync(path.join(dir, `${image.filename.replace(/_\d+_?\.png$/, '')}.png`), bytes);
                }
            }
            console.log(`s${job.seed} done (${Math.round((Date.now() - started) / 1000)}s)`);
            break;
        }
        await new Promise(resolve => setTimeout(resolve, 2500));
    }
}
console.log(`images under ${path.join(OUT, `${COUNT}girls`)}`);
