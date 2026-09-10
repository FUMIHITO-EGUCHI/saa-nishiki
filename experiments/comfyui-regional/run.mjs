// Queues regional-compare.api.json on a running ComfyUI and waits for both images.
// Only needed to check that the graph executes - normal use is to drag
// regional-compare.workflow.json onto the ComfyUI canvas and hit Run.
//
//   node run.mjs [--host=http://127.0.0.1:8189] [--save=<dir>]

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const arg = (name, fallback) => process.argv.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const HOST = arg('host', 'http://127.0.0.1:8189').replace(/\/$/, '');
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SAVE = arg('save', '');

const prompt = JSON.parse(fs.readFileSync(path.join(HERE, 'regional-compare.api.json'), 'utf8'));
const clientId = `saa-regional-${Date.now()}`;

const queued = await fetch(`${HOST}/prompt`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prompt, client_id: clientId }),
});
const body = await queued.json();
if (!queued.ok) {
    console.error(JSON.stringify(body, null, 2));
    process.exit(1);
}
const promptId = body.prompt_id;
console.log(`queued ${promptId} (number ${body.number})`);

const started = Date.now();
for (;;) {
    await new Promise(resolve => setTimeout(resolve, 3000));
    const history = await (await fetch(`${HOST}/history/${promptId}`)).json();
    const entry = history[promptId];
    if (entry) {
        const status = entry.status?.status_str ?? 'unknown';
        console.log(`${status} after ${Math.round((Date.now() - started) / 1000)}s`);
        if (status === 'error') {
            console.error(JSON.stringify(entry.status?.messages ?? entry.status, null, 2));
            process.exit(1);
        }
        for (const [nodeId, output] of Object.entries(entry.outputs ?? {})) {
            for (const image of output.images ?? []) {
                const query = new URLSearchParams({ filename: image.filename, subfolder: image.subfolder ?? '', type: image.type ?? 'output' });
                console.log(`node ${nodeId} (${prompt[nodeId]?._meta?.title ?? ''}): ${image.subfolder}/${image.filename}`);
                if (SAVE) {
                    fs.mkdirSync(SAVE, { recursive: true });
                    const bytes = Buffer.from(await (await fetch(`${HOST}/view?${query}`)).arrayBuffer());
                    const target = path.join(SAVE, image.filename);
                    fs.writeFileSync(target, bytes);
                    console.log(`  saved ${target}`);
                }
            }
        }
        break;
    }
    const queue = await (await fetch(`${HOST}/queue`)).json();
    const pending = (queue.queue_running?.length ?? 0) + (queue.queue_pending?.length ?? 0);
    process.stdout.write(`  waiting ${Math.round((Date.now() - started) / 1000)}s (queue ${pending})\r`);
    if (Date.now() - started > 20 * 60 * 1000) { console.error('\ntimed out'); process.exit(1); }
}
