#!/usr/bin/env node
// Pod start / stop / status from the command line (issue #4).
//
//   node scripts/podControl.mjs status
//   node scripts/podControl.mjs start
//   node scripts/podControl.mjs stop
//   node scripts/podControl.mjs status --settings C:\path\to\settings\app.json
//
// The API key comes from RUNPOD_API_KEY or the app setting api_pod_runpod_api_key;
// the pod id from RUNPOD_POD_ID, api_pod_runpod_pod_id, or the SSH target prefix.
// Only status / start / stop exist here: a pod is never terminated from SAA.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ALLOWED_ACTIONS, podAction, resolvePodId } from './shared/runpodApi.js';

const projectDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv) {
    const args = { action: '', settings: path.join(projectDir, 'settings', 'app.json') };
    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        if (arg === '--settings') args.settings = argv[++index];
        else if (arg === '--help' || arg === '-h') args.help = true;
        else if (!args.action) args.action = arg;
    }
    return args;
}

function readSettings(file) {
    try {
        const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
        return raw && typeof raw.data === 'object' ? raw.data : raw; // sectioned app.json or a flat object
    } catch {
        return {};
    }
}

const args = parseArgs(process.argv.slice(2));
if (args.help || !ALLOWED_ACTIONS.includes(args.action)) {
    process.stdout.write(`usage: node scripts/podControl.mjs <${ALLOWED_ACTIONS.join('|')}> [--settings settings/app.json]\n`);
    process.exit(args.help ? 0 : 2);
}
const settings = readSettings(args.settings);
const apiKey = process.env.RUNPOD_API_KEY || settings.api_pod_runpod_api_key;
const podId = process.env.RUNPOD_POD_ID || resolvePodId(settings);
if (!podId) {
    process.stderr.write('pod id unknown: set RUNPOD_POD_ID, api_pod_runpod_pod_id, or the SSH target in settings\n');
    process.exit(2);
}
const result = await podAction({ apiKey, podId, action: args.action });
if (!result.ok) {
    process.stderr.write(`${result.message}\n`);
    process.exit(1);
}
const pod = result.pod ?? {};
process.stdout.write(`${args.action} ${podId}: ${pod.desiredStatus ?? 'ok'}${pod.gpu ? ` · ${pod.gpu}` : ''}${Number.isFinite(pod.costPerHr) ? ` · $${pod.costPerHr.toFixed(2)}/h` : ''}\n`);
