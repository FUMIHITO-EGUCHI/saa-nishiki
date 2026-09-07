// Builds data/character_works.json: the Danbooru copyright ("work") tags each
// character of the character lists belongs to, plus the works' names in other
// languages, so the character picker can be searched by series (艦これ, FGO, …).
//
// Sources (all offline once downloaded):
//   danbooru_tags.csv              tag,category,count,alias     (category 3 = copyright, 4 = character)
//   danbooru_tags_cooccurrence.csv tag_a,tag_b,count            (pairs seen on >= 100 posts)
//   both from https://huggingface.co/datasets/SpadeA/danbooru-tag-csv (danbooru2025 metadata)
//   data/.cache/danbooru-wiki.jsonl  scripts/fetchDanbooruWiki.mjs output (other_names of the work tags)
//
//   node scripts/buildCharacterWorks.mjs --tags danbooru_tags.csv --pairs danbooru_tags_cooccurrence.csv
//        [--wiki data/.cache/danbooru-wiki.jsonl] [--out data/character_works.json]
//        [--min-share 0.2] [--max-works 4]
//
// A character belongs to the works it co-occurs with on at least --min-share of
// its posts (top --max-works, the most frequent one always). Characters whose
// list spelling differs from Danbooru ("2b (nier automata)" vs "2b_(nier:automata)",
// "abarai renji (bleach)" vs "abarai_renji") are matched through a normalized
// key, then through their base name; the rest fall back to the work the other
// characters with the same qualifier ("(pokemon)") belong to.
//
// Japanese titles (works[tag].ja) are not derived here: an existing value in the
// output file is kept, so a reviewed title survives a rebuild.
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectDir = path.dirname(scriptDir);
const DEFAULT_OUT = path.join(projectDir, 'data', 'character_works.json');
const DEFAULT_WIKI = path.join(projectDir, 'data', '.cache', 'danbooru-wiki.jsonl');
const COPYRIGHT = 3;
const CHARACTER = 4;

export const SOURCE_URL = 'https://huggingface.co/datasets/SpadeA/danbooru-tag-csv';

// The list form ("hatsune miku") and the Danbooru form ("hatsune_miku").
export const toDanbooru = tag => String(tag ?? '').trim().replace(/\s+/g, '_');
export const toListForm = tag => String(tag ?? '').trim().replace(/_/g, ' ');

