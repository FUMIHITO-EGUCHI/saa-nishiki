// Tags -> English prose, for the language-model-encoder models (Anima, WAI-ANIMA).
//
// Those models read "A does X to B" from a plain sentence (12/15 on the bench) and lose it
// when the same content is sent as tags plus one sentence (7-9/15). Writing the paragraph
// by hand for every picture is the cost, so a local LLM should write it from SAA's fields.
// Anima also needs the result in English: its conditioning follows the T5 token sequence,
// and a Japanese sentence becomes a single <unk> there.
//
// This script only produces the paragraphs and measures the LLMs; whether the pictures obey
// them is a separate Pod run against the hand-written sentences in casesNL.mjs.
//
//   node prose.mjs [--models=gemma,qwen] [--lang=en,ja] [--gpu=0] [--out=prose-results.json]
//
// --gpu is Ollama's num_gpu (layers on the GPU). 0 is the setting that coexists with
// WAI-ANIMA holding ~5.5 GB of a 12 GB card, which is what SAA will actually run with.

import { writeFileSync } from 'node:fs';
import { NL_CASES } from './casesNL.mjs';

const OLLAMA = process.env.OLLAMA_URL || 'http://127.0.0.1:11434';
const QUALITY = 'masterpiece, best quality, amazing quality';

const MODELS = {
    gemma: 'gemma4-12b-uncensored-comfy',
    qwen: 'hf.co/HauhauCS/Qwen3.5-35B-A3B-Uncensored-HauhauCS-Aggressive:Q4_K_M',
};

// The same actions as casesNL.mjs, the way a Japanese user would type them into Action.
const JA_ACTION = {
    'princess-carry': '黒髪の子が金髪の子をお姫様抱っこしている',
    piggyback: '金髪の子が黒髪の子をおんぶしている',
    headpat: '黒髪の子が金髪の子の頭をなでている',
    'kneel-and-stand': '金髪の子が床にひざまずき、黒髪の子がその前に立って見下ろしている',
    'hands-apart': '二人が向かい合って、腕を伸ばして手をつないでいる',
    feeding: '黒髪の子が金髪の子にスプーンで食べさせている',
};

const SYSTEM_PROMPT = `You rewrite an image-generation prompt written as Danbooru tags into the form a language-model text encoder reads best: the quality tags, then one English paragraph.

The input is JSON with these fields; any of them may be empty:
- common: quality tags, the number of people, anything shared by the whole picture
- background, view: where the scene is and how it is framed
- style: colour, lighting, rendering
- left, right: the tags of character A (left) and character B (right)
- action: who does what to whom, in English or Japanese

Write:
1. The quality tags from common first, unchanged and comma-separated.
2. Then one paragraph of plain English sentences in this order: how many people and where they are; character A's appearance; character B's appearance; the action; the background, colour and light.
3. Write the action once, in the active voice, with the character who acts as the grammatical subject. Do not restate it in the passive. Refer to each character by their appearance, for example "the girl with short black hair". Never call them left, right, A or B.
4. Write the action as what the two bodies do, not as the name of the act or pose: where each character is relative to the other, what holds or touches what, and who looks at whom. For example, instead of "lap pillow" write "the girl with short brown hair sits on the floor, and the girl with long red hair lies on her back with her head resting on her lap, looking up at her". Do not use the name of the act or pose, even when the input does.
5. Use only what the input says and the positions and gaze its action implies. Do not add clothing, expressions, props, lighting or background that are not in it. Do not say that anyone stands, sits or walks unless the action requires it. Keep the direction of the action exactly as given.
6. Copy character names, series names, LoRA trigger words and any token with parentheses, underscores or weights such as (word:1.2) exactly.
7. English only. Translate Japanese input. The output must not contain Japanese or any other non-English characters.
8. Describe only what is in the picture. Never mention that a field is empty or that something is unspecified.

Return JSON: {"prompt": "<quality tags>, <paragraph>"}`;

