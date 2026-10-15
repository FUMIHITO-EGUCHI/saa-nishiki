// Quality check of one llama-server model on the full 12-case set (6 NL cases x en/ja
// action), the same request SAA sends for Prose. Written to decide whether the
// 35B-A3B (--cpu-moe) run is good enough to be the teacher for the distillation.
//
//   node experiments/prose-small/qa-llamaserver.mjs [--out=results-qa.json] [--label=qwen35-cpumoe]
//
// Prints the mechanical checks of bench.mjs; the direction of the action is read by eye.

import { writeFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { PROSE_SYSTEM_PROMPT, PROSE_RESPONSE_FORMAT, buildProseUserContent, hasNonEnglish, parseProseResponse } from '../../scripts/shared/prosePrompt.js';
import { NL_CASES } from '../comfyui-regional/casesNL.mjs';

const URL_ = process.env.LLAMA_URL || 'http://127.0.0.1:8089';
const QUALITY = 'masterpiece, best quality, score_7, safe';
const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const args = Object.fromEntries(process.argv.slice(2).map(a => { const m = a.match(/^--([^=]+)=(.*)$/); return m ? [m[1], m[2]] : [a.replace(/^--/, ''), 'true']; }));
const outFile = path.resolve(HERE, args.out || 'results-qa.json');
const label = args.label || 'llamaserver';
// --system=<file>: a system prompt file instead of PROSE_SYSTEM_PROMPT (the distilled student's short one)
const systemPrompt = args.system ? readFileSync(path.resolve(HERE, args.system), 'utf8').trim() : PROSE_SYSTEM_PROMPT;
// --schema=0: no JSON schema constraint (the student is meant to run without one)
const useSchema = args.schema !== '0';

const JA_ACTION = {
    'princess-carry': '@1 が @2 をお姫様抱っこしている',
    piggyback: '@2 が @1 をおんぶしている',
    headpat: '@1 が @2 の頭をなでている',
    'kneel-and-stand': '@2 が床にひざまずき、@1 がその前に立って見下ろしている',
    'hands-apart': '二人が向かい合って、腕を伸ばして手をつないでいる',
    feeding: '@1 が @2 にスプーンで食べさせている',
};
const EN_ACTION = {
    'princess-carry': '@1 is carrying @2 in her arms',
    piggyback: '@2 is giving @1 a piggyback ride on her back',
    headpat: '@1 is patting @2 on the head',
    'kneel-and-stand': '@2 kneels on the floor and @1 stands in front of her looking down at her',
    'hands-apart': 'the two face each other with their arms stretched out, holding hands',
    feeding: '@1 is feeding @2 with a spoon',
};

function fieldsFor(entry, lang) {
    const scene = entry.scene.split(', ');
    const looks = entry.looks.split(', ');
    return {
        common: `${QUALITY}, ${scene[0]}`,
        characters: [{ ref: '@1', tags: looks.slice(3).join(', ') }, { ref: '@2', tags: looks.slice(0, 3).join(', ') }],
        view: scene.at(-1), background: scene.slice(1, -1).join(', '), style: '', positive: '',
        action: lang === 'ja' ? JA_ACTION[entry.id] : EN_ACTION[entry.id],
    };
}

function check(prompt, fields) {
    const text = prompt.toLowerCase();
    const looks = fields.characters.flatMap(c => c.tags.split(', '));
    const missing = looks.filter(phrase => !phrase.split(' ').every(word => text.includes(word)));
    return { nonEnglish: hasNonEnglish(prompt), keepsQuality: prompt.startsWith(QUALITY), missingLooks: missing,
        saysLeftRight: /\b(left|right)\b/i.test(prompt), hasRef: /@\d/.test(prompt), words: prompt.split(/\s+/).length };
}

const results = [];
for (const lang of ['en', 'ja']) {
    for (const entry of NL_CASES) {
        const fields = fieldsFor(entry, lang);
        const t0 = Date.now();
        const res = await fetch(`${URL_}/v1/chat/completions`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: 'x',
                messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: buildProseUserContent(fields) }],
                ...(useSchema ? { response_format: { type: 'json_schema', json_schema: { name: 'prose', schema: PROSE_RESPONSE_FORMAT } } } : {}),
                temperature: 0.3, seed: 1, max_tokens: 768, stream: false,
                chat_template_kwargs: { enable_thinking: false },
            }),
        });
        const body = await res.json();
        if (!res.ok) { console.log(`[${lang} ${entry.id}] HTTP ${res.status} ${JSON.stringify(body).slice(0, 200)}`); continue; }
        const t = body.timings || {};
        const content = body.choices?.[0]?.message?.content ?? '';
        const parsed = parseProseResponse(content);
        const c = check(parsed.prompt, fields);
        const wallSec = (Date.now() - t0) / 1000;
        results.push({ model: label, lang, id: entry.id, actor: entry.actor, fields, prompt: parsed.prompt, ok: parsed.ok, wallSec,
            promptTokens: t.prompt_n, cacheTokens: t.cache_n, outTokens: t.predicted_n, outTps: t.predicted_per_second, check: c });
        console.log(`\n[${label} ${lang} ${entry.id}] wall ${wallSec.toFixed(1)}s prompt_n=${t.prompt_n} cache_n=${t.cache_n ?? '?'} out ${t.predicted_n}t (${t.predicted_per_second?.toFixed(1)} t/s) ok=${parsed.ok}`);
        console.log(`  checks: nonEnglish=${c.nonEnglish} quality=${c.keepsQuality} leftRight=${c.saysLeftRight} ref=${c.hasRef} missing=[${c.missingLooks.join('; ')}] words=${c.words}`);
        console.log(`  ${parsed.prompt}`);
        writeFileSync(outFile, JSON.stringify({ results }, null, 2));
    }
}
console.log(`\nwrote ${outFile}`);
