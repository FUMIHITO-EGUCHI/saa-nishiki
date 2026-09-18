import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

// The pipeline card's own guards (no poll, the row bodies watched, refresh() never writing
// into a watched body) are driven on a fake DOM in tests/ui-shell-behaviour.test.mjs.

// The caret mirror and the suggestion box the capsule fields must not open are driven for
// real in tests/tag-auto-complete-ui.test.mjs.