// Spelling-insensitive key: "2b_(nier_automata)" and "2b_(nier:automata)" meet here.
export function normalizeTagKey(tag) {
  return String(tag ?? '').toLowerCase().replace(/[\s_:'".!-]/g, '');
}

// "artoria pendragon (swimsuit ruler) (fate)" -> base "artoria pendragon", qualifiers [...]
export function splitQualifiers(tag) {
  const source = String(tag ?? '').trim();
  const first = source.indexOf('(');
  const base = (first < 0 ? source : source.slice(0, first)).trim();
  const qualifiers = [...source.matchAll(/\(([^()]*)\)/g)].map(match => match[1].trim()).filter(Boolean);
  return { base, qualifiers };
}

export function parseTagsCsv(text) {
  const info = new Map();
  for (const line of String(text).split('\n').slice(1)) {
    const match = /^([^,]+),(\d+),(\d+)/.exec(line);
    if (match) info.set(match[1], { category: Number(match[2]), count: Number(match[3]) });
  }
  return info;
}

// Every character named by the character lists and the Japanese name table.
export function readCharacterTags(dataDir) {
  const tags = new Set();
  for (const file of fs.readdirSync(dataDir).filter(name => name.endsWith('_characters.csv'))) {
    for (const line of fs.readFileSync(path.join(dataDir, file), 'utf8').replace(/^﻿/, '').split(/\r?\n/)) {
      const comma = line.indexOf(',');
      if (comma > 0) tags.add(line.slice(comma + 1).trim());
    }
  }
  const namesPath = path.join(dataDir, 'character_names.json');
  if (fs.existsSync(namesPath)) {
    for (const tag of Object.keys(JSON.parse(fs.readFileSync(namesPath, 'utf8'))['ja-JP'] ?? {})) tags.add(tag);
  }
  tags.delete('');
  return [...tags].sort();
}

export function buildCharacterIndex(tagInfo) {
  const exact = new Set();
  const normalized = new Map();
  const bases = new Map();
  for (const [tag, { category, count }] of tagInfo) {
    if (category !== CHARACTER) continue;
    exact.add(tag);
    const key = normalizeTagKey(tag);
    if (!normalized.has(key) || count > tagInfo.get(normalized.get(key)).count) normalized.set(key, tag);
    const base = normalizeTagKey(splitQualifiers(tag).base);
    if (base) bases.set(base, bases.has(base) ? null : tag);
  }
  return { exact, normalized, bases };
}

// The Danbooru character tag a list entry stands for, or null.
export function resolveCharacterTag(listTag, index) {
  const tag = toDanbooru(listTag);
  if (index.exact.has(tag)) return tag;
  const byKey = index.normalized.get(normalizeTagKey(tag));
  if (byKey) return byKey;
  const { base, qualifiers } = splitQualifiers(tag);
  if (qualifiers.length === 0) return null;
  return index.bases.get(normalizeTagKey(base)) ?? null;
}

// Copyright partners of the resolved characters, from the co-occurrence dump.
export async function collectWorkPairs(pairsPath, characters, tagInfo) {
  const pairs = new Map();
  const add = (character, work, count) => {
    if (!pairs.has(character)) pairs.set(character, []);
    pairs.get(character).push({ work, count });
  };
  const reader = readline.createInterface({ input: fs.createReadStream(pairsPath) });
  let first = true;
  for await (const line of reader) {
    if (first) { first = false; continue; }
    const comma = line.indexOf(',');
    const last = line.lastIndexOf(',');
    if (comma < 0 || last <= comma) continue;
    const a = line.slice(0, comma);
    const b = line.slice(comma + 1, last);
    const count = Number(line.slice(last + 1));
    if (characters.has(a) && tagInfo.get(b)?.category === COPYRIGHT) add(a, b, count);
    else if (characters.has(b) && tagInfo.get(a)?.category === COPYRIGHT) add(b, a, count);
  }
  return pairs;
}

export function chooseWorks(pairList, characterCount, { minShare = 0.2, maxWorks = 4 } = {}) {
  const sorted = [...(pairList ?? [])].sort((left, right) => right.count - left.count);
  if (sorted.length === 0) return [];
  const total = characterCount > 0 ? characterCount : sorted[0].count;
  return sorted
    .filter((entry, position) => position === 0 || entry.count / total >= minShare)
    .slice(0, maxWorks)
    .map(entry => entry.work);
}

// "(pokemon)" -> ["pokemon"]: the works most of the resolved characters carrying
// that qualifier belong to (every work named by at least half as many of them
// as the top one, two at most); used for characters the dump does not know.
export function qualifierWorkMap(assignments) {
  const votes = new Map();
  for (const [listTag, works] of assignments) {
    const qualifier = normalizeTagKey(splitQualifiers(listTag).qualifiers.at(-1) ?? '');
    if (!qualifier || works.length === 0) continue;
    if (!votes.has(qualifier)) votes.set(qualifier, new Map());
    const tally = votes.get(qualifier);
    for (const work of works) tally.set(work, (tally.get(work) ?? 0) + 1);
  }
  const map = new Map();
  for (const [qualifier, tally] of votes) {
    const ranked = [...tally].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]));
    const top = ranked[0][1];
    map.set(qualifier, ranked.filter(([, count]) => count * 2 >= top).slice(0, 2).map(([work]) => work));
  }
  return map;
}

export function parseWikiCache(text) {
  const works = new Map();
  for (const line of String(text ?? '').split('\n')) {
    if (!line.trim()) continue;
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    if (!entry?.found || entry.category !== COPYRIGHT || !entry.name) continue;
    const names = Array.isArray(entry.wiki?.otherNames)
      ? entry.wiki.otherNames.filter(name => typeof name === 'string' && name.trim())
      : [];
    works.set(entry.name, names);
  }
  return works;
}

