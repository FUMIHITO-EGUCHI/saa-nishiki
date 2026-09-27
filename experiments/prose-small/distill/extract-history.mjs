// Real prompt history for the distillation inputs: the positive prompts of the images
// SAA generated (ComfyUI writes the API graph into the PNG's "prompt" text chunk), so
// the student also sees the tag mixes that are actually typed: long positives, artist
// tags, weights, LoRA lines, NSFW.
//
//   node experiments/prose-small/distill/extract-history.mjs [--root=<comfy output dir>] [--out=history.jsonl]
//
// Only the dated folders (YYYY-MM-DD) are read; bench folders are skipped. A prompt that
// is already a paragraph (a Prose output) is skipped, since the inputs must be tags.
// Each row is the Refine-fallback shape SAA also sends (everything in `positive`) with
// the quality/count prefix moved to `common` when it can be told apart.

import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const args = Object.fromEntries(process.argv.slice(2).map(a => { const m = a.match(/^--([^=]+)=(.*)$/); return m ? [m[1], m[2]] : [a.replace(/^--/, ''), 'true']; }));
const ROOT = args.root || 'C:\\Users\\kurah\\Documents\\Codex\\2026-08-15\\huggingface-llm-uncensored\\wai-stack\\output';
const OUT = path.resolve(HERE, args.out || 'history.jsonl');

// PNG text chunks: tEXt (latin1), iTXt (utf8, maybe compressed), zTXt (compressed latin1)
function pngTexts(buf) {
    const out = {};
    let pos = 8;
    while (pos + 8 <= buf.length) {
        const len = buf.readUInt32BE(pos);
        const type = buf.toString('latin1', pos + 4, pos + 8);
        const data = buf.subarray(pos + 8, pos + 8 + len);
        if (type === 'tEXt') {
            const nul = data.indexOf(0);
            out[data.toString('latin1', 0, nul)] = data.toString('utf8', nul + 1);
        } else if (type === 'zTXt') {
            const nul = data.indexOf(0);
            try { out[data.toString('latin1', 0, nul)] = zlib.inflateSync(data.subarray(nul + 2)).toString('utf8'); } catch { /* skip */ }
        } else if (type === 'iTXt') {
            const nul = data.indexOf(0);
            const key = data.toString('latin1', 0, nul);
            const compressed = data[nul + 1] === 1;
            let p = nul + 3;
            p = data.indexOf(0, p) + 1; // language tag
            p = data.indexOf(0, p) + 1; // translated keyword
            const rest = data.subarray(p);
            try { out[key] = compressed ? zlib.inflateSync(rest).toString('utf8') : rest.toString('utf8'); } catch { /* skip */ }
        }
        if (type === 'IEND') break;
        pos += 12 + len;
    }
    return out;
}

// The positive text(s): every CLIPTextEncode whose output reaches the sampler's
// `positive` input (through ConditioningSetMask / Combine / Concat and the like).
function positiveTexts(graph) {
    const sampler = Object.values(graph).find(n => /KSampler|SamplerCustom|RegionalSampler/.test(n.class_type) && n.inputs?.positive);
    if (!sampler) return [];
    const texts = [];
    const seen = new Set();
    const walk = ref => {
        if (!Array.isArray(ref)) return;
        const id = String(ref[0]);
        if (seen.has(id)) return;
        seen.add(id);
        const node = graph[id];
        if (!node) return;
        if (node.class_type === 'CLIPTextEncode' && typeof node.inputs?.text === 'string') texts.push(node.inputs.text);
        for (const v of Object.values(node.inputs ?? {})) walk(v);
    };
    walk(sampler.inputs.positive);
    return texts;
}

const QUALITY = /^(masterpiece|best quality|amazing quality|very awa|absurdres|highres|score_\d|safe|sensitive|nsfw|explicit|newest|year \d{4}|1girl|1boy|2girls|2boys|1other|solo|multiple girls|multiple boys|\d(girls|boys))$/i;
const looksLikeProse = text => /[.!?]\s+[A-Z]/.test(text) && text.split(/\s+/).length > 25 && (text.match(/,/g) || []).length < text.split(/\s+/).length / 4;

const files = [];
for (const d of readdirSync(ROOT)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) continue;
    const dir = path.join(ROOT, d);
    const walk = p => { for (const f of readdirSync(p)) { const fp = path.join(p, f); if (statSync(fp).isDirectory()) walk(fp); else if (f.endsWith('.png')) files.push(fp); } };
    walk(dir);
}

const rows = [];
const seenText = new Set();
const stats = { files: files.length, noPrompt: 0, prose: 0, dup: 0, regional: 0, kept: 0, nsfw: 0, lora: 0, artist: 0 };
for (const file of files) {
    let texts = [];
    try {
        const info = pngTexts(readFileSync(file));
        // SAA writes an A1111-style "parameters" chunk: the positive up to "Negative prompt:"
        if (info.parameters) {
            const positive = info.parameters.split('\nNegative prompt:')[0].split('\nSteps:')[0].trim();
            if (positive) texts = [positive];
        }
        if (!texts.length && info.prompt) texts = positiveTexts(JSON.parse(info.prompt));
    } catch { /* fall through */ }
    if (!texts.length) { stats.noPrompt++; continue; }
    if (texts.length > 1) stats.regional++;
    for (const raw of texts) {
        const lines = raw.split('\n').map(s => s.trim()).filter(Boolean);
        const loraLines = lines.filter(l => /^<lora:/i.test(l));
        const text = lines.filter(l => !/^<lora:/i.test(l)).join(', ').replace(/\s*,\s*/g, ', ').replace(/(, )+/g, ', ').replace(/^, |, $/g, '');
        if (text.split(', ').length < 4) continue;
        if (looksLikeProse(text)) { stats.prose++; continue; }
        const key = text.toLowerCase();
        if (seenText.has(key)) { stats.dup++; continue; }
        seenText.add(key);
        const tags = text.split(', ');
        let i = 0;
        while (i < tags.length && QUALITY.test(tags[i].trim())) i++;
        const common = tags.slice(0, i).join(', ');
        const positive = [...tags.slice(i), ...loraLines].join(', ');
        if (/\b(nsfw|explicit|nude|sex|pussy|penis|nipples|cum|fellatio|anal|vaginal|breasts out|topless|bottomless|naked)\b/i.test(text)) stats.nsfw++;
        if (loraLines.length) stats.lora++;
        if (/(^|, )@\w/.test(text)) stats.artist++;
        rows.push({ source: path.relative(ROOT, file), fields: { common, characters: [], view: '', background: '', style: '', positive, action: '' } });
        stats.kept++;
    }
}
writeFileSync(OUT, rows.map(r => JSON.stringify(r)).join('\n') + '\n');
console.log(JSON.stringify(stats));
console.log(`wrote ${rows.length} rows to ${OUT}`);
for (const r of rows.slice(0, 5)) console.log('  ', JSON.stringify(r.fields).slice(0, 260));
