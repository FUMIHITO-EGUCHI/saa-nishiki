// Puts an image into ComfyUI's input folder so LoadImage can name it.
//
//   node upload.mjs pose.png [--host=…] [--name=saa-pose-feeding.png]

import fs from 'node:fs';
import path from 'node:path';

export async function uploadImage(host, file, name = path.basename(file)) {
    const form = new FormData();
    form.set('image', new Blob([fs.readFileSync(file)], { type: 'image/png' }), name);
    form.set('overwrite', 'true');
    const response = await fetch(`${host.replace(/\/$/, '')}/upload/image`, { method: 'POST', body: form });
    if (!response.ok) throw new Error(`upload of ${name} failed: ${response.status} ${await response.text()}`);
    const body = await response.json();
    return body.subfolder ? `${body.subfolder}/${body.name}` : body.name;
}

if (import.meta.url === `file://${process.argv[1].replaceAll('\\', '/')}`) {
    const arg = (key, fallback) => process.argv.find(a => a.startsWith(`--${key}=`))?.slice(key.length + 3) ?? fallback;
    const file = process.argv[2];
    if (!file) throw new Error('usage: node upload.mjs <file> [--name=…] [--host=…]');
    const stored = await uploadImage(arg('host', 'http://127.0.0.1:8189'), file, arg('name', path.basename(file)));
    console.log(stored);
}
