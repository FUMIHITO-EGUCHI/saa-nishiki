// LLM review of the Japanese names shown in the character picker:
//   --stage works       Japanese titles of the works in data/character_works.json
//   --stage characters  Japanese character names in data/character_names.json
//
// Evidence comes from the Danbooru wiki cache (scripts/fetchDanbooruWiki.mjs:
// other_names carry the Japanese spellings), the character's works and, for a
// work, the hand-written data/official_work_names.json. Same backends and
// batching as the tag review (scripts/llmBatchBackend.mjs: Codex first).
//
//   node scripts/reviewCharacterNames.mjs --stage works --report works.jsonl [--recheck]
//   node scripts/reviewCharacterNames.mjs --stage works --apply works.jsonl [--min-confidence medium]
//   node scripts/reviewCharacterNames.mjs --stage characters --report names.jsonl [--select all|missing|nowork]
//   node scripts/reviewCharacterNames.mjs --stage characters --apply names.jsonl [--min-confidence high]
//
// --apply only writes rows at or above --min-confidence (default high); a
// "keep" never changes anything. The report is JSON lines, one line per batch.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  backendArgDefaults, backendHelpText, createBatchClient, planLanes, takeBackendArg, validateBackendArgs,
} from './llmBatchBackend.mjs';
import { readCharacterTags, splitQualifiers, toDanbooru } from './buildCharacterWorks.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectDir = path.dirname(scriptDir);
const DEFAULT_WORKS = path.join(projectDir, 'data', 'character_works.json');
const DEFAULT_NAMES = path.join(projectDir, 'data', 'character_names.json');
const DEFAULT_OFFICIAL = path.join(projectDir, 'data', 'official_work_names.json');
const DEFAULT_WIKI = path.join(projectDir, 'data', '.cache', 'danbooru-wiki.jsonl');
const JAPANESE = 'ja-JP';
const CONFIDENCES = ['high', 'medium', 'low'];
const STAGES = ['works', 'characters', 'verify'];
const SELECTIONS = ['all', 'missing', 'nowork'];
const MAX_OTHER_NAMES = 12;
const JAPANESE_SCRIPT = /[぀-ヿ一-鿿]/;

const WORK_RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    rows: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          i: { type: 'integer' },
          ja: { type: 'string' },
          confidence: { type: 'string', enum: CONFIDENCES },
        },
        required: ['i', 'ja', 'confidence'],
        additionalProperties: false,
      },
    },
  },
  required: ['rows'],
  additionalProperties: false,
};

const CHARACTER_RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    rows: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          i: { type: 'integer' },
          action: { type: 'string', enum: ['keep', 'change'] },
          confidence: { type: 'string', enum: CONFIDENCES },
          name: { type: 'string' },
        },
        required: ['i', 'action', 'confidence', 'name'],
        additionalProperties: false,
      },
    },
  },
  required: ['rows'],
  additionalProperties: false,
};

export const WORK_SYSTEM_PROMPT = `You name copyrights (series, games, anime, manga, franchises) from the Danbooru image board for the Japanese UI of an illustration app.

For every row give "ja": the title as it is officially used in Japan.
- Japanese works: the official Japanese title, without taglines, subtitles or the "-艦これ-" style repetition. "kantai collection" -> 艦隊これくしょん, "idolmaster cinderella girls" -> アイドルマスター シンデレラガールズ, "sousou no frieren" -> 葬送のフリーレン, "touhou" -> 東方Project.
- Titles that are officially written in Latin letters in Japan stay so: "fate/grand order" -> Fate/Grand Order, "nier:automata" -> NieR:Automata, "vocaloid" -> VOCALOID, "spy x family" -> SPY×FAMILY.
- Foreign works with an official Japanese release use that Japanese title: "the legend of zelda" -> ゼルダの伝説, "league of legends" -> リーグ・オブ・レジェンド, "genshin impact" -> 原神, "honkai: star rail" -> 崩壊：スターレイル. Without an official Japanese title keep the original title as written in Japan.
- "(series)" tags name the whole franchise: "fate (series)" -> Fate, "honkai (series)" -> 崩壊, "persona (series)" -> ペルソナ, "the legend of zelda (series)" -> ゼルダの伝説.
- Evidence: "aliases" are Danbooru other_names (Japanese, Chinese, Korean and Pixiv spellings, in no order — pick the Japanese one, never a Chinese or Korean one), "hint" is a previously curated Japanese title for the same work when one exists. Do not invent titles.
- "confidence": high when the title is established and matches the evidence, medium when it is plausible but unverified, low when unsure (then "ja" may be an empty string).

Return exactly one JSON row per input row, same "i", nothing else.`;

