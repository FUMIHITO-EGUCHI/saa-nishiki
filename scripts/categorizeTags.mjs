// Batch tag-category assignment with a local Ollama model.
//
// Fills data/tag_categories.json for the detailed tag-picker filters (see
// scripts/main/tagCategories.js). Follows the two-pass pattern established by
// reviewJapaneseTags.mjs: an assignment pass proposes a category per tag, a
// verification pass double-checks every proposal, and only high-confidence,
// verified assignments are applied. Applied records carry source "LLM" plus the
// model name so provenance stays distinguishable from the hand-checked
// "Danbooru Wiki" seed entries.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseTagRows, splitReviewRows, parseReviewResponse } from './reviewJapaneseTags.mjs';
import { TAG_CATEGORY_LABELS } from './main/tagCategories.js';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectDir = path.dirname(scriptDir);
const DEFAULT_INPUT = path.join(projectDir, 'data', 'danbooru_e621_merged.csv');
const DEFAULT_ALIASES = path.join(projectDir, 'data', 'danbooru_e621_merged_ja.csv');
const DEFAULT_CATEGORIES = path.join(projectDir, 'data', 'tag_categories.json');
const DEFAULT_MODEL = 'hf.co/HauhauCS/Qwen3.5-35B-A3B-Uncensored-HauhauCS-Aggressive:Q4_K_M';
const DEFAULT_CODEX_MODEL = 'gpt-5.6-luna';
const OLLAMA_URL = process.env.OLLAMA_TAG_REVIEW_URL || 'http://127.0.0.1:11434/api/chat';

// Routing policy: explicit tags go to the local uncensored model (a cloud model
// may refuse or skew on them); everything else goes to Codex, which is far
// faster than the partially CPU-offloaded local 35B. A batch Codex rejects or
// garbles falls back to the local model, so this list only has to catch the
// obvious cases, not be exhaustive.
const NSFW_TAG_PATTERN = new RegExp([
  'sex', 'penis', 'pussy', 'vagina', 'anal', 'anus', '(^|_)cum', 'semen', 'ejaculat', 'erection',
  'fellatio', 'irrumatio', 'cunnilingus', 'paizuri', 'handjob', 'footjob', 'masturbat', 'orgasm',
  'nipple', 'areola', 'topless', 'bottomless', 'nude', 'naked', 'pubic', 'penetrat', 'futanari',
  'testicle', 'condom', 'bukkake', 'gangbang', 'rape', 'bdsm', 'bondage', 'dildo', 'vibrator',
  'cameltoe', 'vulva', 'clitoris', 'lactation', '(^|_)hetero($|_)', 'yaoi', 'yuri_sex', '(^|_)oral', 'fingering',
  'breasts_out', 'spread_legs', 'spread_pussy', 'x-ray', 'internal_cumshot', 'clothed_sex',
].join('|'));

export function isNsfwTag(tag) {
  return NSFW_TAG_PATTERN.test(String(tag).toLowerCase());
}

// Danbooru general/meta and their E621 counterparts; character, artist, work,
// species and lore tags are already covered by the coarse group filters.
const DEFAULT_GROUPS = [0, 7, 5, 14];

export const CATEGORIES = Object.freeze(Object.keys(TAG_CATEGORY_LABELS).filter(key => key !== 'unknown'));

const ASSIGN_RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    rows: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          i: { type: 'integer' },
          category: { type: 'string', enum: [...CATEGORIES, 'unknown'] },
          confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
        },
        required: ['i', 'category', 'confidence'],
        additionalProperties: false,
      },
    },
  },
  required: ['rows'],
  additionalProperties: false,
};

const VERIFY_RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    rows: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          i: { type: 'integer' },
          accept: { type: 'boolean' },
          confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
        },
        required: ['i', 'accept', 'confidence'],
        additionalProperties: false,
      },
    },
  },
  required: ['rows'],
  additionalProperties: false,
};

