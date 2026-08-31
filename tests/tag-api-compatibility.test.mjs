import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const root = process.cwd();
const read = relativePath => fs.readFileSync(path.join(root, relativePath), 'utf8');

test('keeps the optional tagGet options compatible across preload, IPC, and WebSocket', () => {
  const backend = read('scripts/main/tagAutoComplete_backend.js');
  const preload = read('scripts/preload.js');
  const websocket = read('scripts/webserver/back/wsService.js');

  assert.match(preload, /tagGet: async \(text, options\) => ipcRenderer\.invoke\('tag-get-suggestions', text, options\)/);
  assert.match(backend, /ipcMain\.handle\('tag-get-suggestions', async \(event, text, options\) =>/);
  assert.match(backend, /return tagGet\(text, options\);/);
  assert.match(websocket, /'tagGet': \(params = \[\]\)=> tagGet\(\.\.\.params\)/);
});

test('retains the legacy group argument while adding the optional filter argument', () => {
  const backend = read('scripts/main/tagAutoComplete_backend.js');

  assert.match(backend, /getSuggestions\(text, limit = 50, group = null, options = null\)/);
  assert.match(backend, /group && typeof group === 'object' && !Array\.isArray\(group\)/);
  assert.match(backend, /group !== null && Array\.isArray\(group\) && !group\.includes\(promptInfo\.group\)/);
  assert.match(backend, /updateSuggestions\(text, options = null\)/);
  assert.match(backend, /function tagGet\(text, options\)/);
});
