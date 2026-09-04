// Builds data/tag_related.txt (offline "related tags" dictionary) from the Danbooru
// co-occurrence dump published at https://huggingface.co/datasets/SpadeA/danbooru-tag-csv
// (MIT; derived from danbooru2025-metadata). Not run at app start — rerun when the
// source changes:
//
//   node scripts/buildTagRelated.mjs <danbooru_tags.csv> <danbooru_tags_cooccurrence.csv> [out]
//
// For every tag the top `TOP_N` neighbours by normalized PMI are kept. Plain Jaccard
// (what ComfyUI-Autocomplete-Plus shows) ranks the mega tags first for everything —
// long_hair → 1girl, solo, breasts — while NPMI rewards the pairs that are specific to
// each other: long_hair → very_long_hair, absurdly_long_hair, hair_between_eyes. Only
// general tags (category 0) are offered as neighbours, so a character / copyright tag
// still gets its typical traits but a general tag never suggests a character.
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { formatRelatedLine, npmi, trimTop, RELATED_SCORE_SCALE } from './shared/tagRelated.js';

const TOP_N = 20;
const KEEP_WHILE_STREAMING = TOP_N * 3;
const MIN_TAG_COUNT = 50;
// Post count behind the co-occurrence dump (danbooru2025-metadata). Only the scale of
// the probabilities depends on it; the ranking is insensitive to ±20 %.
const TOTAL_POSTS = 9_300_000;
// A neighbour must share at least this many posts so that NPMI cannot be won by a
// pair that happens to be rare on both sides.
const MIN_PAIR_COUNT = 200;

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const [tagsPath, pairsPath, outPath = path.join(scriptDir, '..', 'data', 'tag_related.txt')] = process.argv.slice(2);
if (!tagsPath || !pairsPath) {
    console.error('usage: node scripts/buildTagRelated.mjs <danbooru_tags.csv> <danbooru_tags_cooccurrence.csv> [out]');
    process.exit(1);
}

// tag,category,count,alias  (alias is quoted and may contain commas)
function parseTagLine(line) {
    const first = line.indexOf(',');
    const second = line.indexOf(',', first + 1);
    const third = line.indexOf(',', second + 1);
    if (first < 0 || second < 0) return null;
    const tag = line.slice(0, first).trim();
    const category = Number.parseInt(line.slice(first + 1, second), 10);
    const count = Number.parseInt(third < 0 ? line.slice(second + 1) : line.slice(second + 1, third), 10);
    if (!tag || !Number.isFinite(category) || !Number.isFinite(count)) return null;
    return { tag, category, count };
}

async function main() {
    const tags = new Map();
    const tagReader = readline.createInterface({ input: fs.createReadStream(tagsPath, 'utf8'), crlfDelay: Infinity });
    let header = true;
    for await (const line of tagReader) {
        if (header) { header = false; continue; }
        const parsed = parseTagLine(line);
        if (parsed && parsed.count >= MIN_TAG_COUNT) tags.set(parsed.tag, parsed);
    }
    console.log(`[buildTagRelated] ${tags.size} tags with count >= ${MIN_TAG_COUNT}`);

    const neighbours = new Map();
    const add = (from, to, score) => {
        let list = neighbours.get(from);
        if (!list) { list = []; neighbours.set(from, list); }
        list.push({ tag: to, score });
        if (list.length > KEEP_WHILE_STREAMING) trimTop(list, TOP_N);
    };

    const pairReader = readline.createInterface({ input: fs.createReadStream(pairsPath, 'utf8'), crlfDelay: Infinity });
    header = true;
    let pairs = 0;
    for await (const line of pairReader) {
        if (header) { header = false; continue; }
        const [a, b, countText] = line.split(',');
        const tagA = tags.get(a?.trim());
        const tagB = tags.get(b?.trim());
        const both = Number.parseFloat(countText);
        if (!tagA || !tagB || !Number.isFinite(both) || both < MIN_PAIR_COUNT) continue;
        pairs += 1;
        const score = npmi(tagA.count, tagB.count, both, TOTAL_POSTS) * RELATED_SCORE_SCALE;
        if (score < 1) continue;
        if (tagB.category === 0) add(tagA.tag, tagB.tag, score);
        if (tagA.category === 0) add(tagB.tag, tagA.tag, score);
    }
    console.log(`[buildTagRelated] ${pairs} pairs read, ${neighbours.size} tags with neighbours`);

    const lines = [];
    for (const tag of [...neighbours.keys()].sort()) {
        const list = trimTop(neighbours.get(tag), TOP_N);
        list.sort((x, y) => y.score - x.score);
        lines.push(formatRelatedLine(tag, list));
    }
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, `${lines.join('\n')}\n`, 'utf8');
    const size = fs.statSync(outPath).size;
    console.log(`[buildTagRelated] wrote ${lines.length} lines, ${(size / 1024 / 1024).toFixed(1)} MB → ${outPath}`);
}

main().catch(error => {
    console.error('[buildTagRelated] failed:', error);
    process.exit(1);
});
