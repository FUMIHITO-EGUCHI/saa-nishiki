// scripts/main/remoteAI_backend.js driven in plain node: electron's `net`, the settings and
// the pod SSH relay are swapped for stubs through module hooks, and the LLM it talks to is a
// local HTTP server on an ephemeral port. Nothing leaves the machine, no Ollama and no pod.
//
// The `net` stub is node:http wearing electron's shape: request({ method, url, headers }),
// a request that emits 'response' / 'error', and abort() that ends it with ECONNABORTED.
// Its `timeout` option is accepted and does nothing, exactly as electron's does — that is
// why requestTimeout.js arms the limit by hand.
import assert from 'node:assert/strict';
import http from 'node:http';
import module from 'node:module';
import test from 'node:test';

import { STRUCTURED_REFINE_MIN_TIMEOUT } from '../scripts/main/ollamaSaaAdapter.js';

const stub = {
    settings: {},
    pod: null,          // what the podSshTransport stub answers, and what it was asked
    podCalls: [],
    failNext: null,     // an error the next request is destroyed with, before it answers
};
globalThis.__remoteAiStub = stub;

stub.net = {
    request(options) {
        const url = new URL(options.url);
        const request = http.request({
            hostname: url.hostname,
            port: url.port,
            path: url.pathname + url.search,
            method: options.method,
            headers: options.headers,
        });
        // electron ends an aborted request with ECONNABORTED; node's abort() only stops it quietly
        request.abort = () => request.destroy(Object.assign(new Error('aborted'), { code: 'ECONNABORTED' }));
        if (stub.failNext) {
            const error = stub.failNext;
            stub.failNext = null;
            setImmediate(() => request.destroy(error));
        }
        return request;
    },
};

const STUBS = {
    electron: `
        const stub = globalThis.__remoteAiStub;
        export const ipcMain = { handle: (channel, handler) => { stub.handlers[channel] = handler; } };
        export const net = stub.net;`,
    settings: `
        export function getGlobalSettings() { return globalThis.__remoteAiStub.settings; }`,
    pod: `
        export function podOllamaRequest(options) {
            const stub = globalThis.__remoteAiStub;
            stub.podCalls.push(options);
            return stub.pod(options);
        }`,
};
stub.handlers = {};
const stubUrl = name => `data:text/javascript,${encodeURIComponent(STUBS[name])}`;

const hooksAvailable = typeof module.registerHooks === 'function';
if (hooksAvailable) {
    module.registerHooks({
        resolve(specifier, context, nextResolve) {
            const fromBackend = String(context.parentURL ?? '').endsWith('/scripts/main/remoteAI_backend.js');
            if (specifier === 'saa-remote-ai-hook-probe') return { url: stubUrl('electron'), shortCircuit: true };
            if (fromBackend && specifier === 'electron') return { url: stubUrl('electron'), shortCircuit: true };
            if (fromBackend && specifier === './globalSettings.js') return { url: stubUrl('settings'), shortCircuit: true };
            if (fromBackend && specifier === './podSshTransport.js') return { url: stubUrl('pod'), shortCircuit: true };
            return nextResolve(specifier, context);
        },
    });
}

// Loaded only with the stubs in place: without them it would import electron for real.
let backend = null;
if (hooksAvailable) {
    const probe = await import('saa-remote-ai-hook-probe');
    if (typeof probe.net === 'object') backend = await import('../scripts/main/remoteAI_backend.js');
}
const opts = { skip: backend ? false : 'needs node:module registerHooks', timeout: 30_000 };

// Every fake LLM still listening, closed after the test whatever happened in it: an open
// server keeps the test process alive, and the run would hang instead of reporting.
const openServers = new Set();

async function closeServer(server) {
    openServers.delete(server);
    server.closeAllConnections();
    await new Promise(resolve => server.close(() => resolve()));
}

test.afterEach(async () => {
    for (const server of [...openServers]) await closeServer(server);
    stub.failNext = null;
    stub.podCalls = [];
});

/**
 * An LLM stand-in. `reply(request, response)` decides what comes back; `calls` holds what
 * was asked ({ url, headers, body }). A reply that never comes is a stalled backend.
 */