const ASSIGN_SYSTEM_PROMPT = `You classify booru image-generation tags into UI filter categories.
Return ONLY valid JSON in this shape: {"rows":[{"i":1,"category":"body","confidence":"high"}]}

Categories:
- body: anatomical body parts and physique traits (breasts, navel, thighs, tail, muscular, wings when body-grown).
- pose_action: poses, gestures, movements, gaze, facial expressions, and actions (standing, holding_sword, looking_at_viewer, smile, running).
- clothing: clothing, footwear, headwear, and worn accessories (school_uniform, thighhighs, hat, jewelry, glasses).
- appearance: hair and eye color or style, skin tone, and intrinsic character appearance features that are not plain anatomy (blue_hair, twintails, red_eyes, halo, dark_skin).
- object: props, items, weapons, furniture, food, vehicles, animals, and other scene objects that are not worn (sword, cup, car, cat).
- composition_quality: framing, viewpoint, subject count, background, lighting, image quality, and rendering or meta terms (1girl, solo, from_above, simple_background, blurry, highres, monochrome).
- unknown: the tag fits none of the above, mixes several, or you are unsure what it means.

Rules:
- Judge the tag's established booru meaning, not a literal reading. The Japanese alias, when present, is a hint to the meaning.
- holding_x and other interaction tags are pose_action even when x is an object.
- Use confidence high only when the category is obvious; otherwise medium or low.
- Prefer unknown over guessing for obscure or ambiguous tags.
- Return exactly one row for every input row, preserving each input i. Do not omit, merge, or reorder rows.`;

const VERIFY_SYSTEM_PROMPT = `You are the final quality gate for category labels on booru image-generation tags.
Return ONLY valid JSON in this shape: {"rows":[{"i":1,"accept":true,"confidence":"high"}]}

The category definitions:
body = anatomy and physique; pose_action = poses, actions, expressions, gaze; clothing = worn items;
appearance = hair/eye/skin colors, styles and intrinsic character features; object = scene props not worn;
composition_quality = framing, viewpoint, subject count, background, lighting, quality and meta terms.

- Accept only when the proposed category clearly matches the tag's established booru meaning.
- Reject when a different category fits better or the meaning is uncertain.
- confidence must be high only when the decision is clear.
- Return exactly one row for every input row, preserving each input i.`;

function parseArgs(argv) {
  const args = {
    mode: 'assign', input: DEFAULT_INPUT, aliases: DEFAULT_ALIASES, categories: DEFAULT_CATEGORIES,
    report: '', output: '', model: DEFAULT_MODEL, codexModel: DEFAULT_CODEX_MODEL, backend: 'auto',
    batchSize: 40, codexBatchSize: 100, offset: 0, limit: 0,
    minHeat: 10000, groups: DEFAULT_GROUPS,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--apply') args.mode = 'apply';
    else if (arg === '--input') args.input = argv[++index];
    else if (arg === '--aliases') args.aliases = argv[++index];
    else if (arg === '--categories') args.categories = argv[++index];
    else if (arg === '--report') args.report = argv[++index];
    else if (arg === '--output') args.output = argv[++index];
    else if (arg === '--model') args.model = argv[++index];
    else if (arg === '--codex-model') args.codexModel = argv[++index];
    else if (arg === '--backend') args.backend = argv[++index];
    else if (arg === '--batch-size') args.batchSize = Number.parseInt(argv[++index], 10);
    else if (arg === '--codex-batch-size') args.codexBatchSize = Number.parseInt(argv[++index], 10);
    else if (arg === '--offset') args.offset = Number.parseInt(argv[++index], 10);
    else if (arg === '--limit') args.limit = Number.parseInt(argv[++index], 10);
    else if (arg === '--min-heat') args.minHeat = Number.parseInt(argv[++index], 10);
    else if (arg === '--groups') args.groups = argv[++index].split(',').map(value => Number.parseInt(value, 10));
    else if (arg === '--help') args.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!Number.isInteger(args.batchSize) || args.batchSize < 1 || args.batchSize > 200) {
    throw new Error('--batch-size must be an integer from 1 to 200');
  }
  if (!Number.isInteger(args.codexBatchSize) || args.codexBatchSize < 1 || args.codexBatchSize > 200) {
    throw new Error('--codex-batch-size must be an integer from 1 to 200');
  }
  if (!['auto', 'ollama', 'codex'].includes(args.backend)) {
    throw new Error('--backend must be auto, ollama, or codex');
  }
  if (!Number.isInteger(args.offset) || args.offset < 0) throw new Error('--offset must be a non-negative integer');
  if (!Number.isInteger(args.limit) || args.limit < 0) throw new Error('--limit must be a non-negative integer');
  if (!Number.isInteger(args.minHeat) || args.minHeat < 0) throw new Error('--min-heat must be a non-negative integer');
  if (!args.groups.length || args.groups.some(group => !Number.isInteger(group) || group < 0)) {
    throw new Error('--groups must be a comma-separated list of non-negative integers');
  }
  return args;
}

