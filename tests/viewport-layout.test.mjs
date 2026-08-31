import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.join(testDirectory, '..');
const read = relativePath => fs.readFileSync(path.join(projectRoot, relativePath), 'utf8');

test('fills the viewport while keeping the split panes inside the available height', () => {
  const baseStylesheet = read('html/index.css');
  assert.match(baseStylesheet, /#split\s*\{[^}]*display:\s*grid;[^}]*flex:\s*1\s+1\s+auto;[^}]*min-height:\s*0;[^}]*height:\s*auto;/s);
  assert.match(baseStylesheet, /#left, #right\s*\{[^}]*min-width:\s*0;[^}]*min-height:\s*0;/s);

  for (const theme of ['html/index_dark.css', 'html/index_light.css']) {
    const stylesheet = read(theme);
    assert.match(stylesheet, /#full-body\s*\{[^}]*inset:\s*0;[^}]*display:\s*flex;[^}]*flex-direction:\s*column;[^}]*align-items:\s*stretch;/s, `${theme} should fill the viewport`);
    assert.doesNotMatch(stylesheet, /width:\s*calc\(100vw\s*-\s*100px\)/);
    assert.doesNotMatch(stylesheet, /height:\s*calc\(100vh\s*-\s*122px\)/);
  }
});