async function fakeLlm(reply) {
    const calls = [];
    const server = http.createServer((request, response) => {
        let text = '';
        request.on('data', chunk => { text += chunk; });
        request.on('end', () => {
            calls.push({ url: request.url, headers: request.headers, body: text });
            reply(request, response);
        });
    });
    openServers.add(server);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    return { calls, port: server.address().port, close: () => closeServer(server) };
}

const json = (response, status, payload) => {
    response.writeHead(status, { 'Content-Type': 'application/json' });
    response.end(typeof payload === 'string' ? payload : JSON.stringify(payload));
};

async function deadPort() {
    const server = http.createServer();
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    await new Promise(resolve => server.close(resolve));
    return port;
}

test('a remote answer comes back whole, with the key and the English instruction', opts, async () => {
    const answer = JSON.stringify({ choices: [{ message: { role: 'assistant', content: '1girl, solo' } }] });
    const llm = await fakeLlm((request, response) => json(response, 200, answer));
    try {
        const result = await backend.remoteAI({
            apiUrl: `http://127.0.0.1:${llm.port}/v1/chat/completions`,
            apiKey: 'sk-test-key',
            modelSelect: 'gpt-test',
            userPrompt: 'a cat',
            systemPrompt: 'you are a prompt writer',
            timeout: 10_000,
        });
        assert.equal(result, answer, 'the body is handed on untouched');
        const [call] = llm.calls;
        assert.equal(call.url, '/v1/chat/completions');
        assert.equal(call.headers.authorization, 'Bearer sk-test-key');
        assert.deepEqual(JSON.parse(call.body), {
            model: 'gpt-test',
            messages: [
                { role: 'system', content: 'you are a prompt writer' },
                { role: 'user', content: 'a cat;Response in English' },
            ],
        });
    } finally {
        await llm.close();
    }
});

test('a remote HTTP error is answered as an error, never as the body it came with', opts, async () => {
    const llm = await fakeLlm((request, response) => json(response, 500, { error: 'model overloaded' }));
    try {
        const result = await backend.remoteAI({ apiUrl: `http://127.0.0.1:${llm.port}/v1/chat/completions`, apiKey: 'k', timeout: 10_000 });
        assert.equal(result, 'Error: HTTP error: 500');
    } finally {
        await llm.close();
    }
});

test('a local llama.cpp request carries cache_prompt, the stop token and both messages', opts, async () => {
    const llm = await fakeLlm((request, response) => json(response, 200, { choices: [{ message: { content: 'ok' } }] }));
    try {
        const result = await backend.localAI({
            apiUrl: `http://127.0.0.1:${llm.port}/v1/chat/completions`,
            apiAuth: 'user:pass',
            userPrompt: 'a dog',
            systemPrompt: 'system line',
            temperature: 0.42,
            n_predict: 321,
            timeout: 10_000,
        });
        assert.equal(JSON.parse(result).choices[0].message.content, 'ok');
        const [call] = llm.calls;
        assert.equal(call.headers.authorization, `Basic ${Buffer.from('user:pass').toString('base64')}`);
        assert.deepEqual(JSON.parse(call.body), {
            temperature: 0.42,
            n_predict: 321,
            cache_prompt: true,          // the KV cache of the last request is reused
            stop: ['<|im_end|>'],
            messages: [
                { role: 'system', content: 'system line' },
                { role: 'user', content: 'a dog;Response in English' },
            ],
        });
    } finally {
        await llm.close();
    }
});

