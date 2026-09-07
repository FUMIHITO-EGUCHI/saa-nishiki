// Shared LLM backends for the dictionary batch scripts (categorizeTags.mjs,
// reviewJapaneseTags.mjs).
//
// Routing policy: every batch goes to Codex first (fast, accurate); a batch
// Codex refuses or garbles is re-run on an uncensored Ollama model, either on
// the Runpod pod over the SSH relay or locally. --nsfw-direct sends obviously
// explicit tags straight to that fallback model, saving Codex round-trips.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeKeepAlive } from './shared/ollamaModels.js';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectDir = path.dirname(scriptDir);

export const DEFAULT_OLLAMA_MODEL = 'hf.co/HauhauCS/Qwen3.5-35B-A3B-Uncensored-HauhauCS-Aggressive:Q4_K_M';
export const DEFAULT_CODEX_MODEL = 'gpt-5.6-luna';
export const DEFAULT_POD_MODEL = 'huihui_ai/qwen3-abliterated:8b';
export const DEFAULT_POD_SETTINGS = path.join(projectDir, 'settings', 'app.json');
export const OLLAMA_URL = process.env.OLLAMA_TAG_REVIEW_URL || 'http://127.0.0.1:11434/api/chat';
export const BACKENDS = Object.freeze(['auto', 'codex', 'ollama', 'pod']);
export const FALLBACKS = Object.freeze(['ollama', 'pod']);
export const CODEX_EFFORTS = Object.freeze(['minimal', 'low', 'medium', 'high', 'xhigh']);
// Codex batches at or below this size go to the fallback model when they fail.
export const CODEX_SPLIT_FLOOR = 25;

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

// ---- CLI arguments shared by every batch script ---------------------------

export function backendArgDefaults() {
  return {
    backend: 'auto',
    model: DEFAULT_OLLAMA_MODEL,
    codexModel: DEFAULT_CODEX_MODEL,
    // '' = the reasoning effort from ~/.codex/config.toml (the user's default, e.g. xhigh)
    codexEffort: '',
    podModel: DEFAULT_POD_MODEL,
    podModelExplicit: false,
    podSettings: DEFAULT_POD_SETTINGS,
    fallback: '',
    nsfwDirect: false,
    batchSize: 40,
    codexBatchSize: 100,
  };
}

// Consumes one backend option at argv[index]; returns how many argv entries
// were used (0 when the option is not a backend option).
export function takeBackendArg(args, argv, index) {
  const arg = argv[index];
  const value = () => argv[index + 1];
  switch (arg) {
    case '--backend': args.backend = value(); return 2;
    case '--model': args.model = value(); return 2;
    case '--codex-model': args.codexModel = value(); return 2;
    case '--codex-effort': args.codexEffort = value(); return 2;
    case '--pod-model': args.podModel = value(); args.podModelExplicit = true; return 2;
    case '--pod-settings': args.podSettings = value(); return 2;
    case '--fallback': args.fallback = value(); return 2;
    case '--nsfw-direct': args.nsfwDirect = true; return 1;
    case '--batch-size': args.batchSize = Number.parseInt(value(), 10); return 2;
    case '--codex-batch-size': args.codexBatchSize = Number.parseInt(value(), 10); return 2;
    default: return 0;
  }
}

export function isPodConfigured(podSettingsPath) {
  try {
    const file = JSON.parse(fs.readFileSync(podSettingsPath, 'utf8'));
    const raw = file?.data ?? file;
    return raw.api_pod_ssh_enable === true && Boolean(String(raw.api_pod_ssh_target ?? '').trim());
  } catch {
    return false;
  }
}

export function validateBackendArgs(args) {
  if (!Number.isInteger(args.batchSize) || args.batchSize < 1 || args.batchSize > 200) {
    throw new Error('--batch-size must be an integer from 1 to 200');
  }
  if (!Number.isInteger(args.codexBatchSize) || args.codexBatchSize < 1 || args.codexBatchSize > 200) {
    throw new Error('--codex-batch-size must be an integer from 1 to 200');
  }
  if (!BACKENDS.includes(args.backend)) throw new Error('--backend must be auto, ollama, codex, or pod');
  if (args.codexEffort && !CODEX_EFFORTS.includes(args.codexEffort)) throw new Error(`--codex-effort must be one of ${CODEX_EFFORTS.join(', ')}`);
  // where a batch Codex refuses or garbles goes: the pod when its SSH is configured, else the local model
  if (!args.fallback) args.fallback = isPodConfigured(args.podSettings) ? 'pod' : 'ollama';
  if (!FALLBACKS.includes(args.fallback)) throw new Error('--fallback must be ollama or pod');
  return args;
}

