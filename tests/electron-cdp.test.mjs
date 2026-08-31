import assert from 'node:assert/strict';
import test from 'node:test';

import {
  configureCdp,
  getCdpConfiguration,
  parseCdpPort,
} from '../scripts/main/electronCdp.js';

test('keeps CDP disabled when no opt-in setting is supplied', () => {
  assert.equal(parseCdpPort(undefined), null);
  assert.deepEqual(
    getCdpConfiguration({ env: {}, argv: ['electron', '.'] }),
    { enabled: false, port: null, source: 'disabled' },
  );
});

test('accepts only valid non-privileged TCP ports', () => {
  assert.equal(parseCdpPort('9222'), 9222);
  assert.equal(parseCdpPort(65535), 65535);
  assert.equal(parseCdpPort('1023'), null);
  assert.equal(parseCdpPort('65536'), null);
  assert.equal(parseCdpPort('-1'), null);
  assert.equal(parseCdpPort('9222.5'), null);
  assert.equal(parseCdpPort('not-a-port'), null);
});

test('resolves the explicit SAA_CDP_PORT environment setting', () => {
  assert.deepEqual(
    getCdpConfiguration({
      env: { SAA_CDP_PORT: '9333' },
      argv: ['electron', '.'],
    }),
    { enabled: true, port: 9333, source: 'environment' },
  );
});

test('lets the explicit CLI option override the environment setting', () => {
  assert.deepEqual(
    getCdpConfiguration({
      env: { SAA_CDP_PORT: '9333' },
      argv: ['electron', '.', '--saa-cdp-port=9444'],
    }),
    { enabled: true, port: 9444, source: 'command-line' },
  );
});

test('does not enable CDP for an invalid explicit setting', () => {
  assert.deepEqual(
    getCdpConfiguration({
      env: { SAA_CDP_PORT: '0' },
      argv: ['electron', '.'],
    }),
    { enabled: false, port: null, source: 'invalid' },
  );
});

test('appends the Electron remote debugging switch only when enabled', () => {
  const calls = [];
  const electronApp = {
    commandLine: {
      appendSwitch(...args) {
        calls.push(args);
      },
    },
  };

  assert.deepEqual(
    configureCdp(electronApp, {
      env: { SAA_CDP_PORT: '9222' },
      argv: ['electron', '.'],
    }),
    { enabled: true, port: 9222, source: 'environment' },
  );
  assert.deepEqual(calls, [['remote-debugging-port', '9222']]);

  calls.length = 0;
  assert.deepEqual(
    configureCdp(electronApp, {
      env: {},
      argv: ['electron', '.'],
    }),
    { enabled: false, port: null, source: 'disabled' },
  );
  assert.deepEqual(calls, []);
});