test('an Ollama answer is normalized to the OpenAI shape, and a broken one is an error', opts, async () => {
    let body = { model: 'gemma4', message: { role: 'assistant', content: 'a tag list' }, done_reason: 'length' };
    const llm = await fakeLlm((request, response) => json(response, 200, body));
    try {
        const url = `http://127.0.0.1:${llm.port}/api/chat`;
        const options = { apiUrl: url, userPrompt: 'a fox', systemPrompt: 'sys', temperature: 0.3, n_predict: 100, timeout: 10_000 };
        const result = JSON.parse(await backend.localAI(options));
        assert.deepEqual(result, {
            model: 'gemma4',
            choices: [{ message: { role: 'assistant', content: 'a tag list' }, finish_reason: 'length' }],
        });
        // the Ollama dialect, not the llama.cpp one: no cache_prompt, a model and messages
        const sent = JSON.parse(llm.calls[0].body);
        assert.equal(sent.cache_prompt, undefined);
        assert.equal(typeof sent.model, 'string');
        assert.ok(Array.isArray(sent.messages) && sent.messages.length >= 2);

        body = 'not json at all';
        assert.equal(await backend.localAI(options), 'Error: Invalid Ollama response');
        body = { model: 'gemma4' };     // no message content
        assert.equal(await backend.localAI(options), 'Error: Invalid Ollama response');
    } finally {
        await llm.close();
    }
});

test('a local HTTP error is read as an error before the Ollama answer is parsed', opts, async () => {
    const llm = await fakeLlm((request, response) => json(response, 404, { error: 'model "gemma4" not found' }));
    try {
        const result = await backend.localAI({ apiUrl: `http://127.0.0.1:${llm.port}/api/chat`, userPrompt: 'x', timeout: 10_000 });
        assert.equal(result, 'Error: HTTP error: 404', 'not "Invalid Ollama response": the status is read first');
    } finally {
        await llm.close();
    }
});

test('a backend that accepts the request and goes quiet is given up on when the limit is up', opts, async () => {
    const llm = await fakeLlm(() => { /* never answers: a stalled LLM */ });
    try {
        const url = `http://127.0.0.1:${llm.port}/v1/chat/completions`;
        const started = Date.now();
        assert.equal(await backend.localAI({ apiUrl: url, userPrompt: 'x', timeout: 300 }), 'Error: Request timed out after 300ms');
        assert.equal(await backend.remoteAI({ apiUrl: url, apiKey: 'k', userPrompt: 'x', timeout: 300 }), 'Error: Request timed out after 300ms');
        assert.ok(Date.now() - started < 20_000, 'the wait really ended at the limit');
    } finally {
        await llm.close();
    }
});

test('an answer cut off mid-flight fails instead of resolving half of it', opts, async () => {
    const llm = await fakeLlm((request, response) => {
        response.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': '400' });
        response.write('{"choices":[{"message":{"content":"half a se');
        response.socket.destroy();
    });
    try {
        const url = `http://127.0.0.1:${llm.port}/v1/chat/completions`;
        for (const result of [await backend.localAI({ apiUrl: url, userPrompt: 'x', timeout: 10_000 }),
            await backend.remoteAI({ apiUrl: url, apiKey: 'k', userPrompt: 'x', timeout: 10_000 })]) {
            assert.match(result, /^Request failed:, /, result);
            assert.doesNotMatch(result, /half a se/, 'the truncated body is never handed on as the answer');
        }
    } finally {
        await llm.close();
    }
});

test('a refused connection says what failed, with the reason the caller can act on', opts, async () => {
    const url = `http://127.0.0.1:${await deadPort()}/v1/chat/completions`;
    const refusedLocal = await backend.localAI({ apiUrl: url, userPrompt: 'x', timeout: 10_000 });
    assert.match(refusedLocal, /^Request failed:, .*ECONNREFUSED/);
    const refusedRemote = await backend.remoteAI({ apiUrl: url, apiKey: 'k', timeout: 10_000 });
    assert.match(refusedRemote, /^Request failed:, .*ECONNREFUSED/);
});

test('an aborted request is reported as a timeout, not as a failure', opts, async () => {
    // electron ends an aborted request with ECONNABORTED: that is the one error the caller
    // is told about as a timeout, without the "Error:" prefix the other paths use. A live
    // backend that never answers, so nothing but the abort can end the request.
    const llm = await fakeLlm(() => {});
    const aborted = () => Object.assign(new Error('aborted'), { code: 'ECONNABORTED' });
    try {
        const url = `http://127.0.0.1:${llm.port}/v1/chat/completions`;
        stub.failNext = aborted();
        assert.equal(await backend.localAI({ apiUrl: url, userPrompt: 'x', timeout: 4321 }), 'Request timed out after 4321ms');
        stub.failNext = aborted();
        assert.equal(await backend.remoteAI({ apiUrl: url, apiKey: 'k', timeout: 4321 }), 'Request timed out after 4321ms');
    } finally {
        await llm.close();
    }
});