export function buildWorksTable(workTags, wikiNames, previous = {}) {
  const table = {};
  for (const tag of [...workTags].sort()) {
    const key = toListForm(tag);
    const aliases = [...new Set(wikiNames.get(tag) ?? previous[key]?.aliases ?? [])];
    const entry = { en: key };
    if (typeof previous[key]?.ja === 'string' && previous[key].ja.trim()) entry.ja = previous[key].ja.trim();
    if (aliases.length) entry.aliases = aliases;
    table[key] = entry;
  }
  return table;
}

export async function buildCharacterWorks({ dataDir, tagsPath, pairsPath, wikiPath, previous = {}, minShare, maxWorks }) {
  const tagInfo = parseTagsCsv(fs.readFileSync(tagsPath, 'utf8'));
  const listTags = readCharacterTags(dataDir);
  const index = buildCharacterIndex(tagInfo);
  const resolved = new Map();
  for (const listTag of listTags) {
    const tag = resolveCharacterTag(listTag, index);
    if (tag) resolved.set(listTag, tag);
  }
  const pairs = await collectWorkPairs(pairsPath, new Set(resolved.values()), tagInfo);
  const assignments = new Map();
  for (const [listTag, tag] of resolved) {
    const works = chooseWorks(pairs.get(tag), tagInfo.get(tag)?.count ?? 0, { minShare, maxWorks });
    if (works.length) assignments.set(listTag, works);
  }
  const byQualifier = qualifierWorkMap(assignments);
  let fallbacks = 0;
  for (const listTag of listTags) {
    if (assignments.has(listTag)) continue;
    const qualifier = normalizeTagKey(splitQualifiers(listTag).qualifiers.at(-1) ?? '');
    const works = qualifier ? byQualifier.get(qualifier) : null;
    if (works?.length) {
      assignments.set(listTag, works);
      fallbacks += 1;
    }
  }
  const workTags = new Set([...assignments.values()].flat());
  const wikiNames = wikiPath && fs.existsSync(wikiPath) ? parseWikiCache(fs.readFileSync(wikiPath, 'utf8')) : new Map();
  const characters = Object.fromEntries([...assignments]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([listTag, works]) => [listTag, works.map(toListForm)]));
  return {
    output: {
      schemaVersion: 1,
      source: `${SOURCE_URL} (danbooru_tags_cooccurrence.csv, danbooru_tags.csv), Danbooru wiki other_names`,
      characters,
      works: buildWorksTable(workTags, wikiNames, previous.works ?? {}),
    },
    stats: {
      listTags: listTags.length,
      resolved: resolved.size,
      assigned: assignments.size,
      fallbacks,
      unassigned: listTags.filter(tag => !assignments.has(tag)),
      works: workTags.size,
      worksWithNames: [...workTags].filter(tag => wikiNames.has(tag)).length,
    },
  };
}

function parseArgs(argv) {
  const args = { tags: '', pairs: '', wiki: DEFAULT_WIKI, out: DEFAULT_OUT, minShare: 0.2, maxWorks: 4 };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--tags') args.tags = argv[++index];
    else if (arg === '--pairs') args.pairs = argv[++index];
    else if (arg === '--wiki') args.wiki = argv[++index];
    else if (arg === '--out') args.out = argv[++index];
    else if (arg === '--min-share') args.minShare = Number(argv[++index]);
    else if (arg === '--max-works') args.maxWorks = Number.parseInt(argv[++index], 10);
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!args.tags || !args.pairs) throw new Error('--tags and --pairs are required');
  if (!(args.minShare >= 0 && args.minShare <= 1)) throw new Error('--min-share must be between 0 and 1');
  if (!(args.maxWorks >= 1)) throw new Error('--max-works must be at least 1');
  return args;
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const previous = fs.existsSync(args.out) ? JSON.parse(fs.readFileSync(args.out, 'utf8')) : {};
  const { output, stats } = await buildCharacterWorks({
    dataDir: path.join(projectDir, 'data'),
    tagsPath: args.tags,
    pairsPath: args.pairs,
    wikiPath: args.wiki,
    previous,
    minShare: args.minShare,
    maxWorks: args.maxWorks,
  });
  fs.writeFileSync(args.out, `${JSON.stringify(output, null, 1)}\n`, 'utf8');
  console.log(JSON.stringify({ ...stats, unassigned: stats.unassigned.length, sample: stats.unassigned.slice(0, 30), out: args.out }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(error.message);
    process.exit(1);
  });
}
