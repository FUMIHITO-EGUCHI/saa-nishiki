// Writes the reviewed names SAA already shows in the character picker into the
// Japanese tag dictionary: character names from data/character_names.json
// (with the curated work title in the qualifier) and work titles from
// data/character_works.json, as loadReferenceAliases assembles them. Only
// Danbooru Character (4) and Copyright (3) rows are touched: a row whose alias
// differs from the reference is rewritten, a tag without a row is appended.
// A repeated row of the same tag survives only when it adds a different
// Japanese alias.
//
//   node scripts/syncReferenceAliases.mjs --dry-run [--report changes.jsonl]
//   node scripts/syncReferenceAliases.mjs --output data/danbooru_e621_merged_ja.csv
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  applyPinnedAliases, formatTagRows, loadBaseIndex, loadPinnedAliases, loadReferenceAliases, normalizeTagKey, parseTagRows,
} from './reviewJapaneseTags.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectDir = path.dirname(scriptDir);
const DEFAULT_INPUT = path.join(projectDir, 'data', 'danbooru_e621_merged_ja.csv');
const DEFAULT_BASE = path.join(projectDir, 'data', 'danbooru_e621_merged.csv');
const DEFAULT_GROUPS = [3, 4];
const JAPANESE_CHARACTERS = /[ぁ-んァ-ン一-龯々〆ヵヶー]/;

export function syncReferenceAliases(rows, base, references, { groups = DEFAULT_GROUPS } = {}) {
  const referenceFor = tag => {
    const info = base.get(tag);
    if (!info || !groups.includes(info.group)) return '';
    return references.get(normalizeTagKey(tag)) || '';
  };
  const changed = [];
  const dropped = [];
  const added = [];
  const seenTags = new Set();
  const result = [];
  for (const row of rows) {
    const reference = referenceFor(row.tag);
    if (!reference) { result.push(row); continue; }
    if (!seenTags.has(row.tag)) {
      seenTags.add(row.tag);
      if (row.alias !== reference) changed.push({ tag: row.tag, from: row.alias, to: reference });
      result.push(row.alias === reference ? row : { ...row, alias: reference });
      continue;
    }
    // a second row of the tag: keep a distinct Japanese alias, drop the rest
    if (row.alias === reference || !JAPANESE_CHARACTERS.test(row.alias)) dropped.push({ tag: row.tag, from: row.alias });
    else result.push(row);
  }
  const known = new Set(rows.map(row => row.tag));
  let nextId = rows.length;
  for (const tag of base.keys()) {
    if (known.has(tag)) continue;
    const reference = referenceFor(tag);
    if (!reference) continue;
    nextId += 1;
    known.add(tag);
    result.push({ i: nextId, tag, alias: reference });
    added.push({ tag, to: reference });
  }
  return { rows: result, changed, dropped, added };
}

function parseArgs(argv) {
  const args = { input: DEFAULT_INPUT, base: DEFAULT_BASE, output: '', report: '', groups: DEFAULT_GROUPS, dryRun: false, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--input') args.input = argv[++index];
    else if (arg === '--base') args.base = argv[++index];
    else if (arg === '--output') args.output = argv[++index];
    else if (arg === '--report') args.report = argv[++index];
    else if (arg === '--groups') args.groups = argv[++index].split(',').map(value => Number.parseInt(value, 10));
    else if (arg === '--dry-run') args.dryRun = true;
    else if (arg === '--help') args.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!args.groups.length || args.groups.some(group => !Number.isInteger(group) || group < 0)) {
    throw new Error('--groups must be a comma-separated list of non-negative integers');
  }
  if (!args.dryRun && !args.output) throw new Error('--output is required unless --dry-run');
  return args;
}

export function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) {
    console.log(`Sync the Japanese tag dictionary with the reviewed character names and work titles.

  node scripts/syncReferenceAliases.mjs --dry-run [--report changes.jsonl]
  node scripts/syncReferenceAliases.mjs --output <new.csv> [--report changes.jsonl] [--groups 3,4]
`);
    return;
  }
  const rows = parseTagRows(fs.readFileSync(args.input, 'utf8'));
  const base = loadBaseIndex(fs.readFileSync(args.base, 'utf8'));
  const synced = syncReferenceAliases(rows, base, loadReferenceAliases(), { groups: args.groups });
  const { changed, dropped, added } = synced;
  const result = applyPinnedAliases(synced.rows, loadPinnedAliases());
  if (args.report) {
    const lines = [
      ...changed.map(entry => ({ action: 'change', ...entry })),
      ...dropped.map(entry => ({ action: 'drop', ...entry })),
      ...added.map(entry => ({ action: 'add', ...entry })),
    ];
    fs.writeFileSync(args.report, `${lines.map(line => JSON.stringify(line)).join('\n')}\n`, 'utf8');
  }
  if (!args.dryRun) fs.writeFileSync(args.output, formatTagRows(result), 'utf8');
  console.log(JSON.stringify({
    inputRows: rows.length, changed: changed.length, dropped: dropped.length, added: added.length,
    outputRows: result.length, ...(args.dryRun ? { dryRun: true } : { output: args.output }),
  }));
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    main();
  } catch (error) {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  }
}
