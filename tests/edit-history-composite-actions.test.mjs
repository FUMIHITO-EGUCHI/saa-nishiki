import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = path => fs.readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('textbox exposes separate silent setValue and committed user-edit paths', () => {
  const textbox = read('scripts/renderer/components/myTextbox.js');
  assert.match(textbox, /commitValue:\s*\(value\)\s*=>/);
  assert.match(textbox, /commitValue:[\s\S]*dispatchEvent\(new Event\('input', \{ bubbles: true \}\)\)/);
});

test('image metadata load is one Prompt plus Generation transaction and commits prompt values', () => {
  const source = read('scripts/renderer/imageInfo.js');
  assert.match(source, /runEditTransaction\(\{\s*source:\s*'image-metadata',[\s\S]*sections:\s*\['prompt', 'generation'\]/);
  assert.match(source, /prompt\.common\.commitValue/);
  assert.match(source, /prompt\.positive\.commitValue/);
  assert.match(source, /prompt\.negative\.commitValue/);
});

test('LoRA extraction is one Prompt plus LoRA transaction and commits the cleaned prompt', () => {
  const source = read('scripts/renderer/components/myRightClickMenu.js');
  assert.match(source, /source:\s*'send-lora-to-slot'/);
  assert.match(source, /sections:\s*\['prompt', 'lora'\]/);
  assert.match(source, /prompt\.common\.commitValue/);
  assert.match(source, /prompt\.positive\.commitValue/);
});
