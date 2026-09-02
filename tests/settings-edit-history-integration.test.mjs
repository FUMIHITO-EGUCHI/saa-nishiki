import test from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_SETTINGS } from '../scripts/shared/settingsSections.js';
import { installSettingsProxy, setupSettingsPersistence } from '../scripts/renderer/settingsPersistence.js';

test('settings writes become one atomic multi-section history entry and restore through one UI refresh', async () => {
  const original = {
    api: globalThis.api,
    document: globalThis.document,
    addEventListener: globalThis.addEventListener,
    prompt: globalThis.prompt,
    generate: globalThis.generate,
    editHistory: globalThis.editHistory,
    settingsPersistence: globalThis.settingsPersistence,
    settingsAutosave: globalThis.settingsAutosave,
  };
  const dispatched = [];
  let updateCount = 0;
  let slotFlushCount = 0;

  globalThis.api = {
    saveSettingsSections: async () => true,
    saveSettingsSectionsSync: () => true,
  };
  globalThis.document = {
    querySelector: () => null,
    getElementById: () => null,
    addEventListener: () => {},
    dispatchEvent: event => { dispatched.push(event); return true; },
  };
  globalThis.addEventListener = () => {};
  globalThis.prompt = null;
  globalThis.generate = null;

  try {
    const settings = installSettingsProxy(structuredClone(DEFAULT_SETTINGS));
    const persistence = setupSettingsPersistence({
      updateSettings: () => { updateCount += 1; },
      flushSlots: () => { slotFlushCount += 1; },
    });

    settings.api_prompt = 'refined';
    settings.random_seed = 42;
    await Promise.resolve();
    await Promise.resolve();

    assert.equal(persistence.history.undoCount(), 1);
    assert.equal(settings.api_prompt, 'refined');
    assert.equal(settings.random_seed, 42);

    await persistence.history.undo();
    assert.equal(settings.api_prompt, DEFAULT_SETTINGS.api_prompt);
    assert.equal(settings.random_seed, DEFAULT_SETTINGS.random_seed);
    assert.equal(updateCount, 1);
    assert.equal(slotFlushCount, 0);
    assert.deepEqual(globalThis.settingsAutosave.pending().sort(), ['generation', 'prompt']);
    const applied = dispatched.filter(event => event.type === 'saa-settings-applied').at(-1).detail;
    assert.equal(applied.section, null);
    assert.deepEqual(applied.sections.sort(), ['generation', 'prompt']);

    persistence.applySectionData('prompt', { api_prompt: 'single-section' });
    const singleApplied = dispatched.filter(event => event.type === 'saa-settings-applied').at(-1).detail;
    assert.equal(singleApplied.section, 'prompt');
    assert.deepEqual(singleApplied.sections, ['prompt']);
    await persistence.flush();
  } finally {
    Object.assign(globalThis, original);
  }
});
