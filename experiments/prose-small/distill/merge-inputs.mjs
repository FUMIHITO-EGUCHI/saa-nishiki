// One inputs file for the teacher: the synthetic 5000 (inputs.jsonl), the NSFW-weighted
// batch (inputs-nsfw.jsonl, ids 5000+), and the real prompt history (history.jsonl),
// the last filtered to rows that carry enough content to be worth a paragraph, given
// ids after the synthetic ones.
//   node experiments/prose-small/distill/merge-inputs.mjs [--out=inputs-all.jsonl] [--history-max=1500]
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const args = Object.fromEntries(process.argv.slice(2).map(a => { const m = a.match(/^--([^=]+)=(.*)$/); return m ? [m[1], m[2]] : [a.replace(/^--/, ''), 'true']; }));
const OUT = path.resolve(HERE, args.out || 'inputs-all.jsonl');
const HISTORY_MAX = Number(args['history-max'] || 1500);
const read = f => (existsSync(path.join(HERE, f)) ? readFileSync(path.join(HERE, f), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) : []);

const base = read('inputs.jsonl');
const nsfw = read('inputs-nsfw.jsonl');
let nextId = Math.max(...[...base, ...nsfw].map(r => r.id)) + 1;

const FILLER = /^(nsfw|explicit|sensitive|safe|detailed eyes|\(detailed eyes:[\d.]+\)|\(nsfw:[\d.]+\)|\(explicit:[\d.]+\)|<lora::[\d.:]+>)$/i;
const history = read('history.jsonl').filter(r => {
    const tags = r.fields.positive.split(', ').map(t => t.trim()).filter(t => t && !FILLER.test(t));
    return tags.length >= 6 && r.fields.positive.length <= 1200;
}).slice(0, HISTORY_MAX).map(r => ({ id: nextId++, lang: 'en', count: 0, scope: 'fallback', nsfw: /nsfw|explicit/i.test(r.fields.common + r.fields.positive), source: r.source, fields: r.fields }));

const all = [...base, ...nsfw, ...history];
writeFileSync(OUT, all.map(r => JSON.stringify(r)).join('\n') + '\n');
console.log(`base ${base.length} + nsfw ${nsfw.length} + history ${history.length} (of ${read('history.jsonl').length}) = ${all.length} -> ${OUT}`);
