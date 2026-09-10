// Regional conditioning with an arbitrary number of regions, to see what a grid buys
// over the left/right split SAA is locked to.
//
// The interesting shape for two interacting characters is not a 2x2 grid: it is a split
// top row over an undivided bottom. Faces are what must not mix, and faces sit side by
// side even when the bodies overlap; the bodies are what has to be free to cross the
// seam. So: top-left face, top-right face, bottom shared.
//
//   node gridrun.mjs --layout=1,1,0.2,1;1,1 --seeds=1,2,3 --case=princess-carry
//
// Layout syntax (Mask.py): ';' cuts rows, and inside each row the FIRST value is that
// row's height weight while the rest are the column weights. So "1,1,0.2,1;1,1" is two
// rows of equal height; the top one split 1:0.2:1 (a centre overlap strip), the bottom
// one left whole.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildApi, fetchSpecs, validate } from './graph.mjs';
import { NEGATIVE } from './cases.mjs';

const arg = (name, fallback) => process.argv.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const num = (name, fallback) => Number(arg(name, fallback));

const HOST = arg('host', 'http://127.0.0.1:8189').replace(/\/$/, '');
const OUT = arg('out', path.join(path.dirname(fileURLToPath(import.meta.url)), 'out-grid'));
const SEEDS = arg('seeds', '1,2,3').split(',').map(Number);
const LAYOUT = arg('layout', '1,1,0.2,1;1,1');
const CASE = arg('case', 'princess-carry');

const S = {
    model: arg('model', 'waiIllustriousSDXL_v170.safetensors'),
    width: num('width', 1216),
    height: num('height', 832),
    steps: num('steps', 28),
    cfg: num('cfg', 5.0),
    sampler: arg('sampler', 'euler'),
    scheduler: arg('scheduler', 'normal'),
    strength: num('mask-strength', 1.0),
};

// Base carries the place and the head count only - never the directional tag, which is
// what makes both girls perform the action (see README).
const GRID_CASES = {
    'princess-carry': {
        base: 'masterpiece, best quality, amazing quality, 2girls, indoors, full body',
        regions: [
            { name: 'top-left', index: 0, overlap: 'Next', prompt: '1girl, long blonde hair, blue eyes, face, carried, lifted, arms around another\'s neck' },
            { name: 'top-right', index: 2, overlap: 'Previous', prompt: '1girl, short black hair, red eyes, face, princess carry, carrying, holding another' },
            { name: 'bottom', index: 3, overlap: 'None', prompt: 'white dress, black suit, legs, princess carry, indoors' },
        ],
    },
    piggyback: {
        base: 'masterpiece, best quality, amazing quality, 2girls, outdoors, park, full body',
        regions: [
            { name: 'top-left', index: 0, overlap: 'Next', prompt: '1girl, long blonde hair, blue eyes, face, carried, on another\'s back, arms around another\'s neck' },
            { name: 'top-right', index: 2, overlap: 'Previous', prompt: '1girl, short black hair, red eyes, face, piggyback, carrying' },
            { name: 'bottom', index: 3, overlap: 'None', prompt: 'white dress, black jacket, legs, walking, park path' },
        ],
    },
};

const entry = GRID_CASES[CASE];
if (!entry) throw new Error(`unknown case "${CASE}" (have ${Object.keys(GRID_CASES).join(', ')})`);

