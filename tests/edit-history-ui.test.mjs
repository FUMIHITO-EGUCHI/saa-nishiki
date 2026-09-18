import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { classifyHistoryInput, historyShortcut } from '../scripts/renderer/editHistoryUi.js';

const read = path => fs.readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('historyShortcut supports platform undo/redo keys and ignores IME or unrelated chords', () => {
  assert.equal(historyShortcut({ key: 'z', ctrlKey: true }), 'undo');
  assert.equal(historyShortcut({ key: 'Z', metaKey: true, shiftKey: true }), 'redo');
  assert.equal(historyShortcut({ key: 'y', ctrlKey: true }), 'redo');
  assert.equal(historyShortcut({ key: 'z', ctrlKey: true, altKey: true }), null);
  assert.equal(historyShortcut({ key: 'z', ctrlKey: true, isComposing: true }), null);
  assert.equal(historyShortcut({ key: 'z', ctrlKey: true, keyCode: 229 }), null);
  assert.equal(historyShortcut({ key: 'x', ctrlKey: true }), null);
});

test('input classification separates typing, deletion, paste, drop, and IME composition', () => {
  assert.equal(classifyHistoryInput('insertText'), 'typing');
  assert.equal(classifyHistoryInput('deleteContentBackward'), 'delete');
  assert.equal(classifyHistoryInput('insertFromPaste'), 'paste');
  assert.equal(classifyHistoryInput('insertFromDrop'), 'drop');
  assert.equal(classifyHistoryInput('insertCompositionText', true), 'composition');
  assert.equal(classifyHistoryInput('historyUndo'), 'history');
});

