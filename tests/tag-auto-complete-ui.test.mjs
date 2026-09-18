import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  TAG_FILTERS,
  extractPromptKeyFromSuggestion,
  getTagFilterOptions,
  setupSuggestionSystem,
} from '../scripts/renderer/tagAutoComplete.js';
import { withFakeDom } from './helpers/fakeDom.mjs';

const testDirectory = path.dirname(fileURLToPath(import.meta.url));

test('exposes the English coarse filter labels and their backend options', () => {
  assert.deepEqual(TAG_FILTERS.map(filter => filter.label), [
    'All',
    'General',
    'Character',
    'Work',
    'Artist',
    'Species',
    'Meta',
    'Lore',
    'Pose / Action',
    'Clothing',
    'Appearance',
    'Object',
    'Scenery / Background',
    'Composition / Quality',
  ]);
  assert.deepEqual(getTagFilterOptions('all'), undefined);
  assert.deepEqual(getTagFilterOptions('work'), { groupIds: [3, 10] });
  assert.deepEqual(getTagFilterOptions('species'), { groupIds: [12] });
  assert.deepEqual(getTagFilterOptions('pose_action'), { category: 'pose_action' });
  assert.deepEqual(getTagFilterOptions('appearance'), { category: 'appearance' });
  assert.deepEqual(getTagFilterOptions('scenery'), { category: 'scenery' });
});

test('extracts the English prompt key from unchanged suggestion markup', () => {
  assert.equal(
    extractPromptKeyFromSuggestion('<b>holding_halo</b>: (holding halo) (123) [G] [Pose / Action]'),
    'holding_halo',
  );
});

