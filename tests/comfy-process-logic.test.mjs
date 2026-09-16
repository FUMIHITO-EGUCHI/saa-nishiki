import test from 'node:test';
import assert from 'node:assert/strict';

import { firstToken, launchSpec, loopbackPort, parseLsofPids, parseNetstatPids, shouldAutostart } from '../scripts/shared/comfyProcessLogic.js';

test('the loopback port comes from api_addr; remote hosts are never touched', () => {
    assert.equal(loopbackPort('127.0.0.1:8189'), 8189);
    assert.equal(loopbackPort('http://localhost:8188'), 8188);
    assert.equal(loopbackPort('localhost'), 8188, 'ComfyUI default port');
    assert.equal(loopbackPort('https://abc-8188.proxy.runpod.net'), null);
    assert.equal(loopbackPort(''), null);
});

test('on Windows a .ps1 launch command runs through cmd.exe hosting powershell (a detached powershell.exe exits silently)', () => {
    const spec = launchSpec('C:\\wai-stack\\start-comfy.ps1', 'win32', { log: 'C:\\logs\\comfy-launch.log' });
    assert.equal(spec.file, 'cmd.exe');
    assert.deepEqual(spec.args.slice(0, 3), ['/d', '/s', '/c']);
    assert.equal(spec.windowsVerbatimArguments, true, 'the command line goes to cmd.exe as typed');
    const line = spec.args[3];
    assert.match(line, /^"powershell\.exe -NoProfile -ExecutionPolicy Bypass -Command "/);
    assert.match(line, /& 'C:\\wai-stack\\start-comfy\.ps1' \*>&1 \| Out-File -Append -Encoding utf8 -FilePath 'C:\\logs\\comfy-launch\.log'/, 'the script output lands in the launch log');
    assert.match(line, /catch \{ \$_ \| Out-File -Append[^}]*; exit 1 \}/, 'a throw is logged and fails the launch');
    assert.match(line, /exit \$LASTEXITCODE""$/, 'the script exit code is the launch exit code');
    assert.equal(line.slice(1, -1).split('"').length, 3, 'no double quotes inside the -Command "..." argument');
    assert.equal(spec.selfLogged, true, 'the caller keeps the log out of the child stdio (Out-File needs the file free)');
    assert.equal(spec.cwd, 'C:\\wai-stack');
    assert.equal(spec.shell, false);
});

test('without a log the .ps1 runs the same way, just unlogged', () => {
    const spec = launchSpec('C:\\wai-stack\\start-comfy.ps1', 'win32');
    assert.equal(spec.file, 'cmd.exe');
    assert.doesNotMatch(spec.args[3], /Out-File/);
    assert.match(spec.args[3], /try \{ & 'C:\\wai-stack\\start-comfy\.ps1' \} catch \{ exit 1 \}; exit \$LASTEXITCODE/);
    assert.equal(spec.selfLogged, false);
});

test('a quoted script path with spaces keeps its arguments; single quotes in the path are escaped', () => {
    const spec = launchSpec('"C:\\my stack\\start-comfy.ps1" -Port 8189', 'win32');
    assert.match(spec.args[3], /& 'C:\\my stack\\start-comfy\.ps1' -Port 8189/);
    assert.equal(spec.cwd, 'C:\\my stack');
    assert.match(launchSpec("C:\\o'neil\\start.ps1", 'win32').args[3], /& 'C:\\o''neil\\start\.ps1'/);
    assert.equal(firstToken('"C:\\my stack\\x.ps1" -a'), 'C:\\my stack\\x.ps1');
});

test('elsewhere a .ps1 runs through pwsh with the script as -File', () => {
    const spec = launchSpec('/opt/wai/start-comfy.ps1 -Port 8189', 'linux');
    assert.equal(spec.file, 'pwsh');
    assert.deepEqual(spec.args, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', '/opt/wai/start-comfy.ps1', '-Port', '8189']);
    assert.equal(spec.cwd, '/opt/wai');
});

test('.cmd / .bat go through cmd.exe, anything else through the shell as typed', () => {
    const cmd = launchSpec('C:\\wai-stack\\Start-Comfy.cmd', 'win32');
    assert.equal(cmd.file, 'cmd.exe');
    assert.equal(cmd.args.at(-1), '"C:\\wai-stack\\Start-Comfy.cmd"');
    const raw = launchSpec('python main.py --port 8189', 'win32');
    assert.equal(raw.shell, true);
    assert.equal(raw.file, 'python main.py --port 8189');
    assert.equal(launchSpec('   '), null);
});

test('netstat output yields only the pids listening on the wanted port', () => {
    const output = [
        'Active Connections',
        '',
        '  Proto  Local Address          Foreign Address        State           PID',
        '  TCP    127.0.0.1:8189         0.0.0.0:0              LISTENING       4321',
        '  TCP    127.0.0.1:8189         127.0.0.1:52000        ESTABLISHED     4321',
        '  TCP    0.0.0.0:8188           0.0.0.0:0              LISTENING       999',
        '  TCP    [::1]:8189             [::]:0                 LISTENING       4321',
        '  UDP    0.0.0.0:8189           *:*                                    77',
    ].join('\r\n');
    assert.deepEqual(parseNetstatPids(output, 8189), [4321]);
    assert.deepEqual(parseNetstatPids(output, 8188), [999]);
    assert.deepEqual(parseNetstatPids(output, 81), []);
});

test('lsof -t output is one pid per line', () => {
    assert.deepEqual(parseLsofPids('4321\n4321\n77\n'), [4321, 77]);
    assert.deepEqual(parseLsofPids(''), []);
});

test('autostart only when enabled, configured, local, and the backend is down', () => {
    const base = { api_interface: 'ComfyUI', api_addr: '127.0.0.1:8189', comfy_autostart: true, comfy_launch_command: 'C:\\x\\start-comfy.ps1' };
    assert.equal(shouldAutostart(base, { ok: false }), true);
    assert.equal(shouldAutostart(base, { ok: true }), false, 'already up');
    assert.equal(shouldAutostart({ ...base, comfy_autostart: false }, { ok: false }), false);
    assert.equal(shouldAutostart({ ...base, comfy_launch_command: '' }, { ok: false }), false);
    assert.equal(shouldAutostart({ ...base, api_pod_ssh_enable: true }, { ok: false }), false, 'pod generation');
    assert.equal(shouldAutostart({ ...base, api_addr: 'https://x.proxy.runpod.net' }, { ok: false }), false, 'remote');
    assert.equal(shouldAutostart({ ...base, api_interface: 'WebUI' }, { ok: false }), false);
});