export const CHARACTER_SYSTEM_PROMPT = `You review the Japanese display names of Danbooru character tags for the Japanese UI of an illustration app. Each row has the tag, the current Japanese name, the works the character belongs to and the Danbooru other_names.

Format of a name: 名前（限定子）（作品）
- The name in its official Japanese spelling: Japanese names in kanji/kana as the work writes them, family name first without a space (初音ミク, 博麗霊夢, 阿散井恋次); foreign names in the official Japanese katakana with "・" between parts (アルトリア・ペンドラゴン, アビゲイル・ウィリアムズ); names officially written in Latin letters or digits stay so (2B, 9S, A2, KOS-MOS).
- Every "(qualifier)" of the tag except the work becomes a fullwidth （）part in the same order, translated the way the work does: kai ni -> 改二, kai san -> 改三, swimsuit -> 水着, school uniform -> 制服, first/second/third ascension -> 第1再臨/第2再臨/第3再臨, festival outfit -> 祭装, female -> 女性, male -> 男性, young -> 幼少期, hunt -> 巡狩, archer install -> アーチャー・インストール. Keep Fate class names as the game writes them: swimsuit ruler -> 水着ルーラー.
- The work: when the tag ends with a work qualifier, append the work's Japanese title given in "works" as the last （）part; when the tag has no work qualifier, append nothing. "abe nana" -> 安部菜々, "2b (nier automata)" -> 2B（NieR:Automata）, "kaga (kancolle)" -> 加賀（艦隊これくしょん）, "kaga kai ni (kancolle)" -> 加賀（改二）（艦隊これくしょん）.
- Evidence: "otherNames" are Danbooru other_names in no order and mixed scripts. Prefer the Japanese entry (博麗霊夢) over Chinese (博丽灵梦 / 博麗靈夢) or Korean ones. Do not transliterate by yourself when an official Japanese spelling exists in the evidence; do not invent names.
- Keep the current name when it is already correct and well formed ("keep"). Change it when the spelling, the order, the qualifier translation or the work title is wrong, machine translated, or the name is missing ("change" with the full name).
- "confidence": high when the name is established by the evidence or common knowledge, medium when plausible but unverified, low when unsure (then use "keep").

Return exactly one JSON row per input row, same "i", nothing else.`;

function readJson(file, fallback = {}) {
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : fallback;
}

