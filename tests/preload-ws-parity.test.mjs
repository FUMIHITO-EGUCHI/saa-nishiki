// The two ways the renderer reaches the main process must stay in step:
//   Electron  - window.api.<method>()  -> ipcRenderer.invoke('<channel>') -> ipcMain.handle
//   browser   - sendWebSocketMessage({ type: 'API', method }) -> wsService methodHandlers
// This is the one place where reading the sources is the point: both sides are enumerated
// (the preload bridge by running it with electron stubbed, the handlers by scanning where
// they are registered) and compared. Every gap is named, with the reason it is allowed -
// a new gap fails the test instead of joining a silent majority.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import module from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

function walk(directory, out = []) {
    for (const entry of fs.readdirSync(path.join(root, directory), { withFileTypes: true })) {
        const next = `${directory}/${entry.name}`;
        if (entry.isDirectory()) walk(next, out);
        else if (entry.name.endsWith('.js')) out.push(next);
    }
    return out;
}

// ------------------------------------------------------------------ the preload bridge, run

const bridges = { api: null, okm: null, on: [], calls: [] };
globalThis.__preloadParityBridges = bridges;

const ELECTRON_STUB = `
    const bridges = globalThis.__preloadParityBridges;
    export const contextBridge = { exposeInMainWorld: (key, value) => { bridges[key] = value; } };
    export const ipcRenderer = {
        on: (channel, listener) => { bridges.on.push({ channel, listener }); },
        invoke: async (channel, ...args) => { bridges.calls.push({ kind: 'invoke', channel, args }); },
        sendSync: (channel, ...args) => { bridges.calls.push({ kind: 'sendSync', channel, args }); },
    };`;

const hooksAvailable = typeof module.registerHooks === 'function';
if (hooksAvailable) {
    module.registerHooks({
        resolve(specifier, context, nextResolve) {
            if (specifier === 'saa-preload-parity-probe') return { url: `data:text/javascript,${encodeURIComponent('export const hooked = true;')}`, shortCircuit: true };
            if (String(context.parentURL ?? '').endsWith('/scripts/preload.js') && specifier === 'electron') {
                return { url: `data:text/javascript,${encodeURIComponent(ELECTRON_STUB)}`, shortCircuit: true };
            }
            return nextResolve(specifier, context);
        },
    });
}

let loaded = false;
if (hooksAvailable) {
    const { hooked } = await import('saa-preload-parity-probe');
    if (hooked === true) {
        // preload.js registers a DOMContentLoaded listener on the global at import time
        const savedListener = Object.getOwnPropertyDescriptor(globalThis, 'addEventListener');
        Object.defineProperty(globalThis, 'addEventListener', { value: () => {}, configurable: true, writable: true });
        await import('../scripts/preload.js');
        if (savedListener) Object.defineProperty(globalThis, 'addEventListener', savedListener);
        else delete globalThis.addEventListener;
        loaded = true;
    }
}
const opts = { skip: loaded ? false : 'needs node:module registerHooks', timeout: 20_000 };

// method -> { kind, channel } | { error }, found by calling each bridged method once.
const bridged = new Map();
if (loaded) {
    for (const [name, method] of Object.entries(bridges.api)) {
        bridges.calls.length = 0;
        try {
            await method();
        } catch (error) {
            bridged.set(name, { error: error.message });
            continue;
        }
        bridged.set(name, bridges.calls.length === 1 ? bridges.calls[0] : { error: `${bridges.calls.length} ipc calls` });
    }
}

// ------------------------------------------------------------------ the handlers, enumerated

const MAIN_FILES = ['main.js', 'main-common.js', ...walk('scripts/main'), ...walk('scripts/webserver')];

