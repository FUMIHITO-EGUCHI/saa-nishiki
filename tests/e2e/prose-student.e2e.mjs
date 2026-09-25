// The Prose card's Student writer, end to end: the real app starts the distilled model's
// llama-server itself, the paragraph it writes is what ComfyUI receives as the positive
// prompt, and the card says who wrote it. Skipped when this machine has no student build
// (the server exe and the GGUF are looked for where the SAA stack keeps them).
// Run with `npm run test:e2e`.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import test from 'node:test';

import { launchApp, workflow } from './harness.mjs';

const STACK = 'C:\\Users\\kurah\\Documents\\Codex\\2026-08-15\\huggingface-llm-uncensored\\wai-stack';
const SERVER = process.env.SAA_STUDENT_SERVER || `${STACK}\\runtime\\llama.cpp-b11173\\llama-server.exe`;
const MODEL = process.env.SAA_STUDENT_MODEL || `${STACK}\\models\\llm\\student-v1-q8_0.gguf`;
const PORT = 8093;   // not the 8090 a hand-started student server may hold
const available = existsSync(SERVER) && existsSync(MODEL);

let app = null;

test.before(async () => {
    if (!available) return;
    app = await launchApp({
        settings: {
            api_model_type: 'Diffusion',
            api_model_sampler: 'er_sde', api_model_scheduler: 'simple', step: 6, cfg: 3,
            ai_interface: 'Local',
            ai_prose_enable: true,
            ai_prose_scope: 'all',
            ai_prose_writer: 'student',
            ai_prose_student_server: SERVER,
            ai_prose_student_model: MODEL,
            ai_prose_student_port: PORT,
        },
    });
});
test.after(async () => { await app?.close(); });

test('the student writes the paragraph that reaches ComfyUI, and the card names it', { skip: available ? false : 'no student build on this machine' }, async () => {
    assert.equal(await app.setting('api_model_type'), 'Diffusion');
    assert.equal(await app.setting('ai_prose_writer'), 'student');
    await app.typePositive('1girl, solo, white background, red eyes, smile, holding a red umbrella');
    const run = await app.generate({ expectImages: 1 });
    assert.equal(run.error, '', `no error overlay; log ${app.logFile}`);
    assert.equal(run.history.length, 1);
    const { workflow: wf, outputs } = run.history[0];
    const positive = workflow.positive(wf, outputs) ?? '';
    assert.match(positive, /^1girl, solo, white background/, 'the common tags open the prompt, verbatim');
    assert.match(positive, /\b(girl|she|her)\b.*\b(umbrella)\b/i, 'the paragraph describes the girl and the umbrella');
    assert.match(positive, /[a-z]\. |[a-z]\.$/, 'sentences, not a tag list');
    assert.doesNotMatch(positive, /Rewrite this image prompt/, 'the system prompt never leaks into the picture');

    const status = await app.page.evaluate(`document.getElementById('prose-card-status')?.textContent ?? ''`);
    assert.match(status, /^Student · student-v1/, `the card names the student writer: ${status}`);
    const paragraph = await app.page.evaluate(`document.getElementById('prose-preview')?.value ?? ''`);
    assert.equal(paragraph, positive, 'the card shows the paragraph that was sent');
});
