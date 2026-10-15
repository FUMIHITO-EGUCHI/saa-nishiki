// Prose (tags -> one English paragraph for Anima) on smaller local LLMs.
//
// SAA writes the paragraph with scripts/shared/prosePrompt.js: the same system prompt,
// the same JSON fields and the same schema-constrained answer are used here, so what is
// measured is what the app would do. The question is whether a 2-4B model that fits the
// GPU beside WAI-ANIMA (which holds ~6 GB of the 12 GB card) writes an acceptable
// paragraph, and how much faster than the 12B / 35B models running on the CPU.
//
//   node experiments/prose-small/bench.mjs [--models=a,b] [--lang=en,ja] [--gpu=99] [--cases=id,id] [--out=results.json]
//
// --gpu is Ollama's num_gpu for the models named "gpu" below (layers on the GPU);
// the CPU baselines always run with num_gpu 0, as SAA runs them today.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { PROSE_SYSTEM_PROMPT, PROSE_RESPONSE_FORMAT, buildProseUserContent, hasNonEnglish, parseProseResponse } from '../../scripts/shared/prosePrompt.js';
import { NL_CASES } from '../comfyui-regional/casesNL.mjs';

const OLLAMA = process.env.OLLAMA_URL || 'http://127.0.0.1:11434';
const QUALITY = 'masterpiece, best quality, score_7, safe';
const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));

// name -> { model, gpu: true = the layers go to the GPU (--gpu), false = CPU only }
const MODELS = {
    gemma12: { model: 'gemma4-12b-uncensored-comfy:latest', gpu: false },
    qwen35: { model: 'hf.co/HauhauCS/Qwen3.5-35B-A3B-Uncensored-HauhauCS-Aggressive:Q4_K_M', gpu: false },
    qwen4b: { model: 'huihui_ai/qwen3.5-abliterated:4B', gpu: true },
    qwen2b: { model: 'huihui_ai/qwen3.5-abliterated:2B', gpu: true },
    gemmae4b: { model: 'hf.co/HauhauCS/Gemma-4-E4B-Uncensored-HauhauCS-Aggressive:Q4_K_M', gpu: true },
    gemma12gpu: { model: 'gemma4-12b-uncensored-comfy:latest', gpu: true },
    // MoE (3B active): --gpu=8 puts a few whole layers on the GPU, the rest on the CPU
    qwen35gpu: { model: 'hf.co/HauhauCS/Qwen3.5-35B-A3B-Uncensored-HauhauCS-Aggressive:Q4_K_M', gpu: true },
};

const JA_ACTION = {
    'princess-carry': '@1 が @2 をお姫様抱っこしている',
    piggyback: '@2 が @1 をおんぶしている',
    headpat: '@1 が @2 の頭をなでている',
    'kneel-and-stand': '@2 が床にひざまずき、@1 がその前に立って見下ろしている',
    'hands-apart': '二人が向かい合って、腕を伸ばして手をつないでいる',
    feeding: '@1 が @2 にスプーンで食べさせている',
};

// The English actions of casesNL name the girls by hair; the cast form names them by ref.
const EN_ACTION = {
    'princess-carry': '@1 is carrying @2 in her arms',
    piggyback: '@2 is giving @1 a piggyback ride on her back',
    headpat: '@1 is patting @2 on the head',
    'kneel-and-stand': '@2 kneels on the floor and @1 stands in front of her looking down at her',
    'hands-apart': 'the two face each other with their arms stretched out, holding hands',
    feeding: '@1 is feeding @2 with a spoon',
};

const args = Object.fromEntries(process.argv.slice(2).map(a => {
    const m = a.match(/^--([^=]+)=(.*)$/);
    return m ? [m[1], m[2]] : [a.replace(/^--/, ''), 'true'];
}));
const modelKeys = (args.models || 'qwen4b,qwen2b,gemmae4b,gemma12').split(',');
const langs = (args.lang || 'en,ja').split(',');
const gpuLayers = Number(args.gpu ?? 99);
const outFile = path.resolve(HERE, args.out || 'results.json');
// --cases=princess-carry,piggyback limits the run to those NL cases (default: all)
const caseIds = args.cases ? new Set(args.cases.split(',')) : null;
const cases = caseIds ? NL_CASES.filter(c => caseIds.has(c.id)) : NL_CASES;

