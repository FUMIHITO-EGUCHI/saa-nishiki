// The window fills the viewport and the two panes live inside the height that is left.
// The rules are read as declarations, not as the text of a block: a reordered rule still
// passes, a wrong value does not.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { declarationsFor, parseStylesheet } from './helpers/cssRules.mjs';

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.join(testDirectory, '..');
const rulesOf = relativePath => parseStylesheet(fs.readFileSync(path.join(projectRoot, relativePath), 'utf8'));

const THEMES = ['html/index_dark.css', 'html/index_light.css'];
// the old layout sized the panes by hand; these four must never do that again
const VIEWPORT_MATHS = /calc\([^)]*100v[wh][^)]*\)/;

test('the split is a row of the window column, and both panes may shrink inside it', () => {
  const base = rulesOf('html/index.css');

  const split = declarationsFor(base, '#split');
  assert.equal(split.get('display'), 'grid');
  assert.equal(split.get('grid-template-columns'), 'repeat(2, 1fr)');
  assert.equal(split.get('flex'), '1 1 auto', 'the split takes the height the header leaves');
  assert.equal(split.get('min-height'), '0', 'and may shrink below its content, or it would overflow the window');
  assert.equal(split.get('height'), 'auto');
  assert.ok(!VIEWPORT_MATHS.test(split.get('height') ?? ''), 'the height is not computed from the viewport');

  for (const pane of ['#left', '#right']) {
    const rules = declarationsFor(base, pane);
    assert.equal(rules.get('min-width'), '0', `${pane} may shrink horizontally`);
    assert.equal(rules.get('min-height'), '0', `${pane} may shrink vertically`);
    assert.equal(rules.get('overflow-y'), 'auto', `${pane} scrolls on its own`);
    for (const [name, value] of rules) {
      assert.ok(!VIEWPORT_MATHS.test(value), `${pane} sizes ${name} from the layout, not from the viewport (${value})`);
    }
  }
});

test('both themes make the window body a column that fills the viewport', () => {
  for (const theme of THEMES) {
    const body = declarationsFor(rulesOf(theme), '#full-body');
    assert.equal(body.get('position'), 'absolute', theme);
    assert.equal(body.get('inset'), '0', `${theme} fills the window`);
    assert.equal(body.get('display'), 'flex', theme);
    assert.equal(body.get('flex-direction'), 'column', `${theme} stacks header over split`);
    assert.equal(body.get('align-items'), 'stretch', `${theme} lets each row take the full width`);
    for (const [name, value] of body) {
      assert.ok(!VIEWPORT_MATHS.test(value), `${theme} sizes ${name} from the viewport (${value})`);
    }
  }
});