// merged CSV rows are tag,group,heat,"aliases"; the first three fields never
// contain commas, so splitting on the first three commas is safe.
export function parseMergedRows(csvText) {
  return String(csvText)
    .split(/\r?\n/)
    .filter(line => line.trim() !== '')
    .map(line => {
      const [tag, group, heat] = line.split(',', 3);
      return { tag: tag.trim(), group: Number.parseInt(group, 10), heat: Number.parseInt(heat, 10) };
    })
    .filter(row => row.tag && Number.isInteger(row.group) && Number.isInteger(row.heat));
}

export function selectCandidates(rows, { groups, minHeat, known }) {
  const groupSet = new Set(groups);
  return rows
    .filter(row => groupSet.has(row.group) && row.heat >= minHeat && !known.has(row.tag))
    .sort((left, right) => right.heat - left.heat)
    .map((row, index) => ({ i: index + 1, ...row }));
}

export function loadKnownTags(categoriesPath) {
  try {
    const data = JSON.parse(fs.readFileSync(categoriesPath, 'utf8'));
    return new Set(Object.keys(data?.tags ?? {}));
  } catch {
    return new Set();
  }
}

export function validateAssignmentRows(inputRows, assignmentRows) {
  if (assignmentRows.length !== inputRows.length) {
    throw new Error(`LLM returned ${assignmentRows.length} rows for ${inputRows.length} inputs`);
  }
  const inputById = new Map(inputRows.map(row => [row.i, row]));
  const seen = new Set();
  return assignmentRows.map((row, index) => {
    const input = inputById.get(row?.i);
    if (!input || seen.has(row.i)) throw new Error(`Invalid or duplicate index at response row ${index + 1}`);
    seen.add(row.i);
    if (row.category !== 'unknown' && !CATEGORIES.includes(row.category)) {
      throw new Error(`Invalid category for tag ${input.tag}: ${row.category}`);
    }
    if (!['high', 'medium', 'low'].includes(row.confidence)) {
      throw new Error(`Invalid confidence for tag ${input.tag}: ${row.confidence}`);
    }
    return { i: input.i, tag: input.tag, group: input.group, heat: input.heat, alias: input.alias || '', category: row.category, confidence: row.confidence };
  }).sort((left, right) => left.i - right.i);
}

export function validateVerificationRows(inputRows, verificationRows) {
  if (verificationRows.length !== inputRows.length) {
    throw new Error(`LLM returned ${verificationRows.length} verification rows for ${inputRows.length} inputs`);
  }
  const inputById = new Map(inputRows.map(row => [row.i, row]));
  const seen = new Set();
  return verificationRows.map((row, index) => {
    const input = inputById.get(row?.i);
    if (!input || seen.has(row.i)) throw new Error(`Invalid or duplicate verification index at response row ${index + 1}`);
    seen.add(row.i);
    if (typeof row.accept !== 'boolean') throw new Error(`Invalid accept value for tag ${input.tag}`);
    if (!['high', 'medium', 'low'].includes(row.confidence)) throw new Error(`Invalid verification confidence for tag ${input.tag}`);
    return { i: input.i, accepted: row.accept, confidence: row.confidence };
  }).sort((left, right) => left.i - right.i);
}

export function collectApplicable(reviews) {
  return reviews.filter(review => review.category !== 'unknown'
    && review.confidence === 'high'
    && review.verification?.accepted
    && review.verification.confidence === 'high');
}

export function mergeCategories(existing, reviews, model) {
  const data = existing && existing.schemaVersion === 1 && existing.tags && typeof existing.tags === 'object'
    ? { schemaVersion: 1, tags: { ...existing.tags } }
    : { schemaVersion: 1, tags: {} };
  let added = 0;
  for (const review of collectApplicable(reviews)) {
    if (data.tags[review.tag]) continue; // never overwrite hand-checked entries
    // rows carry their own model when a Codex batch fell back to the local model
    data.tags[review.tag] = { category: review.category, status: 'verified', source: 'LLM', model: review.model || model };
    added += 1;
  }
  return { data, added };
}

async function callOllamaJson(model, systemPrompt, userContent, schema) {
  const response = await fetch(OLLAMA_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    signal: AbortSignal.timeout(300_000),
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userContent },
      ],
      stream: false,
      think: false,
      format: schema,
      temperature: 0.1,
      options: { num_predict: 4096 },
      keep_alive: 0,
    }),
  });
  if (!response.ok) throw new Error(`Ollama HTTP ${response.status}: ${await response.text()}`);
  const payload = await response.json();
  if (typeof payload?.message?.content !== 'string') throw new Error('Ollama response has no message content');
  return parseReviewResponse(payload.message.content);
}

