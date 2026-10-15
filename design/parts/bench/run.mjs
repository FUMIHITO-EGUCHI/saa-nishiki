// Parts sample bench: mannequin base per category × txt2img vs img2img over a flat white
// canvas × Anima / Illustrious, one seed. Talks to the local ComfyUI directly.
//   node design/parts/bench/run.mjs [--only outfit,hair] [--skip-existing]
import fs from 'node:fs';
import path from 'node:path';

const COMFY = 'http://127.0.0.1:8189';
const OUT = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const SEED = 3;
const args = process.argv.slice(2);
const only = (args.includes('--only') ? args[args.indexOf('--only') + 1] : '').split(',').filter(Boolean);
const skipExisting = args.includes('--skip-existing');

const PARTS = {
    outfit: 'serafuku, pleated skirt, red neckerchief, white thighhighs, loafers',
    hair: 'twin tails, very long hair, brown hair',
    body: 'muscular female, abs, tall, wide hips',
    background: 'classroom, sunset, window, desk, orange sky, lens flare',
};
const BASE = {
    outfit: '1girl, white mannequin, faceless, bald, standing, arms at sides, full body, simple background, white background',
    hair: '1girl, white mannequin, faceless, upper body, facing viewer, simple background, white background',
    body: '1girl, white mannequin, faceless, bald, white bodysuit, standing, full body, simple background, white background',
    background: 'no humans, scenery',
};
// alternative mannequin wording, outfit only
const BASE_ALT = '1girl, mannequin, doll joints, no face, standing, arms at sides, full body, simple background, white background';

const MODELS = {
    anima: {
        quality: 'masterpiece, best quality, score_7, safe',
        negative: 'worst quality, low quality, score_1, score_2, score_3, artist name, signature, watermark, text, logo',
        steps: 20, cfg: 4.5, sampler: 'er_sde', scheduler: 'simple',
    },
    illustrious: {
        quality: 'masterpiece, best quality, very aesthetic, absurdres',
        negative: 'worst quality, low quality, bad anatomy, bad hands, artist name, signature, watermark, text, logo',
        steps: 24, cfg: 5, sampler: 'euler_ancestral', scheduler: 'normal',
    },
};

function graph({ model, positive, negative, width, height, denoise }) {
    const m = MODELS[model];
    const g = {};
    if (model === 'anima') {
        g['50'] = { class_type: 'CLIPLoader', inputs: { clip_name: 'qwen_3_06b_base.safetensors', type: 'stable_diffusion', device: 'default' } };
        g['51'] = { class_type: 'UNETLoader', inputs: { unet_name: 'waiANIMA_v10Base10.safetensors', weight_dtype: 'default' } };
        g['52'] = { class_type: 'VAELoader', inputs: { vae_name: 'qwen_image_vae.safetensors' } };
        g['2'] = { class_type: 'CLIPTextEncode', inputs: { text: positive, clip: ['50', 0] } };
        g['3'] = { class_type: 'CLIPTextEncode', inputs: { text: negative, clip: ['50', 0] } };
        var modelRef = ['51', 0], vaeRef = ['52', 0];
    } else {
        g['1'] = { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'waiIllustriousSDXL_v170.safetensors' } };
        g['4'] = { class_type: 'CLIPSetLastLayer', inputs: { clip: ['1', 1], stop_at_clip_layer: -2 } };
        g['2'] = { class_type: 'CLIPTextEncode', inputs: { text: positive, clip: ['4', 0] } };
        g['3'] = { class_type: 'CLIPTextEncode', inputs: { text: negative, clip: ['4', 0] } };
        var modelRef = ['1', 0], vaeRef = ['1', 2];
    }
    if (denoise < 1) {
        g['10'] = { class_type: 'EmptyImage', inputs: { width, height, batch_size: 1, color: 0xFFFFFF } };
        g['5'] = { class_type: 'VAEEncode', inputs: { pixels: ['10', 0], vae: vaeRef } };
    } else {
        g['5'] = { class_type: 'EmptyLatentImage', inputs: { width, height, batch_size: 1 } };
    }
    g['36'] = { class_type: 'KSampler', inputs: {
        seed: SEED, steps: m.steps, cfg: m.cfg, sampler_name: m.sampler, scheduler: m.scheduler, denoise,
        model: modelRef, positive: ['2', 0], negative: ['3', 0], latent_image: ['5', 0] } };
    g['6'] = { class_type: 'VAEDecode', inputs: { samples: ['36', 0], vae: vaeRef } };
    g['9'] = { class_type: 'SaveImage', inputs: { filename_prefix: 'parts-bench/img', images: ['6', 0] } };
    return g;
}

