import assert from 'node:assert/strict';
import test from 'node:test';

import {
    compareLaunchArgs, desiredLaunchArgs, flagGroups, invalidLaunchArgs, managedLaunchFlags, parseLaunchArgs,
} from '../scripts/shared/comfyLaunchArgs.js';
import { launchSpec } from '../scripts/shared/comfyProcessLogic.js';

const SETTINGS = {
    api_fast_enable: true,
    api_fast_comfy_args: '',
    api_fast_diff_comfy_args: '--use-sage-attention --fast',
};

// sys.argv of the stack's ComfyUI as /system_stats reports it
const BASE_ARGV = ['C:\\wai-stack\\runtime\\ComfyUI\\main.py', '--listen', '127.0.0.1', '--port', '8189', '--disable-auto-launch',
    '--database-url', 'sqlite:///C:/wai-stack/user/comfyui.db', '--preview-method', 'latent2rgb'];

test('flag strings split into tokens and refuse anything a shell could act on', () => {
    assert.deepEqual(parseLaunchArgs('  --use-sage-attention   --fast '), { args: ['--use-sage-attention', '--fast'], invalid: [] });
    assert.deepEqual(parseLaunchArgs('--fast fp16_accumulation autotune').args, ['--fast', 'fp16_accumulation', 'autotune']);
    assert.deepEqual(parseLaunchArgs('--fast & calc'), { args: [], invalid: ['&'] }, 'one bad token voids the whole string');
    assert.deepEqual(parseLaunchArgs('--fast;rm').invalid, ['--fast;rm']);
    assert.deepEqual(parseLaunchArgs('"--fast"').invalid, ['"--fast"']);
    assert.deepEqual(parseLaunchArgs('--x=%PATH%').invalid, ['--x=%PATH%']);
    assert.deepEqual(parseLaunchArgs('--x $(id)').invalid, ['$(id)']);
    assert.deepEqual(parseLaunchArgs('autotune --fast'), { args: [], invalid: ['autotune'] }, 'a value needs a flag in front');
    assert.deepEqual(parseLaunchArgs(undefined), { args: [], invalid: [] });
});

test('flag groups keep the values that follow a flag', () => {
    assert.deepEqual(flagGroups(['main.py', '--port', '8189', '--fast', '--use-sage-attention']), [
        { flag: '--port', values: ['8189'] },
        { flag: '--fast', values: [] },
        { flag: '--use-sage-attention', values: [] },
    ]);
});

test('each route wants its own flags, and none with fast mode off', () => {
    assert.deepEqual(desiredLaunchArgs(SETTINGS, { diffusion: true }), ['--use-sage-attention', '--fast']);
    assert.deepEqual(desiredLaunchArgs(SETTINGS, { diffusion: false }), []);
    assert.deepEqual(desiredLaunchArgs({ ...SETTINGS, api_fast_enable: false }, { diffusion: true }), []);
    assert.deepEqual(desiredLaunchArgs({ ...SETTINGS, api_fast_diff_comfy_args: '--fast | x' }, { diffusion: true }), []);
    assert.deepEqual(invalidLaunchArgs({ ...SETTINGS, api_fast_diff_comfy_args: '--fast | x' }, { diffusion: true }), ['|']);
    assert.deepEqual([...managedLaunchFlags({ ...SETTINGS, api_fast_comfy_args: '--fast autotune' })].sort(), ['--fast', '--use-sage-attention']);
    assert.deepEqual([...managedLaunchFlags({ ...SETTINGS, api_fast_enable: false })].sort(), ['--fast', '--use-sage-attention'],
        'flags stay managed with fast mode off, so they can be taken away');
});

test('a caller that names no route gets the Checkpoint set, and both sets stay managed', () => {
    // the route is an option: without it the Checkpoint fast set applies, never the Diffusion one
    const both = { api_fast_enable: true, api_fast_comfy_args: '--cache-none --reserve-vram 1.0', api_fast_diff_comfy_args: '--use-sage-attention --fast' };
    assert.deepEqual(desiredLaunchArgs(both), ['--cache-none', '--reserve-vram', '1.0']);
    assert.deepEqual(desiredLaunchArgs(both, {}), ['--cache-none', '--reserve-vram', '1.0']);
    assert.deepEqual(desiredLaunchArgs({ ...both, api_fast_enable: false }), []);
    assert.deepEqual(invalidLaunchArgs(both), []);
    assert.deepEqual(invalidLaunchArgs({ ...both, api_fast_comfy_args: '--cache-none > out' }), ['>']);
    // managedLaunchFlags walks both sets: a flag only one of them carries is SAA's to take away
    assert.deepEqual([...managedLaunchFlags(both)].sort(), ['--cache-none', '--fast', '--reserve-vram', '--use-sage-attention']);
});

test('a plain process lacks the Diffusion fast flags', () => {
    const result = compareLaunchArgs(BASE_ARGV, ['--use-sage-attention', '--fast'], managedLaunchFlags(SETTINGS));
    assert.deepEqual(result, { match: false, missing: ['--use-sage-attention', '--fast'], unwanted: [] });
});

test('a fast process matches the Diffusion fast run, whatever the order', () => {
    const argv = [...BASE_ARGV, '--fast', '--use-sage-attention'];
    assert.equal(compareLaunchArgs(argv, ['--use-sage-attention', '--fast'], managedLaunchFlags(SETTINGS)).match, true);
});