export function backendHelpText() {
  return `Backends (--backend auto|codex|ollama|pod, default auto):
  auto sends everything to Codex first (--codex-model, default ${DEFAULT_CODEX_MODEL};
  --codex-effort minimal|low|medium|high|xhigh, default: ~/.codex/config.toml);
  a batch Codex refuses or garbles falls back to --fallback (pod when the SSH
  pod is configured in --pod-settings, default settings/app.json; else ollama).
  --nsfw-direct sends explicit tags straight to the fallback model instead.
  pod = the Ollama model on the Runpod pod over the SSH relay (--pod-model,
  default ${DEFAULT_POD_MODEL}); ollama = OLLAMA_TAG_REVIEW_URL / 127.0.0.1:11434
  (--model, default ${DEFAULT_OLLAMA_MODEL}).
  --batch-size N (Ollama/pod, default 40), --codex-batch-size N (default 100).`;
}

// Splits the selected rows into backend lanes according to --backend / --nsfw-direct.
export function planLanes(args, rows) {
  if (args.backend !== 'auto') return [{ backend: args.backend, rows }];
  if (!args.nsfwDirect) return [{ backend: 'codex', rows }];
  return [
    { backend: 'codex', rows: rows.filter(row => !isNsfwTag(row.tag)) },
    { backend: args.fallback, rows: rows.filter(row => isNsfwTag(row.tag)) },
  ];
}

// ---- response helpers -----------------------------------------------------

export function parseJsonRows(content) {
  const text = String(content).trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`LLM returned invalid JSON: ${error.message}`);
  }
  if (!parsed || !Array.isArray(parsed.rows)) throw new Error('LLM JSON does not contain a rows array');
  return parsed.rows;
}

export function splitRows(rows) {
  if (rows.length < 2) return [rows];
  const midpoint = Math.ceil(rows.length / 2);
  return [rows.slice(0, midpoint), rows.slice(midpoint)];
}

// ---- transports -----------------------------------------------------------

function ollamaChatPayload(model, systemPrompt, userContent, schema, keepAlive) {
  return {
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
    keep_alive: keepAlive,
  };
}

async function callLocalOllama(model, systemPrompt, userContent, schema) {
  const response = await fetch(OLLAMA_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    signal: AbortSignal.timeout(300_000),
    // locally VRAM goes back to ComfyUI as soon as the batch is done
    body: JSON.stringify(ollamaChatPayload(model, systemPrompt, userContent, schema, 0)),
  });
  if (!response.ok) throw new Error(`Ollama HTTP ${response.status}: ${await response.text()}`);
  const payload = await response.json();
  if (typeof payload?.message?.content !== 'string') throw new Error('Ollama response has no message content');
  return parseJsonRows(payload.message.content);
}

