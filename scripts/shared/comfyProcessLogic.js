// Pure pieces of the local ComfyUI process control (scripts/main/comfyProcess.js):
// how a launch command turns into a spawn, which port the backend listens on, and
// how the pids holding that port are read out of netstat / lsof output. No
// electron, no child_process here, so the tests run in plain node.

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

// The loopback endpoint ComfyUI is configured on, { protocol, host, port }; null for a
// remote address (the process control only ever touches the local machine). An address
// without a port means the scheme's default port, as it does for the generation requests
// (backendAddress.js httpApiUrl), so start / stop act on the backend SAA generates against.
export function loopbackTarget(apiAddress) {
    const raw = String(apiAddress ?? '').trim();
    if (!raw) return null;
    let url;
    try {
        url = new URL(/^https?:\/\//i.test(raw) ? raw : `http://${raw}`);
    } catch {
        return null;
    }
    if (!LOOPBACK_HOSTS.has(url.hostname)) return null;
    const port = url.port ? Number(url.port) : (url.protocol === 'https:' ? 443 : 80);
    if (!(Number.isInteger(port) && port > 0 && port < 65536)) return null;
    return { protocol: url.protocol, host: url.hostname.replace(/^\[(.*)\]$/, '$1'), port };
}

// The loopback port ComfyUI is configured on; null for a remote address.
export function loopbackPort(apiAddress) {
    return loopbackTarget(apiAddress)?.port ?? null;
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

// Tokens of a command line: whitespace separates, double quotes group (and are dropped).
export function splitCommandLine(text) {
    const tokens = [];
    let current = '';
    let started = false;
    let quoted = false;
    for (const char of String(text ?? '')) {
        if (char === '"') {
            quoted = !quoted;
            started = true;
        } else if (!quoted && /\s/.test(char)) {
            if (started) tokens.push(current);
            current = '';
            started = false;
        } else {
            current += char;
            started = true;
        }
    }
    if (started) tokens.push(current);
    return tokens;
}

// How to run the configured launch command:
//   .ps1        -> Windows: cmd /c "powershell -NoProfile -ExecutionPolicy Bypass -EncodedCommand <script block>"
//                  elsewhere: pwsh -NoProfile -ExecutionPolicy Bypass -File <script> <rest>
//   .cmd / .bat -> cmd /c "<command line>"
//   anything else runs through the shell as typed (python.exe main.py --port ...).
// A command SAA cannot run as meant yields { error } instead (an unquoted path with
// spaces, a relative main.py whose folder is unknown).
//
// The spawn is detached (ComfyUI must outlive SAA), which on Windows means the
// child gets no console. powershell.exe / pwsh.exe started that way exit at once
// with code 0 and print nothing, so cmd.exe hosts PowerShell instead; and since a
// console-less PowerShell also drops its stdout, `options.log` names the file the
// script's output is appended to (Out-File writes it as a file, which works).
//
// `options.extraArgs` (fast-mode ComfyUI flags, comfyLaunchArgs.js) are appended to the
// command line; a start script has to pass its own arguments on to main.py for them to
// reach ComfyUI. They are dropped unless every token is shell-safe.
// `options.exists` (a file check) lets a plain command's relative script path be placed.
export function launchSpec(command, platform = process.platform, { log = '', extraArgs = [], exists = null } = {}) {
    const text = String(command ?? '').trim();
    if (!text) return null;
    const spaced = unquotedSpacedPath(text);
    if (spaced) return { error: `the launch command starts with a path that contains spaces; put it in double quotes: "${spaced}"` };
    const script = firstToken(text);
    const extra = safeExtraArgs(extraArgs);
    const given = text.slice(text.indexOf(script) + script.length).replace(/^"/, '').trim();
    const rest = [given, ...extra].filter(Boolean).join(' ');
    const commandLine = [text, ...extra].join(' ');
    const extension = (script.match(/\.([a-z0-9]+)$/i)?.[1] ?? '').toLowerCase();
    if (extension === 'ps1' && platform === 'win32') {
        // The arguments after the script are PowerShell syntax (-Dir "C:\Program Files\X").
        // They sit on a line of their own inside a script block, so a # there cannot swallow
        // the output redirect or the error handling — and the extra flags go in front of a
        // comment the user wrote, which would otherwise swallow them.
        const [before, comment] = splitPsComment(given);
        const psRest = [before, ...extra, comment].filter(Boolean).join(' ');
        const call = `& '${psQuote(script)}'${psRest ? ` ${psRest}` : ''}`;
        const tee = log ? ` *>&1 | Out-File -Append -Encoding utf8 -FilePath '${psQuote(log)}'` : '';
        const onError = log ? `$_ | Out-File -Append -Encoding utf8 -FilePath '${psQuote(log)}'; exit 1` : 'exit 1';
        const inner = `try { & {\n${call}\n}${tee} } catch { ${onError} }; exit $LASTEXITCODE`;
        // handed over base64-encoded: nothing of the path or the arguments goes through cmd.exe's
        // or powershell.exe's command-line parsing, so quotes, &, %, ^ and any character arrive as typed
        const line = `powershell.exe -NoProfile -ExecutionPolicy Bypass -EncodedCommand ${Buffer.from(inner, 'utf16le').toString('base64')}`;
        // selfLogged: the caller must not hand the log to the child as stdout / stderr —
        // Out-File cannot open a file another handle already has open for writing
        return { file: 'cmd.exe', args: ['/d', '/s', '/c', `"${line}"`], shell: false, cwd: directoryOf(script), windowsVerbatimArguments: true, selfLogged: Boolean(log), script: inner };
    }
    if (extension === 'ps1') {
        const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script];
        args.push(...splitCommandLine(given), ...extra);
        return { file: 'pwsh', args, shell: false, cwd: directoryOf(script) };
    }
    if (platform === 'win32' && (extension === 'cmd' || extension === 'bat')) {
        return { file: 'cmd.exe', args: ['/d', '/s', '/c', `"${commandLine}"`], shell: false, cwd: directoryOf(script), windowsVerbatimArguments: true };
    }
    // `cd /d C:\ComfyUI && python main.py`: the command takes itself to the right folder,
    // so SAA neither has to place it nor may refuse its relative main.py.
    const chdir = chdirTarget(text);
    const placed = chdir ? { cwd: chdir } : plainCommandCwd(script, given, exists);
    if (placed.error) return { error: placed.error };
    return { file: commandLine, args: [], shell: true, cwd: placed.cwd };
}

// The folder a command changes to before running anything else (`cd /d C:\ComfyUI && ...`,
// `pushd "C:\my stack" & ...`); '' when it does not start that way, or the folder is relative.
export function chdirTarget(command) {
    const match = String(command ?? '').trim().match(/^(?:cd|chdir|pushd)\s+(?:\/d\s+)?("[^"]+"|\S+)\s*(?:&{1,2}|;)\s*\S/i);
    if (!match) return '';
    const dir = match[1].replace(/^"(.*)"$/, '$1').replace(/[\\/]+$/, '');
    return ABSOLUTE_PATH.test(dir) ? dir : '';
}

// Splits PowerShell arguments at the comment they end with: ['-Port 8189', '# note'].
// A # only starts a comment at the start of a token and outside quotes.
function splitPsComment(text) {
    const line = String(text ?? '');
    let quote = '';
    for (const [index, char] of [...line].entries()) {
        if (quote) {
            if (char === quote) quote = '';
        } else if (char === '"' || char === "'") {
            quote = char;
        } else if (char === '#' && (index === 0 || /\s/.test(line[index - 1]))) {
            return [line.slice(0, index).trim(), line.slice(index)];
        }
    }
    return [line, ''];
}

const SAFE_EXTRA_ARG = /^[A-Za-z0-9_.:=/+-]+$/;
const ABSOLUTE_PATH = /^(?:[A-Za-z]:[\\/]|\\\\|\/)/;

function safeExtraArgs(extraArgs) {
    const tokens = (Array.isArray(extraArgs) ? extraArgs : []).map(token => String(token ?? '')).filter(Boolean);
    return tokens.every(token => SAFE_EXTRA_ARG.test(token)) ? tokens : [];
}

// Inside a PowerShell single-quoted string only the quote itself needs escaping — and
// PowerShell takes the typographic single quotes (‘ ’ ‚ ‛) for quotes as well.
function psQuote(text) {
    return String(text ?? '').replaceAll(/['\u2018\u2019\u201A\u201B]/g, quote => quote + quote);
}

function directoryOf(file) {
    const match = String(file ?? '').match(/^(.*)[\\/][^\\/]+$/);
    return match ? match[1] : undefined;
}

// `C:\my stack\start-comfy.ps1` typed without quotes: its first token (C:\my) is no program.
// Returns the path for the error message; '' when the command does not look like that.
function unquotedSpacedPath(text) {
    if (!/^(?:[A-Za-z]:[\\/]|\\\\)/.test(text)) return '';
    const tokens = text.split(/\s+/);
    if (/\.[a-z0-9]+$/i.test(tokens[0])) return '';
    for (let index = 1; index < tokens.length; index++) {
        const token = tokens[index];
        if (token.startsWith('-') || token.includes('"') || ABSOLUTE_PATH.test(token)) return '';
        if (/[\\/]/.test(token) && /\.(?:ps1|cmd|bat|exe)$/i.test(token)) return tokens.slice(0, index + 1).join(' ');
    }
    return '';
}

// Where a plain command (python ... main.py) runs. A relative script path resolves against the
// working directory, which SAA only knows from an absolute program path: the program's folder,
// or the one above it (ComfyUI portable: python_embeded\python.exe -s ComfyUI\main.py). With
// `exists`, a relative .py found in neither is refused instead of being run from SAA's folder.
function plainCommandCwd(program, given, exists) {
    const scripts = splitCommandLine(given).filter(token => /\.py$/i.test(token));
    const relative = scripts.find(token => !ABSOLUTE_PATH.test(token));
    const programDir = directoryOf(program);
    if (!relative || typeof exists !== 'function') {
        return { cwd: programDir ?? directoryOf(scripts.find(token => ABSOLUTE_PATH.test(token))) };
    }
    const candidates = ABSOLUTE_PATH.test(program) ? [programDir, directoryOf(programDir)].filter(Boolean) : [];
    const cwd = candidates.find(dir => exists(`${dir}${dir.includes('\\') ? '\\' : '/'}${relative}`));
    if (cwd) return { cwd };
    return { error: `${relative} is a relative path and SAA does not know the folder it is in; give its full path (python C:\\ComfyUI\\main.py ...)` };
}

// Address part of a netstat / lsof socket name: `[::1]:8188` -> ::1, `0.0.0.0:8188` -> 0.0.0.0, `*:8188` -> *
function socketHost(name) {
    const text = String(name ?? '');
    return text.slice(0, text.lastIndexOf(':')).replace(/^\[(.*)\]$/, '$1').replace(/%.*$/, '');
}

// Listening TCP sockets on `port` from `netstat -ano` output (Windows, IPv4 and IPv6):
// [{ pid, host }]. The state column is localized (LISTENING, ABHÖREN, ...), so a row counts
// as listening by its foreign address, which is the unspecified 0.0.0.0:0 / [::]:0 only there.
export function parseNetstatListeners(output, port) {
    const listeners = [];
    for (const line of String(output ?? '').split(/\r?\n/)) {
        const columns = line.trim().split(/\s+/);
        if (columns.length < 5 || columns[0].toUpperCase() !== 'TCP') continue;
        const [, local, foreign] = columns;
        if (foreign !== '0.0.0.0:0' && foreign !== '[::]:0') continue;
        if (!local.endsWith(`:${port}`)) continue;
        const pid = Number(columns.at(-1));
        if (Number.isInteger(pid) && pid > 0) listeners.push({ pid, host: socketHost(local) });
    }
    return listeners;
}

// Listening sockets from `lsof -nP -iTCP:<port> -sTCP:LISTEN -Fpn` output (POSIX): [{ pid, host }].
export function parseLsofListeners(output) {
    const listeners = [];
    let pid = 0;
    for (const line of String(output ?? '').split(/\r?\n/)) {
        if (line.startsWith('p')) pid = Number(line.slice(1));
        else if (line.startsWith('n') && Number.isInteger(pid) && pid > 0) listeners.push({ pid, host: socketHost(line.slice(1)) });
    }
    return listeners;
}

// Pids of the listeners a request to `host` reaches: the ones bound to that very address, else
// the wildcard ones (an IPv4 address also reaches a dual-stack [::] socket). localhost may
// resolve to either family, so it takes both. A listener on another address is not the one.
export function listenerPidsForHost(listeners, host) {
    const pids = new Set();
    for (const address of host === 'localhost' ? ['127.0.0.1', '::1'] : [host]) {
        const stages = address.includes(':') ? [[address], ['::', '*']] : [[address], ['0.0.0.0', '*'], ['::']];
        for (const hosts of stages) {
            const reached = listeners.filter(listener => hosts.includes(listener.host));
            if (reached.length === 0) continue;
            for (const listener of reached) pids.add(listener.pid);
            break;
        }
    }
    return [...pids];
}

// Whether a /system_stats body is ComfyUI's ({ system: {...}, devices: [...] }).
export function isComfySystemStats(text) {
    try {
        const data = JSON.parse(text);
        return Boolean(data && typeof data.system === 'object' && data.system !== null);
    } catch {
        return false;
    }
}

// Which listener pids Stop may end: { kill, spared }. A listener is only ended when it is the
// ComfyUI SAA talks to — the address answered /system_stats as ComfyUI, or SAA's launch record
// names that pid. SAA's own process and its parent, and system pids (0-4), are never ended.
// `unverified`: the user was shown the pid and the program behind it and said to end it anyway
// (a hung ComfyUI, or one started outside SAA); SAA's own pids stay protected even then.
export function stopTargets(pids, { answered = false, launchedPids = [], protectedPids = [], unverified = false } = {}) {
    const protect = new Set(protectedPids.map(Number));
    const launched = new Set((Array.isArray(launchedPids) ? launchedPids : []).map(Number));
    const kill = [];
    const spared = [];
    for (const pid of pids) {
        const allowed = Number.isInteger(pid) && pid > 4 && !protect.has(pid) && (answered || unverified || launched.has(pid));
        (allowed ? kill : spared).push(pid);
    }
    return { kill, spared };
}

// Program name behind a pid from `tasklist /FI "PID eq <pid>" /FO CSV /NH` output
// ("python.exe","1234",...), or '' when the pid is gone (tasklist then says so in prose).
export function parseTasklistName(output) {
    const line = String(output ?? '').split(/\r?\n/).find(text => text.trim().startsWith('"'));
    return line ? (line.match(/^"([^"]*)"/)?.[1] ?? '') : '';
}

// Whether SAA's launch record for `port` stands for a start that may still bring ComfyUI up:
// not completed (no pids yet), not ended (failed / stopped), and recent — within `waitMs`, or
// within `lateMs` while its launcher still runs (a start script waiting for the backend).
// A record whose launcher is named and gone stands for a start that died with it (SAA was
// closed or crashed during it): it only holds the port for `deadMs`, long enough to keep two
// SAA instances from launching at once, not long enough to refuse the user a new Start.
export function launchPending(record, port, { now = Date.now(), waitMs = 0, lateMs = 0, deadMs = 0, launcherAlive = false } = {}) {
    if (!record || record.port !== port || record.ended === true) return false;
    if (Array.isArray(record.pids) && record.pids.length > 0) return false;
    const age = now - Date.parse(record.at);
    if (!Number.isFinite(age) || age < 0) return false;
    const launcher = Number(record.launcher);
    const known = Number.isInteger(launcher) && launcher > 0;
    if (known && !launcherAlive) return age < deadMs;
    return age < waitMs || (launcherAlive && age < lateMs);
}

// The last `lines` non-empty lines of a log text; a progress bar redraws with \r, so that ends
// a line too, and an overlong line is cut.
export function tailLines(text, lines = 30, maxLength = 400) {
    return String(text ?? '').split(/\r\n|\r|\n/).filter(line => line.trim())
        .slice(-lines)
        .map(line => (line.length > maxLength ? `${line.slice(0, maxLength)}…` : line))
        .join('\n');
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