function normalizeKey(value) {
  return String(value ?? '').replace(/_/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
}

// Wiki cache rows indexed by their normalized tag (the cache stores "hakurei reimu").
export function loadWikiOtherNames(wikiPath = DEFAULT_WIKI) {
  const names = new Map();
  if (!fs.existsSync(wikiPath)) return names;
  for (const line of fs.readFileSync(wikiPath, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    if (!entry?.found) continue;
    const otherNames = Array.isArray(entry.wiki?.otherNames)
      ? entry.wiki.otherNames.filter(name => typeof name === 'string' && name.trim()).slice(0, MAX_OTHER_NAMES)
      : [];
    for (const key of [entry.normalizedTag, entry.requestedTag, entry.name]) {
      if (key) names.set(normalizeKey(key), otherNames);
    }
  }
  return names;
}

// official_work_names.json is keyed by the tag qualifier ("kancolle"); a work
// tag matches it directly, through its "(series)"-less form, or through the
// qualifier its characters carry.
export function officialTitleFor(work, officialWorkNames, qualifiers = []) {
  const candidates = [work, work.replace(/\s*\(series\)$/, ''), ...qualifiers].map(normalizeKey);
  for (const candidate of candidates) {
    const title = officialWorkNames?.[candidate];
    if (typeof title === 'string' && title.trim()) return title.trim();
  }
  return '';
}

export function buildWorkRows(worksFile, officialWorkNames, { recheck = false } = {}) {
  const qualifiersByWork = new Map();
  for (const [tag, works] of Object.entries(worksFile.characters ?? {})) {
    const qualifier = splitQualifiers(tag).qualifiers.at(-1);
    if (!qualifier) continue;
    for (const work of works) {
      if (!qualifiersByWork.has(work)) qualifiersByWork.set(work, new Map());
      const tally = qualifiersByWork.get(work);
      tally.set(qualifier, (tally.get(qualifier) ?? 0) + 1);
    }
  }
  const rows = [];
  for (const [work, entry] of Object.entries(worksFile.works ?? {})) {
    if (!recheck && typeof entry?.ja === 'string' && entry.ja.trim()) continue;
    const qualifiers = [...(qualifiersByWork.get(work) ?? [])].sort((left, right) => right[1] - left[1]).map(([name]) => name).slice(0, 3);
    rows.push({
      i: rows.length + 1,
      tag: work,
      current: typeof entry?.ja === 'string' ? entry.ja : '',
      aliases: Array.isArray(entry?.aliases) ? entry.aliases.slice(0, MAX_OTHER_NAMES) : [],
      hint: officialTitleFor(work, officialWorkNames, qualifiers),
    });
  }
  return rows;
}

export function buildWorkPrompt(rows) {
  return `Give the Japanese title of exactly ${rows.length} works. Return exactly ${rows.length} JSON rows with these input ids: ${rows.map(row => row.i).join(', ')}.\n${JSON.stringify(rows.map(({ i, tag, current, aliases, hint }) => ({ i, tag, current, aliases, hint })))}`;
}

export function validateWorkRows(inputRows, outputRows) {
  if (outputRows.length !== inputRows.length) throw new Error(`LLM returned ${outputRows.length} rows for ${inputRows.length} inputs`);
  const inputById = new Map(inputRows.map(row => [row.i, row]));
  const seen = new Set();
  return outputRows.map((row, index) => {
    const input = inputById.get(row?.i);
    if (!input || seen.has(row.i)) throw new Error(`Invalid or duplicate index at response row ${index + 1}`);
    seen.add(row.i);
    if (!CONFIDENCES.includes(row.confidence)) throw new Error(`Invalid confidence for ${input.tag}: ${row.confidence}`);
    if (typeof row.ja !== 'string' || /[\r\n]/.test(row.ja) || row.ja.length > 80) throw new Error(`Invalid title for ${input.tag}`);
    const ja = row.ja.trim();
    return { i: input.i, tag: input.tag, current: input.current, ja, confidence: ja ? row.confidence : 'low' };
  });
}

export function applyWorkTitles(worksFile, reportRows, { minConfidence = 'high' } = {}) {
  const accepted = CONFIDENCES.slice(0, CONFIDENCES.indexOf(minConfidence) + 1);
  let changed = 0;
  for (const row of reportRows) {
    const entry = worksFile.works?.[row.tag];
    if (!entry || !row.ja || !accepted.includes(row.confidence) || entry.ja === row.ja) continue;
    entry.ja = row.ja;
    changed += 1;
  }
  return changed;
}

function isSuspiciousName(tag, name) {
  if (typeof name !== 'string' || !name.trim()) return true;
  if (!JAPANESE_SCRIPT.test(name) && !/^[A-Za-z0-9]/.test(name)) return true;
  // an untranslated "(qualifier)" copied from the tag
  return /\([a-z][^()]*\)/.test(name) && !/\([a-z][^()]*\)/.test(tag);
}

export function buildCharacterRows({ tags, names, worksFile, wikiNames, select = 'all' }) {
  const rows = [];
  for (const tag of tags) {
    const current = typeof names[tag] === 'string' ? names[tag] : '';
    const works = (worksFile.characters?.[tag] ?? []).map(work => worksFile.works?.[work]?.ja || work);
    if (select === 'missing' && current && !isSuspiciousName(tag, current)) continue;
    if (select === 'nowork' && works.length) continue;
    const otherNames = wikiNames.get(normalizeKey(tag)) ?? wikiNames.get(normalizeKey(toDanbooru(tag))) ?? [];
    rows.push({ i: rows.length + 1, tag, current, works, otherNames });
  }
  return rows;
}

export function buildCharacterPrompt(rows) {
  return `Review exactly ${rows.length} Japanese character names. Return exactly ${rows.length} JSON rows with these input ids: ${rows.map(row => row.i).join(', ')}.\n${JSON.stringify(rows.map(({ i, tag, current, works, otherNames }) => ({ i, tag, current, works, otherNames })))}`;
}

export function validateCharacterRows(inputRows, outputRows) {
  if (outputRows.length !== inputRows.length) throw new Error(`LLM returned ${outputRows.length} rows for ${inputRows.length} inputs`);
  const inputById = new Map(inputRows.map(row => [row.i, row]));
  const seen = new Set();
  return outputRows.map((row, index) => {
    const input = inputById.get(row?.i);
    if (!input || seen.has(row.i)) throw new Error(`Invalid or duplicate index at response row ${index + 1}`);
    seen.add(row.i);
    if (!['keep', 'change'].includes(row.action)) throw new Error(`Invalid action for ${input.tag}: ${row.action}`);
    if (!CONFIDENCES.includes(row.confidence)) throw new Error(`Invalid confidence for ${input.tag}: ${row.confidence}`);
    if (typeof row.name !== 'string' || /[\r\n,]/.test(row.name) || row.name.length > 120) throw new Error(`Invalid name for ${input.tag}`);
    const name = row.name.trim().replace(/\(/g, '（').replace(/\)/g, '）');
    // a change without a name, or to the same name, is a keep
    const action = row.action === 'change' && name && name !== input.current ? 'change' : 'keep';
    return {
      i: input.i,
      tag: input.tag,
      current: input.current,
      action,
      confidence: action === 'keep' && row.action === 'change' ? 'low' : row.confidence,
      name: action === 'change' ? name : input.current,
    };
  });
}

// A reviewed name, cleaned: no zero-width characters, and no （...） parts when
// the tag carries no qualifier (the work is only shown when the tag names it).
export function cleanCharacterName(tag, name) {
  let text = String(name ?? '').replace(/[​-‍﻿]/g, '').trim();
  if (!String(tag).includes('(')) text = text.replace(/（[^（）]*）/g, '').trim();
  return text;
}

export function applyCharacterNames(names, reportRows, { minConfidence = 'high' } = {}) {
  const accepted = CONFIDENCES.slice(0, CONFIDENCES.indexOf(minConfidence) + 1);
  let changed = 0;
  for (const row of reportRows) {
    if (row.action !== 'change' || !accepted.includes(row.confidence)) continue;
    const name = cleanCharacterName(row.tag, row.name);
    if (!name || names[row.tag] === name) continue;
    names[row.tag] = name;
    changed += 1;
  }
  return changed;
}

// official_work_names.json (qualifier -> title, read at runtime by
// characterLocalization) follows the reviewed titles: every qualifier whose
// characters mostly (over half) belong to one reviewed work takes that work's title.
export function syncOfficialWorkNames(officialWorkNames, worksFile, { minCharacters = 3 } = {}) {
  const tally = new Map();
  for (const [tag, works] of Object.entries(worksFile.characters ?? {})) {
    const qualifier = normalizeKey(splitQualifiers(tag).qualifiers.at(-1) ?? '');
    if (!qualifier || !works.length) continue;
    if (!tally.has(qualifier)) tally.set(qualifier, new Map());
    const counts = tally.get(qualifier);
    counts.set(works[0], (counts.get(works[0]) ?? 0) + 1);
  }
  let changed = 0;
  for (const [qualifier, counts] of tally) {
    const ranked = [...counts].sort((left, right) => right[1] - left[1]);
    const [work, count] = ranked[0];
    const total = ranked.reduce((sum, [, value]) => sum + value, 0);
    const ja = worksFile.works?.[work]?.ja;
    const known = Object.hasOwn(officialWorkNames, qualifier);
    if (!ja || count * 2 <= total || (!known && count < minCharacters)) continue;
    if (officialWorkNames[qualifier] === ja) continue;
    officialWorkNames[qualifier] = ja;
    changed += 1;
  }
  return changed;
}

// ---------------------------------------------------------------- verify
// Second opinion on the applied changes: is the new name at least as good as
// the old one? A "before" verdict reverts the change.
const VERIFY_RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    rows: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          i: { type: 'integer' },
          verdict: { type: 'string', enum: ['after', 'before', 'unsure'] },
          confidence: { type: 'string', enum: CONFIDENCES },
        },
        required: ['i', 'verdict', 'confidence'],
        additionalProperties: false,
      },
    },
  },
  required: ['rows'],
  additionalProperties: false,
};

