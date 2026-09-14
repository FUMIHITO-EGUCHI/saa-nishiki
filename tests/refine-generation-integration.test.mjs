import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.join(testDirectory, '..');
const read = relativePath => fs.readFileSync(path.join(projectRoot, relativePath), 'utf8');

test('normal and regional generation queue the frozen editor fields and rendered generation context', () => {
  for (const file of ['scripts/renderer/generate.js', 'scripts/renderer/generate_regional.js']) {
    const source = read(file);
    const snapshotAt = source.indexOf('const refineSnapshot = captureRefineEditorSnapshot');
    const expansionAt = source.indexOf('const expansion = planBatchExpansion');
    const loopAt = source.indexOf('for(let loop = 0; loop < loops; loop++');
    assert.ok(snapshotAt >= 0 && snapshotAt < expansionAt && expansionAt < loopAt, `${file} freezes state before preparing images`);
    assert.match(source, /editorFields: structuredRefine \? refineSnapshot\.fields : null,/);
    assert.match(source, /generationContext: structuredRefine \? \{[\s\S]*?positive:[\s\S]*?positiveRight:[\s\S]*?negative:[\s\S]*?\} : null,/);
    assert.match(source, /structuredRefine,/);
    assert.match(source, /refineSnapshot,/);
    assert.match(source, /refineContext: createPromptResult\.refineContext,/);
  }
});

test('normal and regional fixed context stays separate for V2 prompt recomposition', () => {
  const normal = read('scripts/renderer/generate.js');
  assert.match(normal, /refineContext: \{[\s\S]*?beforePrompts: BOP,[\s\S]*?views,[\s\S]*?characters,[\s\S]*?exclude,[\s\S]*?slotLora:/);
  assert.match(normal, /characterNegative: negative_tags,/);

  const regional = read('scripts/renderer/generate_regional.js');
  assert.match(regional, /refineContext: \{[\s\S]*?left: \{[\s\S]*?characters: character_left,[\s\S]*?right: \{[\s\S]*?characters: character_right/);
  assert.match(regional, /leftSeed: randomSeed,[\s\S]*?rightSeed: randomSeedr,[\s\S]*?characterNegative: \[negative_tags_left, negative_tags_right\]/);
});

test('the negative units reach Refine and the rebuilt side negatives reach the backend', () => {
  const normal = read('scripts/renderer/generate.js');
  assert.match(normal, /negative: \{ chain: negativeOrder, texts: negativeTexts \},/);

  const regional = read('scripts/renderer/generate_regional.js');
  assert.match(regional, /characterNegativeLeft: negative_tags_left,[\s\S]*?characterNegativeRight: negative_tags_right,/);
  assert.match(regional, /negative: \{ chains: negatives\.chains, texts: negatives\.texts \},/);
  assert.match(regional, /negativeLeft: createPromptResult\.negativePromptLeft,[\s\S]*?negativeRight: createPromptResult\.negativePromptRight,/, 'the model sees each rendered side negative');

  // ComfyUI masks a negative per side, so a rebuilt one has to replace it
  assert.match(normal, /generateData\.negative_left = promptResult\.negativeLeft;/);
  assert.match(normal, /generateData\.negative_right = promptResult\.negativeRight;/);
});

test('main process forwards structured editor and generation context only to the Ollama adapter', () => {
  const source = read('scripts/main/remoteAI_backend.js');
  assert.match(source, /const useOllama = isOllamaChatUrl\(apiUrl\);/);
  assert.match(source, /buildOllamaChatRequest\(\{[\s\S]*?editorFields,[\s\S]*?generationContext,/);
  const legacyBody = source.slice(source.indexOf(': {', source.indexOf('const requestBody = useOllama')));
  assert.doesNotMatch(legacyBody, /editorFields|generationContext/, 'non-Ollama local backend remains legacy generation-only');
});

test('pending Refine UI treats model output as text and exposes keyboard-native actions', () => {
  const source = read('scripts/renderer/uiShell.js');
  assert.match(source, /summary\.textContent = String\(text \?\? ''\)/, 'untrusted model output is assigned with textContent');
  assert.doesNotMatch(source, /ai-refine-summary[^\n]*innerHTML/, 'pending summary never uses innerHTML');
  assert.match(source, /apply\.type = 'button'/);
  assert.match(source, /discard\.type = 'button'/);
  assert.match(source, /pendingRunId !== runId/, 'only the newest pending run remains actionable');
});