// Non-interactive Codex call: the prompt goes over stdin, the response shape is
// enforced with --output-schema, and the final message is read from a temp file.
// read-only sandbox; the model is told to answer directly without tools.
export function callCodexJson(model, systemPrompt, userContent, schema, { effort = '' } = {}) {
  const stamp = `saa-batch-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const schemaFile = path.join(os.tmpdir(), `${stamp}-schema.json`);
  const outFile = path.join(os.tmpdir(), `${stamp}-out.json`);
  fs.writeFileSync(schemaFile, JSON.stringify(schema), 'utf8');
  try {
    const commandLine = [
      'codex', 'exec', '--ephemeral', '--skip-git-repo-check', '--color', 'never',
      '-s', 'read-only',
      '-m', model,
      // reasoning effort and service tier come from ~/.codex/config.toml unless --codex-effort is given
      ...(effort ? ['-c', `model_reasoning_effort="${effort}"`] : []),
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
    return parseJsonRows(fs.readFileSync(outFile, 'utf8'));
  } finally {
    fs.rmSync(schemaFile, { force: true });
    fs.rmSync(outFile, { force: true });
  }
}

// ---- client ---------------------------------------------------------------

// `transports` lets tests replace the real Codex / Ollama / pod calls.
export function createBatchClient(args, transports = {}) {
  let podTransport = null;

  function podSettings() {
    const file = JSON.parse(fs.readFileSync(args.podSettings, 'utf8'));
    const raw = file && typeof file.data === 'object' ? file.data : file; // sectioned app.json or a flat object
    if (raw.api_pod_ssh_enable !== true || !String(raw.api_pod_ssh_target ?? '').trim()) {
      throw new Error(`pod SSH is not configured in ${args.podSettings} (api_pod_ssh_enable / api_pod_ssh_target)`);
    }
    return raw;
  }

  // --pod-model wins; otherwise the app's ai_pod_model setting; otherwise the default
  function podModel() {
    if (args.podModelExplicit) return args.podModel;
    try {
      const raw = JSON.parse(fs.readFileSync(args.podSettings, 'utf8'));
      const configured = String(raw?.data?.ai_pod_model ?? raw?.ai_pod_model ?? '').trim();
      if (configured) return configured;
    } catch { /* no settings file */ }
    return args.podModel;
  }

  // the pod keeps the model warm between batches (the app's ai_pod_keep_alive setting)
  function podKeepAlive() {
    try {
      const raw = JSON.parse(fs.readFileSync(args.podSettings, 'utf8'));
      return normalizeKeepAlive(raw?.data?.ai_pod_keep_alive ?? raw?.ai_pod_keep_alive, '10m');
    } catch {
      return '10m';
    }
  }

  async function callPod(systemPrompt, userContent, schema) {
    podTransport ??= await import('./main/podSshTransport.js');
    const body = ollamaChatPayload(podModel(), systemPrompt, userContent, schema, podKeepAlive());
    const reply = await podTransport.podOllamaRequest({ settings: podSettings(), method: 'POST', path: '/api/chat', body, timeoutMs: 600_000 });
    if (!reply.ok) throw new Error(`pod ollama: ${reply.message}`);
    return parseJsonRows(String(reply.json?.message?.content ?? ''));
  }

  function modelFor(backend) {
    if (backend === 'codex') return args.codexModel;
    if (backend === 'pod') return podModel();
    return args.model;
  }

  function batchSizeFor(backend) {
    return backend === 'codex' ? args.codexBatchSize : args.batchSize;
  }

  async function callJson(backend, systemPrompt, userContent, schema) {
    if (transports[backend]) return transports[backend](systemPrompt, userContent, schema);
    if (backend === 'codex') return callCodexJson(args.codexModel, systemPrompt, userContent, schema, { effort: args.codexEffort });
    if (backend === 'pod') return callPod(systemPrompt, userContent, schema);
    return callLocalOllama(args.model, systemPrompt, userContent, schema);
  }

  // Sends `rows` and returns the validated result rows. A Codex failure
  // (refusal, malformed output) reroutes the whole batch to the fallback model,
  // tagging each row with the model that actually answered; an invalid Ollama
  // response is retried as two halves.
  async function requestRows(backend, rows, { systemPrompt, buildPrompt, schema, validate, label = 'request' }) {
    try {
      const validated = validate(rows, await callJson(backend, systemPrompt, buildPrompt(rows), schema));
      return validated.map(row => ({ ...row, model: row.model || modelFor(backend) }));
    } catch (error) {
      const parts = splitRows(rows);
      if (backend === 'codex') {
        // A malformed answer is far more common than a refusal: retry smaller
        // Codex batches first and hand only a stubborn small batch to the
        // (slow, memory-hungry) fallback model.
        if (rows.length > CODEX_SPLIT_FLOOR) {
          process.stdout.write(`Codex ${label} failed (${error.message.slice(0, 160)}); retrying as ${parts[0].length}+${parts[1].length} rows...\n`);
          return [
            ...await requestRows(backend, parts[0], { systemPrompt, buildPrompt, schema, validate, label }),
            ...await requestRows(backend, parts[1], { systemPrompt, buildPrompt, schema, validate, label }),
          ];
        }
        process.stdout.write(`Codex ${label} failed (${error.message.slice(0, 160)}); falling back to ${args.fallback}...\n`);
        return requestRows(args.fallback, rows, { systemPrompt, buildPrompt, schema, validate, label });
      }
      if (parts.length === 1) throw error;
      process.stdout.write(`Retrying invalid ${label} response as ${parts[0].length}+${parts[1].length} rows...\n`);
      return [
        ...await requestRows(backend, parts[0], { systemPrompt, buildPrompt, schema, validate, label }),
        ...await requestRows(backend, parts[1], { systemPrompt, buildPrompt, schema, validate, label }),
      ];
    }
  }

  // The pod lane keeps an ssh child alive and the model in VRAM: free the GPU
  // for image generation, then close the relay so the process can exit.
  async function close() {
    if (!podTransport) return;
    try {
      await podTransport.podOllamaUnload?.({ settings: podSettings() });
    } catch { /* the pod may already be gone */ }
    podTransport.stopPodSshSession?.();
  }

  return { callJson, requestRows, modelFor, batchSizeFor, close };
}