const cases = [];
for (const model of Object.keys(MODELS)) {
    for (const cat of Object.keys(PARTS)) {
        for (const method of ['t2i', 'i2i']) {
            cases.push({ name: `${cat}-${method}-${model}`, model, cat, base: BASE[cat], width: 512, height: 704, denoise: method === 'i2i' ? 0.88 : 1 });
        }
    }
    cases.push({ name: `outfit-i2i95-${model}`, model, cat: 'outfit', base: BASE.outfit, width: 512, height: 704, denoise: 0.95 });
    cases.push({ name: `outfit-alt-t2i-${model}`, model, cat: 'outfit', base: BASE_ALT, width: 512, height: 704, denoise: 1 });
    cases.push({ name: `outfit-small-t2i-${model}`, model, cat: 'outfit', base: BASE.outfit, width: 384, height: 528, denoise: 1 });
}

// Round 2: Illustrious read "white mannequin" as a shop dress form beside a real girl.
// Try wordings that keep one figure, with a negative against a second one.
const NEG2 = ', 2girls, multiple girls, multiple views, dress form, mannequin stand';
const R2 = {
    r2a: { outfit: '1girl, solo, faceless, no face, bald, white skin, colored skin, standing, arms at sides, full body, simple background, white background',
           hair: '1girl, solo, faceless, no face, white skin, colored skin, upper body, facing viewer, simple background, white background' },
    r2b: { outfit: '1girl, solo, mannequin, faceless, bald, standing, arms at sides, full body, simple background, white background',
           hair: '1girl, solo, mannequin, faceless, upper body, facing viewer, simple background, white background' },
    r2c: { outfit: BASE.outfit, hair: BASE.hair },
};
if (args.includes('--round2')) {
    cases.length = 0;
    for (const key of Object.keys(R2)) for (const cat of ['outfit', 'hair']) {
        cases.push({ name: `${cat}-${key}-illustrious`, model: 'illustrious', cat, base: R2[key][cat], neg: NEG2, width: 512, height: 704, denoise: 1 });
    }
    for (const key of ['r2a', 'r2b']) cases.push({ name: `outfit-${key}-anima`, model: 'anima', cat: 'outfit', base: R2[key].outfit, neg: NEG2, width: 512, height: 704, denoise: 1 });
}

// Round 3 (Illustrious only): r2a kept one figure but cropped the head. Frame it explicitly,
// and try the round-1 img2img route (the one Illustrious case that gave a single mannequin).
const R3 = {
    r3a: { outfit: '1girl, solo, faceless, bald, white skin, colored skin, standing, facing viewer, looking at viewer, arms at sides, full body, simple background, white background',
           hair: '1girl, solo, faceless, white skin, colored skin, upper body, facing viewer, looking at viewer, simple background, white background' },
    r3b: { outfit: '1girl, solo, no face, bald, pale skin, standing, facing viewer, looking at viewer, arms at sides, full body, simple background, white background',
           hair: '1girl, solo, no face, pale skin, upper body, facing viewer, looking at viewer, simple background, white background' },
};
if (args.includes('--round3')) {
    cases.length = 0;
    for (const key of Object.keys(R3)) for (const cat of ['outfit', 'hair']) {
        cases.push({ name: `${cat}-${key}-illustrious`, model: 'illustrious', cat, base: R3[key][cat], neg: NEG2, width: 512, height: 704, denoise: 1 });
    }
    cases.push({ name: `outfit-r3a-i2i-illustrious`, model: 'illustrious', cat: 'outfit', base: R3.r3a.outfit, neg: NEG2, width: 512, height: 704, denoise: 0.88 });
    cases.push({ name: `outfit-r3a-s4-illustrious`, model: 'illustrious', cat: 'outfit', base: R3.r3a.outfit, neg: NEG2, width: 512, height: 704, denoise: 1, seed: 4 });
    cases.push({ name: `outfit-r3a-s5-illustrious`, model: 'illustrious', cat: 'outfit', base: R3.r3a.outfit, neg: NEG2, width: 512, height: 704, denoise: 1, seed: 5 });
}

