// Held-out evaluation of a Prose model (teacher or student) behind a llama-server /
// Ollama OpenAI endpoint: every input of a jsonl through the model, the same mechanical
// checks as teach.mjs, plus JSON-parse rate and speed. For the student, pass its short
// system prompt and no schema (--system=student-system.txt --schema=0), which is how the
// app would run it.
//
//   node experiments/prose-small/distill/eval.mjs --in=holdout.jsonl [--system=student-system.txt] [--schema=0]
//        [--label=student-v1] [--limit=100] [--out=eval-student-v1.json]
//   LLAMA_URL=http://127.0.0.1:8090 selects the server.
//
// A row of the input file may be a teacher row (with the teacher's `prompt`); then the
// report also gives the word overlap between student and teacher paragraphs.

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { PROSE_SYSTEM_PROMPT, PROSE_RESPONSE_FORMAT, buildProseUserContent, hasNonEnglish, parseProseResponse } from '../../../scripts/shared/prosePrompt.js';

const URL_ = process.env.LLAMA_URL || 'http://127.0.0.1:8090';
const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const args = Object.fromEntries(process.argv.slice(2).map(a => { const m = a.match(/^--([^=]+)=(.*)$/); return m ? [m[1], m[2]] : [a.replace(/^--/, ''), 'true']; }));
const IN = path.resolve(HERE, args.in || 'holdout.jsonl');
const label = args.label || 'model';
const OUT = path.resolve(HERE, args.out || `eval-${label}.json`);
const LIMIT = Number(args.limit || Infinity);
const systemPrompt = args.system ? readFileSync(path.resolve(HERE, args.system), 'utf8').trim() : PROSE_SYSTEM_PROMPT;
const useSchema = args.schema !== '0';
const MODEL = args.model || 'x';

function checks(prompt, fields) {
    const text = prompt.toLowerCase();
    const entries = (fields.characters || []).map(e => (typeof e === 'string' ? e : e.tags));
    const verbatim = entries.every(tags => tags.toLowerCase().split(/[\s,]+/).filter(Boolean).every(w => text.includes(w.replace(/[()]/g, ''))));
    const words = prompt.split(/\s+/).length;
    return {
        english: !hasNonEnglish(prompt),
        quality: fields.common === '' || prompt.startsWith(fields.common),
        verbatim,
        noRef: !/@\d/.test(prompt),
        noSide: !/\b(left|right)\b/i.test(prompt),
        noPassive: !/\b(is|are) being \w+(ed|en)\b/i.test(prompt),
        complete: words >= 20 && words <= 220,
    };
}

const overlap = (a, b) => {
    const A = new Set(a.toLowerCase().split(/\W+/).filter(w => w.length > 3)), B = new Set(b.toLowerCase().split(/\W+/).filter(w => w.length > 3));
    const inter = [...A].filter(w => B.has(w)).length;
    return A.size ? inter / A.size : 0;
};

const rows = readFileSync(IN, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)).slice(0, LIMIT);
const results = [];
const tally = { n: 0, jsonOk: 0, allOk: 0, failed: {}, sec: 0, outTokens: 0 };
for (const item of rows) {
    const t0 = Date.now();
    const res = await fetch(`${URL_}/v1/chat/completions`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            model: MODEL,
            messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: buildProseUserContent(item.fields) }],
            ...(useSchema ? { response_format: { type: 'json_schema', json_schema: { name: 'prose', schema: PROSE_RESPONSE_FORMAT } } } : {}),
            temperature: 0.3, seed: 1, max_tokens: 512, stream: false,
            chat_template_kwargs: { enable_thinking: false },
        }),
    });
    const body = await res.json();
    if (!res.ok) { console.log(`id ${item.id}: HTTP ${res.status} ${JSON.stringify(body).slice(0, 200)}`); continue; }
    const content = body.choices?.[0]?.message?.content ?? '';
    const parsed = parseProseResponse(content);
    const c = parsed.ok ? checks(parsed.prompt, item.fields) : null;
    const ok = !!c && Object.values(c).every(Boolean);
    const sec = (Date.now() - t0) / 1000;
    const t = body.timings || {};
    tally.n++; tally.sec += sec; tally.outTokens += t.predicted_n ?? body.usage?.completion_tokens ?? 0;
    if (parsed.ok) tally.jsonOk++;
    if (ok) tally.allOk++;
    else {
        const key = parsed.ok ? Object.entries(c).filter(([, v]) => !v).map(([k]) => k).join(',') : `json:${parsed.reason}`;
        tally.failed[key] = (tally.failed[key] || 0) + 1;
    }
    results.push({ id: item.id, lang: item.lang, count: item.count, scope: item.scope, ok, checks: c, reason: parsed.reason ?? '', sec, tps: t.predicted_per_second,
        prompt: parsed.prompt, teacher: item.prompt ?? null, teacherOverlap: item.prompt ? overlap(item.prompt, parsed.prompt) : null, raw: parsed.ok ? undefined : content.slice(0, 300) });
    if (tally.n % 10 === 0) console.log(`${tally.n}/${rows.length} json ${tally.jsonOk} ok ${tally.allOk} avg ${(tally.sec / tally.n).toFixed(1)}s`);
}
const summary = {
    label, n: tally.n, jsonRate: tally.jsonOk / tally.n, passRate: tally.allOk / tally.n, failed: tally.failed,
    avgSec: tally.sec / tally.n, avgOutTokens: tally.outTokens / tally.n,
    teacherOverlap: results.filter(r => r.teacherOverlap != null).reduce((a, r, _, arr) => a + r.teacherOverlap / arr.length, 0),
};
writeFileSync(OUT, JSON.stringify({ summary, results }, null, 2));
console.log(JSON.stringify(summary, null, 2));
console.log(`wrote ${OUT}`);
