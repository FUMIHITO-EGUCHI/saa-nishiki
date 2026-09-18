// HTTP to the local ComfyUI for the process control (scripts/main/comfyProcess.js). No
// electron here, so the tests run it against a server in plain node.
//
// A request always settles, with { ok, status, text } or { ok: false, error }: a connection
// that closes before the body is complete, or a response that trickles past the deadline,
// counts as a failed request instead of leaving a start / stop waiting for good.
import http from 'node:http';
import https from 'node:https';
import { backendAuthHeaders } from '../shared/backendAddress.js';

export function comfyRequest(target, { method = 'GET', pathname = '/', body = null, timeout = 2000 } = {}) {
    return new Promise(resolve => {
        let settled = false;
        let req = null;
        const finish = result => {
            if (settled) return;
            settled = true;
            clearTimeout(deadline);
            resolve(result);
        };
        // on top of the socket idle timeout: a body that keeps trickling in never goes idle
        const deadline = setTimeout(() => {
            finish({ ok: false, error: 'timeout' });
            req?.destroy(new Error('timeout'));
        }, timeout * 2 + 1000);
        const secure = target?.protocol === 'https:';
        req = (secure ? https : http).request({
            host: target?.host ?? '127.0.0.1', port: target?.port, method, path: pathname, timeout,
            agent: false,               // no pooled socket to a ComfyUI that has been stopped since
            // loopback only (loopbackTarget): a local TLS ComfyUI runs on a self-signed certificate
            ...(secure ? { rejectUnauthorized: false } : {}),
            // `target.auth`: the credentials the generation requests carry (a local ComfyUI
            // behind an auth proxy answers /system_stats only with them)
            headers: { ...backendAuthHeaders(target?.auth), ...(body ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } : {}) } }, res => {
            const chunks = [];
            res.on('data', chunk => chunks.push(chunk));
            res.on('end', () => finish({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') }));
            res.on('error', error => finish({ ok: false, error: error?.message ?? String(error) }));
            // 'end' comes first for a complete body; a close without it is a cut-off response
            res.on('close', () => finish({ ok: false, error: 'connection closed before the response was complete' }));
        });
        req.on('timeout', () => { req.destroy(new Error('timeout')); });
        req.on('error', error => finish({ ok: false, error: error?.message ?? String(error) }));
        req.on('close', () => finish({ ok: false, error: 'connection closed' }));
        if (body) req.write(body);
        req.end();
    });
}