const FORMAT = {
    type: 'object',
    properties: { prompt: { type: 'string' } },
    required: ['prompt'],
};

const args = Object.fromEntries(process.argv.slice(2).map(a => {
    const m = a.match(/^--([^=]+)=(.*)$/);
    return m ? [m[1], m[2]] : [a.replace(/^--/, ''), 'true'];
}));
const modelKeys = (args.models || 'gemma,qwen').split(',');
const langs = (args.lang || 'en,ja').split(',');
const numGpu = Number(args.gpu ?? 0);
const outFile = args.out || 'prose-results.json';

// SAA's field shape: the count in Common, place in Background, framing in View, each
// character's looks on their own side, the action on its own.
function fieldsFor(entry, lang) {
    const scene = entry.scene.split(', ');
    const looks = entry.looks.split(', ');
    return {
        common: `${QUALITY}, ${scene[0]}`,
        background: scene.slice(1, -1).join(', '),
        view: scene.at(-1),
        style: '',
        left: looks.slice(0, 3).join(', '),
        right: looks.slice(3).join(', '),
        action: lang === 'ja' ? JA_ACTION[entry.id] : entry.action,
    };
}

async function chat(model, fields) {
    const started = Date.now();
    const res = await fetch(`${OLLAMA}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            model,
            messages: [
                { role: 'system', content: SYSTEM_PROMPT },
                { role: 'user', content: JSON.stringify(fields, null, 2) },
            ],
            stream: false,
            think: false,
            format: FORMAT,
            options: { temperature: 0.3, seed: 1, num_predict: 512, num_ctx: 4096, num_gpu: numGpu },
            keep_alive: '10m',
        }),
    });
    if (!res.ok) throw new Error(`${model}: HTTP ${res.status} ${await res.text()}`);
    const body = await res.json();
    let prompt;
    try {
        prompt = JSON.parse(body.message.content).prompt;
    } catch {
        prompt = body.message.content;
    }
    const ns = n => (n ?? 0) / 1e9;
    return {
        prompt,
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

// Mechanical checks only; whether the direction survived is read by eye.
function check(prompt, fields) {
    const text = prompt.toLowerCase();
    const looks = [...fields.left.split(', '), ...fields.right.split(', ')];
    const missing = looks.filter(phrase => !phrase.split(' ').every(word => text.includes(word)));
    return {
        nonEnglish: /[　-鿿가-힯＀-￯]/.test(prompt),
        keepsQuality: prompt.startsWith(QUALITY),
        missingLooks: missing,
        saysLeftRight: /\b(left|right)\b/i.test(prompt),
        words: prompt.split(/\s+/).length,
    };
}

const results = [];
for (const key of modelKeys) {
    const model = MODELS[key] || key;
    console.log(`\n=== ${key} (${model}), num_gpu=${numGpu} ===`);
    for (const lang of langs) {
        for (const entry of NL_CASES) {
            const fields = fieldsFor(entry, lang);
            const r = await chat(model, fields);
            const c = check(r.prompt, fields);
            results.push({ model: key, lang, id: entry.id, actor: entry.actor, fields, ...r, check: c });
            console.log(`\n[${key} ${lang} ${entry.id}] wall ${r.wallSec.toFixed(1)}s load ${r.loadSec.toFixed(1)}s`
                + ` prompt ${r.promptTokens}t/${r.promptSec.toFixed(1)}s out ${r.outTokens}t/${r.outSec.toFixed(1)}s`
                + ` (${(r.outTokens / (r.outSec || 1)).toFixed(1)} t/s)`);
            console.log(`  checks: nonEnglish=${c.nonEnglish} quality=${c.keepsQuality} leftRight=${c.saysLeftRight}`
                + ` missing=[${c.missingLooks.join('; ')}] words=${c.words}`);
            console.log(`  ${r.prompt}`);
            writeFileSync(outFile, JSON.stringify({ numGpu, systemPrompt: SYSTEM_PROMPT, results }, null, 2));
        }
    }
    await unload(model);
}
console.log(`\nwrote ${outFile}`);
