// The distilled Prose model's server: a llama-server child that SAA starts from the
// settings (ai_prose_student_server = the exe, ai_prose_student_model = the GGUF,
// ai_prose_student_port) the first time a paragraph asks for it, keeps for the session,
// and stops on exit. The renderer talks to it as a plain OpenAI-style endpoint
// (remoteAI_backend.js, buildLlamaChatRequest) once `ensure` says it answers.
//
// Not detached: unlike ComfyUI, nothing of it must outlive SAA, so it dies with the app.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

const CAT = '[ProseStudent]';
const READY_TIMEOUT_MS = 90_000;
const POLL_MS = 500;

let child = null;
let running = { server: '', model: '', port: 0 };

export function studentUrl(port) {
    return `http://127.0.0.1:${Number(port) || 8090}/v1/chat/completions`;
}

/** The launch line for the student's llama-server: every layer on the GPU, one slot. */
export function studentServerArgs({ model, port }) {
    return ['-m', model, '--port', String(port), '-ngl', '99', '-fa', 'on', '-c', '4096', '-np', '1',
        '--jinja', '--reasoning-budget', '0', '--no-webui'];
}

/** The settings the server needs, or the reason it cannot start. */
export function studentSpec(settings = {}) {
    const server = String(settings.ai_prose_student_server ?? '').trim();
    const model = String(settings.ai_prose_student_model ?? '').trim();
    const port = Number.parseInt(settings.ai_prose_student_port, 10) || 8090;
    if (!server) return { ok: false, message: 'no llama-server path' };
    if (!model) return { ok: false, message: 'no model path' };
    if (!existsSync(server)) return { ok: false, message: `llama-server not found: ${server}` };
    if (!existsSync(model)) return { ok: false, message: `model not found: ${model}` };
    return { ok: true, server, model, port };
}

async function healthy(port, timeout = 1500) {
    try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeout);
        const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: controller.signal });
        clearTimeout(timer);
        if (!response.ok) return false;
        const body = await response.json().catch(() => ({}));
        return body?.status === 'ok';
    } catch {
        return false;
    }
}

function sameAsRunning(spec) {
    return child && !child.killed && child.exitCode === null
        && running.server === spec.server && running.model === spec.model && running.port === spec.port;
}

/**
 * Makes sure the student's server answers for the current settings: reuses the running
 * child, restarts it when the exe / model / port changed, or starts it. Resolves
 * { ok, apiUrl } or { ok: false, message }.
 */
export async function ensureProseStudent(settings = {}) {
    const spec = studentSpec(settings);
    if (!spec.ok) return spec;
    if (sameAsRunning(spec) && await healthy(spec.port)) return { ok: true, apiUrl: studentUrl(spec.port) };
    // something else already on the port (a server the user started by hand): use it
    if (!child && await healthy(spec.port)) return { ok: true, apiUrl: studentUrl(spec.port) };
    stopProseStudent();
    console.log(CAT, `starting ${path.basename(spec.server)} with ${path.basename(spec.model)} on :${spec.port}`);
    try {
        child = spawn(spec.server, studentServerArgs(spec), {
            cwd: path.dirname(spec.server),
            windowsHide: true,
            stdio: 'ignore',
        });
    } catch (error) {
        child = null;
        return { ok: false, message: `spawn failed: ${error?.message ?? error}` };
    }
    running = { server: spec.server, model: spec.model, port: spec.port };
    const started = child;
    started.on('exit', code => {
        if (child === started) child = null;
        console.log(CAT, `llama-server exited (${code})`);
    });
    const deadline = Date.now() + READY_TIMEOUT_MS;
    while (Date.now() < deadline) {
        if (started.exitCode !== null) return { ok: false, message: `llama-server exited with ${started.exitCode}` };
        if (await healthy(spec.port)) return { ok: true, apiUrl: studentUrl(spec.port) };
        await new Promise(resolve => setTimeout(resolve, POLL_MS));
    }
    stopProseStudent();
    return { ok: false, message: 'llama-server did not answer in time' };
}

export function stopProseStudent() {
    if (!child) return;
    try { child.kill(); } catch { /* already gone */ }
    child = null;
    running = { server: '', model: '', port: 0 };
}

export function registerProseStudent(ipcMain, getSettings) {
    ipcMain.handle('prose-student-ensure', async () => {
        try {
            return await ensureProseStudent(getSettings() ?? {});
        } catch (error) {
            return { ok: false, message: error?.message ?? String(error) };
        }
    });
}
