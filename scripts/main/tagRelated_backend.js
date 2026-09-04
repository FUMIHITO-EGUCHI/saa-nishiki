// Offline "related tags" lookup for the capsule suggestion strip.
//   related: co-occurrence neighbours from data/tag_related.txt (see scripts/buildTagRelated.mjs)
//   family : tags from the autocomplete list sharing the base tag's last word (…_hair)
// The dictionary is read lazily on first use and kept as raw lines (tag → line) so the
// ~200k-entry table costs one string per tag, not one object per neighbour.
import { app, ipcMain } from 'electron';
import path from 'node:path';
import * as fs from 'node:fs';
import { familyMatches, familyWord, lookupKey, parseRelatedLine } from '../shared/tagRelated.js';
import { getPromptList } from './tagAutoComplete_backend.js';

const CAT = '[TagRelatedBackend]';
const appPath = app.isPackaged ? path.join(path.dirname(app.getPath('exe')), 'resources', 'app') : app.getAppPath();
const DICTIONARY_PATH = path.join(appPath, 'data', 'tag_related.txt');

// Danbooru general + e621 general (see groupNames in tagAutoComplete_backend.js)
const FAMILY_GROUPS = new Set([0, 7]);

let table = null;
let loadError = null;

function loadTable() {
    if (table || loadError) return table;
    try {
        const started = Date.now();
        const text = fs.readFileSync(DICTIONARY_PATH, 'utf8');
        table = new Map();
        let start = 0;
        while (start < text.length) {
            let end = text.indexOf('\n', start);
            if (end < 0) end = text.length;
            const tab = text.indexOf('\t', start);
            if (tab > start && tab < end) table.set(text.slice(start, tab), text.slice(tab + 1, end));
            start = end + 1;
        }
        console.log(CAT, `Loaded ${table.size} entries in ${Date.now() - started} ms`);
    } catch (error) {
        loadError = error;
        table = null;
        console.warn(CAT, `Dictionary not available (${DICTIONARY_PATH}):`, error.message);
    }
    return table;
}

export function hasRelatedDictionary() {
    return fs.existsSync(DICTIONARY_PATH);
}

export function getRelatedTags(value, options = {}) {
    const { limit = 20, familyLimit = 20 } = options ?? {};
    const key = lookupKey(value);
    if (!key) return { tag: '', related: [], family: [], familyWord: '' };

    const dictionary = loadTable();
    const line = dictionary?.get(key);
    const related = line ? (parseRelatedLine(`${key}\t${line}`)?.related ?? []).slice(0, Math.max(0, limit)) : [];

    const word = familyWord(key);
    const exclude = new Set([key, ...related.map(entry => entry.tag)]);
    const family = familyMatches(word, getPromptList(), { limit: familyLimit, exclude, allowGroups: FAMILY_GROUPS });

    return { tag: key, related, family, familyWord: word };
}

export function setupTagRelatedBackend() {
    ipcMain.handle('tag-related', async (event, value, options) => getRelatedTags(value, options));
    ipcMain.handle('tag-related-available', async () => hasRelatedDictionary());
    if (!hasRelatedDictionary()) console.warn(CAT, `No dictionary at ${DICTIONARY_PATH}; suggestions fall back to same-family tags only.`);
    return true;
}
