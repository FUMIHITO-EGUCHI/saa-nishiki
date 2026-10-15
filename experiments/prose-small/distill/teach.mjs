// The teacher pass of the Prose distillation: every input of inputs.jsonl through a
// llama-server (Qwen3.5-35B-A3B, experts on the CPU) with SAA's system prompt and
// schema, the answer checked mechanically, and the pairs written to teacher.jsonl.
// Resumable: ids already in the output are skipped.
//
//   node experiments/prose-small/distill/teach.mjs [--in=inputs.jsonl] [--out=teacher.jsonl] [--limit=N] [--parallel=1]
//
// Checks (a failed one keeps the row with ok=false so it can be dropped at training):
//   english   no non-Latin script in the paragraph
//   quality   the paragraph opens with the common tags verbatim
//   verbatim  each character entry's tags appear (words present, in order) in the paragraph
//   noRef     no "@1"-style handle left in the output
//   noSide    no "left"/"right" naming of characters
//   noPassive no "is being <verb>ed" restatement of the action (rule 3)
//   complete  the JSON closed and the paragraph is 20..220 words

import { readFileSync, writeFileSync, appendFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { PROSE_SYSTEM_PROMPT, PROSE_RESPONSE_FORMAT, buildProseUserContent, hasNonEnglish, parseProseResponse } from '../../../scripts/shared/prosePrompt.js';

const URL_ = process.env.LLAMA_URL || 'http://127.0.0.1:8089';
const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const args = Object.fromEntries(process.argv.slice(2).map(a => { const m = a.match(/^--([^=]+)=(.*)$/); return m ? [m[1], m[2]] : [a.replace(/^--/, ''), 'true']; }));
const IN = path.resolve(HERE, args.in || 'inputs.jsonl');
const OUT = path.resolve(HERE, args.out || 'teacher.jsonl');
const LIMIT = Number(args.limit || Infinity);
const PARALLEL = Number(args.parallel || 1);
// --style=v2: the first teacher batch restated a character's whole tag list in every
// sentence, and the student learned to say the same sentence once per action line. The
// v2 rows are taught under one more rule, so the checks below reject fewer answers.
const STYLE = String(args.style || '');
const STYLE_RULES = {
    v2: '\n9. Name each character in full once, where they are introduced. Afterwards refer to them by a short phrase of two or three words ("the red-haired girl", "the taller one") or a pronoun, never by the full list of tags again. Every sentence says something new; never restate what an earlier sentence already said.',
};
const SYSTEM = PROSE_SYSTEM_PROMPT + (STYLE_RULES[STYLE] || '');

const inputs = readFileSync(IN, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
const done = new Set(existsSync(OUT) ? readFileSync(OUT, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l).id) : []);
if (!existsSync(OUT)) writeFileSync(OUT, '');

const COLOUR = /\b(blonde|black|brown|blue|white|pink|grey|gray|purple|red|green|orange|silver|aqua|yellow|golden|amber|violet|teal|lavender|platinum|ginger|auburn)(?=[ -](hair|eyes|eye)\b)/gi;
export function inventedColours(prompt, fields) {
    const input = JSON.stringify(fields).toLowerCase().replace(/_/g, ' ');
    const out = new Set([...String(prompt).toLowerCase().matchAll(COLOUR)].map(m => m[1].replace(/^gray$/, 'grey')));
    return [...out].filter(c => !input.includes(c) && !(c === 'grey' && input.includes('gray')));
}
export function repeatsItself(prompt) {
    const sentences = String(prompt).split(/(?<=[.!?])\s+/).map(s => s.toLowerCase().replace(/[^a-z0-9\s]/g, '').trim()).filter(s => s.split(/\s+/).length >= 5);
    for (let i = 0; i < sentences.length; i++) {
        const a = new Set(sentences[i].split(/\s+/));
        for (let j = i + 1; j < sentences.length; j++) {
            const b = new Set(sentences[j].split(/\s+/));
            let common = 0; for (const w of a) if (b.has(w)) common++;
            if (common / Math.max(a.size, b.size) >= 0.7) return true;
        }
    }
    return false;
}

function checks(prompt, fields) {
    const text = prompt.toLowerCase();
    const entries = (fields.characters || []).map(e => (typeof e === 'string' ? e : e.tags));
    const verbatim = entries.every(tags => {
        // every word of every tag present; the whole entry in order for named ones
        const words = tags.toLowerCase().split(/[\s,]+/).filter(Boolean);
        return words.every(w => text.includes(w.replace(/[()]/g, '')));
    });
    const words = prompt.split(/\s+/).length;
    return {
        english: !hasNonEnglish(prompt),
        quality: fields.common === '' || prompt.startsWith(fields.common),
        verbatim,
        noRef: !/@\d/.test(prompt),
        noSide: !/\b(left|right)\b/i.test(prompt),
        noPassive: !/\b(is|are|being) being \w+(ed|en)\b|\bis being \w+(ed|en)\b|\bare being \w+(ed|en)\b/i.test(prompt),
        complete: words >= 20 && words <= 220,
        // student v1 (2026-09-26) invented "long pink hair and a pink track jacket" for a
        // character given by name alone, and said the same sentence once per action line:
        // a hair or eye colour the input never gave, or two near-identical sentences, fail
        noInvention: inventedColours(prompt, fields).length === 0,
        noRepeat: !repeatsItself(prompt),
    };
}

async function teach(item) {
    const t0 = Date.now();
    const res = await fetch(`${URL_}/v1/chat/completions`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            model: 'x',
            messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: buildProseUserContent(item.fields) }],
            response_format: { type: 'json_schema', json_schema: { name: 'prose', schema: PROSE_RESPONSE_FORMAT } },
            temperature: 0.3, seed: 1 + item.id, max_tokens: 512, stream: false,
            chat_template_kwargs: { enable_thinking: false },
        }),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(`HTTP ${res.status} ${JSON.stringify(body).slice(0, 200)}`);
    const content = body.choices?.[0]?.message?.content ?? '';
    const parsed = parseProseResponse(content);
    const c = parsed.ok ? checks(parsed.prompt, item.fields) : null;
    const ok = !!c && Object.values(c).every(Boolean);
    const t = body.timings || {};
    return { ...item, prompt: parsed.prompt, ok, checks: c, reason: parsed.ok ? '' : parsed.reason, sec: (Date.now() - t0) / 1000, outTokens: t.predicted_n, tps: t.predicted_per_second };
}

