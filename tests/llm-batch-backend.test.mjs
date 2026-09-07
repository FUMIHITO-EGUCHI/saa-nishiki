import test from 'node:test';
import assert from 'node:assert/strict';

import {
  backendArgDefaults,
  createBatchClient,
  isNsfwTag,
  parseJsonRows,
  planLanes,
  splitRows,
  takeBackendArg,
  validateBackendArgs,
} from '../scripts/llmBatchBackend.mjs';

function parse(argv) {
  const args = backendArgDefaults();
  for (let index = 0; index < argv.length; index += 1) {
    const consumed = takeBackendArg(args, argv, index);
    if (!consumed) throw new Error(`unhandled ${argv[index]}`);
    index += consumed - 1;
  }
  return validateBackendArgs(args);
}

test('backend options parse and default to Codex with a local fallback', () => {
  const args = parse(['--codex-batch-size', '50', '--pod-settings', 'nonexistent.json']);
  assert.equal(args.backend, 'auto');
  assert.equal(args.fallback, 'ollama');
  assert.equal(args.codexBatchSize, 50);
  assert.equal(parse(['--backend', 'pod', '--pod-model', 'x', '--pod-settings', 'nonexistent.json']).podModelExplicit, true);
  assert.throws(() => parse(['--backend', 'cloud']), /--backend must be/);
  assert.throws(() => parse(['--fallback', 'codex']), /--fallback must be/);
  assert.throws(() => parse(['--batch-size', '0']), /--batch-size/);
  assert.equal(parse([]).codexEffort, '', 'the reasoning effort defaults to the Codex config');
  assert.equal(parse(['--codex-effort', 'xhigh']).codexEffort, 'xhigh');
  assert.throws(() => parse(['--codex-effort', 'max']), /--codex-effort/);
});

test('lanes: everything to Codex unless --nsfw-direct or an explicit backend', () => {
  const rows = [{ tag: 'smile' }, { tag: 'sex' }];
  const args = { ...backendArgDefaults(), fallback: 'ollama' };
  assert.deepEqual(planLanes(args, rows), [{ backend: 'codex', rows }]);
  assert.deepEqual(planLanes({ ...args, nsfwDirect: true }, rows), [
    { backend: 'codex', rows: [rows[0]] },
    { backend: 'ollama', rows: [rows[1]] },
  ]);
  assert.deepEqual(planLanes({ ...args, backend: 'ollama' }, rows), [{ backend: 'ollama', rows }]);
  assert.equal(isNsfwTag('holding_sword'), false);
});

test('parses fenced JSON rows and splits batches in order', () => {
  assert.deepEqual(parseJsonRows('```json\n{"rows":[{"i":1}]}\n```'), [{ i: 1 }]);
  assert.throws(() => parseJsonRows('{"nope":1}'), /rows array/);
  assert.deepEqual(splitRows([1, 2, 3]), [[1, 2], [3]]);
  assert.deepEqual(splitRows([1]), [[1]]);
});

test('a failed Codex batch is re-run on the fallback model and tagged with it', async () => {
  const calls = [];
  const args = { ...backendArgDefaults(), fallback: 'ollama', model: 'local-model' };
  const client = createBatchClient(args, {
    codex: async () => { calls.push('codex'); throw new Error('refused'); },
    ollama: async (system, user) => { calls.push('ollama'); return JSON.parse(user).map(row => ({ i: row.i, ok: true })); },
  });
  const rows = [{ i: 1, tag: 'a' }, { i: 2, tag: 'b' }];
  const result = await client.requestRows('codex', rows, {
    systemPrompt: 's',
    buildPrompt: batch => JSON.stringify(batch),
    schema: {},
    validate: (input, output) => {
      assert.equal(output.length, input.length);
      return output;
    },
    label: 'test',
  });
  assert.deepEqual(calls, ['codex', 'ollama']);
  assert.deepEqual(result.map(row => row.model), ['local-model', 'local-model']);
});

test('a large failed Codex batch is split and retried on Codex before any fallback', async () => {
  const sizes = [];
  const client = createBatchClient({ ...backendArgDefaults(), fallback: 'ollama' }, {
    codex: async (system, user) => {
      const batch = JSON.parse(user);
      sizes.push(batch.length);
      if (batch.length > 25) throw new Error('garbled');
      return batch.map(row => ({ i: row.i }));
    },
    ollama: async () => { throw new Error('must not be called'); },
  });
  const rows = Array.from({ length: 60 }, (_, index) => ({ i: index + 1 }));
  const result = await client.requestRows('codex', rows, {
    systemPrompt: 's', buildPrompt: batch => JSON.stringify(batch), schema: {}, validate: (input, output) => output,
  });
  assert.deepEqual(sizes, [60, 30, 15, 15, 30, 15, 15]);
  assert.equal(result.length, 60);
});

test('an invalid Ollama response is retried as two halves', async () => {
  let attempts = 0;
  const client = createBatchClient({ ...backendArgDefaults(), fallback: 'ollama' }, {
    ollama: async (system, user) => {
      attempts += 1;
      const batch = JSON.parse(user);
      return batch.length > 1 ? [] : batch.map(row => ({ i: row.i }));
    },
  });
  const result = await client.requestRows('ollama', [{ i: 1 }, { i: 2 }], {
    systemPrompt: 's',
    buildPrompt: batch => JSON.stringify(batch),
    schema: {},
    validate: (input, output) => {
      if (output.length !== input.length) throw new Error('short');
      return output;
    },
  });
  assert.equal(attempts, 3);
  assert.deepEqual(result.map(row => row.i), [1, 2]);
});