test('the pod relay is handed the chat body with its model and keep-alive, and its reply is normalized', opts, async () => {
    stub.settings = { ai_pod_model: 'hf.co/pod-model:Q4', ai_pod_keep_alive: '25m' };
    stub.pod = async () => ({ ok: true, json: { model: 'hf.co/pod-model:Q4', message: { role: 'assistant', content: 'from the pod' } } });
    const options = { apiUrl: 'pod-ssh://ollama/api/chat', userPrompt: 'a fox', systemPrompt: 'sys', temperature: 0.3, n_predict: 100, timeout: 9000 };
    const result = JSON.parse(await backend.localAI(options));
    assert.deepEqual(result, { model: 'hf.co/pod-model:Q4', choices: [{ message: { role: 'assistant', content: 'from the pod' } }] });
    const [call] = stub.podCalls;
    assert.equal(call.method, 'POST');
    assert.equal(call.path, '/api/chat');
    assert.equal(call.timeoutMs, 9000);
    assert.equal(call.body.model, 'hf.co/pod-model:Q4', 'the pod model replaces the one the adapter picked');
    assert.equal(call.body.keep_alive, '25m', 'the pod keeps the model warm between calls');
    assert.ok(Array.isArray(call.body.messages));

    // no limit asked for: the relay keeps its own default rather than 0 ms
    stub.podCalls = [];
    await backend.localAI({ ...options, timeout: 0 });
    assert.equal(stub.podCalls[0].timeoutMs, undefined);

    // a structured Refine writes every field again: the AI card's limit is floored, not taken
    // as it stands, or the whole edit is thrown away halfway (ollamaSaaAdapter.js)
    stub.podCalls = [];
    await backend.localAI({
        ...options,
        timeout: 1000,
        promptMode: 'Refine',
        editorFields: { positive: 'a fox' },
        generationContext: { model: 'anima' },
    });
    assert.equal(stub.podCalls[0].timeoutMs, STRUCTURED_REFINE_MIN_TIMEOUT);

    // a relay that could not run, a reply that is not an Ollama answer, and a thrown error
    stub.pod = async () => ({ ok: false, message: 'ssh: connect to host ssh.runpod.io port 22: refused' });
    assert.equal(await backend.localAI(options), 'Error: ssh: connect to host ssh.runpod.io port 22: refused');
    stub.pod = async () => ({ ok: true, json: { error: 'model not found' } });
    assert.equal(await backend.localAI(options), 'Error: Invalid Ollama response');
    stub.pod = () => Promise.reject(new Error('relay died'));
    assert.equal(await backend.localAI(options), 'Error: relay died');
    stub.settings = {};
});

test('both IPC channels answer with what the backend returned', opts, async () => {
    const llm = await fakeLlm((request, response) => json(response, 200, { choices: [{ message: { content: 'answered' } }] }));
    try {
        stub.handlers = {};
        backend.setupModelApi();
        assert.deepEqual(Object.keys(stub.handlers).sort(), ['request-ai-local', 'request-ai-remote']);
        const url = `http://127.0.0.1:${llm.port}/v1/chat/completions`;
        const remote = await stub.handlers['request-ai-remote']({}, { apiUrl: url, apiKey: 'k', userPrompt: 'x', timeout: 10_000 });
        const local = await stub.handlers['request-ai-local']({}, { apiUrl: url, userPrompt: 'x', timeout: 10_000 });
        for (const reply of [remote, local]) {
            assert.equal(typeof reply, 'string', 'the handler answers the renderer, it does not return nothing');
            assert.equal(JSON.parse(reply).choices[0].message.content, 'answered');
        }
    } finally {
        await llm.close();
    }
});
