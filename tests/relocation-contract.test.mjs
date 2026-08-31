import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const stackRoot = process.env.SAA_STACK_ROOT ? path.resolve(process.env.SAA_STACK_ROOT) : null;
const expectedSaaRoot = path.resolve(
  process.env.SAA_ROOT ?? path.join(process.env.USERPROFILE ?? process.cwd(), 'Documents', 'Git', 'SAA'),
);

test('SAA relocation keeps the old path as a compatibility junction', {
  skip: !stackRoot ? 'set SAA_STACK_ROOT to run the external stack contract' : false,
}, () => {
  const oldSaaRoot = path.join(stackRoot, 'runtime', 'character-select');
  assert.equal(fs.realpathSync(projectRoot), fs.realpathSync(expectedSaaRoot));
  assert.ok(fs.lstatSync(oldSaaRoot).isSymbolicLink(), 'old SAA path must be a junction/symlink');

  const start = fs.readFileSync(path.join(stackRoot, 'start-saa.ps1'), 'utf8');
  const stop = fs.readFileSync(path.join(stackRoot, 'stop-wai-stack.ps1'), 'utf8');
  assert.match(start, /Documents[\\/]Git[\\/]SAA/i);
  assert.match(stop, /Documents[\\/]Git[\\/]SAA/i);
});
