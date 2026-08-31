import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectDir = path.dirname(scriptDir);
const DEFAULT_INPUT = path.join(projectDir, 'data', 'danbooru_e621_merged_ja.csv');
const DEFAULT_CACHE = path.join(projectDir, 'data', '.cache', 'danbooru-wiki.jsonl');
const DEFAULT_BASE_URL = 'https://danbooru.donmai.us';
const DEFAULT_USER_AGENT = 'SAA-Japanese-localization-review/0.1 (local batch lookup)';
const DEFAULT_ONLY = 'name,category,wiki_page[id,title,body,other_names]';

const SUSPICIOUS_ALIAS_PATTERNS = /賞賛する|承認されています|一般的な|青いアーカイブ|航空機キャリア|最初のアセンション|第二性性能|フィニッシュライン|ハード翻訳|補う|手数料|翻訳を確認|部分的に翻訳|一部位の|前方に傾いています|服ビリ|黒人|メガマン/i;

function parseArgs(argv) {
  const args = {
    input: DEFAULT_INPUT,
    cache: DEFAULT_CACHE,
    baseUrl: DEFAULT_BASE_URL,
    offset: 0,
    limit: 0,
    batchSize: 100,
    maxUrlLength: 6000,
    minDelayMs: 1000,
    retryCount: 4,
    suspiciousOnly: false,
    refresh: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--input') args.input = argv[++index];
    else if (arg === '--cache') args.cache = argv[++index];
    else if (arg === '--base-url') args.baseUrl = argv[++index];
    else if (arg === '--offset') args.offset = Number.parseInt(argv[++index], 10);
    else if (arg === '--limit') args.limit = Number.parseInt(argv[++index], 10);
    else if (arg === '--batch-size') args.batchSize = Number.parseInt(argv[++index], 10);
    else if (arg === '--max-url-length') args.maxUrlLength = Number.parseInt(argv[++index], 10);
    else if (arg === '--min-delay-ms') args.minDelayMs = Number.parseInt(argv[++index], 10);
    else if (arg === '--retry-count') args.retryCount = Number.parseInt(argv[++index], 10);
    else if (arg === '--suspicious-only') args.suspiciousOnly = true;
    else if (arg === '--refresh') args.refresh = true;
    else if (arg === '--help') args.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!Number.isInteger(args.offset) || args.offset < 0) throw new Error('--offset must be a non-negative integer');
  if (!Number.isInteger(args.limit) || args.limit < 0) throw new Error('--limit must be a non-negative integer');
  if (!Number.isInteger(args.batchSize) || args.batchSize < 1 || args.batchSize > 1000) throw new Error('--batch-size must be an integer from 1 to 1000');
  if (!Number.isInteger(args.maxUrlLength) || args.maxUrlLength < 256) throw new Error('--max-url-length must be at least 256');
  if (!Number.isInteger(args.minDelayMs) || args.minDelayMs < 0) throw new Error('--min-delay-ms must be a non-negative integer');
  if (!Number.isInteger(args.retryCount) || args.retryCount < 0 || args.retryCount > 10) throw new Error('--retry-count must be an integer from 0 to 10');
  return args;
}

