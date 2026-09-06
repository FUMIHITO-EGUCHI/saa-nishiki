import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  NEGATIVE_BUILTIN_ORDER,
  POSITIVE_BUILTIN_ORDER,
  asFragment,
  joinOrderedUnits,
  makeCustomFieldId,
  normalizeCustomFields,
  normalizeOrder,
} from '../scripts/shared/promptFieldOrder.js';

const read = relativePath => fs.readFileSync(path.join(process.cwd(), relativePath), 'utf8');

test('custom fields normalize: ids validated, names trimmed, polarity defaulted', () => {
  const fields = normalizeCustomFields([
    { id: 'cf_abc123', name: '  Face  ', polarity: 'positive', text: 'detailed face' },
    { id: 'cf_neg1', name: 'Bans', polarity: 'negative' },
    { id: 'cf_abc123', name: 'dup' },              // duplicate id dropped
    { id: 'not-valid', name: 'x' },                // invalid id dropped
    { id: 'cf_noname' },                           // gets a fallback name
    'garbage',
  ]);
  assert.deepEqual(fields.map(f => f.id), ['cf_abc123', 'cf_neg1', 'cf_noname']);
  assert.equal(fields[0].name, 'Face');
  assert.equal(fields[1].polarity, 'negative');
  assert.equal(fields[2].name, 'Custom');
  assert.equal(fields[2].text, '');
  assert.match(makeCustomFieldId(), /^cf_[a-z0-9]+$/);
});

test('order normalization keeps known ids, appends missing units in default order', () => {
  const customs = [
    { id: 'cf_face', name: 'Face', polarity: 'positive' },
    { id: 'cf_bans', name: 'Bans', polarity: 'negative' },
  ];
  // user moved style before common and put the custom field first
  assert.deepEqual(
    normalizeOrder(['cf_face', 'style', 'common', 'bogus'], 'positive', customs),
    ['cf_face', 'style', 'common', 'views', 'background', 'ai', 'characters', 'positive'],
  );
  // empty stored order falls back to defaults with customs appended
  assert.deepEqual(
    normalizeOrder([], 'positive', customs),
    [...POSITIVE_BUILTIN_ORDER, 'cf_face'],
  );
  assert.deepEqual(normalizeOrder(null, 'negative', customs), [...NEGATIVE_BUILTIN_ORDER, 'cf_bans']);
  // negative order never admits positive units
  assert.deepEqual(normalizeOrder(['positive', 'cf_face', 'cf_bans'], 'negative', customs), ['cf_bans', 'negative']);
});

test('ordered join concatenates non-empty units with colored variants', () => {
  const { prompt, promptColored } = joinOrderedUnits(
    ['b', 'missing', 'a', 'empty'],
    {
      a: { text: 'aaa, ', colored: '[color=red]aaa, [/color]' },
      b: 'bbb, ',
      empty: { text: '', colored: '' },
    },
  );
  assert.equal(prompt, 'bbb, aaa, ');
  assert.equal(promptColored, 'bbb, [color=red]aaa, [/color]');
  assert.equal(asFragment('  tag  '), 'tag, ');
  assert.equal(asFragment('tag,'), 'tag, ');
  assert.equal(asFragment('   '), '');
});

test('generate.js drives the positive chain and negative merge from the stored order', () => {
  const generate = read('scripts/renderer/generate.js');
  assert.match(generate, /normalizeOrder\(SETTINGS\.prompt_positive_order, 'positive', SETTINGS\.prompt_custom_fields\)/);
  assert.match(generate, /joinOrderedUnits\(order, units\)/);
  assert.match(generate, /getViewTags\(seed, false\)/);
  assert.match(generate, /normalizeOrder\(globalThis\.globalSettings\.prompt_negative_order, 'negative'/);
  assert.match(generate, /getCustomFieldTexts\('negative'\)/);
  // the regional path keeps the legacy view combo
  const regional = read('scripts/renderer/generate_regional.js');
  assert.match(regional, /getViewTags\(seed\)/);
});

test('settings carry the new prompt-field keys in the prompt section', () => {
  const sections = read('scripts/shared/settingsSections.js');
  assert.match(sections, /prompt_custom_fields: \[\]/);
  assert.match(sections, /'prompt_custom_fields', 'prompt_positive_order', 'prompt_negative_order', 'prompt_field_presets',/);
});

test('custom field entries carry their weight plans / batch compactly (#13)', async () => {
  const { customFieldExtras, isCustomFieldId, setCustomFieldExtras } = await import('../scripts/shared/promptFieldOrder.js');
  const plan = { id: 'sword#0', mode: 'increment', min: 1, max: 1.3, step: 0.1, seed: 0 };
  const fields = normalizeCustomFields([
    { id: 'cf_gear', name: 'Gear', polarity: 'positive', text: 'sword', weight_plans: [plan, 'junk', { mode: 'increment' }], batch: { enabled: true, count: '3' } },
    { id: 'cf_plain', name: 'Plain', text: 'x', weight_plans: [], batch: { enabled: false, count: 4 } },
  ]);
  assert.deepEqual(fields[0].weight_plans, [plan]);
  assert.deepEqual(fields[0].batch, { enabled: true, count: 3 });
  // nothing stored → keys absent (old presets / tests compare the compact form)
  assert.equal(Object.hasOwn(fields[1], 'weight_plans'), false);
  assert.equal(Object.hasOwn(fields[1], 'batch'), false);

  assert.deepEqual(customFieldExtras(fields, 'cf_plain'), { weight_plans: [], batch: { enabled: false, count: 4 } });
  assert.deepEqual(customFieldExtras(fields, 'cf_gear'), { weight_plans: [plan], batch: { enabled: true, count: 3 } });
  assert.deepEqual(customFieldExtras(undefined, 'cf_gear'), { weight_plans: [], batch: { enabled: false, count: 4 } });

  const updated = setCustomFieldExtras(fields, 'cf_plain', { weight_plans: [plan] });
  assert.deepEqual(updated[1].weight_plans, [plan]);
  assert.equal(Object.hasOwn(updated[1], 'batch'), false, 'untouched extra stays absent');
  const cleared = setCustomFieldExtras(updated, 'cf_gear', { weight_plans: [], batch: { enabled: false, count: 4 } });
  assert.equal(Object.hasOwn(cleared[0], 'weight_plans'), false);
  assert.equal(Object.hasOwn(cleared[0], 'batch'), false);
  assert.deepEqual(fields[1].weight_plans, undefined, 'input is not mutated');
  assert.ok(isCustomFieldId('cf_gear') && !isCustomFieldId('positive') && !isCustomFieldId(null));
});