export const VERIFY_SYSTEM_PROMPT = `You are the quality gate for Japanese display names of Danbooru character tags in an illustration app. Each row shows the tag, the previous name ("before"), the newly proposed name ("after"), the works the character belongs to and the Danbooru other_names (mixed scripts, no order).

Decide for every row:
- "after": the new name is better or equally good — the official Japanese spelling (kanji/kana as the work writes it, katakana with "・" for foreign names, official Latin spellings kept), qualifiers translated the way the work does (kai ni -> 改二, swimsuit -> 水着, 1st costume -> 初期衣装), the work title in the last （） only when the tag carries one.
- "before": the old name was better — the new one is a wrong character, a wrong reading, a fan nickname or slang instead of the official name, a Chinese or Korean spelling, a machine transliteration, a lost or wrong qualifier, or a wrong work.
- "unsure": you cannot tell which is right.
A change from romaji-style katakana (アマミ・ハルカ) to the official kanji (天海春香) is "after"; a change from an established official name to something unverified is "before". Judge the name, not the formatting of parentheses.

Return exactly one JSON row per input row, same "i", nothing else.`;

// The applied (high-confidence) changes of a characters report, with evidence.
export function buildVerifyRows(reportRows, { worksFile, wikiNames, minConfidence = 'high' } = {}) {
  const accepted = CONFIDENCES.slice(0, CONFIDENCES.indexOf(minConfidence) + 1);
  const rows = [];
  for (const row of reportRows) {
    if (row.action !== 'change' || !accepted.includes(row.confidence)) continue;
    const after = cleanCharacterName(row.tag, row.name);
    if (!after || after === row.current) continue;
    rows.push({
      i: rows.length + 1,
      tag: row.tag,
      before: row.current,
      after,
      works: (worksFile?.characters?.[row.tag] ?? []).map(work => worksFile.works?.[work]?.ja || work),
      otherNames: wikiNames?.get(normalizeKey(row.tag)) ?? wikiNames?.get(normalizeKey(toDanbooru(row.tag))) ?? [],
    });
  }
  return rows;
}

