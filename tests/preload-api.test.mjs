// scripts/preload.js is the only bridge between the renderer and the main process, and it runs
// in a sandbox where a typo is not a build error: `contextBridge` hands the renderer whatever
// the arrow function closes over, and a name that was never a parameter only throws when a
// user clicks the thing. So the bridge is built here for real — electron is a stub through
// module hooks, the renderer globals it touches are stubbed too — and the functions are called.
import assert from 'node:assert/strict';
import module from 'node:module';
import test from 'node:test';

globalThis.addEventListener ??= () => {};   // preload registers a DOMContentLoaded handler
const bridge = { exposed: null, invokes: [], subscribed: [] };
globalThis.__preloadBridge = bridge;

const ELECTRON = `
    const bridge = globalThis.__preloadBridge;
    export const contextBridge = { exposeInMainWorld: (name, api) => { bridge.exposed = { name, api }; } };
    export const ipcRenderer = {
        invoke: (channel, ...args) => { bridge.invokes.push({ channel, args }); return Promise.resolve('ok'); },
        on: channel => { bridge.subscribed.push(channel); },
        send: (channel, ...args) => { bridge.invokes.push({ channel, args }); },
        sendSync: (channel, ...args) => { bridge.invokes.push({ channel, args }); return {}; },
    };`;
const electronUrl = `data:text/javascript,${encodeURIComponent(ELECTRON)}`;

const hooksAvailable = typeof module.registerHooks === 'function';
if (hooksAvailable) {
    module.registerHooks({
        resolve(specifier, context, nextResolve) {
            if (specifier === 'electron') return { url: electronUrl, shortCircuit: true };
            return nextResolve(specifier, context);
        },
    });
}

if (hooksAvailable) await import('../scripts/preload.js');
const api = bridge.exposed?.api ?? null;
const opts = { skip: api ? false : 'needs node:module registerHooks', timeout: 30_000 };

test('the bridge is the `api` object the renderer reads', opts, () => {
    assert.equal(bridge.exposed.name, 'api');
    assert.ok(Object.keys(api).length > 50, `${Object.keys(api).length} entries`);
});

test('downloadURL passes on the address and the file it was given', opts, async () => {
    bridge.invokes = [];
    await api.downloadURL('https://example.invalid/a.png', 'C:\\tmp\\a.png');
    assert.deepEqual(bridge.invokes, [{ channel: 'download-url', args: ['https://example.invalid/a.png', 'C:\\tmp\\a.png'] }]);
});

test('no bridge function reaches for a name it was never given', opts, async () => {
    // Anything the bridge can be called with no arguments at all: a body that names something
    // the signature does not (`(url, filePath)` left out of the parameters) throws here and
    // nowhere else, because a preload sandbox has no such variable to fall back on.
    const nullary = Object.entries(api).filter(([, value]) => typeof value === 'function' && value.length === 0);
    assert.ok(nullary.length > 10, `${nullary.length} functions take no argument`);
    const broken = [];
    for (const [name, value] of nullary) {
        try {
            await value();
        } catch (error) {
            broken.push(`${name}: ${error.name}: ${error.message}`);
        }
    }
    assert.deepEqual(broken, []);
});