test('a checkpoint run on a fast process wants the managed flags gone', () => {
    const argv = [...BASE_ARGV, '--use-sage-attention', '--fast'];
    const result = compareLaunchArgs(argv, [], managedLaunchFlags(SETTINGS));
    assert.deepEqual(result, { match: false, missing: [], unwanted: ['--use-sage-attention', '--fast'] });
});

test('flags the user launches with themselves are never judged', () => {
    const argv = [...BASE_ARGV, '--lowvram'];
    assert.equal(compareLaunchArgs(argv, [], managedLaunchFlags(SETTINGS)).match, true);
});

test('a flag with other values counts as missing', () => {
    const argv = [...BASE_ARGV, '--fast', 'autotune'];
    assert.deepEqual(compareLaunchArgs(argv, ['--fast'], new Set(['--fast'])), { match: false, missing: ['--fast'], unwanted: [] });
    assert.equal(compareLaunchArgs([...BASE_ARGV, '--fast'], ['--fast'], new Set(['--fast'])).match, true);
});

test('launch flags reach every kind of launch command', () => {
    const extraArgs = ['--use-sage-attention', '--fast'];
    const ps1 = launchSpec('C:\\wai-stack\\start-comfy.ps1', 'win32', { log: 'C:\\logs\\comfy-launch.log', extraArgs });
    // the .ps1 call goes to PowerShell base64-encoded (-EncodedCommand); spec.script is what it decodes to
    assert.equal(Buffer.from(ps1.args[3].match(/-EncodedCommand (\S+)"$/)[1], 'base64').toString('utf16le'), ps1.script);
    assert.match(ps1.script, /& 'C:\\wai-stack\\start-comfy\.ps1' --use-sage-attention --fast\n\} \*>&1/);

    const ps1Args = launchSpec('"C:\\my stack\\start-comfy.ps1" -Port 8189', 'win32', { extraArgs });
    assert.match(ps1Args.script, /& 'C:\\my stack\\start-comfy\.ps1' -Port 8189 --use-sage-attention --fast/);

    const posix = launchSpec('/opt/wai/start-comfy.ps1', 'linux', { extraArgs });
    assert.deepEqual(posix.args.slice(-2), extraArgs);

    const cmd = launchSpec('C:\\wai-stack\\Start-Comfy.cmd', 'win32', { extraArgs });
    assert.equal(cmd.args.at(-1), '"C:\\wai-stack\\Start-Comfy.cmd --use-sage-attention --fast"');

    const python = launchSpec('python main.py --port 8189', 'win32', { extraArgs });
    assert.equal(python.file, 'python main.py --port 8189 --use-sage-attention --fast');
});

test('launch flags are dropped whole when a token is not shell-safe', () => {
    const python = launchSpec('python main.py', 'win32', { extraArgs: ['--fast', '&', 'calc'] });
    assert.equal(python.file, 'python main.py');
    const none = launchSpec('python main.py', 'win32');
    assert.equal(none.file, 'python main.py');
});

test('every name imported from comfyProcess.js is exported there (electron-bound, so not loadable in node)', async () => {
    const fs = await import('node:fs');
    const read = file => fs.readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
    const source = read('scripts/main/comfyProcess.js');
    const importers = [
        ['main.js', /import \{([^}]+)\} from '\.\/scripts\/main\/comfyProcess\.js'/],
        ['scripts/main/generate_backend_comfyui.js', /import \{([^}]+)\} from '\.\/comfyProcess\.js'/],
    ];
    for (const [file, pattern] of importers) {
        const names = read(file).match(pattern)?.[1].split(',').map(name => name.trim()).filter(Boolean) ?? [];
        assert.ok(names.length > 0, `${file} imports from comfyProcess.js`);
        for (const name of names) {
            assert.match(source, new RegExp(`export (async )?function ${name}[(]`), `${file} imports ${name}`);
        }
    }
});

test('only a run from the SAA window itself may restart the local ComfyUI for its flags', async () => {
    const fs = await import('node:fs');
    const read = file => fs.readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
    const backend = read('scripts/main/generate_backend_comfyui.js');
    // the call path decides, not the uuid in the message a client sent
    assert.match(backend, /ensureComfyLaunchArgs\(settings, \{[^}]*\n\s*remote,/, 'prepareFastModeRun is told by its caller');
    assert.doesNotMatch(backend, /remote: uuid/, 'never read out of the generation data');
    assert.match(backend, /prepareFastModeRun\(generateData, getGlobalSettings\(\), true\);/, 'a Python client run is remote');
    assert.equal(backend.match(/async function runComfyUI(?:_Regional)?\(generateData, \{ remote = false \} = \{\}\)/g)?.length, 2,
        'the IPC handlers get the local default');
    const service = read('scripts/webserver/back/wsService.js');
    for (const method of ['runComfyUI', 'runComfyUI_Regional']) {
        assert.match(service, new RegExp(`'${method}': \\(params\\)=> ${method}\\(params\\?\\.\\[0], \\{ remote: true \\}\\)`), `${method} over the websocket is remote`);
    }
    const source = read('scripts/main/comfyProcess.js');
    const remoteCheck = source.indexOf('if (remote) {');
    assert.ok(remoteCheck > 0, 'ensureComfyLaunchArgs checks remote');
    assert.ok(remoteCheck < source.indexOf('await restartComfy(settings, { extraArgs: desired'), 'before it restarts anything');
});
