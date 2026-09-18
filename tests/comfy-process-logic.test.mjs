import test from 'node:test';
import assert from 'node:assert/strict';

import {
    chdirTarget, firstToken, isComfySystemStats, launchPending, launchSpec, listenerPidsForHost, loopbackPort, loopbackTarget,
    parseLsofListeners, parseNetstatListeners, parseTasklistName, shouldAutostart, splitCommandLine, stopTargets, tailLines,
} from '../scripts/shared/comfyProcessLogic.js';
import { httpApiUrl, normalizeApiAddress } from '../scripts/shared/backendAddress.js';

// the PowerShell script block a Windows .ps1 spec hands over base64-encoded
function encodedScript(spec) {
    const match = spec.args[3].match(/^"powershell\.exe -NoProfile -ExecutionPolicy Bypass -EncodedCommand ([A-Za-z0-9+/=]+)"$/);
    assert.ok(match, `cmd.exe gets only an encoded PowerShell command: ${spec.args[3]}`);
    return Buffer.from(match[1], 'base64').toString('utf16le');
}

test('the loopback port comes from api_addr; remote hosts are never touched', () => {
    assert.equal(loopbackPort('127.0.0.1:8189'), 8189);
    assert.equal(loopbackPort('http://localhost:8188'), 8188);
    assert.equal(loopbackPort('https://abc-8188.proxy.runpod.net'), null);
    assert.equal(loopbackPort(''), null);
    assert.equal(loopbackTarget('0.0.0.0:8188'), null);
    assert.equal(loopbackTarget('http://127.0.0.1:8188@evil.com'), null);
    assert.equal(loopbackTarget('[::ffff:127.0.0.1]:8188'), null);
    assert.deepEqual(loopbackTarget('[::1]:8189'), { protocol: 'http:', host: '::1', port: 8189 });
    assert.deepEqual(loopbackTarget('https://localhost:8443'), { protocol: 'https:', host: 'localhost', port: 8443 });
});

test('an address without a port means the port the generation requests go to', () => {
    for (const address of ['localhost', '127.0.0.1', 'http://127.0.0.1:80', 'https://127.0.0.1', 'https://localhost:443/', '127.0.0.1:8189']) {
        const url = new URL(httpApiUrl(normalizeApiAddress(address)));
        const generationPort = Number(url.port) || (url.protocol === 'https:' ? 443 : 80);
        assert.equal(loopbackPort(address), generationPort, address);
        assert.equal(loopbackTarget(address).protocol, url.protocol, address);
    }
});

test('on Windows a .ps1 launch command runs through cmd.exe hosting powershell (a detached powershell.exe exits silently)', () => {
    const spec = launchSpec('C:\\wai-stack\\start-comfy.ps1', 'win32', { log: 'C:\\logs\\comfy-launch.log' });
    assert.equal(spec.file, 'cmd.exe');
    assert.deepEqual(spec.args.slice(0, 3), ['/d', '/s', '/c']);
    assert.equal(spec.windowsVerbatimArguments, true, 'the command line goes to cmd.exe as typed');
    const script = encodedScript(spec);
    assert.equal(spec.script, script);
    assert.match(script, /& 'C:\\wai-stack\\start-comfy\.ps1'\n\} \*>&1 \| Out-File -Append -Encoding utf8 -FilePath 'C:\\logs\\comfy-launch\.log'/, 'the script output lands in the launch log');
    assert.match(script, /catch \{ \$_ \| Out-File -Append[^}]*; exit 1 \}/, 'a throw is logged and fails the launch');
    assert.match(script, /exit \$LASTEXITCODE$/, 'the script exit code is the launch exit code');
    assert.equal(spec.selfLogged, true, 'the caller keeps the log out of the child stdio (Out-File needs the file free)');
    assert.equal(spec.cwd, 'C:\\wai-stack');
    assert.equal(spec.shell, false);
});

test('without a log the .ps1 runs the same way, just unlogged', () => {
    const spec = launchSpec('C:\\wai-stack\\start-comfy.ps1', 'win32');
    assert.equal(spec.file, 'cmd.exe');
    const script = encodedScript(spec);
    assert.doesNotMatch(script, /Out-File/);
    assert.equal(script, "try { & {\n& 'C:\\wai-stack\\start-comfy.ps1'\n} } catch { exit 1 }; exit $LASTEXITCODE");
    assert.equal(spec.selfLogged, false);
});