export function buildVerifyPrompt(rows) {
  return `Judge exactly ${rows.length} name changes. Return exactly ${rows.length} JSON rows with these input ids: ${rows.map(row => row.i).join(', ')}.\n${JSON.stringify(rows.map(({ i, tag, before, after, works, otherNames }) => ({ i, tag, before, after, works, otherNames })))}`;
}

export function validateVerifyRows(inputRows, outputRows) {
  if (outputRows.length !== inputRows.length) throw new Error(`LLM returned ${outputRows.length} rows for ${inputRows.length} inputs`);
  const inputById = new Map(inputRows.map(row => [row.i, row]));
  const seen = new Set();
  return outputRows.map((row, index) => {
    const input = inputById.get(row?.i);
    if (!input || seen.has(row.i)) throw new Error(`Invalid or duplicate index at response row ${index + 1}`);
    seen.add(row.i);
    if (!['after', 'before', 'unsure'].includes(row.verdict)) throw new Error(`Invalid verdict for ${input.tag}: ${row.verdict}`);
    if (!CONFIDENCES.includes(row.confidence)) throw new Error(`Invalid confidence for ${input.tag}: ${row.confidence}`);
    return { i: input.i, tag: input.tag, before: input.before, after: input.after, verdict: row.verdict, confidence: row.confidence };
  });
}

