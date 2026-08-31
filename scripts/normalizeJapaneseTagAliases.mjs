import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { formatTagRows, parseTagRows } from './reviewJapaneseTags.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectDir = path.dirname(scriptDir);
const DEFAULT_INPUT = path.join(projectDir, 'data', 'danbooru_e621_merged_ja.csv');
const WORK_NAMES_PATH = path.join(projectDir, 'data', 'official_work_names.json');

const EXACT_ALIAS_OVERRIDES = new Map([
  ['ear piercing', '耳ピアス'],
  ['mole on breast', '胸のほくろ'],
  ['sex from behind', '後背位'],
  ['halo', 'ヘイロー'],
  ['holding rocket launcher', 'ロケットランチャーを持っている'],
  ['holding halo', 'ヘイローを手に持っている'],
  ['holding staff', '杖を持っている'],
  ['holding breath', '息を止めている'],
  ['holding poke ball', 'モンスターボールを持っている'],
  ['holding paper', '紙を持っている'],
  ['holding axe', '斧を持っている'],
  ['holding pickaxe', 'つるはしを持っている'],
  ['holding grenade', '手榴弾を持っている'],
  ['holding drinking straw', 'ストローを持っている'],
  ['holding with tail', '尾で物を持っている'],
  ['holding plate', '皿を持っている'],
  ['holding instrument', '楽器を持っている'],
  ['holding card', 'カードを持っている'],
  ['holding wand', '杖を持っている'],
  ['holding can', '缶を持っている'],
  ['holding shield', '盾を持っている'],
  ['holding box', '箱を持っている'],
  ['holding sign', '看板を持っている'],
  ['holding branch', '枝を持っている'],
  ['holding heart', 'ハートを持っている'],
  ['holding notebook', 'ノートを持っている'],
  ['holding test tube', '試験管を持っている'],
  ['holding menu', 'メニューを持っている'],
  ['holding marker', 'マーカーを持っている'],
  ['holding magazine', '雑誌を持っている'],
  ['holding star', '星を持っている'],
  ['holding handcuffs', '手錠を持っている'],
  ['holding club', '棍棒を持っている'],
  ['holding golf club', 'ゴルフクラブを持っている'],
  ['holding sheet', 'シーツを持っている'],
  ['holding magazine (weapon)', '弾倉を持っている（武器）'],
  ['holding hands is lewd', '手をつなぐのは淫ら'],
  ['holding belt', 'ベルトを持っている'],
  ['holding by the ears', '耳をつかんで持ち上げている'],
  ['holding party popper', 'パーティークラッカーを持っている'],
  ['holding scale', 'はかりを持っている'],
  ['holding scanner', 'スキャナーを持っている'],
]);

const WORK_NAMES = new Map(
  Object.entries(JSON.parse(fs.readFileSync(WORK_NAMES_PATH, 'utf8')))
    .map(([tag, name]) => [normalizeTagKey(tag), name]),
);

