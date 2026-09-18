import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';

import { comfyRequest } from '../scripts/main/comfyHttp.js';

// a throwaway HTTP server on an ephemeral loopback port, closed after the test
async function serve(t, handler) {
    const server = http.createServer(handler);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => {
        server.closeAllConnections();
        server.close();
    });
    return { protocol: 'http:', host: '127.0.0.1', port: server.address().port };
}

test('a complete answer comes back with its status and body', async t => {
    const target = await serve(t, (req, res) => {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ method: req.method, url: req.url, body }));
        });
    });
    const reply = await comfyRequest(target, { method: 'POST', pathname: '/free', body: '{"unload_models":true}' });
    assert.equal(reply.ok, true);
    assert.equal(reply.status, 200);
    assert.deepEqual(JSON.parse(reply.text), { method: 'POST', url: '/free', body: '{"unload_models":true}' });
});

test('the credentials of the address are carried, so a ComfyUI behind auth still answers', async t => {
    const seen = [];
    const target = await serve(t, (req, res) => {
        seen.push(req.headers.authorization);
        res.writeHead(200);
        res.end('{"system":{}}');
    });
    await comfyRequest(target, { pathname: '/system_stats' });
    await comfyRequest({ ...target, auth: 'token123' }, { pathname: '/system_stats' });
    await comfyRequest({ ...target, auth: 'user:pass' }, { method: 'POST', pathname: '/free', body: '{}' });
    assert.deepEqual(seen, [undefined, 'Bearer token123', `Basic ${Buffer.from('user:pass').toString('base64')}`]);
});

test('a connection cut before the body is complete settles as a failure instead of hanging', async t => {
    const target = await serve(t, (req, res) => {
        res.writeHead(200, { 'Content-Length': '100' });
        res.write('{"system":');
        setTimeout(() => req.socket.destroy(), 50);
    });
    const reply = await comfyRequest(target, { pathname: '/system_stats', timeout: 2000 });
    assert.equal(reply.ok, false);
    assert.ok(reply.error);
});

test('a body that keeps trickling in ends at the deadline', async t => {
    const target = await serve(t, (req, res) => {
        res.writeHead(200, { 'Content-Length': '100000' });
        const timer = setInterval(() => res.write('x'), 50);
        req.socket.on('close', () => clearInterval(timer));
    });
    const started = Date.now();
    const reply = await comfyRequest(target, { pathname: '/system_stats', timeout: 200 });
    assert.deepEqual(reply, { ok: false, error: 'timeout' });
    assert.ok(Date.now() - started < 3000);
});

test('no answer at all ends at the idle timeout; nothing listening is a failure too', async t => {
    const target = await serve(t, () => {});
    assert.deepEqual(await comfyRequest(target, { timeout: 200 }), { ok: false, error: 'timeout' });
    const reply = await comfyRequest({ protocol: 'http:', host: '127.0.0.1', port: 1 }, { timeout: 1000 });
    assert.equal(reply.ok, false);
});