test('renderer wires global history controls, managed prompt input, focus restore, and localization', () => {
  const html = read('scripts/html_shared_body.js');
  assert.match(html, /id="edit-history-undo"/);
  assert.match(html, /id="edit-history-redo"/);
  assert.match(html, /id="edit-history-status"[^>]*aria-live="polite"/);

  const renderer = read('scripts/renderer.js');
  assert.match(renderer, /setupEditHistoryUi/);
  assert.match(renderer, /setupSettingsPersistence[\s\S]*setupEditHistoryUi\(\)/);

  const language = JSON.parse(read('data/language.json'));
  for (const locale of ['en-US', 'zh-CN']) {
    for (const key of ['ui_history_undo', 'ui_history_redo', 'ui_history_undone', 'ui_history_redone']) {
      assert.equal(typeof language[locale][key], 'string', `${locale} ${key}`);
    }
  }
  for (const file of ['html/index_dark.css', 'html/index_light.css']) {
    assert.match(read(file), /\.edit-history-button \{/);
    assert.match(read(file), /\.edit-history-button:focus-visible/);
  }
});

// ---------------------------------------------------------- the toolbar on a fake DOM
// setupEditHistoryUi driven against the real history core (tools/editHistory.js), wired
// the way settingsPersistence.js wires it: the core's onChange is the document event the
// toolbar listens for.
const LANGUAGE = {
  'en-US': { ui_history_undo: 'Undo', ui_history_redo: 'Redo', ui_history_undone: 'Undo complete', ui_history_redone: 'Redo complete' },
  'zh-CN': { ui_history_undo: '撤销', ui_history_redo: '重做', ui_history_undone: '已撤销', ui_history_redone: '已重做' },
};

async function withToolbar(body, { buttons = true } = {}) {
  const { withFakeDom } = await import('./helpers/fakeDom.mjs');
  const { createEditHistory } = await import('../scripts/renderer/tools/editHistory.js');
  const { setupEditHistoryUi } = await import('../scripts/renderer/editHistoryUi.js');
  const saved = { editHistory: globalThis.editHistory, globalSettings: globalThis.globalSettings, cachedFiles: globalThis.cachedFiles, prompt: globalThis.prompt };
  try {
    await withFakeDom(async document => {
      globalThis.globalSettings = { language: 'en-US' };
      globalThis.cachedFiles = { language: LANGUAGE };
      globalThis.prompt = {};
      const element = (tag, id) => {
        const node = document.body.appendChild(document.createElement(tag));
        node.id = id;
        return node;
      };
      const undoButton = buttons ? element('button', 'edit-history-undo') : null;
      const redoButton = buttons ? element('button', 'edit-history-redo') : null;
      const status = element('span', 'edit-history-status');
      const state = { prompt: 'first' };
      const history = createEditHistory({
        capture: section => (section === 'prompt' ? state.prompt : null),
        restore: snapshots => { if ('prompt' in snapshots) state.prompt = snapshots.prompt; },
        onChange: next => document.dispatchEvent(new CustomEvent('saa-edit-history-changed', { detail: next })),
      });
      globalThis.editHistory = history;
      const ui = setupEditHistoryUi();
      await body({ document, ui, history, state, undoButton, redoButton, status });
    });
  } finally {
    Object.assign(globalThis, saved);
  }
}

test('the history toolbar needs both buttons and the status line, or it stays out of the way', async () => {
  await withToolbar(async ({ ui }) => {
    assert.equal(ui, null, 'no Undo / Redo buttons in the document: nothing is wired');
    assert.equal(globalThis.editHistoryUi, undefined, 'and no api is published either');
  }, { buttons: false });
});

test('the Undo / Redo buttons follow what the history has to offer', async () => {
  await withToolbar(async ({ history, state, undoButton, redoButton }) => {
    assert.equal(undoButton.disabled, true, 'nothing recorded yet');
    assert.equal(redoButton.disabled, true);
    assert.equal(undoButton.children.length, 1, 'each button carries its icon');
    assert.equal(undoButton.children[0].classList.contains('tag-ui-icon-undo'), true);
    assert.equal(redoButton.children[0].classList.contains('tag-ui-icon-redo'), true);

    await history.runTransaction({ source: 'input', sections: ['prompt'] }, () => { state.prompt = 'second'; });
    assert.equal(undoButton.disabled, false, 'the change reached the buttons through the document event');
    assert.equal(redoButton.disabled, true, 'nothing undone: nothing to redo');

    await history.undo();
    assert.equal(undoButton.disabled, true);
    assert.equal(redoButton.disabled, false);
  });
});

test('clicking Undo undoes, clicking Redo redoes, and each says so in the status line', async () => {
  await withToolbar(async ({ history, state, undoButton, redoButton, status }) => {
    await history.runTransaction({ source: 'input', sections: ['prompt'] }, () => { state.prompt = 'second'; });
    assert.equal(status.textContent, '', 'nothing said before anything was pressed');

    undoButton.click();
    await new Promise(resolve => { setTimeout(resolve, 0); });
    assert.equal(state.prompt, 'first', 'the click really travelled');
    assert.equal(status.textContent, 'Undo complete');
    assert.equal(undoButton.disabled, true);

    redoButton.click();
    await new Promise(resolve => { setTimeout(resolve, 0); });
    assert.equal(state.prompt, 'second');
    assert.equal(status.textContent, 'Redo complete');
    assert.equal(redoButton.disabled, true);
  });
});

test('an Undo with nothing to undo changes neither the prompt nor the status line', async () => {
  await withToolbar(async ({ ui, state, status }) => {
    assert.equal(await ui.undo(), false);
    assert.equal(await ui.redo(), false);
    assert.equal(state.prompt, 'first');
    assert.equal(status.textContent, '', 'a travel that did nothing reports nothing');
  });
});

test('the Undo / Redo buttons name their shortcut, in the language that is on', async () => {
  await withToolbar(async ({ ui, undoButton, redoButton }) => {
    assert.equal(undoButton.title, 'Undo (Ctrl+Z)');
    assert.equal(redoButton.title, 'Redo (Ctrl+Y / Ctrl+Shift+Z)');
    assert.equal(undoButton.getAttribute('aria-label'), undoButton.title, 'the tooltip is the accessible name');
    assert.equal(redoButton.getAttribute('aria-label'), redoButton.title);

    globalThis.globalSettings.language = 'zh-CN';
    ui.updateLanguage();
    assert.equal(undoButton.title, '撤销 (Ctrl+Z)');
    assert.equal(redoButton.title, '重做 (Ctrl+Y / Ctrl+Shift+Z)');
    assert.equal(undoButton.getAttribute('aria-label'), '撤销 (Ctrl+Z)');
  });
});

test('pressing an Undo / Redo button never takes the focus off what is being edited', async () => {
  await withToolbar(async ({ undoButton, redoButton }) => {
    for (const button of [undoButton, redoButton]) {
      let prevented = false;
      button.dispatchEvent({ type: 'pointerdown', target: button, preventDefault() { prevented = true; }, stopPropagation() {} });
      assert.equal(prevented, true, 'the pointer press is swallowed, so the caret stays in the prompt');
    }
  });
});

test('Ctrl+Z / Ctrl+Y anywhere outside a native editor travel the history', async () => {
  await withToolbar(async ({ document, history, state }) => {
    await history.runTransaction({ source: 'input', sections: ['prompt'] }, () => { state.prompt = 'second'; });
    const press = (key, modifiers = {}) => {
      let prevented = false;
      document.dispatchEvent({
        type: 'keydown', key, ctrlKey: true, ...modifiers,
        target: document.body, preventDefault() { prevented = true; }, stopPropagation() {},
      });
      return prevented;
    };
    assert.equal(press('z'), true, 'the browser never gets the chord');
    await new Promise(resolve => { setTimeout(resolve, 0); });
    assert.equal(state.prompt, 'first');
    assert.equal(press('y'), true);
    await new Promise(resolve => { setTimeout(resolve, 0); });
    assert.equal(state.prompt, 'second');
    assert.equal(press('s'), false, 'an unrelated chord is left alone');
  });
});

const tick = () => new Promise(resolve => { setTimeout(resolve, 0); });

test('Ctrl+Z is the field\'s own inside a plain editor and the history\'s inside a prompt box', async () => {
  await withToolbar(async ({ document, history, state }) => {
    const textarea = document.body.appendChild(document.createElement('textarea'));
    await history.runTransaction({ source: 'input', sections: ['prompt'] }, () => { state.prompt = 'second'; });
    const press = () => {
      let prevented = false;
      document.dispatchEvent({
        type: 'keydown', key: 'z', ctrlKey: true, target: textarea,
        preventDefault() { prevented = true; }, stopPropagation() {},
      });
      return prevented;
    };
    assert.equal(press(), false, 'a search box or any other plain field keeps the browser undo');
    await tick();
    assert.equal(state.prompt, 'second', 'the history did not travel');

    globalThis.prompt = { positive: { getElement: () => textarea } };   // the same box, now the Positive field
    assert.equal(press(), true);
    await tick();
    assert.equal(state.prompt, 'first');
  });
});

test('the browser\'s own undo inside a prompt box becomes a history travel instead', async () => {
  await withToolbar(async ({ document, history, state }) => {
    const textarea = document.body.appendChild(document.createElement('textarea'));
    globalThis.prompt = { common: { getElement: () => textarea } };
    await history.runTransaction({ source: 'input', sections: ['prompt'] }, () => { state.prompt = 'second'; });
    let prevented = false;
    document.dispatchEvent({
      type: 'beforeinput', inputType: 'historyUndo', target: textarea,
      preventDefault() { prevented = true; }, stopPropagation() {},
    });
    await tick();
    assert.equal(prevented, true, 'the textarea never rolls its own text back behind the history\'s back');
    assert.equal(state.prompt, 'first');
  });
});

test('typing in a prompt box records the burst as one entry, and a plain field records none', async () => {
  await withToolbar(async ({ document, history, state }) => {
    const textarea = document.body.appendChild(document.createElement('textarea'));
    const type = target => document.dispatchEvent({
      type: 'beforeinput', inputType: 'insertText', target,
      preventDefault() {}, stopPropagation() {},
    });
    type(textarea);
    await tick();
    assert.equal(history.undoCount(), 0, 'a field the prompt does not own is not recorded');

    globalThis.prompt = { negative: { getElement: () => textarea } };
    type(textarea);
    state.prompt = 'second';
    await tick();
    type(textarea);
    state.prompt = 'third';
    await tick();
    assert.equal(history.undoCount(), 1, 'the keystrokes of one burst merge into a single Undo');
  });
});

test('the focus adapter is published so a travel can put the caret back where it was', async () => {
  await withToolbar(async ({ document }) => {
    const textarea = document.body.appendChild(document.createElement('textarea'));
    textarea.value = 'long hair, blue eyes';
    textarea.selectionStart = 5;
    textarea.selectionEnd = 9;
    textarea.selectionDirection = 'forward';
    let range = null;
    textarea.setSelectionRange = (start, end, direction) => { range = [start, end, direction]; };
    globalThis.prompt = { positive: { getElement: () => textarea } };
    textarea.focus();

    const focus = globalThis.editHistoryFocus.capture();
    assert.deepEqual(focus, { kind: 'text', field: 'positive', start: 5, end: 9, direction: 'forward' });
    textarea.blur();
    assert.equal(globalThis.editHistoryFocus.capture(), null, 'a focus outside every prompt field is not worth keeping');
    globalThis.editHistoryFocus.restore(focus);
    assert.equal(document.activeElement, textarea, 'the caret goes back to the field it was taken from');
    assert.deepEqual(range, [5, 9, 'forward']);
  });
});
