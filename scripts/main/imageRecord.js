// Where a generated image ended up on disk, and the generation time written into it.
//
// ComfyUI's saver reports a file as { filename, subfolder, type } relative to its output
// directory, which SAA has no setting for: a ComfyUI on this machine tells it through
// /system_stats (its argv, with --output-directory or --base-directory) or, failing those,
// /internal/folder_paths (the base directory holds custom_nodes and output side by side).
// A remote ComfyUI's folders are not on this disk, so no path is guessed for one.
//
// The time an image took is only known after the saver wrote it, so it is added to the
// saved PNG afterwards as the "saa_time" text chunk (the recipe went in with the prompt).

import fs from 'node:fs';
import path from 'node:path';

import { backendAuthHeaders, httpApiUrl, isSecureApiAddress } from '../shared/backendAddress.js';
import { asciiJson, insertTextChunks, isPng } from '../shared/pngText.js';
import { TIME_CHUNK } from '../shared/recipe.js';

const CAT = '[ImageRecord]';
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]', '0.0.0.0']);
const outputDirs = new Map();   // addr -> Promise<string>

export function isLocalAddress(addr) {
    if (isSecureApiAddress(addr)) return false;
    const host = String(addr ?? '').trim().replace(/^https?:\/\//i, '').replace(/:\d+$/, '').toLowerCase();
    return LOOPBACK.has(host);
}

function pathApi(sample) {
    return /^[a-zA-Z]:[\\/]|\\/.test(String(sample ?? '')) ? path.win32 : path.posix;
}

function argValue(argv, name) {
    for (let index = 0; index < argv.length; index++) {
        const arg = String(argv[index] ?? '');
        if (arg === name) return String(argv[index + 1] ?? '');
        if (arg.startsWith(`${name}=`)) return arg.slice(name.length + 1);
    }
    return '';
}

/**
 * ComfyUI's output directory from what it reports: `stats` (/system_stats) and
 * `folderPaths` (/internal/folder_paths). '' when neither says.
 */
export function outputDirFromStats(stats, folderPaths) {
    const argv = Array.isArray(stats?.system?.argv) ? stats.system.argv : [];
    const main = String(argv[0] ?? '');
    const api = pathApi(main || folderPaths?.custom_nodes?.[0]);
    const resolve = value => (api.isAbsolute(value) ? api.normalize(value) : (api.isAbsolute(main) ? api.resolve(api.dirname(main), value) : ''));
    const output = argValue(argv, '--output-directory');
    if (output) return resolve(output);
    const base = argValue(argv, '--base-directory');
    if (base) {
        const resolved = resolve(base);
        return resolved ? api.join(resolved, 'output') : '';
    }
    const customNodes = String(folderPaths?.custom_nodes?.[0] ?? '');
    if (customNodes) {
        const nodes = pathApi(customNodes);
        return nodes.join(nodes.dirname(customNodes), 'output');
    }
    return api.isAbsolute(main) ? api.join(api.dirname(main), 'output') : '';
}

async function fetchJson(addr, auth, route) {
    const response = await fetch(httpApiUrl(addr, route), { headers: backendAuthHeaders(auth), signal: AbortSignal.timeout(3000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
}

/** The output directory of the ComfyUI at `addr` when it runs on this machine, else ''. */
export function comfyOutputDir(addr, auth = '') {
    if (!isLocalAddress(addr)) return Promise.resolve('');
    if (!outputDirs.has(addr)) {
        const lookup = (async () => {
            const stats = await fetchJson(addr, auth, 'system_stats').catch(() => null);
            let dir = outputDirFromStats(stats, null);
            if (!argValue(stats?.system?.argv ?? [], '--output-directory')) {
                const folderPaths = await fetchJson(addr, auth, 'internal/folder_paths').catch(() => null);
                if (folderPaths) dir = outputDirFromStats(stats, folderPaths) || dir;
            }
            return dir && fs.existsSync(dir) ? dir : '';
        })();
        outputDirs.set(addr, lookup);
        // a failed lookup (ComfyUI still starting) is tried again next time
        lookup.then(dir => { if (!dir) outputDirs.delete(addr); });
    }
    return outputDirs.get(addr);
}

/** Forget the cached directories (ComfyUI restarted with other flags). */
export function forgetComfyOutputDirs() {
    outputDirs.clear();
}

/** The absolute path of a saver's { filename, subfolder, type } under `outputDir`, or ''. */
export function savedImagePath(outputDir, image) {
    if (!outputDir || image?.type !== 'output' || !image.filename) return '';
    const parts = [outputDir, ...String(image.subfolder ?? '').split(/[\\/]/).filter(Boolean), String(image.filename)];
    const full = path.resolve(...parts);
    const root = path.resolve(outputDir);
    return full.startsWith(root + path.sep) ? full : '';
}

/**
 * Writes `records` ([[keyword, text]]) into the PNG at `file`, keeping its times (the
 * Library sorts by them). Through a temporary file, so a reader never sees half a file.
 */
export async function writePngRecords(file, records) {
    const data = await fs.promises.readFile(file);
    if (!isPng(data)) return false;
    const next = insertTextChunks(data, records);
    if (next === data) return false;
    const stat = await fs.promises.stat(file);
    const temp = `${file}.saa-${process.pid}.tmp`;
    try {
        await fs.promises.writeFile(temp, next);
        await fs.promises.rename(temp, file);
        await fs.promises.utimes(file, stat.atime, stat.mtime);
    } catch (error) {
        await fs.promises.rm(temp, { force: true }).catch(() => {});
        throw error;
    }
    return true;
}

/** Adds the generation time to a saved image. Never throws: the picture matters more. */
export async function stampImageTime(file, timing) {
    if (!file || !timing) return false;
    try {
        return await writePngRecords(file, [[TIME_CHUNK, asciiJson(timing)]]);
    } catch (error) {
        console.warn(CAT, 'could not write the time into', file, error?.message ?? error);
        return false;
    }
}