// Non-interactive Codex call: the prompt goes over stdin, the response shape is
// enforced with --output-schema, and the final message is read from a temp file.
// read-only sandbox; the model is told to answer directly without tools.
function callCodexJson(model, systemPrompt, userContent, schema) {
  const stamp = `saa-cat-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const schemaFile = path.join(os.tmpdir(), `${stamp}-schema.json`);
  const outFile = path.join(os.tmpdir(), `${stamp}-out.json`);
  fs.writeFileSync(schemaFile, JSON.stringify(schema), 'utf8');
  try {
    const commandLine = [
      'codex', 'exec', '--ephemeral', '--skip-git-repo-check', '--color', 'never',
      '-s', 'read-only',
      '-m', model,
      '-c', 'model_reasoning_effort="low"',
      '--output-schema', schemaFile,
      '-o', outFile,
      '-',
    ].map(part => (/\s/.test(part) ? `"${part}"` : part)).join(' ');
    const result = spawnSync(commandLine, {
      input: `${systemPrompt}\n\nAnswer directly with the JSON only. Do not run commands or read files.\n\n${userContent}`,
      encoding: 'utf8',
      shell: true, // resolves the npm shim on Windows
      timeout: 600_000,
    });
    if (result.error) throw result.error;
    if (result.status !== 0) {
      throw new Error(`codex exec exited with ${result.status}: ${String(result.stderr).slice(-400)}`);
    }
    if (!fs.existsSync(outFile)) throw new Error('codex exec produced no output message');
    return parseReviewResponse(fs.readFileSync(outFile, 'utf8'));
  } finally {
    fs.rmSync(schemaFile, { force: true });
    fs.rmSync(outFile, { force: true });
  }
}

function buildAssignPrompt(rows) {
  return `Classify exactly ${rows.length} tags. Return exactly ${rows.length} JSON rows, one for every item, with these input ids: ${rows.map(row => row.i).join(', ')}.\n${JSON.stringify(rows.map(({ i, tag, alias = '' }) => ({ i, tag, alias })))} `;
}

function buildVerifyPrompt(rows) {
  return `Check exactly ${rows.length} proposed categories. Return exactly ${rows.length} JSON rows, one for every item, with these input ids: ${rows.map(row => row.i).join(', ')}.\n${JSON.stringify(rows.map(row => ({ i: row.i, tag: row.tag, alias: row.alias, proposed: row.category })))} `;
}

async function callBackend(backend, args, systemPrompt, userContent, schema) {
  return backend === 'codex'
    ? callCodexJson(args.codexModel, systemPrompt, userContent, schema)
    : callOllamaJson(args.model, systemPrompt, userContent, schema);
}

async function assignAndValidate(backend, args, rows) {
  try {
    return validateAssignmentRows(rows, await callBackend(backend, args, ASSIGN_SYSTEM_PROMPT, buildAssignPrompt(rows), ASSIGN_RESPONSE_SCHEMA));
  } catch (error) {
    if (backend === 'codex') {
      // Refusal or malformed output: reroute the whole batch to the local model.
      process.stdout.write(`Codex assignment failed (${error.message.slice(0, 160)}); falling back to local model...\n`);
      return (await assignAndValidate('ollama', args, rows)).map(row => ({ ...row, model: args.model }));
    }
    const parts = splitReviewRows(rows);
    if (parts.length === 1) throw error;
    process.stdout.write(`Retrying invalid assignment response as ${parts[0].length}+${parts[1].length} rows...\n`);
    return [...await assignAndValidate(backend, args, parts[0]), ...await assignAndValidate(backend, args, parts[1])];
  }
}

async function verifyAndValidate(backend, args, rows) {
  try {
    return validateVerificationRows(rows, await callBackend(backend, args, VERIFY_SYSTEM_PROMPT, buildVerifyPrompt(rows), VERIFY_RESPONSE_SCHEMA));
  } catch (error) {
    if (backend === 'codex') {
      process.stdout.write(`Codex verification failed (${error.message.slice(0, 160)}); falling back to local model...\n`);
      return verifyAndValidate('ollama', args, rows);
    }
    const parts = splitReviewRows(rows);
    if (parts.length === 1) throw error;
    process.stdout.write(`Retrying invalid verification response as ${parts[0].length}+${parts[1].length} rows...\n`);
    return [...await verifyAndValidate(backend, args, parts[0]), ...await verifyAndValidate(backend, args, parts[1])];
  }
}

function printHelp() {
  console.log(`Assign tag-picker categories with Codex plus a local Ollama model.

Assignment mode (writes a JSONL report):
  node scripts/categorizeTags.mjs --report <report.jsonl> [--min-heat 10000] [--groups 0,7,5,14] [--limit N]

Backends (--backend auto|codex|ollama, default auto):
  auto routes explicit tags to the local uncensored Ollama model and the rest
  to Codex (--codex-model, default ${DEFAULT_CODEX_MODEL}); a batch Codex
  refuses or garbles falls back to the local model automatically.

Apply verified high-confidence assignments into data/tag_categories.json:
  node scripts/categorizeTags.mjs --apply --report <report.jsonl> [--output data/tag_categories.json]
`);
}

async function runAssign(args) {
  if (!args.report) throw new Error('Assignment mode requires --report');
  const rows = parseMergedRows(fs.readFileSync(args.input, 'utf8'));
  const aliasMap = new Map(parseTagRows(fs.readFileSync(args.aliases, 'utf8')).map(row => [row.tag, row.alias]));
  const known = loadKnownTags(args.categories);
  const candidates = selectCandidates(rows, { groups: args.groups, minHeat: args.minHeat, known })
    .map(row => ({ ...row, alias: aliasMap.get(row.tag) || '' }));
  const selected = candidates.slice(args.offset, args.limit ? args.offset + args.limit : undefined);
  if (!selected.length) throw new Error('No rows selected');

  // auto: explicit tags stay on the local uncensored model, the bulk goes to
  // Codex (much faster than the partially CPU-offloaded local 35B).
  const lanes = args.backend === 'auto'
    ? [
      { backend: 'codex', rows: selected.filter(row => !isNsfwTag(row.tag)) },
      { backend: 'ollama', rows: selected.filter(row => isNsfwTag(row.tag)) },
    ]
    : [{ backend: args.backend, rows: selected }];
  process.stdout.write(`Categorizing ${selected.length} of ${candidates.length} candidate tags (min heat ${args.minHeat}, groups ${args.groups.join(',')}): ${lanes.map(lane => `${lane.rows.length} via ${lane.backend}`).join(', ')}...\n`);
  fs.writeFileSync(args.report, '', 'utf8');
  for (const lane of lanes) {
    const laneModel = lane.backend === 'codex' ? args.codexModel : args.model;
    const laneBatchSize = lane.backend === 'codex' ? args.codexBatchSize : args.batchSize;
    for (let start = 0; start < lane.rows.length; start += laneBatchSize) {
      const batch = lane.rows.slice(start, start + laneBatchSize);
      process.stdout.write(`[${lane.backend}] Assigning ${start + 1}-${start + batch.length}/${lane.rows.length}...\n`);
      const reviews = await assignAndValidate(lane.backend, args, batch);
      const candidatesToVerify = reviews.filter(review => review.category !== 'unknown');
      if (candidatesToVerify.length) {
        process.stdout.write(`[${lane.backend}] Verifying ${candidatesToVerify.length} proposed categories...\n`);
        const verification = await verifyAndValidate(lane.backend, args, candidatesToVerify);
        const verificationById = new Map(verification.map(row => [row.i, row]));
        for (const review of reviews) review.verification = verificationById.get(review.i) || null;
      }
      fs.appendFileSync(args.report, `${JSON.stringify({ model: laneModel, backend: lane.backend, rows: reviews })}\n`, 'utf8');
    }
  }
  console.log(`Wrote assignment report: ${args.report}`);
}

function readReport(reportPath) {
  const reviews = [];
  let model = '';
  for (const [index, line] of fs.readFileSync(reportPath, 'utf8').split(/\r?\n/).filter(Boolean).entries()) {
    let payload;
    try { payload = JSON.parse(line); } catch (error) { throw new Error(`Invalid report JSON at line ${index + 1}: ${error.message}`); }
    if (!Array.isArray(payload.rows)) throw new Error(`Report line ${index + 1} has no rows`);
    model = payload.model || model;
    reviews.push(...payload.rows);
  }
  return { reviews, model };
}

function runApply(args) {
  if (!args.report) throw new Error('Apply mode requires --report');
  const output = args.output || args.categories;
  const { reviews, model } = readReport(args.report);
  let existing = null;
  try { existing = JSON.parse(fs.readFileSync(args.categories, 'utf8')); } catch { /* start fresh */ }
  const { data, added } = mergeCategories(existing, reviews, model);
  fs.writeFileSync(output, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify({ reportRows: reviews.length, applicable: collectApplicable(reviews).length, added, total: Object.keys(data.tags).length, output }, null, 2));
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) return printHelp();
  if (args.mode === 'apply') return runApply(args);
  return runAssign(args);
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch(error => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}
