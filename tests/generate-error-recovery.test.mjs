import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.join(testDirectory, '..');
const stackRoot = process.env.SAA_STACK_ROOT ? path.resolve(process.env.SAA_STACK_ROOT) : null;
// sources are CRLF on this machine; normalise so the multi-line anchors below stay readable
const read = relativePath => fs.readFileSync(path.join(projectRoot, relativePath), 'utf8').replace(/\r\n/g, '\n');

const backend = read('scripts/main/generate_backend_comfyui.js');
const generate = read('scripts/renderer/generate.js');
const regional = read('scripts/renderer/generate_regional.js');
const callbacks = read('scripts/renderer/callbacks.js');
const main = read('main.js');

test('ComfyUI run(): timeout / error handlers resolve instead of throwing on undefined identifiers', () => {
  const runStart = backend.indexOf('  run(workflow, pythonRun=false) {');
  const runBody = backend.slice(runStart, backend.indexOf('request.end();', runStart));
  assert.ok(runStart > 0);
  assert.doesNotMatch(runBody, /\$\{timeout\}/, 'must use this.timeout');
  assert.doesNotMatch(runBody, /\breq\.destroy\(\)/, 'must destroy `request`, not the undefined `req`');
  assert.match(runBody, /statusCode !== 200\) \{[\s\S]*?setMutexBackendBusy\(false\);[\s\S]*?resolve\(`Error HTTP/, 'HTTP errors release the mutex');
  assert.doesNotMatch(backend, /this\.webSocke = null/, 'closeWS typo removed');
  assert.match(backend, /closeWS\(\)\{\n    const socket = this\.webSocket;\n    this\.webSocket = null;\n    if \(!socket\) return;/);
  assert.doesNotMatch(backend.slice(backend.indexOf('cancelGenerate() {'), backend.indexOf('async openWS(')), /resolve\(/, 'cancelGenerate has no promise to resolve');
  for (const name of ['runComfyUI', 'runComfyUI_Regional', 'runComfyUI_ControlNet', 'runComfyUI_MiraITU']) {
    assert.match(backend, new RegExp(`async function ${name}\\(generateData\\) \\{\\n  try \\{\\n    return await ${name}_unguarded\\(generateData\\);`), `${name} is guarded`);
    assert.match(backend, new RegExp(`${name} failed:', error\\);\\n    await setMutexBackendBusy\\(false\\);`), `${name} releases the mutex on throw`);
  }
});

test('network failures recover: blocklist lifts on any response, stale error overlay clears, pod requests never throw', () => {
  // Any HTTP response proves the address reachable — the 5-minute blocklist must lift,
  // and a non-200 must not (re-)block; only connection errors and timeouts block.
  const getUrlBody = backend.slice(backend.indexOf('  async getUrl() {'), backend.indexOf('  createWorkflow('));
  assert.match(getUrlBody, /response\.on\('end', \(\) => \{\n\s*\/\/[\s\S]*?delete ComfyUI\.addrBlockList\[this\.addr\];/, 'getUrl lifts the block on response');
  assert.doesNotMatch(getUrlBody.slice(getUrlBody.indexOf("response.on('end'"), getUrlBody.indexOf("request.on('error'")), /addrBlockList\[this\.addr\] = /, 'an HTTP status alone no longer blocks the address');
  const runStart = backend.indexOf('  run(workflow, pythonRun=false) {');
  const runBody = backend.slice(runStart, backend.indexOf('request.end();', runStart));
  assert.match(runBody, /delete ComfyUI\.addrBlockList\[this\.addr\];/, 'a reachable /prompt lifts the block too');

  // A new run or a success removes the persistent error overlay (and the run bar banner mirroring it).
  const gallery = read('scripts/renderer/customGallery.js');
  assert.match(gallery, /showLoading = function[\s\S]{0,400}?getElementById\('cg-error-overlay'\)\?\.remove\(\);/, 'showLoading drops the stale error overlay');
  assert.match(gallery, /\} else \{\n\s*document\.getElementById\('cg-error-overlay'\)\?\.remove\(\);\n\s*\}/, 'a successful hideLoading drops it as well');

  // Pod SSH: requests against a dead session resolve an error instead of throwing (which leaked the busy mutex).
  const pod = read('scripts/main/podSshTransport.js');
  assert.match(pod, /if \(!child \|\| child\.killed \|\| !child\.stdin\?\.writable\) \{\n\s*return Promise\.resolve\(\{ ok: false/, 'request() guards a missing session');
  assert.match(pod, /catch \(error\) \{\n\s*clearTimeout\(timer\);\n\s*this\.pending\.delete\(id\);\n\s*resolve\(\{ ok: false/, 'request() resolves on write failure');
  assert.match(pod, /reject\(new Error\('relay start timed out \(60 s\)'\)\);[\s\S]{0,300}?child\.kill\(\);/, 'a hung ssh is killed so the next run can reconnect');
  assert.match(pod, /session\.stop\(\); \/\/ drop the half-open session/, 'a failed connect resets the session');

  // Pod run/await paths turn any throw into the backend's error-string style and always release the mutex.
  assert.match(backend, /async runPod\(workflow\) \{\n\s*try \{\n\s*return this\.runPodUnguarded\(workflow\);/, 'runPod is guarded');
  assert.match(backend, /const result = await run;[\s\S]*?\} finally \{\n\s*setMutexBackendBusy\(false\);\n\s*\}/, 'awaitPod releases the mutex on every path');
});

test('renderer queue and generate loops always clear the busy state and re-enable buttons', () => {
  const queue = generate.slice(generate.indexOf('export async function startQueue()'), generate.indexOf('async function seartGenerate('));
  assert.match(queue, /try \{\n    generateData = globalThis\.queueManager\.getFirstSlot\(\);/);
  assert.match(queue, /\} catch \(error\) \{[\s\S]*queueManager\.removeAll\(\);[\s\S]*setQueueAutoStart\(false\);[\s\S]*\} finally \{[\s\S]*hideLoading\(ret, retCopy\);[\s\S]*globalThis\.inGenerating = false;\n    \}\n\}/);

  for (const [label, source] of [['generate.js', generate], ['generate_regional.js', regional]]) {
    assert.match(source, /let prepareError = null;\n    for\(let loop = 0; loop < loops; loop\+\+\)\{\s*\n      try \{/, `${label} loop body is guarded`);
    assert.match(source, /\} catch \(error\) \{\n        console\.error\('\[Generate(?: Regional)?\] Failed to prepare image', loop \+ 1, error\);\n        prepareError = error;\n        break;/, `${label} records the failure`);
    assert.match(source, /if \(prepareError\) \{\n        globalThis\.mainGallery\.hideLoading\(/, `${label} reports instead of auto-starting`);
  }

  const start = callbacks.slice(callbacks.indexOf('export async function callback_generate_start'), callbacks.indexOf('export function callback_generate_skip'));
  assert.match(start, /try \{\n        if \(runType === 'normal'\)/);
  // a backend failure turns queue auto-start off; the next explicit generate click must turn it back on
  assert.match(generate, /globalThis\.generate\.autoStartDisabledByError = true;\n\s*setQueueAutoStart\(false\);/);
  assert.match(start, /if \(globalThis\.generate\.autoStartDisabledByError && !globalThis\.globalSettings\.generate_auto_start\) \{[\s\S]*setQueueAutoStart\(true\);/);
  assert.match(start, /globalThis\.inGenerating = false;/);
  assert.match(start, /\} finally \{\n        globalThis\.generate\.generate_single\.setClickable\(true\);\n        globalThis\.generate\.generate_batch\.setClickable\(true\);\n        globalThis\.generate\.generate_same\.setClickable\(true\);/);
});

test('SAA asks the loopback ComfyUI to unload models when the last window closes', async () => {
  assert.match(main, /import \{ releaseComfyModels \} from '\.\/scripts\/main\/comfyRelease\.js';/);
  assert.match(main, /app\.on\('window-all-closed', async function \(\) \{[\s\S]*await releaseComfyModels\(getGlobalSettings\(\)\);[\s\S]*app\.quit\(\)/);

  // electron is not importable under node:test; evaluate the pure address guard by stubbing the import
  const source = read('scripts/main/comfyRelease.js').replace("import { net } from 'electron';", 'const net = { request: null };');
  const moduleUrl = `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
  const { loopbackComfyAddress, releaseComfyModels } = await import(moduleUrl);
  assert.equal(loopbackComfyAddress({ api_interface: 'ComfyUI', api_addr: '127.0.0.1:8189' }), 'http://127.0.0.1:8189');
  assert.equal(loopbackComfyAddress({ api_interface: 'ComfyUI', api_addr: 'http://localhost:8189/' }), 'http://localhost:8189');
  assert.equal(loopbackComfyAddress({ api_interface: 'ComfyUI', api_addr: '192.168.1.5:8188' }), null, 'never touches non-loopback hosts');
  assert.equal(loopbackComfyAddress({ api_interface: 'WebUI', api_addr: '127.0.0.1:7860' }), null);
  assert.equal(await releaseComfyModels({ api_interface: 'WebUI', api_addr: '127.0.0.1:7860' }), false);

  const calls = [];
  const fakeRequest = options => {
    calls.push(options);
    const handlers = {};
    return {
      on: (event, handler) => { handlers[event] = handler; },
      write: body => calls.push(JSON.parse(body)),
      end: () => {
        const listeners = {};
        handlers.response({ statusCode: 200, on: (event, fn) => { listeners[event] = fn; if (event === 'end') fn(); } });
      },
      abort: () => {},
    };
  };
  const previousLog = console.log;
  console.log = () => {};
  try {
    assert.equal(await releaseComfyModels({ api_interface: 'ComfyUI', api_addr: '127.0.0.1:8189' }, { request: fakeRequest }), true);
  } finally {
    console.log = previousLog;
  }
  assert.equal(calls[0].url, 'http://127.0.0.1:8189/free');
  assert.deepEqual(calls[1], { unload_models: true, free_memory: true });
});

test('stack scripts kill the ComfyUI process tree and refresh stale pid files', {
  skip: !stackRoot ? 'set SAA_STACK_ROOT to run the external stack contract' : false,
}, () => {
  const stop = fs.readFileSync(path.join(stackRoot, 'stop-wai-stack.ps1'), 'utf8');
  const startComfy = fs.readFileSync(path.join(stackRoot, 'start-comfy.ps1'), 'utf8');
  const startSaa = fs.readFileSync(path.join(stackRoot, 'start-saa.ps1'), 'utf8');
  assert.match(stop, /function Stop-ProcessTree/);
  assert.match(stop, /ParentProcessId -eq \$current/);
  assert.match(stop, /\/free/);
  assert.match(stop, /runtime\\ComfyUI\\main\.py/);
  assert.match(stop, /Stopped \$label/);
  assert.match(startComfy, /already running/i);
  assert.match(startComfy, /Set-Content -LiteralPath \$pidFile -Value \$running\.ProcessId/);
  assert.match(startSaa, /Set-Content -LiteralPath \$pidFile -Value \$running\.ProcessId/);
});
