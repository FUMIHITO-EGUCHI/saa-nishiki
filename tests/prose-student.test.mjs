import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { studentServerArgs, studentSpec, studentUrl } from '../scripts/main/proseStudent.js';
import { buildLlamaChatRequest } from '../scripts/shared/llamaChatRequest.js';
import { PROSE_MODE, PROSE_STUDENT_SYSTEM_PROMPT, collapseRepeatedSentences } from '../scripts/shared/prosePrompt.js';
import { describeProseEndpoint, proseEndpoint, proseWriter, studentApiUrl } from '../scripts/renderer/prosePipeline.js';

const HERE = fileURLToPath(import.meta.url);   // an existing file, standing in for the exe and the model

test('the student is off unless the setting names it, and then owns the endpoint', () => {
    assert.equal(proseWriter({}), 'llm');
    assert.equal(proseWriter({ ai_prose_writer: 'student' }), 'student');
    const endpoint = proseEndpoint({ ai_prose_writer: 'student', ai_prose_student_port: 8123, api_pod_ssh_enable: true, api_pod_ssh_target: 'pod@ssh' });
    assert.equal(endpoint.apiUrl, 'http://127.0.0.1:8123/v1/chat/completions');
    assert.equal(endpoint.student, true, 'the pod relay does not take a student paragraph');
    assert.equal(studentApiUrl({}), 'http://127.0.0.1:8090/v1/chat/completions');
    assert.equal(studentUrl(8090), studentApiUrl({}));
});

test('the Prose card names the student by its model file', () => {
    assert.equal(describeProseEndpoint({ ai_prose_writer: 'student', ai_prose_student_model: 'C:\\models\\llm\\student-v1-q8_0.gguf' }), 'Student · student-v1-q8_0');
    assert.equal(describeProseEndpoint({ ai_prose_writer: 'student' }), 'Student');
});

test('the server spec refuses what it cannot start, and names why', () => {
    assert.equal(studentSpec({}).message, 'no llama-server path');
    assert.equal(studentSpec({ ai_prose_student_server: HERE }).message, 'no model path');
    assert.match(studentSpec({ ai_prose_student_server: HERE, ai_prose_student_model: 'C:\\nope\\x.gguf' }).message, /model not found/);
    const spec = studentSpec({ ai_prose_student_server: HERE, ai_prose_student_model: HERE, ai_prose_student_port: '8091' });
    assert.deepEqual(spec, { ok: true, server: HERE, model: HERE, port: 8091 });
    assert.equal(studentSpec({ ai_prose_student_server: HERE, ai_prose_student_model: HERE }).port, 8090);
});

test('the launch line puts every layer on the GPU with one slot and no web UI', () => {
    const args = studentServerArgs({ model: 'm.gguf', port: 8090 });
    assert.deepEqual(args.slice(0, 4), ['-m', 'm.gguf', '--port', '8090']);
    for (const flag of ['-ngl', '-np', '--jinja', '--no-webui', '--reasoning-budget']) assert.ok(args.includes(flag), flag);
    assert.equal(args[args.indexOf('-np') + 1], '1');
});

test('a sentence the student already said is dropped, the rest stays as written', () => {
    const tags = 'masterpiece, best quality, nsfw, (@asanagi:1.3), ';
    const one = 'rice shower (umamusume) is a girl with long pink hair and a pink track jacket, standing in a dimly lit bedroom with pale colors and flat colors.';
    // the loop seen on 2026-09-26: the same sentence four times after the tags
    assert.equal(collapseRepeatedSentences(`${tags}${one} ${one} ${one} ${one}`), `${tags}${one}`);
    // a restatement with one new word goes too; a sentence that says something new stays
    const restated = 'rice shower (umamusume) is a girl with long pink hair and a pink track jacket, standing in a dimly lit bedroom with pale colors and flat colors, facing the camera.';
    const fresh = 'The girl holds up her skirt with both hands to reveal black lingerie underneath.';
    assert.equal(collapseRepeatedSentences(`${tags}${one} ${restated} ${fresh}`), `${tags}${one} ${fresh}`);
    // short sentences are never dropped, even when every word was said before
    const short = 'The scene has pale colors.';
    assert.equal(collapseRepeatedSentences(`${tags}${one} ${short}`), `${tags}${one} ${short}`);
    // one sentence, or no sentence at all, comes back untouched
    assert.equal(collapseRepeatedSentences('1girl, solo, white background'), '1girl, solo, white background');
    assert.equal(collapseRepeatedSentences(''), '');
});

test('a Prose request to a llama.cpp server sends the fields JSON untouched and no grammar', () => {
    const body = buildLlamaChatRequest({ promptMode: PROSE_MODE, systemPrompt: PROSE_STUDENT_SYSTEM_PROMPT, userPrompt: '{"common":"1girl"}', temperature: 0.3, n_predict: 1024 });
    assert.deepEqual(body.messages, [{ role: 'system', content: PROSE_STUDENT_SYSTEM_PROMPT }, { role: 'user', content: '{"common":"1girl"}' }]);
    assert.equal(body.seed, 1);
    assert.equal(body.max_tokens, 1024);
    assert.equal(body.response_format, undefined);
    assert.equal(body.stop, undefined);
    // Expand keeps its historical shape
    const expand = buildLlamaChatRequest({ promptMode: 'Expand', systemPrompt: 's', userPrompt: 'u', temperature: 0.7, n_predict: 768 });
    assert.equal(expand.messages[1].content, 'u;Response in English');
    assert.deepEqual(expand.stop, ['<|im_end|>']);
});
