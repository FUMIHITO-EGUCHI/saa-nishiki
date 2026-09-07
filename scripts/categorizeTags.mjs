// Batch tag-category assignment with Codex plus an uncensored Ollama model.
//
// Fills data/tag_categories.json for the detailed tag-picker filters (see
// scripts/main/tagCategories.js). Follows the two-pass pattern established by
// reviewJapaneseTags.mjs: an assignment pass proposes a category per tag, a
// verification pass double-checks every proposal, and only high-confidence,
// verified assignments are applied. Applied records carry source "LLM" plus the
// model name so provenance stays distinguishable from the hand-checked
// "Danbooru Wiki" seed entries. Backends and routing live in llmBatchBackend.mjs.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseTagRows } from './reviewJapaneseTags.mjs';
import {
  backendArgDefaults, backendHelpText, createBatchClient, isNsfwTag, planLanes,
  takeBackendArg, validateBackendArgs,
} from './llmBatchBackend.mjs';
import { TAG_CATEGORY_LABELS } from './main/tagCategories.js';

export { isNsfwTag };

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectDir = path.dirname(scriptDir);
const DEFAULT_INPUT = path.join(projectDir, 'data', 'danbooru_e621_merged.csv');
const DEFAULT_ALIASES = path.join(projectDir, 'data', 'danbooru_e621_merged_ja.csv');
const DEFAULT_CATEGORIES = path.join(projectDir, 'data', 'tag_categories.json');

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
- scenery: where and when the picture is set: locations, environments, landscape and architecture, weather, sky, time of day, season, water, plants as scenery, and background descriptors (outdoors, beach, classroom, night, cherry_blossoms, cityscape, simple_background, sky, snow).
- composition_quality: framing, viewpoint, subject count, lighting, image quality, and rendering or meta terms (1girl, solo, from_above, blurry, highres, monochrome, depth_of_field).
- unknown: the tag fits none of the above, mixes several, or you are unsure what it means.

Rules:
- Judge the tag's established booru meaning, not a literal reading. The Japanese alias, when present, is a hint to the meaning.
- holding_x and other interaction tags are pose_action even when x is an object.
- Backgrounds, places, weather and time-of-day tags are scenery, not composition_quality; lighting and framing stay composition_quality.
- Use confidence high only when the category is obvious; otherwise medium or low.
- Prefer unknown over guessing for obscure or ambiguous tags.
- Return exactly one row for every input row, preserving each input i. Do not omit, merge, or reorder rows.`;

const VERIFY_SYSTEM_PROMPT = `You are the final quality gate for category labels on booru image-generation tags.
Return ONLY valid JSON in this shape: {"rows":[{"i":1,"accept":true,"confidence":"high"}]}

The category definitions:
body = anatomy and physique; pose_action = poses, actions, expressions, gaze; clothing = worn items;
appearance = hair/eye/skin colors, styles and intrinsic character features; object = scene props not worn;
scenery = locations, environments, backgrounds, weather, sky, time of day, season;
composition_quality = framing, viewpoint, subject count, lighting, quality and meta terms.

- Accept only when the proposed category clearly matches the tag's established booru meaning.
- Reject when a different category fits better or the meaning is uncertain.
- confidence must be high only when the decision is clear.
- Return exactly one row for every input row, preserving each input i.`;

function parseArgs(argv) {
  const args = {
    ...backendArgDefaults(),
    mode: 'assign', input: DEFAULT_INPUT, aliases: DEFAULT_ALIASES, categories: DEFAULT_CATEGORIES,
    report: '', output: '', offset: 0, limit: 0,
    minHeat: 10000, groups: DEFAULT_GROUPS, recheck: '', help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const consumed = takeBackendArg(args, argv, index);
    if (consumed) { index += consumed - 1; continue; }
    if (arg === '--apply') args.mode = 'apply';
    else if (arg === '--input') args.input = argv[++index];
    else if (arg === '--aliases') args.aliases = argv[++index];
    else if (arg === '--categories') args.categories = argv[++index];
    else if (arg === '--report') args.report = argv[++index];
    else if (arg === '--output') args.output = argv[++index];
    else if (arg === '--offset') args.offset = Number.parseInt(argv[++index], 10);
    else if (arg === '--limit') args.limit = Number.parseInt(argv[++index], 10);
    else if (arg === '--min-heat') args.minHeat = Number.parseInt(argv[++index], 10);
    else if (arg === '--groups') args.groups = argv[++index].split(',').map(value => Number.parseInt(value, 10));
    else if (arg === '--recheck') args.recheck = argv[++index];
    else if (arg === '--help') args.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  validateBackendArgs(args);
  if (!Number.isInteger(args.offset) || args.offset < 0) throw new Error('--offset must be a non-negative integer');
  if (!Number.isInteger(args.limit) || args.limit < 0) throw new Error('--limit must be a non-negative integer');
  if (!Number.isInteger(args.minHeat) || args.minHeat < 0) throw new Error('--min-heat must be a non-negative integer');
  if (args.recheck && !CATEGORIES.includes(args.recheck)) throw new Error(`--recheck must be one of ${CATEGORIES.join(', ')}`);
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

// Tags already in the dictionary. With `exceptCategory`, tags filed under that
// category (LLM-sourced only; wiki entries stay known) are left out so a run
// can re-judge them, e.g. after a new category was introduced.
export function loadKnownTags(categoriesPath, { exceptCategory = '' } = {}) {
  try {
    const data = JSON.parse(fs.readFileSync(categoriesPath, 'utf8'));
    const entries = Object.entries(data?.tags ?? {});
    return new Set(entries
      .filter(([, record]) => !(exceptCategory && record?.category === exceptCategory && record?.source === 'LLM'))
      .map(([tag]) => tag));
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

// `recheck`: an LLM-sourced entry filed under that category may be moved to the
// newly verified category; hand-checked (wiki) entries are never overwritten.
export function mergeCategories(existing, reviews, model, { recheck = '' } = {}) {
  const data = existing && existing.schemaVersion === 1 && existing.tags && typeof existing.tags === 'object'
    ? { schemaVersion: 1, tags: { ...existing.tags } }
    : { schemaVersion: 1, tags: {} };
  let added = 0;
  let updated = 0;
  for (const review of collectApplicable(reviews)) {
    const current = data.tags[review.tag];
    if (current) {
      const movable = recheck && current.source === 'LLM' && current.category === recheck && review.category !== recheck;
      if (!movable) continue;
      updated += 1;
    } else {
      added += 1;
    }
    // rows carry their own model when a Codex batch fell back to the local model
    data.tags[review.tag] = { category: review.category, status: 'verified', source: 'LLM', model: review.model || model };
  }
  return { data, added, updated };
}

function buildAssignPrompt(rows) {
  return `Classify exactly ${rows.length} tags. Return exactly ${rows.length} JSON rows, one for every item, with these input ids: ${rows.map(row => row.i).join(', ')}.\n${JSON.stringify(rows.map(({ i, tag, alias = '' }) => ({ i, tag, alias })))} `;
}

function buildVerifyPrompt(rows) {
  return `Check exactly ${rows.length} proposed categories. Return exactly ${rows.length} JSON rows, one for every item, with these input ids: ${rows.map(row => row.i).join(', ')}.\n${JSON.stringify(rows.map(row => ({ i: row.i, tag: row.tag, alias: row.alias, proposed: row.category })))} `;
}

function printHelp() {
  console.log(`Assign tag-picker categories with Codex plus an uncensored Ollama model.

