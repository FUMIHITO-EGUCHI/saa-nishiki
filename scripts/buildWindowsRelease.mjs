// Builds the Windows release zip (SAA-Nishiki-<version>-win32-x64.zip) for a tag and, with
// --upload, attaches it to that tag's GitHub Release. The app is packaged from a clean
// checkout of the tag in a temporary worktree, so nothing ignored by git (settings, generated
// images, downloaded packs, models) can end up in the zip.
//
//   node scripts/buildWindowsRelease.mjs                  tag v<package.json version>
//   node scripts/buildWindowsRelease.mjs v4.1.0           a given tag
//   node scripts/buildWindowsRelease.mjs v4.1.0 --upload  also run gh release upload --clobber
//
// The zip lands in release/ (gitignored). Needs git, npm, gh (for --upload) and either 7-Zip
// or the tar.exe that ships with Windows.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PACKAGER_VERSION = '20.3.0';
const EXE_NAME = 'saa-nishiki';
const ICON = path.join(ROOT, 'html', 'icon.ico');

// Paths the app never reads at run time: tests, benches, design sources, README images.
// onnxruntime-node ships every platform's binaries; only win32 is kept.
const IGNORE = [
    /^\/(tests|experiments|docs|design|reports|examples|release|\.github|\.claude|\.vscode)(\/|$)/,
    /^\/AGENTS\.md$/,
    /^\/scripts\/buildWindowsRelease\.mjs$/,
    /^\/node_modules\/onnxruntime-node\/bin\/napi-v\d+\/(darwin|linux)(\/|$)/,
];

function run(cmd, args, opts = {}) {
    console.log(`> ${cmd} ${args.join(' ')}`);
    // npm and gh are .cmd shims on Windows, so they go through the shell; quote paths with spaces.
    const shell = opts.shell ?? process.platform === 'win32';
    const argv = shell ? args.map(a => (/\s/.test(a) ? `"${a}"` : a)) : args;
    const res = spawnSync(shell && /\s/.test(cmd) ? `"${cmd}"` : cmd, argv, { stdio: 'inherit', ...opts, shell });
    if (res.status !== 0) throw new Error(`${cmd} exited with ${res.status ?? res.signal}`);
}

function git(args, opts = {}) {
    const res = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8', ...opts });
    if (res.status !== 0) throw new Error(`git ${args.join(' ')}: ${res.stderr.trim()}`);
    return res.stdout.trim();
}

function removeWorktree(dir) {
    if (!fs.existsSync(dir)) return;
    spawnSync('git', ['worktree', 'remove', '--force', dir], { cwd: ROOT, stdio: 'inherit' });
    fs.rmSync(dir, { recursive: true, force: true });
    git(['worktree', 'prune']);
}

async function loadPackager() {
    const dir = path.join(os.tmpdir(), `saa-nishiki-packager-${PACKAGER_VERSION}`);
    const entry = path.join(dir, 'node_modules', '@electron', 'packager', 'dist', 'index.js');
    if (!fs.existsSync(entry)) {
        fs.mkdirSync(dir, { recursive: true });
        run('npm', ['install', '--prefix', dir, '--no-audit', '--no-fund', `@electron/packager@${PACKAGER_VERSION}`]);
    }
    return (await import(pathToFileURL(entry).href)).packager;
}

function zip(srcDir, zipPath) {
    fs.rmSync(zipPath, { force: true });
    const sevenZip = path.join(process.env.ProgramFiles || 'C:\\Program Files', '7-Zip', '7z.exe');
    const cwd = path.dirname(srcDir);
    const name = path.basename(srcDir);
    if (fs.existsSync(sevenZip)) run(sevenZip, ['a', '-tzip', '-mx=7', zipPath, name], { cwd, shell: false });
    else run(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe'), ['-a', '-c', '-f', zipPath, name], { cwd, shell: false });
}

async function main() {
    const args = process.argv.slice(2);
    const upload = args.includes('--upload');
    const rootVersion = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
    const tag = args.find(a => !a.startsWith('--')) || `v${rootVersion}`;
    const commit = git(['rev-parse', '--verify', `${tag}^{commit}`]);

    const work = path.join(os.tmpdir(), `saa-nishiki-build-${tag}`);
    removeWorktree(work);
    git(['worktree', 'add', '--detach', work, commit]);
    try {
        const version = JSON.parse(fs.readFileSync(path.join(work, 'package.json'), 'utf8')).version;
        if (`v${version}` !== tag) throw new Error(`${tag} has package.json version ${version}`);
        run('npm', ['ci', '--no-audit', '--no-fund'], { cwd: work });

        const packager = await loadPackager();
        const out = path.join(work, '.out');
        const [built] = await packager({
            dir: work,
            name: EXE_NAME,
            platform: 'win32',
            arch: 'x64',
            out,
            overwrite: true,
            appVersion: version,
            // The app writes to its own data/ and settings/ (resources\app\...), so no asar.
            asar: false,
            icon: fs.existsSync(ICON) ? ICON : undefined,
            win32metadata: { ProductName: 'SAA-Nishiki', FileDescription: 'SAA-Nishiki' },
            ignore: IGNORE,
        });
        const base = `SAA-Nishiki-${version}-win32-x64`;
        const appDir = path.join(out, base);
        fs.renameSync(built, appDir);

        const releaseDir = path.join(ROOT, 'release');
        fs.mkdirSync(releaseDir, { recursive: true });
        const zipPath = path.join(releaseDir, `${base}.zip`);
        zip(appDir, zipPath);
        console.log(`wrote ${zipPath} (${(fs.statSync(zipPath).size / 1048576).toFixed(1)} MB) from ${tag} (${commit.slice(0, 7)})`);

        if (upload) run('gh', ['release', 'upload', tag, zipPath, '--clobber'], { cwd: ROOT });
    } finally {
        removeWorktree(work);
    }
}

main().catch(err => {
    console.error(err.message || err);
    process.exit(1);
});
