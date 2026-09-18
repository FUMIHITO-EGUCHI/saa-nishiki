// Extra ComfyUI launch flags that go with fast mode (pure, no I/O).
//
// Some speed-ups are process-wide switches of ComfyUI, not workflow values:
// --use-sage-attention swaps the attention kernel for every model, --fast turns on
// torch-level options (fp16 accumulation, cuDNN autotune). They cannot be set per
// prompt, so the ComfyUI process has to be started with them — and started without
// them for a run that should not have them (--fast shifts the colours of an Anima
// picture; an SDXL run may want none of it). Each fast set carries its own flags:
//   api_fast_comfy_args       Checkpoint (SDXL / Illustrious) fast mode
//   api_fast_diff_comfy_args  Diffusion (Anima) fast mode
// With fast mode off, or on a route whose flags are empty, none of those flags are
// wanted. Flags that appear in neither setting belong to the user's own launch
// command and are never judged.
//
// scripts/main/comfyProcess.js compares what a run wants with the running process
// (GET /system_stats → system.argv) and restarts the local backend on a difference.

import { isFastModeActive } from './fastMode.js';

// One token of a flag string. Launch commands pass through cmd.exe, PowerShell or a
// POSIX shell, so anything that could quote, expand or chain is refused outright
// (spaces separate tokens; no quotes, $, %, ^, !, &, |, ;, <, >, backticks, parens).
const SAFE_TOKEN = /^[A-Za-z0-9_.:=/+-]+$/;

// "--use-sage-attention --fast" → { args: ['--use-sage-attention', '--fast'], invalid: [] }
// All or nothing: one refused token and the string yields no args, so half a flag
// string is never launched (and a broken setting never takes flags away either).
export function parseLaunchArgs(text) {
    const tokens = String(text ?? '').trim().split(/\s+/).filter(Boolean);
    const invalid = tokens.filter((token, index) => !SAFE_TOKEN.test(token)
        // a value needs a flag in front of it
        || (index === 0 && !token.startsWith('-')));
    return { args: invalid.length > 0 ? [] : tokens, invalid };
}

// ['--fast', 'autotune', '--use-sage-attention'] → [{ flag: '--fast', values: ['autotune'] }, { flag: '--use-sage-attention', values: [] }]
// Values are the tokens after a flag up to the next token that starts with "--".
export function flagGroups(tokens) {
    const groups = [];
    for (const token of Array.isArray(tokens) ? tokens : []) {
        const text = String(token ?? '');
        if (text.startsWith('--') && text.length > 2) {
            groups.push({ flag: text, values: [] });
        } else if (groups.length > 0) {
            groups.at(-1).values.push(text);
        }
    }
    return groups;
}

function settingKey(diffusion) {
    return diffusion ? 'api_fast_diff_comfy_args' : 'api_fast_comfy_args';
}

// The flags a run on this route wants the process to have (tokens, in order).
export function desiredLaunchArgs(settings = {}, { diffusion = false } = {}) {
    if (!isFastModeActive(settings)) return [];
    return parseLaunchArgs(settings?.[settingKey(diffusion)]).args;
}

// Refused tokens of the setting that applies to this route (reported, never launched).
export function invalidLaunchArgs(settings = {}, { diffusion = false } = {}) {
    if (!isFastModeActive(settings)) return [];
    return parseLaunchArgs(settings?.[settingKey(diffusion)]).invalid;
}

// Every flag name either fast set may add: the ones SAA owns and may take away again.
export function managedLaunchFlags(settings = {}) {
    const flags = new Set();
    for (const diffusion of [false, true]) {
        for (const group of flagGroups(parseLaunchArgs(settings?.[settingKey(diffusion)]).args)) flags.add(group.flag);
    }
    return flags;
}

/**
 * Compares a running ComfyUI's argv with what a run wants.
 *   missing  — wanted flags the process lacks (or has with other values), as "--flag v1 v2"
 *   unwanted — managed flags the process has but this run does not want
 * `argv` is sys.argv (argv[0], the main.py path, is skipped by flagGroups: it is no flag).
 */
export function compareLaunchArgs(argv, desired, managed) {
    const running = flagGroups(argv);
    const wanted = flagGroups(desired);
    const sameValues = (a, b) => a.length === b.length && a.every((value, index) => value === b[index]);
    const missing = [];
    for (const group of wanted) {
        const present = running.filter(item => item.flag === group.flag);
        if (!present.some(item => sameValues(item.values, group.values))) {
            missing.push([group.flag, ...group.values].join(' '));
        }
    }
    const wantedFlags = new Set(wanted.map(group => group.flag));
    const unwanted = [...new Set(running.map(group => group.flag))]
        .filter(flag => managed instanceof Set && managed.has(flag) && !wantedFlags.has(flag));
    return { match: missing.length === 0 && unwanted.length === 0, missing, unwanted };
}
