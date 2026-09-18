// Waits for the ComfyUI queue to drain, then downloads every image in /history whose
// output subfolder matches a prefix. Use it when a sweep was interrupted after queueing
// (the jobs keep running on the server; only the download stopped).
//
//   node collect.mjs --prefix=regional/sweep --out=./out [--host=…]

import fs from 'node:fs';
import path from 'node:path';

const arg = (name, fallback) => process.argv.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const HOST = arg('host', 'http://127.0.0.1:8189').replace(/\/$/, '');
const PREFIX = arg('prefix', 'regional/sweep');
const OUT = arg('out', './out');

for (;;) {
    const queue = await (await fetch(`${HOST}/queue`)).json();
    const left = (queue.queue_running?.length ?? 0) + (queue.queue_pending?.length ?? 0);
    if (!left) break;
    process.stdout.write(`  ${left} job(s) still queued\r`);
    await new Promise(resolve => setTimeout(resolve, 4000));
}

const history = await (await fetch(`${HOST}/history`)).json();
let saved = 0;
for (const entry of Object.values(history)) {
    for (const output of Object.values(entry.outputs ?? {})) {
        for (const image of output.images ?? []) {
            const subfolder = image.subfolder ?? '';
            // ComfyUI joins the prefix with the OS separator, so on Windows this is "a\b"
            if (!subfolder.replaceAll('\\', '/').startsWith(PREFIX)) continue;
            const dir = path.join(OUT, path.basename(subfolder));
            fs.mkdirSync(dir, { recursive: true });
            // s<seed>_<branch>_00001_.png / pose_00001_.png -> s<seed>_<branch>.png / _pose.png
            const stem = image.filename.replace(/_\d+_?\.png$/, '');
            const name = stem === 'pose' ? '_pose.png' : `${stem}.png`;
            const query = new URLSearchParams({ filename: image.filename, subfolder, type: image.type ?? 'output' });
            const bytes = Buffer.from(await (await fetch(`${HOST}/view?${query}`)).arrayBuffer());
            fs.writeFileSync(path.join(dir, name), bytes);
            saved += 1;
        }
    }
}
console.log(`saved ${saved} images under ${OUT}`);