test('a .ps1 path and its arguments reach PowerShell as typed, whatever cmd.exe would make of them', () => {
    const spec = launchSpec('"C:\\my stack & 100%\\start-comfy.ps1" -Dir "C:\\Program Files\\X" -Name \'a&b\' # note', 'win32', { log: 'C:\\logs\\comfy-launch.log' });
    assert.equal(spec.args[3].slice(1, -1).includes('"'), false, 'no double quote inside the cmd.exe argument');
    assert.doesNotMatch(spec.args[3], /[&%^|<>]/, 'nothing cmd.exe acts on');
    const lines = encodedScript(spec).split('\n');
    assert.equal(lines[1], "& 'C:\\my stack & 100%\\start-comfy.ps1' -Dir \"C:\\Program Files\\X\" -Name 'a&b' # note");
    assert.match(lines[2], /^\} \*>&1 \| Out-File/, 'a # in the arguments cannot swallow the redirect and the error handling');
    assert.equal(spec.cwd, 'C:\\my stack & 100%');
});

test('a quoted script path with spaces keeps its arguments; single quotes in the path are escaped', () => {
    const spec = launchSpec('"C:\\my stack\\start-comfy.ps1" -Port 8189', 'win32');
    assert.match(encodedScript(spec), /& 'C:\\my stack\\start-comfy\.ps1' -Port 8189/);
    assert.equal(spec.cwd, 'C:\\my stack');
    assert.match(encodedScript(launchSpec("C:\\o'neil\\start.ps1", 'win32')), /& 'C:\\o''neil\\start\.ps1'/);
    assert.match(encodedScript(launchSpec('C:\\O\u2019Brien\\start.ps1', 'win32')), /& 'C:\\O\u2019\u2019Brien\\start\.ps1'/,
        'PowerShell reads a typographic quote as a quote too');
    assert.equal(firstToken('"C:\\my stack\\x.ps1" -a'), 'C:\\my stack\\x.ps1');
});

test('an unquoted path with spaces is refused with a hint instead of running C:\\my', () => {
    assert.match(launchSpec('C:\\my stack\\start-comfy.ps1 -Port 8189', 'win32').error, /double quotes: "C:\\my stack\\start-comfy\.ps1"/);
    assert.match(launchSpec('C:\\Program Files\\ComfyUI\\run.bat', 'win32').error, /double quotes/);
    assert.equal(launchSpec('C:\\ComfyUI\\python_embeded\\python -s main.py', 'win32', { exists: () => true }).error, undefined);
    assert.equal(launchSpec('"C:\\my stack\\start-comfy.ps1"', 'win32').error, undefined);
});