function normalizeTagKey(value) {
  return String(value).replace(/_/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
}

function findWorkKey(tag) {
  const normalizedTag = normalizeTagKey(tag);
  if (WORK_NAMES.has(normalizedTag)) return normalizedTag;

  const seriesMatch = normalizedTag.match(/^(.*) \(series\)$/);
  if (seriesMatch && WORK_NAMES.has(seriesMatch[1])) return seriesMatch[1];

  const colonIndex = normalizedTag.indexOf(':');
  if (colonIndex > 0) {
    const root = normalizedTag.slice(0, colonIndex).trim();
    if ((root.startsWith('fate/') || root.startsWith('toaru ')) && WORK_NAMES.has(root)) {
      return root;
    }
  }

  return [...WORK_NAMES.keys()]
    .filter(key => key.length > 2)
    .sort((left, right) => right.length - left.length)
    .find(key => normalizedTag.includes(`(${key})`)) || null;
}

function isSeriesWorkTag(tag, workKey) {
  return normalizeTagKey(tag) === `${workKey} (series)`;
}

function isDirectWorkTag(tag, workKey) {
  const normalizedTag = normalizeTagKey(tag);
  return normalizedTag === workKey
    || normalizedTag.startsWith(`${workKey}:`);
}

function replaceFatePrefix(alias, workName) {
  return alias.replace(/^運命\/[^：:]+/i, workName);
}

function replaceWorkAnnotation(alias, tag, workKey, workName) {
  const sourceParts = [...String(tag).matchAll(/\(([^()]*)\)/g)]
    .map(match => normalizeTagKey(match[1]));
  const workIndex = sourceParts.indexOf(workKey);
  if (workIndex < 0) return alias;

  const aliasParts = [...String(alias).matchAll(/（[^（）]*）|\([^()]*\)/g)];
  const target = aliasParts[workIndex];
  if (!target) return alias;
  const current = target[0].slice(1, -1).trim();
  if (normalizeTagKey(current) === normalizeTagKey(workName)) return alias;
  const open = target[0][0];
  const close = target[0].at(-1);
  const replacement = `${open}${workName}${close}`;
  return `${alias.slice(0, target.index)}${replacement}${alias.slice(target.index + target[0].length)}`;
}

function normalizeHoldingAlias(tag, alias) {
  if (!normalizeTagKey(tag).startsWith('holding ')) return alias;

  const replacements = [
    [/を保持しています(?=（|\(|$)/g, 'を持っている'],
    [/を持っています(?=（|\(|$)/g, 'を持っている'],
    [/を保持します(?=（|\(|$)/g, 'を持っている'],
    [/を保持する(?=（|\(|$)/g, 'を持っている'],
    [/を保持(?=（|\(|$)/g, 'を持っている'],
    [/を抱いています(?=（|\(|$)/g, 'を抱いている'],
    [/を抱えています(?=（|\(|$)/g, 'を抱えている'],
    [/を握っています(?=（|\(|$)/g, 'を握っている'],
  ];
  return replacements.reduce(
    (current, [pattern, replacement]) => current.replace(pattern, replacement),
    alias,
  );
}

export function normalizeJapaneseTagAlias(tag, alias) {
  const normalizedTag = normalizeTagKey(tag);
  const currentAlias = String(alias ?? '').trim();
  const exactOverride = EXACT_ALIAS_OVERRIDES.get(normalizedTag);
  if (exactOverride) return exactOverride;

  const holdingAlias = normalizeHoldingAlias(tag, currentAlias);
  if (holdingAlias !== currentAlias) return holdingAlias;

  const workKey = findWorkKey(tag);
  if (!workKey) return currentAlias;

  const workName = WORK_NAMES.get(workKey);
  if (!workName) return currentAlias;
  if (isSeriesWorkTag(tag, workKey)) {
    return `${workName}（シリーズ）`;
  }
  if (isDirectWorkTag(tag, workKey)) {
    if (normalizedTag === workKey) return workName;
    if (workKey.startsWith('fate/') && /^運命\//i.test(currentAlias)) {
      return replaceFatePrefix(currentAlias, workName);
    }
  }

  return replaceWorkAnnotation(currentAlias, tag, workKey, workName);
}

export function normalizeJapaneseTagRows(rows) {
  return rows.map(row => ({
    ...row,
    alias: normalizeJapaneseTagAlias(row.tag, row.alias),
  }));
}

function parseArgs(argv) {
  const args = { input: DEFAULT_INPUT, output: '', apply: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--input') args.input = argv[++index];
    else if (arg === '--output') args.output = argv[++index];
    else if (arg === '--apply') args.apply = true;
    else if (arg === '--help') args.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return args;
}

function printHelp() {
  console.log(`Normalize source-backed Japanese tag aliases.

Write a separate output file:
  node scripts/normalizeJapaneseTagAliases.mjs --output <new.csv>

Apply in place after reviewing the output:
  node scripts/normalizeJapaneseTagAliases.mjs --apply
`);
}

export function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) return printHelp();
  if (!args.apply && !args.output) throw new Error('Use --output or explicitly use --apply');

  const rows = parseTagRows(fs.readFileSync(args.input, 'utf8'));
  const normalized = normalizeJapaneseTagRows(rows);
  const changed = normalized.filter((row, index) => row.alias !== rows[index].alias).length;
  const outputPath = args.apply ? args.input : args.output;
  fs.writeFileSync(outputPath, formatTagRows(normalized), 'utf8');
  console.log(JSON.stringify({ inputRows: rows.length, changed, output: outputPath }, null, 2));
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    main();
  } catch (error) {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  }
}