// Round 4: the candidate final wording (r3a style) on every category and both models, txt2img.
const FINAL = {
    outfit: '1girl, solo, faceless, bald, white skin, colored skin, standing, facing viewer, looking at viewer, arms at sides, full body, simple background, white background',
    hair: '1girl, solo, faceless, white skin, colored skin, upper body, facing viewer, looking at viewer, simple background, white background',
    body: '1girl, solo, faceless, bald, white skin, colored skin, white bodysuit, standing, facing viewer, looking at viewer, full body, simple background, white background',
    background: 'no humans, scenery',
};
if (args.includes('--round4')) {
    cases.length = 0;
    for (const model of Object.keys(MODELS)) for (const cat of Object.keys(FINAL)) {
        cases.push({ name: `${cat}-final-${model}`, model, cat, base: FINAL[cat], neg: NEG2, width: 512, height: 704, denoise: 1 });
    }
}

async function run(c) {
    const m = MODELS[c.model];
    const positive = `${m.quality}, ${c.base}, ${PARTS[c.cat]}`;
    const prompt = graph({ model: c.model, positive, negative: m.negative + (c.neg || ''), width: c.width, height: c.height, denoise: c.denoise });
    if (c.seed) prompt['36'].inputs.seed = c.seed;
    const t0 = Date.now();
    const res = await fetch(`${COMFY}/prompt`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt, client_id: 'parts-bench' }) });
    if (!res.ok) throw new Error(`${c.name}: POST /prompt ${res.status} ${await res.text()}`);
    const { prompt_id } = await res.json();
    let hist;
    for (;;) {
        await new Promise(r => setTimeout(r, 700));
        const h = await (await fetch(`${COMFY}/history/${prompt_id}`)).json();
        if (h[prompt_id]) { hist = h[prompt_id]; break; }
    }
    const wallMs = Date.now() - t0;
    if (hist.status?.status_str === 'error') throw new Error(`${c.name}: ${JSON.stringify(hist.status.messages).slice(0, 500)}`);
    const img = hist.outputs['9'].images[0];
    const buf = Buffer.from(await (await fetch(`${COMFY}/view?filename=${encodeURIComponent(img.filename)}&subfolder=${encodeURIComponent(img.subfolder)}&type=${img.type}`)).arrayBuffer());
    const file = `${c.name}.png`;
    fs.writeFileSync(path.join(OUT, file), buf);
    const ex = hist.status?.messages?.find(x => x[0] === 'execution_start')?.[1]?.timestamp;
    const su = hist.status?.messages?.find(x => x[0] === 'execution_success')?.[1]?.timestamp;
    return { ...c, positive, file, wallMs, execMs: ex && su ? su - ex : null };
}

const results = [];
for (const c of cases) {
    if (only.length && !only.includes(c.cat)) continue;
    if (skipExisting && fs.existsSync(path.join(OUT, `${c.name}.png`))) { console.log('skip', c.name); continue; }
    try {
        const r = await run(c);
        results.push(r);
        console.log(`${r.name.padEnd(28)} ${String(r.execMs ?? r.wallMs).padStart(6)} ms`);
    } catch (e) {
        console.error('FAIL', e.message);
        results.push({ ...c, error: e.message });
    }
}
const round = args.find(a => /^--round\d$/.test(a));
fs.writeFileSync(path.join(OUT, round ? `results-${round.slice(2)}.json` : 'results.json'), JSON.stringify(results, null, 2));