const ipcChannels = new Map();      // channel -> where it is registered
for (const file of MAIN_FILES) {
    for (const match of read(file).matchAll(/ipcMain\.(handle|handleOnce|on)\(\s*['"]([^'"]+)['"]/g)) {
        ipcChannels.set(match[2], `${file} (${match[1]})`);
    }
}

// The methodHandlers table of the websocket service, by its keys.
const wsHandlers = (() => {
    const source = read('scripts/webserver/back/wsService.js');
    const start = source.indexOf('const methodHandlers = {');
    assert.ok(start >= 0, 'wsService.js still has a methodHandlers table');
    const end = source.indexOf('\r\n};', start) >= 0 ? source.indexOf('\r\n};', start) : source.indexOf('\n};', start);
    const block = source.slice(start, end);
    return new Set([...block.matchAll(/^\s*'([A-Za-z_]\w*)':/gm)].map(match => match[1]));
})();

// What the renderer actually asks for over the websocket when it runs in a browser.
const askedOverWs = new Map();
for (const file of [...walk('scripts/renderer'), ...walk('scripts/webserver/front')]) {
    const source = read(file);
    for (const match of source.matchAll(/type:\s*'API'\s*,\s*method:\s*'([A-Za-z_]\w*)'/g)) {
        askedOverWs.set(match[1], file);
    }
    // a computed method name would slip past the scan above; there must not be one
    for (const match of source.matchAll(/type:\s*'API'\s*,\s*method:\s*([^'\s])/g)) {
        assert.fail(`${file} builds a websocket method name at runtime (${match[1]}…); this test would not see it`);
    }
}

// What the main process pushes to the renderer on the 'generate-backend' channel.
const pushed = new Set();
for (const file of MAIN_FILES) {
    for (const match of read(file).matchAll(/sendToRenderer\([^,()]*,\s*[`'"](\w+)[`'"]/g)) pushed.add(match[1]);
}

// ------------------------------------------------------------------ the named exceptions

// Bridged methods a browser client is not meant to reach: each one drives the machine the
// app itself runs on, not the generation backend.
const BROWSER_UNSUPPORTED = new Map([
    ['getBackendStatus', 'the header pills probe the host\'s own ComfyUI / Ollama'],
    ['saveSettingsSections', 'settings live in the host\'s userData; a browser client never writes them'],
    ['saveSettingsSectionsSync', 'the synchronous flush of the same store'],
    ['listPresets', 'presets are files under the host\'s settings folder'],
    ['savePreset', 'presets are files under the host\'s settings folder'],
    ['loadPreset', 'presets are files under the host\'s settings folder'],
    ['deletePreset', 'presets are files under the host\'s settings folder'],
    ['openSettingsFolder', 'opens a window in the host\'s file manager'],
    ['updateCachedCharacterThumb', 'the browser path uses the getCharacterThumb / updateCharacterThumb pair instead'],
    ['updateModelListRemote', 'dials the pod from the host'],
    ['runpodPodControl', 'starts and stops the pod from the host'],
    ['comfyProcess', 'starts and stops the loopback ComfyUI process'],
    ['podRunBootstrap', 'runs the pod bootstrap over the host\'s SSH'],
    ['podSetup', 'the pod setup wizard, over the host\'s SSH'],
    ['podOllama', 'the pod\'s Ollama, over the host\'s SSH relay'],
    ['replaceMisspelling', 'Chromium\'s own spellcheck, which only the Electron window has'],
    ['addToDictionary', 'Chromium\'s own spellcheck, which only the Electron window has'],
    ['getUserLists', 'the user list diffs are files under the host\'s settings folder'],
    ['applyUserListChange', 'the user list diffs are files under the host\'s settings folder'],
    ['prepareUserThumb', 'reads a file the user picked on the host'],
    ['pickUserThumb', 'opens the host\'s file dialog'],
    ['exportUserLists', 'writes to a folder the user picked on the host'],
    ['importUserLists', 'reads from a folder the user picked on the host'],
    ['downloadURL', 'writes the downloaded file to a path on the host'],
]);

// Handlers the websocket offers that the preload bridge has no method for: the browser
// client reaches them by these names and the Electron renderer never needs them.
const WS_ONLY = new Map([
    ['getCharacterThumb', 'the browser client fetches thumbs one at a time; Electron gets them with the cached files'],
    ['updateCharacterThumb', 'the browser-side counterpart of updateCachedCharacterThumb'],
    ['python_runComfyUI', 'the python tools talk to the websocket directly'],
    ['python_runWebUI', 'the python tools talk to the websocket directly'],
]);

// Defects, not decisions. Each entry is a bridge that cannot work; the list exists so a
// new broken bridge fails this test instead of quietly joining them.
const NO_MAIN_HANDLER = new Map([
    ['getImageComfyUI', 'scripts/preload.js:157 invokes generate-backend-comfyui-get-image, which no ipcMain.handle registers anywhere; nothing calls the method either'],
]);
// Empty, and meant to stay that way: downloadURL used to be here (it took no parameters,
// so `url` and `filePath` were undefined identifiers and the call threw), and now takes
// the two it passes on. The list stays so a bridge that throws before it reaches IPC
// fails this test instead of quietly joining a named exception.
const THROWS_BEFORE_IPC = new Map([]);

// ------------------------------------------------------------------ tests

test('the preload script exposes the two bridges, and every method on them is a function', opts, () => {
    assert.deepEqual(Object.keys(bridges).filter(key => key === 'api' || key === 'okm').sort(), ['api', 'okm']);
    assert.deepEqual(Object.keys(bridges.okm), [
        'setup_mainGallery_appendImageData',
        'setup_customOverlay_updatePreview',
        'setup_customOverlay_progressBar',
        'setup_customOverlay_status',
        'setup_rightClickMenu_spellCheck',
    ]);
    for (const [name, method] of Object.entries(bridges.api)) assert.equal(typeof method, 'function', `api.${name}`);
    for (const [name, method] of Object.entries(bridges.okm)) assert.equal(typeof method, 'function', `okm.${name}`);
    assert.deepEqual(bridges.on.map(entry => entry.channel), ['generate-backend'], 'one push channel, listened to once');
});

test('every bridged method makes exactly one IPC call, on a channel of its own', opts, () => {
    const broken = [...bridged].filter(([, result]) => result.error).map(([name]) => name);
    assert.deepEqual(broken.sort(), [...THROWS_BEFORE_IPC.keys()].sort(), 'the only bridges that never reach IPC are the known broken ones');
    assert.deepEqual(bridged.get('downloadURL'), { kind: 'invoke', channel: 'download-url', args: [undefined, undefined] },
        'downloadURL reaches IPC and passes on both parameters');

    const perChannel = new Map();
    for (const [name, result] of bridged) {
        if (result.error) continue;
        assert.ok(['invoke', 'sendSync'].includes(result.kind), `api.${name} uses invoke or sendSync`);
        perChannel.set(result.channel, [...(perChannel.get(result.channel) ?? []), name]);
    }
    for (const [channel, names] of perChannel) assert.equal(names.length, 1, `${channel} is bridged once (${names.join(', ')})`);
    assert.equal(bridged.get('saveSettingsSectionsSync').kind, 'sendSync', 'the synchronous flush stays synchronous');
});

test('every channel the preload bridge invokes is handled in the main process', opts, () => {
    const missing = [...bridged]
        .filter(([, result]) => !result.error && !ipcChannels.has(result.channel))
        .map(([name]) => name);
    assert.deepEqual(missing.sort(), [...NO_MAIN_HANDLER.keys()].sort(),
        `a bridged method with no ipcMain handler: ${missing.map(name => `${name} -> ${bridged.get(name).channel}`).join(', ')}`);
});

test('every ipcMain channel is reachable from the preload bridge', opts, () => {
    const invoked = new Set([...bridged.values()].filter(result => !result.error).map(result => result.channel));
    const unreachable = [...ipcChannels.keys()].filter(channel => !invoked.has(channel));
    assert.deepEqual(unreachable.sort(), [],
        `an ipcMain handler no renderer can reach: ${unreachable.map(channel => `${channel} in ${ipcChannels.get(channel)}`).join(', ')}`);
});

test('the browser client can reach every bridged method that is not host-only', opts, () => {
    const missing = [...bridged.keys()].filter(name => !wsHandlers.has(name));
    const allowed = new Set([...BROWSER_UNSUPPORTED.keys(), ...NO_MAIN_HANDLER.keys(), ...THROWS_BEFORE_IPC.keys()]);
    const unexplained = missing.filter(name => !allowed.has(name));
    assert.deepEqual(unexplained, [], `bridged but unreachable from a browser: ${unexplained.join(', ')}`);
    // and the list cannot rot: nothing on it may quietly gain a handler or disappear
    for (const name of allowed) {
        assert.ok(bridged.has(name), `${name} is still a bridged method`);
        assert.ok(!wsHandlers.has(name), `${name} is on the exception list but wsService now handles it - take it off`);
    }
    assert.equal(missing.length, 25, 'the size of the gap is known; a new one has to be argued for');
});

test('every websocket handler answers a method some client asks for', opts, () => {
    const orphans = [...wsHandlers].filter(name => !bridged.has(name) && !WS_ONLY.has(name));
    assert.deepEqual(orphans, [], `wsService handles a method nothing asks for: ${orphans.join(', ')}`);
    for (const name of WS_ONLY.keys()) assert.ok(wsHandlers.has(name), `${name} is on the ws-only list but has no handler`);
});

test('every method the renderer asks for over the websocket is handled - no exceptions', opts, () => {
    const missing = [...askedOverWs].filter(([name]) => !wsHandlers.has(name));
    assert.deepEqual(missing, [], `the browser path would get "Unknown API method": ${missing.map(([name, file]) => `${name} (${file})`).join(', ')}`);
    assert.ok(askedOverWs.size > 40, 'the scan found the websocket call sites');
    // the same work in Electron goes through the bridge, under the same name
    for (const [name, file] of askedOverWs) {
        if (WS_ONLY.has(name)) continue;
        assert.ok(bridged.has(name), `${file} asks for ${name} over the websocket, but window.api has no such method`);
    }
});

test('every function the main process pushes to the renderer is one the preload bridge dispatches', opts, () => {
    const fired = [];
    const handler = bridges.on[0].listener;
    const setups = bridges.okm;
    setups.setup_mainGallery_appendImageData((...args) => fired.push(['mainGallery_appendImageData', args]));
    setups.setup_customOverlay_updatePreview((...args) => fired.push(['customOverlay_updatePreview', args]));
    setups.setup_customOverlay_progressBar((...args) => fired.push(['customOverlay_progressBar', args]));
    setups.setup_customOverlay_status((...args) => fired.push(['customOverlay_status', args]));
    setups.setup_rightClickMenu_spellCheck((...args) => fired.push(['rightClickMenu_spellCheck', args]));

    assert.deepEqual([...pushed].sort(), ['rightClickMenu_spellCheck', 'updatePreview', 'updateProgress', 'updateStatus']);
    for (const functionName of pushed) {
        fired.length = 0;
        handler(null, { functionName, args: ['a', 'b'] });
        assert.equal(fired.length, 1, `${functionName} reaches exactly one renderer callback`);
        // each dispatcher forwards as many arguments as it declares, first one first
        assert.equal(fired[0][1][0], 'a', `${functionName} passes its arguments through`);
    }

    fired.length = 0;
    handler(null, { functionName: 'noSuchFunction', args: [] });
    assert.deepEqual(fired, [], 'an unknown push is dropped, not thrown');
});

test('appendImage is bridged but never pushed, and its guard tests the wrong callback', opts, () => {
    // DEFECT (scripts/preload.js:54): appendImage checks okm.customOverlay_updatePreview
    // before calling okm.mainGallery_appendImageData. Nothing pushes 'appendImage' over the
    // Electron channel today (the browser path registers its own callback of that name in
    // wsRequest.js), so the wrong guard never bites. If it is fixed, this is the assertion
    // to update - and the push above should start covering appendImage.
    assert.ok(!pushed.has('appendImage'), 'nothing in the main process pushes appendImage');
    const handler = bridges.on[0].listener;
    const gallery = [];
    bridges.okm.setup_mainGallery_appendImageData((...args) => gallery.push(args));
    bridges.okm.setup_customOverlay_updatePreview(null);      // not a function: the setter keeps the old value
    handler(null, { functionName: 'appendImage', args: ['base64', 1, []] });
    assert.deepEqual(gallery, [['base64', 1, []]], 'it does reach the gallery once a preview callback is registered');
});