function nodes(seed) {
    const list = [
        { id: 1, type: 'CheckpointLoaderSimple', title: 'Checkpoint', col: 0, row: 0, widgets: { ckpt_name: S.model } },
        { id: 2, type: 'CLIPTextEncode', title: 'Base', col: 1, row: 0, widgets: { text: entry.base }, to: { clip: [1, 1] } },
        { id: 3, type: 'CLIPTextEncode', title: 'Negative', col: 1, row: 1, widgets: { text: NEGATIVE }, to: { clip: [1, 1] } },
        { id: 4, type: 'EmptyLatentImage', title: 'Latent', col: 1, row: 2, widgets: { width: S.width, height: S.height, batch_size: 1 } },
        { id: 5, type: 'CreateTillingPNGMask', title: 'Layout', col: 1, row: 3, widgets: { Width: S.width, Height: S.height, Colum_first: true, Rows: 1, Colums: 1, Layout: LAYOUT } },
        { id: 6, type: 'SaveImage', title: 'the layout', col: 2, row: 4, widgets: { filename_prefix: `regional/grid-run/${CASE}/_layout` }, to: { images: [5, 0] } },
    ];

    // one Concat + SetMask per region, then a Combine chain (ConditioningCombine takes two)
    let id = 10;
    let combined = null;
    for (const region of entry.regions) {
        const text = id++;
        const concat = id++;
        const mask = id++;
        const setMask = id++;
        list.push(
            { id: text, type: 'CLIPTextEncode', title: region.name, col: 2, row: list.length, widgets: { text: region.prompt }, to: { clip: [1, 1] } },
            { id: concat, type: 'ConditioningConcat', title: `base + ${region.name}`, col: 3, row: list.length, to: { conditioning_to: [2, 0], conditioning_from: [text, 0] } },
            { id: mask, type: 'PngRectanglesToMask', title: `mask ${region.name}`, col: 3, row: list.length + 1, widgets: { Intenisity: 1, Blur: 0, Start_At_Index: region.index, Overlap: region.overlap, Overlap_Count: 1 }, to: { PngRectangles: [5, 2] } },
            { id: setMask, type: 'ConditioningSetMask', title: `set ${region.name}`, col: 4, row: list.length, widgets: { strength: S.strength, set_cond_area: 'default' }, to: { conditioning: [concat, 0], mask: [mask, 0] } },
        );
        if (combined === null) {
            combined = setMask;
        } else {
            const combine = id++;
            list.push({ id: combine, type: 'ConditioningCombine', title: `combine ${region.name}`, col: 5, row: list.length, to: { conditioning_1: [combined, 0], conditioning_2: [setMask, 0] } });
            combined = combine;
        }
    }

    list.push(
        { id: 90, type: 'KSampler', title: 'sampler', col: 6, row: 0, widgets: { seed, steps: S.steps, cfg: S.cfg, sampler_name: S.sampler, scheduler: S.scheduler, denoise: 1 }, to: { model: [1, 0], positive: [combined, 0], negative: [3, 0], latent_image: [4, 0] } },
        { id: 91, type: 'VAEDecode', title: 'decode', col: 7, row: 0, to: { samples: [90, 0], vae: [1, 2] } },
        { id: 92, type: 'SaveImage', title: 'result', col: 8, row: 0, widgets: { filename_prefix: `regional/grid-run/${CASE}/s${seed}` }, to: { images: [91, 0] } },
    );
    return list;
}

const specs = await fetchSpecs(HOST);
const jobs = [];
for (const seed of SEEDS) {
    const response = await fetch(`${HOST}/prompt`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt: buildApi(specs, validate(specs, nodes(seed))), client_id: `grid-${Date.now()}` }),
    });
    const body = await response.json();
    if (!response.ok) { console.error(JSON.stringify(body, null, 2)); process.exit(1); }
    jobs.push({ seed, promptId: body.prompt_id });
}
console.log(`queued ${jobs.length} jobs for ${CASE} with layout "${LAYOUT}"`);

const started = Date.now();
for (const job of jobs) {
    for (;;) {
        const history = await (await fetch(`${HOST}/history/${job.promptId}`)).json();
        const done = history[job.promptId];
        if (done) {
            if (done.status?.status_str === 'error') {
                console.error(JSON.stringify(done.status?.messages ?? done.status, null, 2));
                break;
            }
            const dir = path.join(OUT, CASE);
            fs.mkdirSync(dir, { recursive: true });
            for (const output of Object.values(done.outputs ?? {})) {
                for (const image of output.images ?? []) {
                    const query = new URLSearchParams({ filename: image.filename, subfolder: image.subfolder ?? '', type: image.type ?? 'output' });
                    const bytes = Buffer.from(await (await fetch(`${HOST}/view?${query}`)).arrayBuffer());
                    const stem = image.filename.replace(/_\d+_?\.png$/, '');
                    fs.writeFileSync(path.join(dir, `${stem}.png`), bytes);
                }
            }
            console.log(`s${job.seed} done (${Math.round((Date.now() - started) / 1000)}s)`);
            break;
        }
        await new Promise(resolve => setTimeout(resolve, 2500));
    }
}
console.log(`images under ${path.join(OUT, CASE)}`);