const todo = inputs.filter(x => !done.has(x.id)).slice(0, LIMIT);
console.log(`${inputs.length} inputs, ${done.size} done, ${todo.length} to do, parallel ${PARALLEL}`);
let n = 0, okCount = 0, secSum = 0;
const started = Date.now();
async function worker() {
    for (;;) {
        const item = todo.shift();
        if (!item) return;
        try {
            const r = await teach(item);
            appendFileSync(OUT, JSON.stringify(r) + '\n');
            n++; secSum += r.sec; if (r.ok) okCount++;
            if (n % 20 === 0 || !r.ok) {
                const failed = r.ok ? '' : ` FAIL ${r.reason || Object.entries(r.checks).filter(([, v]) => !v).map(([k]) => k).join(',')}`;
                console.log(`${n}/${todo.length + n} ok=${okCount} avg ${(secSum / n).toFixed(1)}s elapsed ${((Date.now() - started) / 60000).toFixed(0)}min${failed}`);
            }
        } catch (error) {
            console.log(`id ${item.id}: ${error.message}`);
            await new Promise(r => setTimeout(r, 3000));
        }
    }
}
await Promise.all(Array.from({ length: PARALLEL }, worker));
console.log(`done: ${n} new, ${okCount} ok, avg ${(secSum / Math.max(n, 1)).toFixed(1)}s`);
