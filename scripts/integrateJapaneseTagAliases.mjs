import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { formatTagRows, parseTagRows } from './reviewJapaneseTags.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectDir = path.dirname(scriptDir);
const DEFAULT_INPUT = path.join(projectDir, 'data', 'danbooru_e621_merged_ja.csv');
const JAPANESE_CHARACTERS = /[ぁ-んァ-ン一-龯々〆ヵヶー]/;

function parseCsvFields(line) {
  const fields = [];
  let field = '';
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (character === '"') {
      if (quoted && line[index + 1] === '"') {
        field += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (character === ',' && !quoted) {
      fields.push(field);
      field = '';
    } else {
      field += character;
    }
  }
  if (quoted) throw new Error(`Unclosed quoted CSV field: ${line}`);
  fields.push(field);
  return fields;
}

export function normalizeTagKey(value) {
  return String(value).replace(/_/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
}

export function parseBaseTagRows(csvText) {
  return String(csvText)
    .split(/\r?\n/)
    .filter(line => line.trim() !== '')
    .map((line, index) => {
      const fields = parseCsvFields(line);
      const tag = fields[0]?.trim();
      const group = Number.parseInt(fields[1]?.trim(), 10);
      if (!tag || !Number.isInteger(group)) {
        throw new Error(`Invalid base tag row at line ${index + 1}: ${line}`);
      }
      return { tag, group };
    });
}

function containsJapanese(value) {
  return JAPANESE_CHARACTERS.test(String(value ?? ''));
}

function splitAliases(value) {
  return String(value ?? '')
    .split(',')
    .map(alias => alias.trim())
    .filter(Boolean);
}

function appendAliases(row, aliases) {
  const existingAliases = splitAliases(row.alias);
  const known = new Set(existingAliases);
  const additions = aliases.filter(alias => !known.has(alias));
  if (!additions.length) return false;
  row.alias = [...existingAliases, ...additions].join(',');
  return true;
}

export function mergeGeneralJapaneseAliases({ baseText, existingText = '', sourceText }) {
  const baseByKey = new Map(
    parseBaseTagRows(baseText).map(row => [normalizeTagKey(row.tag), row]),
  );
  const rows = [];
  const rowsByKey = new Map();

  for (const row of parseTagRows(existingText)) {
    const key = normalizeTagKey(row.tag);
    const existing = rowsByKey.get(key);
    if (existing) {
      appendAliases(existing, splitAliases(row.alias));
      continue;
    }
    const preserved = { tag: row.tag, alias: row.alias };
    rows.push(preserved);
    rowsByKey.set(key, preserved);
  }

  const stats = {
    sourceRows: 0,
    matchedBaseRows: 0,
    eligibleGeneralRows: 0,
    addedRows: 0,
    mergedAliasRows: 0,
    skippedNonGeneralRows: 0,
    skippedUnlistedRows: 0,
    skippedNonJapaneseRows: 0,
  };

  for (const sourceRow of parseTagRows(sourceText)) {
    stats.sourceRows += 1;
    const baseRow = baseByKey.get(normalizeTagKey(sourceRow.tag));
    if (!baseRow) {
      stats.skippedUnlistedRows += 1;
      continue;
    }
    stats.matchedBaseRows += 1;
    if (baseRow.group !== 0) {
      stats.skippedNonGeneralRows += 1;
      continue;
    }
    if (!containsJapanese(sourceRow.alias)) {
      stats.skippedNonJapaneseRows += 1;
      continue;
    }
    stats.eligibleGeneralRows += 1;

    const key = normalizeTagKey(baseRow.tag);
    const existing = rowsByKey.get(key);
    if (existing) {
      if (appendAliases(existing, splitAliases(sourceRow.alias))) stats.mergedAliasRows += 1;
      continue;
    }
    const added = { tag: baseRow.tag, alias: sourceRow.alias };
    rows.push(added);
    rowsByKey.set(key, added);
    stats.addedRows += 1;
  }

  return { rows, stats };
}

function parseArgs(argv) {
  const args = { base: '', source: '', input: DEFAULT_INPUT, output: '', help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--base') args.base = argv[++index];
    else if (arg === '--source') args.source = argv[++index];
    else if (arg === '--input') args.input = argv[++index];
    else if (arg === '--output') args.output = argv[++index];
    else if (arg === '--help') args.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return args;
}

function printHelp() {
  console.log(`Build a Japanese tag candidate file for Danbooru General only.

  node scripts/integrateJapaneseTagAliases.mjs \\
    --base data/danbooru_e621_merged.csv \\
    --source <danbooru-jp.csv> \\
    --output <candidate.csv>

The source is never merged for Artist, Copyright, Character, or e621 groups.
The output is a candidate file and must pass the Japanese review workflow before
replacing the bundled translation file.
`);
}

export function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) return printHelp();
  if (!args.base || !args.source || !args.output) {
    throw new Error('Use --base, --source, and --output (or --help)');
  }

  const result = mergeGeneralJapaneseAliases({
    baseText: fs.readFileSync(args.base, 'utf8'),
    existingText: fs.readFileSync(args.input, 'utf8'),
    sourceText: fs.readFileSync(args.source, 'utf8'),
  });
  fs.writeFileSync(args.output, formatTagRows(result.rows), 'utf8');
  console.log(JSON.stringify({ ...result.stats, output: args.output }, null, 2));
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    main();
  } catch (error) {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  }
}
