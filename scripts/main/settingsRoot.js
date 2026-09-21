// Where this run keeps its settings (app.json, state.json, presets/, user lists):
// <app>/settings, unless --saa-settings-dir=<dir> or SAA_SETTINGS_DIR names another
// folder. An end-to-end run (tests/e2e) hands the app a folder of its own, so the
// developer's settings are neither read nor written by a test.
import path from 'node:path';

const SETTINGS_DIR_ENV = 'SAA_SETTINGS_DIR';
const SETTINGS_DIR_ARGUMENT = '--saa-settings-dir=';

function explicitSettingsDir({ argv, env }) {
    const argument = Array.isArray(argv)
        ? argv.find(value => typeof value === 'string' && value.startsWith(SETTINGS_DIR_ARGUMENT))
        : undefined;
    if (argument !== undefined) return argument.slice(SETTINGS_DIR_ARGUMENT.length);
    const fromEnv = env && typeof env === 'object' ? env[SETTINGS_DIR_ENV] : undefined;
    return typeof fromEnv === 'string' ? fromEnv : undefined;
}

function resolveSettingsRoot(appPath, { argv = process.argv, env = process.env } = {}) {
    const explicit = explicitSettingsDir({ argv, env });
    const trimmed = typeof explicit === 'string' ? explicit.trim() : '';
    return trimmed ? path.resolve(trimmed) : path.join(appPath, 'settings');
}

export { SETTINGS_DIR_ARGUMENT, SETTINGS_DIR_ENV, resolveSettingsRoot };