// Revert the changes the verifier rejected ("before" at or above minConfidence).
export function applyVerify(names, verifyRows, { minConfidence = 'medium' } = {}) {
  const accepted = CONFIDENCES.slice(0, CONFIDENCES.indexOf(minConfidence) + 1);
  const reverted = [];
  for (const row of verifyRows) {
    if (row.verdict !== 'before' || !accepted.includes(row.confidence)) continue;
    if (names[row.tag] !== row.after) continue;   // changed since; leave it
    if (row.before) names[row.tag] = row.before; else delete names[row.tag];
    reverted.push(row);
  }
  return reverted;
}

function readReportRows(reportPath) {
  return fs.readFileSync(reportPath, 'utf8').split('\n').filter(Boolean).flatMap(line => JSON.parse(line).rows ?? []);
}

function parseArgs(argv) {
  const args = {
    ...backendArgDefaults(),
    stage: '', report: '', apply: '', input: '', select: 'all', recheck: false, minConfidence: 'high',
    offset: 0, limit: 0, dryRun: false, help: false,
    works: DEFAULT_WORKS, names: DEFAULT_NAMES, official: DEFAULT_OFFICIAL, wikiCache: DEFAULT_WIKI,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const consumed = takeBackendArg(args, argv, index);
    if (consumed) { index += consumed - 1; continue; }
    if (arg === '--stage') args.stage = argv[++index];
    else if (arg === '--report') args.report = argv[++index];
    else if (arg === '--apply') args.apply = argv[++index];
    else if (arg === '--input') args.input = argv[++index];
    else if (arg === '--select') args.select = argv[++index];
    else if (arg === '--recheck') args.recheck = true;
    else if (arg === '--min-confidence') args.minConfidence = argv[++index];
    else if (arg === '--offset') args.offset = Number.parseInt(argv[++index], 10);
    else if (arg === '--limit') args.limit = Number.parseInt(argv[++index], 10);
    else if (arg === '--works') args.works = argv[++index];
    else if (arg === '--names') args.names = argv[++index];
    else if (arg === '--official') args.official = argv[++index];
    else if (arg === '--wiki-cache') args.wikiCache = argv[++index];
    else if (arg === '--dry-run') args.dryRun = true;
    else if (arg === '--help') args.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (args.help) return args;
  validateBackendArgs(args);
  if (!STAGES.includes(args.stage)) throw new Error(`--stage must be one of ${STAGES.join(', ')}`);
  if (!SELECTIONS.includes(args.select)) throw new Error(`--select must be one of ${SELECTIONS.join(', ')}`);
  if (!CONFIDENCES.includes(args.minConfidence)) throw new Error(`--min-confidence must be one of ${CONFIDENCES.join(', ')}`);
  if (!args.apply && !args.report && !args.dryRun) throw new Error('--report <file> or --apply <report> is required');
  if (!Number.isInteger(args.offset) || args.offset < 0) throw new Error('--offset must be a non-negative integer');
  if (!Number.isInteger(args.limit) || args.limit < 0) throw new Error('--limit must be a non-negative integer');
  return args;
}

function printHelp() {
  console.log(`Usage:
  node scripts/reviewCharacterNames.mjs --stage works --report works.jsonl [--recheck]
  node scripts/reviewCharacterNames.mjs --stage works --apply works.jsonl [--min-confidence medium]
  node scripts/reviewCharacterNames.mjs --stage characters --report names.jsonl [--select all|missing|nowork]
  node scripts/reviewCharacterNames.mjs --stage characters --apply names.jsonl [--min-confidence high]

Options: --offset N --limit N --dry-run --works FILE --names FILE --official FILE --wiki-cache FILE
${backendHelpText()}`);
}

function applyReport(args) {
  const rows = readReportRows(args.apply);
  if (args.stage === 'works') {
    const worksFile = readJson(args.works);
    const changed = applyWorkTitles(worksFile, rows, { minConfidence: args.minConfidence });
    fs.writeFileSync(args.works, `${JSON.stringify(worksFile, null, 1)}\n`, 'utf8');
    console.log(JSON.stringify({ stage: 'works', rows: rows.length, changed, file: args.works }));
    return;
  }
  const database = readJson(args.names);
  const names = { ...(database[JAPANESE] ?? {}) };
  if (args.stage === 'verify') {
    const reverted = applyVerify(names, rows, { minConfidence: args.minConfidence === 'high' ? 'medium' : args.minConfidence });
    database[JAPANESE] = Object.fromEntries(Object.entries(names).sort(([left], [right]) => left.localeCompare(right)));
    fs.writeFileSync(args.names, `${JSON.stringify(database, null, 2)}\n`, 'utf8');
    for (const row of reverted) console.log(`revert ${row.tag}: ${row.after} -> ${row.before || '(none)'} [${row.confidence}]`);
    console.log(JSON.stringify({ stage: 'verify', rows: rows.length, reverted: reverted.length, file: args.names }));
    return;
  }
  const changed = applyCharacterNames(names, rows, { minConfidence: args.minConfidence });
  database[JAPANESE] = Object.fromEntries(Object.entries(names).sort(([left], [right]) => left.localeCompare(right)));
  fs.writeFileSync(args.names, `${JSON.stringify(database, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify({ stage: 'characters', rows: rows.length, changed, file: args.names }));
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) return printHelp();
  if (args.apply) return applyReport(args);

  const worksFile = readJson(args.works);
  let rows;
  let request;
  if (args.stage === 'works') {
    rows = buildWorkRows(worksFile, readJson(args.official), { recheck: args.recheck });
    request = { systemPrompt: WORK_SYSTEM_PROMPT, buildPrompt: buildWorkPrompt, schema: WORK_RESPONSE_SCHEMA, validate: validateWorkRows, label: 'works' };
  } else if (args.stage === 'verify') {
    if (!args.input) throw new Error('--stage verify needs --input <characters report>');
    rows = buildVerifyRows(readReportRows(args.input), { worksFile, wikiNames: loadWikiOtherNames(args.wikiCache), minConfidence: args.minConfidence });
    request = { systemPrompt: VERIFY_SYSTEM_PROMPT, buildPrompt: buildVerifyPrompt, schema: VERIFY_RESPONSE_SCHEMA, validate: validateVerifyRows, label: 'verify' };
  } else {
    const names = readJson(args.names)[JAPANESE] ?? {};
    rows = buildCharacterRows({
      tags: readCharacterTags(path.dirname(args.names)),
      names,
      worksFile,
      wikiNames: loadWikiOtherNames(args.wikiCache),
      select: args.select,
    });
    request = { systemPrompt: CHARACTER_SYSTEM_PROMPT, buildPrompt: buildCharacterPrompt, schema: CHARACTER_RESPONSE_SCHEMA, validate: validateCharacterRows, label: 'characters' };
  }
  const selected = rows.slice(args.offset, args.limit ? args.offset + args.limit : undefined);
  if (args.dryRun) {
    console.log(JSON.stringify({ stage: args.stage, rows: rows.length, selected: selected.length, sample: selected.slice(0, 3) }));
    return;
  }

  const client = createBatchClient(args);
  const lanes = planLanes(args, selected);
  process.stdout.write(`Reviewing ${selected.length} ${args.stage}: ${lanes.map(lane => `${lane.rows.length} via ${lane.backend}`).join(', ')}...\n`);
  fs.writeFileSync(args.report, '', 'utf8');
  try {
    for (const lane of lanes) {
      const laneBatchSize = client.batchSizeFor(lane.backend);
      for (let start = 0; start < lane.rows.length; start += laneBatchSize) {
        const batch = lane.rows.slice(start, start + laneBatchSize);
        process.stdout.write(`[${lane.backend}] ${args.stage} ${start + 1}-${start + batch.length}/${lane.rows.length}...\n`);
        const results = await client.requestRows(lane.backend, batch, request);
        fs.appendFileSync(args.report, `${JSON.stringify({ stage: args.stage, model: client.modelFor(lane.backend), backend: lane.backend, rows: results })}\n`, 'utf8');
      }
    }
  } finally {
    await client.close();
  }
  console.log(`Wrote review report: ${args.report}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(error.message);
    process.exit(1);
  });
}
