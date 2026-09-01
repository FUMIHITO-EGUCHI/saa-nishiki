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

function containsKana(value) {
  return /[ぁ-んァ-ン]/.test(String(value ?? ''));
}

export function splitJapaneseReviewCandidates(rows) {
  return {
    kanaRows: rows.filter(row => containsKana(row.alias)),
    kanjiOnlyRows: rows.filter(row => !containsKana(row.alias) && JAPANESE_CHARACTERS.test(row.alias)),
  };
}

function appendAlias(row, alias) {
  const incoming = String(alias ?? '').trim();
  if (!incoming) return false;
  const existingText = String(row.alias ?? '').trim();
  const existingAliases = existingText.split(',').map(value => value.trim());
  if (existingText === incoming || existingAliases.includes(incoming)) return false;
  row.alias = existingText ? `${existingText},${incoming}` : incoming;
  return true;
}

export function mergeGeneralJapaneseAliases({ baseText, existingText = '', sourceText }) {
  const baseByKey = new Map(
    parseBaseTagRows(baseText).map(row => [normalizeTagKey(row.tag), row]),
  );
  const rows = [];
  const candidateRows = [];
  const rowsByKey = new Map();

  for (const row of parseTagRows(existingText)) {
    const key = normalizeTagKey(row.tag);
    const preserved = { tag: row.tag, alias: row.alias };
    rows.push(preserved);
    if (!rowsByKey.has(key)) rowsByKey.set(key, preserved);
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
      if (appendAlias(existing, sourceRow.alias)) stats.mergedAliasRows += 1;
      continue;
    }
    const added = { tag: baseRow.tag, alias: sourceRow.alias };
    rows.push(added);
    candidateRows.push({ ...added });
    rowsByKey.set(key, added);
    stats.addedRows += 1;
  }

  return { rows, candidateRows, stats };
}

function parseArgs(argv) {
  const args = {
    base: '', source: '', input: DEFAULT_INPUT, output: '', candidatesOutput: '', kanaOutput: '', kanjiOnlyOutput: '', help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--base') args.base = argv[++index];
    else if (arg === '--source') args.source = argv[++index];
    else if (arg === '--input') args.input = argv[++index];
    else if (arg === '--output') args.output = argv[++index];
    else if (arg === '--candidates-output') args.candidatesOutput = argv[++index];
    else if (arg === '--kana-output') args.kanaOutput = argv[++index];
    else if (arg === '--kanji-only-output') args.kanjiOnlyOutput = argv[++index];
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
    --output <merged-candidate.csv> \\
    --candidates-output <new-general.csv> \\
    --kana-output <kana-review.csv> \\
    --kanji-only-output <manual-review.csv>

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
  const reviewCandidates = splitJapaneseReviewCandidates(result.candidateRows);
  if (args.candidatesOutput) {
    fs.writeFileSync(args.candidatesOutput, formatTagRows(result.candidateRows), 'utf8');
  }
  if (args.kanaOutput) fs.writeFileSync(args.kanaOutput, formatTagRows(reviewCandidates.kanaRows), 'utf8');
  if (args.kanjiOnlyOutput) fs.writeFileSync(args.kanjiOnlyOutput, formatTagRows(reviewCandidates.kanjiOnlyRows), 'utf8');
  console.log(JSON.stringify({
    ...result.stats,
    kanaReviewRows: reviewCandidates.kanaRows.length,
    kanjiOnlyReviewRows: reviewCandidates.kanjiOnlyRows.length,
    output: args.output,
    candidatesOutput: args.candidatesOutput || null,
    kanaOutput: args.kanaOutput || null,
    kanjiOnlyOutput: args.kanjiOnlyOutput || null,
  }, null, 2));
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    main();
  } catch (error) {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  }
}
