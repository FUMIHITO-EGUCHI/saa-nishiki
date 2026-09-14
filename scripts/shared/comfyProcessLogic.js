// Pure pieces of the local ComfyUI process control (scripts/main/comfyProcess.js):
// how a launch command turns into a spawn, which port the backend listens on, and
// how the pids holding that port are read out of netstat / lsof output. No
// electron, no child_process here, so the tests run in plain node.

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
const COMFY_DEFAULT_PORT = 8188;

// The loopback port ComfyUI is configured on; null for a remote address (the
// process control only ever touches the local machine).
export function loopbackPort(apiAddress) {
    const raw = String(apiAddress ?? '').trim();
    if (!raw) return null;
    let url;
    try {
        url = new URL(/^https?:\/\//i.test(raw) ? raw : `http://${raw}`);
    } catch {
        return null;
    }
    if (!LOOPBACK_HOSTS.has(url.hostname)) return null;
    const port = url.port ? Number(url.port) : COMFY_DEFAULT_PORT;
    return Number.isInteger(port) && port > 0 && port < 65536 ? port : null;
}

// First token of a command line, honouring double quotes: `"C:\a b\x.ps1" -Foo` -> C:\a b\x.ps1
export function firstToken(command) {
    const text = String(command ?? '').trim();
    if (!text) return '';
    if (text.startsWith('"')) {
        const end = text.indexOf('"', 1);
        return end > 0 ? text.slice(1, end) : text.slice(1);
    }
    return text.split(/\s+/)[0];
}

// How to run the configured launch command:
//   .ps1        -> powershell -NoProfile -ExecutionPolicy Bypass -File <script>  (rest as args)
//   .cmd / .bat -> cmd /c "<command line>"
//   anything else runs through the shell as typed (python.exe main.py --port ...).
export function launchSpec(command, platform = process.platform) {
    const text = String(command ?? '').trim();
    if (!text) return null;
    const script = firstToken(text);
    const rest = text.slice(text.indexOf(script) + script.length).replace(/^"/, '').trim();
    const extension = (script.match(/\.([a-z0-9]+)$/i)?.[1] ?? '').toLowerCase();
    if (extension === 'ps1') {
        const shell = platform === 'win32' ? 'powershell.exe' : 'pwsh';
        const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script];
        if (rest) args.push(...rest.split(/\s+/));
        return { file: shell, args, shell: false, cwd: directoryOf(script) };
    }
    if (platform === 'win32' && (extension === 'cmd' || extension === 'bat')) {
        return { file: 'cmd.exe', args: ['/d', '/s', '/c', `"${text}"`], shell: false, cwd: directoryOf(script), windowsVerbatimArguments: true };
    }
    return { file: text, args: [], shell: true, cwd: directoryOf(script) };
}

function directoryOf(file) {
    const match = String(file ?? '').match(/^(.*)[\\/][^\\/]+$/);
    return match ? match[1] : undefined;
}

// Pids of the listeners on `port` from `netstat -ano` output (Windows).
export function parseNetstatPids(output, port) {
    const pids = new Set();
    for (const line of String(output ?? '').split(/\r?\n/)) {
        const columns = line.trim().split(/\s+/);
        if (columns.length < 5 || columns[0].toUpperCase() !== 'TCP') continue;
        const [, local, , state, pid] = columns;
        if (state.toUpperCase() !== 'LISTENING') continue;
        if (!local.endsWith(`:${port}`)) continue;
        const number = Number(pid);
        if (Number.isInteger(number) && number > 0) pids.add(number);
    }
    return [...pids];
}

// Pids from `lsof -t -iTCP:<port> -sTCP:LISTEN` output (one per line, POSIX).
export function parseLsofPids(output) {
    const pids = new Set();
    for (const line of String(output ?? '').split(/\r?\n/)) {
        const number = Number(line.trim());
        if (Number.isInteger(number) && number > 0) pids.add(number);
    }
    return [...pids];
}

// Whether SAA should bring ComfyUI up by itself at launch.
export function shouldAutostart(settings = {}, health = {}) {
    if (settings.api_interface !== 'ComfyUI') return false;
    if (settings.api_pod_ssh_enable === true) return false;   // generation runs on the pod
    if (settings.comfy_autostart !== true) return false;
    if (!String(settings.comfy_launch_command ?? '').trim()) return false;
    if (loopbackPort(settings.api_addr) === null) return false;
    return health.ok !== true;
}
