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
    // the request carries only the text that reaches the prompt (refine-editor-state tests)
    assert.match(source, /editorFields: structuredRefine \? refineRequestFields\(refineSnapshot\) : null,/);
    assert.match(source, /generationContext: structuredRefine \? \{[\s\S]*?positive:[\s\S]*?positiveRight:[\s\S]*?negative:[\s\S]*?\} : null,/);
    assert.match(source, /structuredRefine,/);
    assert.match(source, /refineSnapshot,/);
    // the queued context knows the request's schema and the muted fields (refine-generation-result tests)
    assert.match(source, /refineContext: refineRequestContext\(createPromptResult\.refineContext, \{ structuredRefine, refineSystemPrompt: aiRunSettings\.refineSystemPrompt, settings: SETTINGS \}\),/);
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
  // the Artist signature guard, which generation adds without storing, goes along
  assert.match(normal, /extra: signatureGuard\(globalThis\.globalSettings\) \}\);/);
  assert.match(normal, /negative: \{ chain: negativeOrder, texts: negativeTexts, extra: signatureGuard\(globalThis\.globalSettings\) \},/);

  const regional = read('scripts/renderer/generate_regional.js');
  assert.match(regional, /characterNegativeLeft: negative_tags_left,[\s\S]*?characterNegativeRight: negative_tags_right,/);
  assert.match(regional, /negative: \{ chains: negatives\.chains, texts: negatives\.texts \},/);
  assert.match(regional, /negativeLeft: createPromptResult\.negativePromptLeft,[\s\S]*?negativeRight: createPromptResult\.negativePromptRight,/, 'the model sees each rendered side negative');

  // ComfyUI masks a negative per side, so a rebuilt one has to replace it
  assert.match(normal, /generateData\.negative_left = promptResult\.negativeLeft;/);
  assert.match(normal, /generateData\.negative_right = promptResult\.negativeRight;/);
});

test('the pending Refine summary is the one the editor apply is built on', () => {
  const normal = read('scripts/renderer/generate.js');
  assert.doesNotMatch(normal, /function refineCandidateSummary/);
  assert.equal(normal.match(/text: describeRefineCandidate\(decision\.candidate, controller\.snapshot\),/g)?.length, 2);
});

test('main process forwards structured editor and generation context only to the Ollama adapter', () => {
  const source = read('scripts/main/remoteAI_backend.js');
  assert.match(source, /const useOllama = isOllamaChatUrl\(apiUrl\);/);
  assert.match(source, /buildOllamaChatRequest\(\{[\s\S]*?editorFields,[\s\S]*?generationContext,/);
  const legacyBody = source.slice(source.indexOf(': {', source.indexOf('const requestBody = useOllama')));
  assert.doesNotMatch(legacyBody, /editorFields|generationContext/, 'non-Ollama local backend remains legacy generation-only');
});

// The pending Refine panel itself (model output kept as text, the Apply / Discard buttons,
// only the newest run actionable) is driven on a fake DOM in tests/ui-shell-behaviour.test.mjs.
test('the queue tells the parse when the answer is a reused one', () => {
  // the AI role "Last" hands a run the answer of an earlier one (remoteAI.js: 'last-run')
  assert.match(read('scripts/renderer/generate.js'), /reusedAnswer: aiRequest\.source === 'last-run',/);
});