test('keeps renderer filter metadata browser-safe under the Electron CSP', () => {
  const rendererSource = fs.readFileSync(
    path.join(testDirectory, '..', 'scripts', 'renderer', 'tagAutoComplete.js'),
    'utf8',
  );
  const constantsSource = fs.readFileSync(
    path.join(testDirectory, '..', 'scripts', 'main', 'tagCategoryConstants.js'),
    'utf8',
  );

  assert.match(rendererSource, /from ['"]\.\.\/main\/tagCategoryConstants\.js['"]/);
  assert.doesNotMatch(rendererSource, /from ['"]\.\.\/main\/tagCategories\.js['"]/);
  assert.doesNotMatch(constantsSource, /node:fs/);
});

// --------------------------------------------------------- the suggestion box on a fake DOM
// setupSuggestionSystem driven for real: the prompt textarea, the tag backend at
// globalThis.api.tagGet, and the off-screen caret mirror it lays out.
const COMPUTED = {
  font: '13px sans-serif', letterSpacing: 'normal', tabSize: '8', wordWrap: 'break-word',
  overflowWrap: 'break-word', wordBreak: 'normal',
  paddingTop: '4px', paddingRight: '8px', paddingBottom: '4px', paddingLeft: '8px',
};

const SUGGESTION_GLOBALS = {
  getComputedStyle: () => COMPUTED,
  scrollX: 0,
  scrollY: 0,
  innerWidth: 1280,
  innerHeight: 800,
};

const settle = () => new Promise(resolve => { setTimeout(resolve, 80); });   // past the 50 ms debounce

// A Positive prompt textarea inside the wrapper the filter control is hung on, laid out the
// way Chromium lays one out: a box on screen, a padding box 16 px narrower than the border box.
function promptTextarea(document, { clientWidth = 404 } = {}) {
  const wrapper = document.body.appendChild(document.createElement('div'));
  wrapper.className = 'myTextbox-wrapper';
  const inner = wrapper.appendChild(document.createElement('div'));
  const textbox = inner.appendChild(document.createElement('textarea'));
  textbox.className = 'myTextbox-prompt-positive-textarea';
  textbox.value = '';
  textbox.selectionStart = 0;
  textbox.clientWidth = clientWidth;
  textbox.offsetWidth = 420;
  textbox.getClientRects = () => [{ width: 420, height: 30 }];
  textbox.getBoundingClientRect = () => ({ top: 100, left: 40, right: 460, bottom: 130, width: 420, height: 30 });
  textbox.setSelectionRange = (start, end) => { textbox.selectionStart = start; textbox.selectionEnd = end; };
  return textbox;
}

function typeInto(textbox, value, detail) {
  textbox.value = value;
  textbox.selectionStart = value.length;
  textbox.selectionEnd = value.length;
  textbox.dispatchEvent({ type: 'input', bubbles: true, detail, preventDefault() {}, stopPropagation() {} });
}

const mirrors = document => document.body.querySelectorAll('div').filter(node => node.getAttribute('aria-hidden') === 'true');

const DEFAULT_ANSWER = async () => [['<b>long_hair</b>: (long hair) (123) [G]'], ['<b>long_sleeves</b>: (long sleeves) (45) [G]']];

async function withSuggestions(body, answer = DEFAULT_ANSWER) {
  const saved = { api: globalThis.api, inBrowser: globalThis.inBrowser };
  try {
    await withFakeDom(async document => {
      const asked = [];
      globalThis.inBrowser = false;
      globalThis.api = { tagGet: async (...params) => { asked.push(params); return answer(...params); } };
      const textbox = promptTextarea(document);
      setupSuggestionSystem();
      await body({ document, textbox, asked, box: document.body.querySelector('.suggestion-box') });
    }, SUGGESTION_GLOBALS);
  } finally {
    Object.assign(globalThis, saved);
  }
}

test('a typed word opens the suggestion box on the answers the tag backend gives', async () => {
  await withSuggestions(async ({ textbox, asked, box }) => {
    assert.notEqual(box, null, 'the box is created for the textarea');
    assert.equal(box.style.display, 'none', 'and starts closed');
    assert.equal(textbox.dataset.suggestionSetup, 'true');

    typeInto(textbox, 'smile, long hair');
    await settle();
    assert.deepEqual(asked, [['long_hair']], 'the word under the caret goes out with its spaces as underscores');
    const items = box.querySelectorAll('.suggestion-item');
    assert.equal(items.length, 2);
    assert.deepEqual(items.map(item => item.dataset.value), ['long_hair', 'long_sleeves']);
    assert.equal(box.style.display, 'block');
  });
});

test('an escaped tag is read back from the DOM, so what is inserted is the tag, not its markup', async () => {
  await withSuggestions(async ({ textbox, box }) => {
    typeInto(textbox, 'o');
    await settle();
    const [item] = box.querySelectorAll('.suggestion-item');
    assert.equal(item.dataset.value, '<o>', 'the &lt;o&gt; of the display markup is the tag <o>');
  }, async () => [['<b>&lt;o&gt;</b>: (o face) (99) [G]']]);
});

test('a capsule rewrite is not typing: the suggestion box closes and the tag backend is left alone', async () => {
  await withSuggestions(async ({ textbox, asked, box }) => {
    typeInto(textbox, 'long hair');
    await settle();
    assert.equal(box.style.display, 'block', 'typing did open it');
    assert.equal(asked.length, 1);

    // the chip toggle / weight / reorder of the capsule field writes the whole field back
    typeInto(textbox, 'long hair, blue eyes', { source: 'capsules' });
    await settle();
    assert.equal(box.style.display, 'none', 'the box closes instead of following a rewrite nobody typed');
    assert.equal(asked.length, 1, 'and nothing was looked up');
  });
});

test('a textarea the capsule field has hidden has no caret to follow, so no box is opened for it', async () => {
  await withSuggestions(async ({ textbox, asked, box }) => {
    textbox.getClientRects = () => [];   // the field shows capsules: the textarea is out of the layout
    typeInto(textbox, 'long hair');
    await settle();
    assert.equal(box.style.display, 'none');
    assert.deepEqual(asked, []);
  });
});

test('the caret mirror wraps at the textarea padding box, with no border and no scrollbar of its own', async () => {
  await withSuggestions(async ({ document, textbox, box }) => {
    typeInto(textbox, 'long hair');
    await settle();
    const [mirror, ...extra] = mirrors(document);
    assert.notEqual(mirror, undefined, 'the mirror is laid out off-screen');
    assert.deepEqual(extra, [], 'one per textarea, reused');
    assert.equal(mirror.style.width, '404px', 'the clientWidth: the padding box without the scrollbar');
    assert.equal(mirror.style.borderWidth, '0', 'and no border, so both break lines at the same width');
    assert.equal(mirror.style.whiteSpace, 'pre-wrap');
    assert.equal(mirror.style.overflow, 'hidden');
    assert.equal(mirror.style.font, COMPUTED.font, 'the font of the textarea it mirrors');
    assert.equal(mirror.style.paddingLeft, COMPUTED.paddingLeft);
    assert.equal(mirror.firstChild.textContent, 'long hair', 'the text before the caret');
    assert.equal(mirror.children.at(-1).textContent, '​', 'followed by the zero-width marker that is measured');
    assert.equal(box.style.left, '40px', 'the box sits at the caret, never left of the textarea');
    assert.equal(box.style.top, '130px');

    // the marker sits 120 px into the mirror's border box; the caret is that minus the padding
    mirror.children.at(-1).offsetLeft = 120;
    typeInto(textbox, 'long hairs');
    await settle();
    assert.equal(mirrors(document).length, 1, 'a second keystroke lays out no second mirror');
    assert.equal(box.style.left, '152px', 'the textarea left edge plus the caret, the mirror padding stripped off');
  });
});

test('a textarea with no padding box yet falls back to the width it was measured at', async () => {
  await withSuggestions(async ({ document, textbox }) => {
    textbox.clientWidth = 0;   // never laid out: the card was still collapsed
    typeInto(textbox, 'long hair');
    await settle();
    assert.equal(mirrors(document)[0].style.width, '420px', 'the bounding-rect width stands in for the padding box');
  });
});

test('picking a suggestion puts the tag into the textarea and closes the box', async () => {
  await withSuggestions(async ({ textbox, box }) => {
    typeInto(textbox, 'smile, long hair');
    await settle();
    const [, second] = box.querySelectorAll('.suggestion-item');
    box.dispatchEvent({ type: 'click', bubbles: true, target: { closest: () => second }, preventDefault() {}, stopPropagation() {} });
    assert.equal(textbox.value, 'smile, long sleeves,', 'the underscores of the tag become spaces');
    assert.equal(box.style.display, 'none');
    assert.equal(box.querySelectorAll('.suggestion-item').length, 0);
    await settle();   // the input event the insert fires is the tag's own: it opens nothing
    assert.equal(box.style.display, 'none');
  });
});

test('Enter takes the highlighted suggestion, the arrows move the highlight, Escape closes the box', async () => {
  await withSuggestions(async ({ textbox, box }) => {
    typeInto(textbox, 'long hair');
    await settle();
    const press = key => {
      let prevented = false;
      textbox.dispatchEvent({ type: 'keydown', key, target: textbox, preventDefault() { prevented = true; }, stopPropagation() {} });
      return prevented;
    };
    assert.equal(press('ArrowDown'), true);
    assert.deepEqual(box.querySelectorAll('.suggestion-item').map(item => item.classList.contains('selected')), [true, false]);
    press('ArrowDown');
    assert.deepEqual(box.querySelectorAll('.suggestion-item').map(item => item.classList.contains('selected')), [false, true]);
    assert.equal(press('Enter'), true);
    assert.equal(textbox.value, 'long sleeves,');
    assert.equal(box.style.display, 'none');
    await settle();

    typeInto(textbox, 'long sleeves, blue eye');
    await settle();
    assert.equal(box.style.display, 'block');
    press('Escape');
    assert.equal(box.style.display, 'none', 'Escape closes it without touching the text');
    assert.equal(textbox.value, 'long sleeves, blue eye');
  });
});

test('Ctrl+ArrowUp / ArrowDown weigh the tag under the caret and stop at the ends of the range', async () => {
  await withSuggestions(async ({ textbox }) => {
    const weigh = up => textbox.dispatchEvent({
      type: 'keydown', key: up ? 'ArrowUp' : 'ArrowDown', ctrlKey: true, target: textbox,
      preventDefault() {}, stopPropagation() {},
    });
    typeInto(textbox, 'smile, long hair');
    weigh(true);
    assert.equal(textbox.value, 'smile,(long hair:1.05)', 'the tag under the caret is rewritten with its weight');
    weigh(false);
    assert.equal(textbox.value, 'smile,long hair', 'back to 1 is written without the parentheses');
    textbox.value = 'smile, (long hair:2.95)';
    textbox.selectionStart = textbox.value.length - 1;
    textbox.selectionEnd = textbox.selectionStart;
    weigh(true);
    assert.equal(textbox.value, 'smile, (long hair:3)');
    weigh(true);
    assert.equal(textbox.value, 'smile, (long hair:3)', 'a step that would pass 3 is not taken');
    await settle();
  });
});
