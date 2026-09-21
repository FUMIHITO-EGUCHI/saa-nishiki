// Where the app keeps its settings: <app>/settings by default, the folder the command
// line or the environment names otherwise (an end-to-end run keeps its own).
import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import { SETTINGS_DIR_ARGUMENT, SETTINGS_DIR_ENV, resolveSettingsRoot } from '../scripts/main/settingsRoot.js';

const appPath = path.join('C:', 'apps', 'saa');

test('without a flag the settings live under the app', () => {
    assert.equal(resolveSettingsRoot(appPath, { argv: ['electron', '.'], env: {} }), path.join(appPath, 'settings'));
    // a blank value is no value
    assert.equal(resolveSettingsRoot(appPath, { argv: [`${SETTINGS_DIR_ARGUMENT}   `], env: {} }), path.join(appPath, 'settings'));
    assert.equal(resolveSettingsRoot(appPath, { argv: [], env: { [SETTINGS_DIR_ENV]: '' } }), path.join(appPath, 'settings'));
});

test('the command line names the folder, and wins over the environment', () => {
    const fromArgument = resolveSettingsRoot(appPath, {
        argv: ['electron', '.', `${SETTINGS_DIR_ARGUMENT}${path.join('C:', 'tmp', 'e2e', 'settings')}`],
        env: { [SETTINGS_DIR_ENV]: path.join('C:', 'elsewhere') },
    });
    assert.equal(fromArgument, path.join('C:', 'tmp', 'e2e', 'settings'));
    assert.equal(resolveSettingsRoot(appPath, { argv: [], env: { [SETTINGS_DIR_ENV]: path.join('C:', 'elsewhere') } }), path.join('C:', 'elsewhere'));
});

test('a relative folder is resolved against the working directory, not the app', () => {
    const resolved = resolveSettingsRoot(appPath, { argv: [`${SETTINGS_DIR_ARGUMENT}run-settings`], env: {} });
    assert.equal(resolved, path.resolve('run-settings'));
    assert.equal(path.isAbsolute(resolved), true);
});