// SAA's field shape (buildProseFields): the count in common, a cast of {ref, tags},
// view / background / style, and the action with @refs. @1 = black hair (actor in most
// cases), @2 = blonde.
function fieldsFor(entry, lang) {
    const scene = entry.scene.split(', ');
    const looks = entry.looks.split(', ');
    return {
        common: `${QUALITY}, ${scene[0]}`,
        characters: [
            { ref: '@1', tags: looks.slice(3).join(', ') },
            { ref: '@2', tags: looks.slice(0, 3).join(', ') },
        ],
        view: scene.at(-1),
        background: scene.slice(1, -1).join(', '),
        style: '',
        positive: '',
        action: lang === 'ja' ? JA_ACTION[entry.id] : EN_ACTION[entry.id],
    };
}

async function chat(spec, fields) {
    const started = Date.now();
    const res = await fetch(`${OLLAMA}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            model: spec.model,
            messages: [
                { role: 'system', content: PROSE_SYSTEM_PROMPT },
                { role: 'user', content: buildProseUserContent(fields) },
            ],
            stream: false,
            think: false,
            format: PROSE_RESPONSE_FORMAT,
            // SAA's Prose options (ollamaSaaAdapter) with the temperature the app floors at
            options: { temperature: 0.3, seed: 1, num_predict: 768, num_ctx: 4096, num_gpu: spec.gpu ? gpuLayers : 0 },
            keep_alive: '10m',
        }),
    });
    if (!res.ok) throw new Error(`${spec.model}: HTTP ${res.status} ${await res.text()}`);
    const body = await res.json();
    const parsed = parseProseResponse(body.message?.content ?? '');
    const ns = n => (n ?? 0) / 1e9;
    return {
        prompt: parsed.prompt,
        ok: parsed.ok,
        reason: parsed.reason ?? '',
        wallSec: (Date.now() - started) / 1000,
        loadSec: ns(body.load_duration),
        promptTokens: body.prompt_eval_count ?? 0,
        promptSec: ns(body.prompt_eval_duration),
        outTokens: body.eval_count ?? 0,
        outSec: ns(body.eval_duration),
    };
}

async function unload(model) {
    await fetch(`${OLLAMA}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, keep_alive: 0 }),
    });
}

async function gpuMemory() {
    try {
        const { execSync } = await import('node:child_process');
        return execSync('nvidia-smi --query-gpu=memory.used --format=csv,noheader,nounits').toString().trim();
    } catch { return '?'; }
}

// Mechanical checks; whether the direction survived is read by eye from the prompt.
function check(prompt, fields) {
    const text = prompt.toLowerCase();
    const looks = fields.characters.flatMap(c => c.tags.split(', '));
    const missing = looks.filter(phrase => !phrase.split(' ').every(word => text.includes(word)));
    return {
        nonEnglish: hasNonEnglish(prompt),
        keepsQuality: prompt.startsWith(QUALITY),
        missingLooks: missing,
        saysLeftRight: /\b(left|right)\b/i.test(prompt),
        hasRef: /@\d/.test(prompt),
        words: prompt.split(/\s+/).length,
    };
}

mkdirSync(HERE, { recursive: true });
let results = [];
try { results = JSON.parse(readFileSync(outFile, 'utf8')).results ?? []; } catch { /* fresh file */ }
for (const key of modelKeys) {
    const spec = MODELS[key] || { model: key, gpu: true };
    results = results.filter(r => r.model !== key);
    console.log(`\n=== ${key} (${spec.model}), num_gpu=${spec.gpu ? gpuLayers : 0}, gpu mem before ${await gpuMemory()} MiB ===`);
    for (const lang of langs) {
        for (const entry of cases) {
            const fields = fieldsFor(entry, lang);
            let r;
            try { r = await chat(spec, fields); } catch (error) { console.log(`  ${key} ${lang} ${entry.id}: ${error.message}`); continue; }
            const c = check(r.prompt, fields);
            results.push({ model: key, lang, id: entry.id, actor: entry.actor, fields, ...r, check: c });
            console.log(`\n[${key} ${lang} ${entry.id}] wall ${r.wallSec.toFixed(1)}s load ${r.loadSec.toFixed(1)}s`
                + ` prompt ${r.promptTokens}t/${r.promptSec.toFixed(1)}s out ${r.outTokens}t/${r.outSec.toFixed(1)}s`
                + ` (${(r.outTokens / (r.outSec || 1)).toFixed(1)} t/s) ok=${r.ok}`);
            console.log(`  checks: nonEnglish=${c.nonEnglish} quality=${c.keepsQuality} leftRight=${c.saysLeftRight} ref=${c.hasRef}`
                + ` missing=[${c.missingLooks.join('; ')}] words=${c.words}`);
            console.log(`  ${r.prompt}`);
            writeFileSync(outFile, JSON.stringify({ gpuLayers, results }, null, 2));
        }
    }
    console.log(`gpu mem while loaded ${await gpuMemory()} MiB`);
    await unload(spec.model);
}
console.log(`\nwrote ${outFile}`);