export function normalizeWikiTagKey(value) {
  return String(value).replace(/_/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
}

export function deduplicateTagNames(rows) {
  const seen = new Set();
  const result = [];
  for (const row of rows) {
    const tag = String(typeof row === 'string' ? row : row?.tag ?? '').trim();
    const normalizedTag = normalizeWikiTagKey(tag);
    if (!normalizedTag || seen.has(normalizedTag)) continue;
    seen.add(normalizedTag);
    result.push(tag);
  }
  return result;
}

export function buildTagLookupUrl(tags, { baseUrl = DEFAULT_BASE_URL, only = DEFAULT_ONLY } = {}) {
  if (!Array.isArray(tags) || tags.length === 0) throw new Error('At least one tag is required');
  const url = new URL('/tags.json', baseUrl);
  url.searchParams.set('search[name_normalize]', tags.join(','));
  url.searchParams.set('only', only);
  url.searchParams.set('limit', String(tags.length));
  return url.toString();
}

export function splitTagBatches(tags, {
  baseUrl = DEFAULT_BASE_URL,
  only = DEFAULT_ONLY,
  maxUrlLength = 6000,
  maxTagsPerBatch = 100,
} = {}) {
  if (!Number.isInteger(maxTagsPerBatch) || maxTagsPerBatch < 1) throw new Error('maxTagsPerBatch must be a positive integer');
  const batches = [];
  let current = [];
  for (const tag of tags) {
    const candidate = [...current, tag];
    const tooManyTags = candidate.length > maxTagsPerBatch;
    const tooLong = !tooManyTags && buildTagLookupUrl(candidate, { baseUrl, only }).length > maxUrlLength;
    if (current.length && (tooManyTags || tooLong)) {
      batches.push(current);
      current = [tag];
      if (buildTagLookupUrl(current, { baseUrl, only }).length > maxUrlLength) {
        throw new Error(`Tag cannot fit within max URL length: ${tag}`);
      }
    } else {
      if (tooLong) throw new Error(`Tag cannot fit within max URL length: ${tag}`);
      current = candidate;
    }
  }
  if (current.length) batches.push(current);
  return batches;
}

function normalizeWikiRecord(wikiPage) {
  if (!wikiPage || typeof wikiPage !== 'object') return null;
  return {
    id: Number.isInteger(wikiPage.id) ? wikiPage.id : null,
    title: typeof wikiPage.title === 'string' ? wikiPage.title : '',
    body: typeof wikiPage.body === 'string' ? wikiPage.body : '',
    otherNames: Array.isArray(wikiPage.other_names)
      ? wikiPage.other_names.filter(name => typeof name === 'string')
      : [],
  };
}

export function mapTagLookupResponse(requestedTags, payload, fetchedAt) {
  if (!Array.isArray(payload)) throw new Error('Danbooru tag lookup response must be an array');
  const responseByKey = new Map();
  for (const result of payload) {
    if (!result || typeof result.name !== 'string') continue;
    responseByKey.set(normalizeWikiTagKey(result.name), result);
  }
  return requestedTags.map(requestedTag => {
    const result = responseByKey.get(normalizeWikiTagKey(requestedTag));
    return {
      normalizedTag: normalizeWikiTagKey(requestedTag),
      requestedTag,
      fetchedAt,
      found: Boolean(result),
      name: typeof result?.name === 'string' ? result.name : '',
      category: Number.isInteger(result?.category) ? result.category : null,
      wiki: normalizeWikiRecord(result?.wiki_page),
    };
  });
}

export function parseWikiCacheLines(cacheText) {
  const cache = new Map();
  const lines = String(cacheText).split(/\r?\n/).filter(line => line.trim() !== '');
  for (const [index, line] of lines.entries()) {
    let record;
    try {
      record = JSON.parse(line);
    } catch (error) {
      throw new Error(`Invalid wiki cache line ${index + 1}: ${error.message}`);
    }
    if (!record || typeof record !== 'object' || typeof record.normalizedTag !== 'string' || !record.normalizedTag
      || typeof record.requestedTag !== 'string' || typeof record.found !== 'boolean') {
      throw new Error(`Invalid wiki cache record at line ${index + 1}`);
    }
    cache.set(record.normalizedTag, record);
  }
  return cache;
}

export function loadWikiCache(cachePath) {
  if (!fs.existsSync(cachePath)) return new Map();
  return parseWikiCacheLines(fs.readFileSync(cachePath, 'utf8'));
}

function appendWikiCache(cachePath, records) {
  if (!records.length) return;
  fs.mkdirSync(path.dirname(cachePath), { recursive: true });
  fs.appendFileSync(cachePath, `${records.map(record => JSON.stringify(record)).join('\n')}\n`, 'utf8');
}

function parseInputRows(csvText) {
  return String(csvText)
    .split(/\r?\n/)
    .filter(line => line.trim() !== '')
    .map((line, index) => {
      const comma = line.indexOf(',');
      if (comma <= 0) throw new Error(`Invalid tag row at line ${index + 1}`);
      return { i: index + 1, tag: line.slice(0, comma).trim(), alias: line.slice(comma + 1).trim() };
    });
}

function isSuspiciousTagRow(row) {
  const alias = String(row.alias ?? '').trim();
  const normalizedTag = String(row.tag).replace(/[ _-]/g, '').toLowerCase();
  const normalizedAlias = alias.replace(/[ _-]/g, '').toLowerCase();
  const hasNoJapanese = alias !== '' && !/[ぁ-んァ-ン一-龯々〆ヵヶー]/.test(alias);
  const isUnchanged = alias !== '' && normalizedAlias === normalizedTag;
  return alias === '' || hasNoJapanese || isUnchanged || SUSPICIOUS_ALIAS_PATTERNS.test(alias);
}

function sleep(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function retryAfterMs(response) {
  const value = response.headers.get('retry-after');
  if (!value) return 0;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, Math.ceil(seconds * 1000));
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? Math.max(0, timestamp - Date.now()) : 0;
}

function exponentialBackoffMs(attempt) {
  return Math.min(30_000, 1_000 * (2 ** attempt));
}

async function fetchTagBatch(url, { retryCount, userAgent = DEFAULT_USER_AGENT } = {}) {
  for (let attempt = 0; ; attempt += 1) {
    const response = await fetch(url, {
      headers: { 'user-agent': userAgent, accept: 'application/json' },
      signal: AbortSignal.timeout(60_000),
    });
    if (response.ok) return response.json();
    const retryable = response.status === 429 || response.status >= 500;
    if (!retryable || attempt >= retryCount) {
      throw new Error(`Danbooru tag lookup failed with HTTP ${response.status}: ${await response.text()}`);
    }
    const waitMs = Math.max(retryAfterMs(response), exponentialBackoffMs(attempt));
    process.stdout.write(`HTTP ${response.status}; retrying in ${waitMs} ms...\n`);
    await sleep(waitMs);
  }
}

function printHelp() {
  console.log(`Fetch Danbooru tag Wiki metadata into a resumable JSONL cache.

Examples:
  node scripts/fetchDanbooruWiki.mjs --suspicious-only --limit 500
  node scripts/fetchDanbooruWiki.mjs --suspicious-only --cache data/.cache/danbooru-wiki.jsonl

The default is sequential with a 1000 ms client-side delay. Cached tag keys,
including missing tags, are skipped on later runs. Use --refresh to fetch them again.
`);
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) return printHelp();
  const rows = parseInputRows(fs.readFileSync(args.input, 'utf8'));
  const pool = args.suspiciousOnly ? rows.filter(isSuspiciousTagRow) : rows;
  const selected = pool.slice(args.offset, args.limit ? args.offset + args.limit : undefined);
  const requestedTags = deduplicateTagNames(selected);
  const cache = loadWikiCache(args.cache);
  const pendingTags = args.refresh
    ? requestedTags
    : requestedTags.filter(tag => !cache.has(normalizeWikiTagKey(tag)));
  const batches = splitTagBatches(pendingTags, {
    baseUrl: args.baseUrl,
    maxUrlLength: args.maxUrlLength,
    maxTagsPerBatch: args.batchSize,
  });
  console.log(JSON.stringify({
    inputRows: rows.length,
    selectedRows: selected.length,
    uniqueTags: requestedTags.length,
    cachedTags: requestedTags.length - pendingTags.length,
    pendingTags: pendingTags.length,
    batches: batches.length,
    cache: args.cache,
  }));
  let lastRequestAt = 0;
  for (const [index, batch] of batches.entries()) {
    const waitMs = Math.max(0, args.minDelayMs - (Date.now() - lastRequestAt));
    if (waitMs) await sleep(waitMs);
    const url = buildTagLookupUrl(batch, { baseUrl: args.baseUrl });
    process.stdout.write(`Fetching batch ${index + 1}/${batches.length} (${batch.length} tags)...\n`);
    const payload = await fetchTagBatch(url, { retryCount: args.retryCount });
    lastRequestAt = Date.now();
    const records = mapTagLookupResponse(batch, payload, new Date().toISOString());
    appendWikiCache(args.cache, records);
    for (const record of records) cache.set(record.normalizedTag, record);
    process.stdout.write(`Cached ${records.length} tags (${records.filter(record => record.wiki).length} with Wiki pages).\n`);
  }
  console.log(JSON.stringify({ fetchedTags: pendingTags.length, cache: args.cache }));
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch(error => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}
