import test from 'node:test';
import assert from 'node:assert/strict';

import { createEditHistory } from '../scripts/renderer/tools/editHistory.js';

function fixture(options = {}) {
  let clock = 0;
  const state = {
    prompt: { text: 'a' },
    generation: { seed: 1 },
  };
  const focus = { value: null };
  const history = createEditHistory({
    capture: section => structuredClone(state[section]),
    restore: snapshots => {
      for (const [section, value] of Object.entries(snapshots)) state[section] = structuredClone(value);
    },
    captureFocus: () => structuredClone(focus.value),
    restoreFocus: value => { focus.value = structuredClone(value); },
    now: () => clock,
    ...options,
  });
  return { state, focus, history, tick: ms => { clock += ms; } };
}

test('records one atomic entry for nested transactions across multiple sections', async () => {
  const { state, history } = fixture();

  await history.runTransaction({ source: 'metadata', sections: ['prompt'] }, async () => {
    state.prompt.text = 'loaded';
    await history.runTransaction({ source: 'metadata', sections: ['generation'] }, () => {
      state.generation.seed = 42;
    });
  });

  assert.equal(history.undoCount(), 1);
  await history.undo();
  assert.deepEqual(state, { prompt: { text: 'a' }, generation: { seed: 1 } });
  await history.redo();
  assert.deepEqual(state, { prompt: { text: 'loaded' }, generation: { seed: 42 } });
});

test('does not record no-ops and clears redo after a divergent edit', async () => {
  const { state, history } = fixture();

  await history.runTransaction({ source: 'noop', sections: ['prompt'] }, () => {});
  assert.equal(history.canUndo(), false);

  await history.runTransaction({ source: 'typing', sections: ['prompt'] }, () => { state.prompt.text = 'b'; });
  await history.undo();
  assert.equal(history.canRedo(), true);
  await history.runTransaction({ source: 'typing', sections: ['prompt'] }, () => { state.prompt.text = 'c'; });
  assert.equal(history.canRedo(), false);
});

test('coalesces compatible typing while preserving the earliest before state', async () => {
  const { state, history, tick } = fixture({ mergeWindowMs: 500 });

  await history.runTransaction({ source: 'input', sections: ['prompt'], mergeKey: 'prompt:positive:insertText' }, () => { state.prompt.text = 'ab'; });
  tick(200);
  await history.runTransaction({ source: 'input', sections: ['prompt'], mergeKey: 'prompt:positive:insertText' }, () => { state.prompt.text = 'abc'; });

  assert.equal(history.undoCount(), 1);
  await history.undo();
  assert.equal(state.prompt.text, 'a');
  await history.redo();
  assert.equal(state.prompt.text, 'abc');
});

test('does not coalesce after the merge window or across section sets', async () => {
  const { state, history, tick } = fixture({ mergeWindowMs: 100 });

  await history.runTransaction({ source: 'input', sections: ['prompt'], mergeKey: 'same' }, () => { state.prompt.text = 'b'; });
  tick(101);
  await history.runTransaction({ source: 'input', sections: ['prompt'], mergeKey: 'same' }, () => { state.prompt.text = 'c'; });
  await history.runTransaction({ source: 'input', sections: ['generation'], mergeKey: 'same' }, () => { state.generation.seed = 2; });

  assert.equal(history.undoCount(), 3);
});

test('suspendRecording changes state without creating an entry', async () => {
  const { state, history } = fixture();

  await history.suspendRecording(async () => {
    state.prompt.text = 'restored';
    await history.runTransaction({ source: 'ignored', sections: ['prompt'] }, () => { state.prompt.text = 'still restored'; });
  });

  assert.equal(history.canUndo(), false);
  assert.equal(state.prompt.text, 'still restored');
});

test('restores focus metadata in the direction of travel', async () => {
  const { state, focus, history } = fixture();
  focus.value = { field: 'positive', start: 1, end: 1 };

  await history.runTransaction({ source: 'input', sections: ['prompt'] }, () => {
    state.prompt.text = 'ab';
    focus.value = { field: 'positive', start: 2, end: 2 };
  });

  await history.undo();
  assert.deepEqual(focus.value, { field: 'positive', start: 1, end: 1 });
  await history.redo();
  assert.deepEqual(focus.value, { field: 'positive', start: 2, end: 2 });
});

test('enforces entry count and approximate byte limits without retaining oversized entries', async () => {
  const byCount = fixture({ maxEntries: 2, maxBytes: 100_000 });
  for (const text of ['b', 'c', 'd']) {
    await byCount.history.runTransaction({ source: 'edit', sections: ['prompt'] }, () => { byCount.state.prompt.text = text; });
  }
  assert.equal(byCount.history.undoCount(), 2);

  const byBytes = fixture({ maxEntries: 10, maxBytes: 80 });
  await byBytes.history.runTransaction({ source: 'large', sections: ['prompt'] }, () => {
    byBytes.state.prompt.text = 'x'.repeat(200);
  });
  assert.equal(byBytes.history.canUndo(), false);
});

test('clear resets both stacks and emits state changes', async () => {
  const events = [];
  const { state, history } = fixture({ onChange: value => events.push(value) });
  await history.runTransaction({ source: 'edit', sections: ['prompt'] }, () => { state.prompt.text = 'b'; });
  await history.undo();
  history.clear();

  assert.deepEqual(history.status(), { canUndo: false, canRedo: false, undoCount: 0, redoCount: 0 });
  assert.ok(events.some(event => event.canUndo));
  assert.deepEqual(events.at(-1), history.status());
});