test('elsewhere a .ps1 runs through pwsh with the script as -File', () => {
    const spec = launchSpec('/opt/wai/start-comfy.ps1 -Port 8189', 'linux');
    assert.equal(spec.file, 'pwsh');
    assert.deepEqual(spec.args, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', '/opt/wai/start-comfy.ps1', '-Port', '8189']);
    assert.equal(spec.cwd, '/opt/wai');
    assert.deepEqual(launchSpec('/opt/wai/start-comfy.ps1 -Dir "/opt/my models"', 'linux').args.slice(-2), ['-Dir', '/opt/my models'],
        'a quoted argument stays one argument');
});

test('.cmd / .bat go through cmd.exe, anything else through the shell as typed', () => {
    const cmd = launchSpec('C:\\wai-stack\\Start-Comfy.cmd', 'win32');
    assert.equal(cmd.file, 'cmd.exe');
    assert.equal(cmd.args.at(-1), '"C:\\wai-stack\\Start-Comfy.cmd"');
    const quoted = launchSpec('"C:\\my stack\\run.bat" --x', 'win32');
    assert.equal(quoted.args.at(-1), '""C:\\my stack\\run.bat" --x"');
    const raw = launchSpec('python main.py --port 8189', 'win32');
    assert.equal(raw.shell, true);
    assert.equal(raw.file, 'python main.py --port 8189');
    assert.equal(launchSpec('   '), null);
});

test('a relative main.py runs from a folder where it exists, or is refused', () => {
    const portable = 'C:\\ComfyUI_windows_portable\\python_embeded\\python.exe -s ComfyUI\\main.py --windows-standalone-build';
    const files = new Set(['C:\\ComfyUI_windows_portable\\ComfyUI\\main.py', 'C:\\ComfyUI\\main.py']);
    assert.equal(launchSpec(portable, 'win32', { exists: file => files.has(file) }).cwd, 'C:\\ComfyUI_windows_portable');
    assert.equal(launchSpec('C:\\ComfyUI\\python.exe main.py', 'win32', { exists: file => files.has(file) }).cwd, 'C:\\ComfyUI');
    assert.match(launchSpec('python main.py --port 8189', 'win32', { exists: file => files.has(file) }).error, /main\.py is a relative path/);
    assert.match(launchSpec('C:\\venv\\python.exe main.py', 'win32', { exists: () => false }).error, /full path/);
    assert.equal(launchSpec('python C:\\ComfyUI\\main.py', 'win32', { exists: file => files.has(file) }).cwd, 'C:\\ComfyUI');
    assert.equal(launchSpec('C:\\venv\\Scripts\\python.exe C:\\ComfyUI\\main.py', 'win32', { exists: () => true }).cwd, 'C:\\venv\\Scripts');
});

test('a command that changes directory itself keeps its relative main.py', () => {
    const exists = () => false;   // SAA cannot place anything: the command does that itself
    const cd = launchSpec('cd /d C:\\ComfyUI && python main.py --port 8188', 'win32', { exists, extraArgs: ['--fast'] });
    assert.equal(cd.error, undefined);
    assert.equal(cd.shell, true);
    assert.equal(cd.cwd, 'C:\\ComfyUI');
    assert.equal(cd.file, 'cd /d C:\\ComfyUI && python main.py --port 8188 --fast', 'the flags go to the command that runs last');
    assert.equal(launchSpec('pushd "C:\\my stack" & python main.py', 'win32', { exists }).cwd, 'C:\\my stack');
    assert.equal(chdirTarget('cd /d C:\\ComfyUI && python main.py'), 'C:\\ComfyUI');
    assert.equal(chdirTarget('cd ComfyUI && python main.py'), '', 'a relative folder still says nothing about where main.py is');
    assert.equal(chdirTarget('python C:\\ComfyUI\\main.py'), '');
    assert.match(launchSpec('python main.py --port 8188', 'win32', { exists }).error, /relative path/, 'without the cd it is still refused');
});

test('fast-mode flags are not swallowed by a comment in the launch command', () => {
    const spec = launchSpec('C:\\wai\\start.ps1 -Port 8189 # my note', 'win32', { extraArgs: ['--use-sage-attention', '--fast'] });
    assert.match(spec.script, /& 'C:\\wai\\start\.ps1' -Port 8189 --use-sage-attention --fast # my note/);
    // a # inside quotes is part of an argument, not a comment
    const quoted = launchSpec('C:\\wai\\start.ps1 -Tag "a#b"', 'win32', { extraArgs: ['--fast'] });
    assert.match(quoted.script, /-Tag "a#b" --fast/);
});

test('command lines split on spaces outside double quotes', () => {
    assert.deepEqual(splitCommandLine('-Dir "C:\\Program Files\\X"  -Port 8189 ""'), ['-Dir', 'C:\\Program Files\\X', '-Port', '8189', '']);
    assert.deepEqual(splitCommandLine(''), []);
});

const NETSTAT_EN = [
    'Active Connections',
    '',
    '  Proto  Local Address          Foreign Address        State           PID',
    '  TCP    127.0.0.1:8189         0.0.0.0:0              LISTENING       4321',
    '  TCP    127.0.0.1:8189         127.0.0.1:52000        ESTABLISHED     4321',
    '  TCP    127.0.0.1:18189        0.0.0.0:0              LISTENING       555',
    '  TCP    0.0.0.0:8188           0.0.0.0:0              LISTENING       999',
    '  TCP    192.168.0.21:8190      0.0.0.0:0              LISTENING       31',
    '  TCP    0.0.0.0:445            0.0.0.0:0              LISTENING       4',
    '  TCP    [::1]:8191             [::]:0                 LISTENING       777',
    '  TCP    [::]:8192              [::]:0                 LISTENING       888',
    '  TCP    [fe80::1%12]:8193      [::]:0                 LISTENING       66',
    '  UDP    0.0.0.0:8189           *:*                                    77',
].join('\r\n');

test('netstat output yields the listeners on the port, IPv4 and IPv6, whatever the language of the state column', () => {
    assert.deepEqual(parseNetstatListeners(NETSTAT_EN, 8189), [{ pid: 4321, host: '127.0.0.1' }], 'not 18189, not UDP, not an established connection');
    assert.deepEqual(parseNetstatListeners(NETSTAT_EN, 8191), [{ pid: 777, host: '::1' }]);
    assert.deepEqual(parseNetstatListeners(NETSTAT_EN, 8193), [{ pid: 66, host: 'fe80::1' }]);
    assert.deepEqual(parseNetstatListeners(NETSTAT_EN, 81), []);
    const german = NETSTAT_EN.replaceAll('LISTENING', 'ABHÖREN').replace('ESTABLISHED', 'HERGESTELLT');
    assert.deepEqual(parseNetstatListeners(german, 8189), [{ pid: 4321, host: '127.0.0.1' }]);
    assert.deepEqual(parseNetstatListeners(german, 8192), [{ pid: 888, host: '::' }]);
    const spaced = NETSTAT_EN.replaceAll('LISTENING', 'EN ESCUCHA');
    assert.deepEqual(parseNetstatListeners(spaced, 8188), [{ pid: 999, host: '0.0.0.0' }], 'the pid is the last column');
});

test('only the listeners a request to the configured host reaches count', () => {
    const listeners = [{ pid: 10, host: '127.0.0.1' }, { pid: 11, host: '0.0.0.0' }, { pid: 12, host: '::' }, { pid: 13, host: '192.168.0.21' }, { pid: 14, host: '::1' }];
    assert.deepEqual(listenerPidsForHost(listeners, '127.0.0.1'), [10], 'the exact bind wins over a wildcard one');
    assert.deepEqual(listenerPidsForHost(listeners, '::1'), [14]);
    assert.deepEqual(listenerPidsForHost(listeners, 'localhost'), [10, 14]);
    assert.deepEqual(listenerPidsForHost([{ pid: 11, host: '0.0.0.0' }, { pid: 12, host: '::' }], '127.0.0.1'), [11]);
    assert.deepEqual(listenerPidsForHost([{ pid: 12, host: '::' }], '127.0.0.1'), [12], 'a dual-stack socket also takes IPv4');
    assert.deepEqual(listenerPidsForHost([{ pid: 11, host: '0.0.0.0' }], '::1'), [], 'an IPv4 socket never takes ::1');
    assert.deepEqual(listenerPidsForHost([{ pid: 13, host: '192.168.0.21' }], '127.0.0.1'), [], 'a LAN-only bind is someone else');
    assert.deepEqual(listenerPidsForHost([{ pid: 15, host: '*' }], '::1'), [15]);
});

test('lsof -Fpn output gives pid and address per listening socket', () => {
    assert.deepEqual(parseLsofListeners('p4321\nf5\nn127.0.0.1:8188\nf6\nn[::1]:8188\np77\nf3\nn*:8188\n'),
        [{ pid: 4321, host: '127.0.0.1' }, { pid: 4321, host: '::1' }, { pid: 77, host: '*' }]);
    assert.deepEqual(parseLsofListeners(''), []);
});

test('Stop ends a listener only when it is the ComfyUI SAA talks to, and never SAA itself', () => {
    const protectedPids = [500, 400];
    assert.deepEqual(stopTargets([4321], { answered: true, protectedPids }), { kill: [4321], spared: [] });
    assert.deepEqual(stopTargets([4321], { answered: false, protectedPids }), { kill: [], spared: [4321] }, 'no ComfyUI answer, not launched by SAA: someone else');
    assert.deepEqual(stopTargets([4321, 99], { answered: false, launchedPids: [4321], protectedPids }), { kill: [4321], spared: [99] }, 'a hung ComfyUI SAA launched');
    assert.deepEqual(stopTargets([500, 4321], { answered: true, protectedPids }), { kill: [4321], spared: [500] }, "SAA's own port");
    assert.deepEqual(stopTargets([400], { answered: true, launchedPids: [400], protectedPids }), { kill: [], spared: [400] }, "SAA's parent");
    assert.deepEqual(stopTargets([4, 0], { answered: true }), { kill: [], spared: [4, 0] }, 'system pids');
});

test('a listener SAA cannot verify is ended once the user allowed it, but never SAA itself', () => {
    const protectedPids = [500, 400];
    assert.deepEqual(stopTargets([4321], { answered: false, protectedPids, unverified: true }), { kill: [4321], spared: [] },
        'the user was shown the pid and the program and said to end it');
    assert.deepEqual(stopTargets([500, 400, 4, 4321], { answered: false, protectedPids, unverified: true }), { kill: [4321], spared: [500, 400, 4] },
        'SAA, its parent and system pids stay out of it');
});

test('the pid boundary: 5 is an ordinary process, 0-4 are the system ones', () => {
    assert.deepEqual(stopTargets([5], { answered: true }), { kill: [5], spared: [] }, 'pid 5 is no system pid');
    assert.deepEqual(stopTargets([0, 1, 2, 3, 4], { answered: true, unverified: true }), { kill: [], spared: [0, 1, 2, 3, 4] },
        'Idle, System and the low kernel pids are never ended, however the Stop was asked for');
    assert.deepEqual(stopTargets([5], { unverified: true }), { kill: [5], spared: [] });
    assert.deepEqual(stopTargets([4.5, Number.NaN, -1], { answered: true }), { kill: [], spared: [4.5, Number.NaN, -1] }, 'only whole positive pids');
});

test('with no options at all a listener is spared: nothing counts as answered or allowed', () => {
    assert.deepEqual(stopTargets([4321]), { kill: [], spared: [4321] }, 'an unverified listener is not ended unasked');
    assert.deepEqual(stopTargets([4321], {}), { kill: [], spared: [4321] });
    assert.deepEqual(stopTargets([4321], { launchedPids: [99] }), { kill: [], spared: [4321] }, 'another pid in the record does not help');
    // and nothing is protected by default either: an answering ComfyUI is ended
    assert.deepEqual(stopTargets([4321], { answered: true }), { kill: [4321], spared: [] });
    assert.deepEqual(stopTargets([4321], { answered: false, launchedPids: [4321] }), { kill: [4321], spared: [] }, 'SAA launched it');
    assert.deepEqual(stopTargets([], { answered: true }), { kill: [], spared: [] });
});

test('tasklist names the program behind a pid', () => {
    assert.equal(parseTasklistName('"python.exe","1234","Console","1","2,345,678 K"'), 'python.exe');
    assert.equal(parseTasklistName('\r\n"cmd.exe","99","Console","1","3,000 K"\r\n'), 'cmd.exe');
    assert.equal(parseTasklistName('INFO: No tasks are running which match the specified criteria.'), '');
    assert.equal(parseTasklistName(''), '');
});

test('a launch record stands for a start under way only while it can still come up', () => {
    const at = '2026-09-17T10:00:00.000Z';
    const now = Date.parse(at);
    const pending = { port: 8189, pids: [], args: [], launcher: 123, at };
    const options = { waitMs: 120_000, lateMs: 600_000, deadMs: 15_000 };
    assert.equal(launchPending(pending, 8189, { ...options, now: now + 30_000, launcherAlive: true }), true, 'within the start wait');
    assert.equal(launchPending(pending, 8189, { ...options, now: now + 300_000, launcherAlive: true }), true, 'a start script still waiting');
    assert.equal(launchPending(pending, 8189, { ...options, now: now + 700_000, launcherAlive: true }), false);
    assert.equal(launchPending({ ...pending, pids: [4321] }, 8189, { ...options, now, launcherAlive: true }), false, 'it came up');
    assert.equal(launchPending({ ...pending, ended: true }, 8189, { ...options, now, launcherAlive: true }), false, 'failed or stopped');
    assert.equal(launchPending(pending, 8188, { ...options, now, launcherAlive: true }), false, 'another port');
    assert.equal(launchPending(pending, 8189, { ...options, now: now - 5000, launcherAlive: true }), false, 'a clock that went back does not block starts');
    assert.equal(launchPending(null, 8189, options), false);
});

test('a launch whose launcher is gone stops holding the port: SAA crashed during that start', () => {
    const at = '2026-09-17T10:00:00.000Z';
    const now = Date.parse(at);
    const pending = { port: 8189, pids: [], args: [], launcher: 123, at };
    const options = { waitMs: 120_000, lateMs: 600_000, deadMs: 15_000 };
    assert.equal(launchPending(pending, 8189, { ...options, now: now + 5000 }), true, 'moments old: another SAA instance may be launching');
    assert.equal(launchPending(pending, 8189, { ...options, now: now + 30_000 }), false, 'launcher gone: a new Start is the only way out');
    // an old record without a launcher pid is still judged by the start wait alone
    const noLauncher = { port: 8189, pids: [], args: [], at };
    assert.equal(launchPending(noLauncher, 8189, { ...options, now: now + 30_000 }), true);
    assert.equal(launchPending(noLauncher, 8189, { ...options, now: now + 300_000 }), false);
});

test("only ComfyUI's own /system_stats counts as ComfyUI", () => {
    assert.equal(isComfySystemStats('{"system":{"os":"nt","argv":["main.py"]},"devices":[]}'), true);
    assert.equal(isComfySystemStats('{"error":"not found"}'), false);
    assert.equal(isComfySystemStats('<html>'), false);
    assert.equal(isComfySystemStats(''), false);
});

test('the log tail treats a progress redraw (\\r) as a line end and cuts long lines', () => {
    assert.equal(tailLines('a\r\nb\n\nc 10%\rc 50%\rc 100%\n', 3), 'c 10%\nc 50%\nc 100%');
    assert.equal(tailLines(`${'x'.repeat(500)}\n`, 30, 10), `${'x'.repeat(10)}…`);
    assert.equal(tailLines(''), '');
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