Assignment mode (writes a JSONL report):
  node scripts/categorizeTags.mjs --report <report.jsonl> [--min-heat 10000] [--groups 0,7,5,14] [--limit N]
  --recheck <category> also re-judges the LLM-sourced tags filed under that
  category (pass the same flag to --apply so they may move).

${backendHelpText()}

Apply verified high-confidence assignments into data/tag_categories.json:
  node scripts/categorizeTags.mjs --apply --report <report.jsonl> [--output data/tag_categories.json]
`);
}

async function runAssign(args) {
  if (!args.report) throw new Error('Assignment mode requires --report');
  const rows = parseMergedRows(fs.readFileSync(args.input, 'utf8'));
  const aliasMap = new Map(parseTagRows(fs.readFileSync(args.aliases, 'utf8')).map(row => [row.tag, row.alias]));
  const known = loadKnownTags(args.categories, { exceptCategory: args.recheck });
  const candidates = selectCandidates(rows, { groups: args.groups, minHeat: args.minHeat, known })
    .map(row => ({ ...row, alias: aliasMap.get(row.tag) || '' }));
  const selected = candidates.slice(args.offset, args.limit ? args.offset + args.limit : undefined);
  if (!selected.length) throw new Error('No rows selected');

  const client = createBatchClient(args);
  const lanes = planLanes(args, selected);
  process.stdout.write(`Categorizing ${selected.length} of ${candidates.length} candidate tags (min heat ${args.minHeat}, groups ${args.groups.join(',')}): ${lanes.map(lane => `${lane.rows.length} via ${lane.backend}`).join(', ')}...\n`);
  fs.writeFileSync(args.report, '', 'utf8');
  try {
    for (const lane of lanes) {
      const laneBatchSize = client.batchSizeFor(lane.backend);
      for (let start = 0; start < lane.rows.length; start += laneBatchSize) {
        const batch = lane.rows.slice(start, start + laneBatchSize);
        process.stdout.write(`[${lane.backend}] Assigning ${start + 1}-${start + batch.length}/${lane.rows.length}...\n`);
        const reviews = await client.requestRows(lane.backend, batch, {
          systemPrompt: ASSIGN_SYSTEM_PROMPT, buildPrompt: buildAssignPrompt, schema: ASSIGN_RESPONSE_SCHEMA,
          validate: validateAssignmentRows, label: 'assignment',
        });
        const candidatesToVerify = reviews.filter(review => review.category !== 'unknown');
        if (candidatesToVerify.length) {
          process.stdout.write(`[${lane.backend}] Verifying ${candidatesToVerify.length} proposed categories...\n`);
          const verification = await client.requestRows(lane.backend, candidatesToVerify, {
            systemPrompt: VERIFY_SYSTEM_PROMPT, buildPrompt: buildVerifyPrompt, schema: VERIFY_RESPONSE_SCHEMA,
            validate: validateVerificationRows, label: 'verification',
          });
          const verificationById = new Map(verification.map(row => [row.i, row]));
          for (const review of reviews) review.verification = verificationById.get(review.i) || null;
        }
        fs.appendFileSync(args.report, `${JSON.stringify({ model: client.modelFor(lane.backend), backend: lane.backend, rows: reviews })}\n`, 'utf8');
      }
    }
  } finally {
    await client.close();
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
  const { data, added, updated } = mergeCategories(existing, reviews, model, { recheck: args.recheck });
  fs.writeFileSync(output, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify({ reportRows: reviews.length, applicable: collectApplicable(reviews).length, added, updated, total: Object.keys(data.tags).length, output }, null, 2));
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
