import { app, ipcMain, dialog } from 'electron';
import path from 'node:path';
import * as fs from 'node:fs';
import { getWildcardsList } from './wildCards.js';
import { escapeHtml, parseTranslationLine, shouldSkipArtistTranslation } from './tagTranslation.js';
import { aliasMapFor } from '../shared/tagAliases.js';
import {
    createTagFilterMatcher,
    getCategoryForPrompt,
    getCategoryLabel,
    loadTagCategories,
    normalizeTagFilterOptions,
} from './tagCategories.js';

const CAT = '[TagAutoCompleteBackend]';
const appPath = app.isPackaged ? path.join(path.dirname(app.getPath('exe')), 'resources', 'app') : app.getAppPath();

const groupNames = {
    // Danbooru groups
    0: '[G]',           // General
    1: '[A]',           // Artist
    3: '[©]',           // Copyright
    4: '[C]',           // Character
    5: '[M]',           // Meta
    // E621 groups (0+7)
    7: '&lt;G&gt;',     // General
    8: '&lt;A&gt;',     // Artist
    10: '&lt;©&gt;',    // Copyright
    11: '&lt;C&gt;',    // Character
    12: '&lt;S&gt;',    // Species
    14: '&lt;M&gt;',    // Meta
    15: '&lt;L&gt;',    // Lore
    // SAA
    255: 'Wildcards',   // Wildcards
}

class PromptManager {
    prompts = [];
    lastCustomPrompt = "";
    previousCustomPrompt = "";
    dataLoaded = false;
    useTranslate = false;
    categoryIndex = new Map();
    previousFilterKey = '';

    async loadPrompts(promptFilePath, translateFilePath = null, useTranslate = false) {    
        try {
            const promptData = fs.readFileSync(promptFilePath, 'utf-8');
            this.parsePromptData(promptData);

            const wildcardsList = getWildcardsList();
            if (wildcardsList.length > 0) {
                console.log(CAT, `Found ${wildcardsList.length} wildcards files.`);
                for (const wildcard of wildcardsList) {
                    this.prompts.push({
                        prompt: `__${wildcard}__`,
                        group: 255, //wildcards
                        heat: 0,    
                        aliases: ""
                    });
                    console.log(CAT, `Added wildcard prompt: __${wildcard}__`);
                }
            }

            if (useTranslate && translateFilePath) {
                console.log(CAT, `Using translate file ${translateFilePath}`);
                const translateData = fs.readFileSync(translateFilePath, 'utf-8');
                this.parseTranslateData(translateData);
                this.useTranslate = true;
            } else {
                this.useTranslate = false;
            }

            this.sortPromptsByHeat();
            this.dataLoaded = true;
            console.log(CAT, `Loaded ${this.prompts.length} prompts.`);
        } catch (error) {
            console.error(CAT, `Error loading prompts: ${error.message}`);
            this.dataLoaded = false;
        }
    }

    parsePromptData(promptData) {
        const lines = promptData.split('\n').filter(line => line.trim());
        for (const line of lines) {
            const promptInfo = this.parseLine(line);
            if (promptInfo) {
                this.prompts.push(promptInfo);
            }
        }
    }

    parseLine(line) {
        // `tag,category,heat,"alias,alias,alias"`: the alias field is quoted and holds commas,
        // so it is taken whole from the third comma on. Splitting with a limit dropped every
        // alias after the first (10 890 of the 221 787 rows lost aliases, and a search for
        // "sole_female" or "boobs" found nothing).
        const first = line.indexOf(',');
        const second = line.indexOf(',', first + 1);
        if (first <= 0) return null;

        const prompt = this.unquote(line.slice(0, first));
        const third = second < 0 ? -1 : line.indexOf(',', second + 1);
        const group = this.parseNumber(second < 0 ? line.slice(first + 1) : line.slice(first + 1, second));
        const heatField = second < 0 ? '' : (third < 0 ? line.slice(second + 1) : line.slice(second + 1, third));
        const heat = heatField === '' ? 0 : this.parseNumber(heatField);
        const aliases = third < 0 ? '' : this.unquote(line.slice(third + 1));

        return {
            prompt,
            group: heat === 0 ? 0 : group,
            heat: heat === 0 ? group : heat,
            aliases
        };
    }

    parseNumber(value) {
        const match = /^\d+$/.exec(value.trim());
        return match ? Number.parseInt(match[0]) : 0;
    }

    // A CSV field as the dictionary writes it: wrapped in quotes when it holds a comma or a
    // quote of its own, with the inner quotes doubled (35 tags carry one, e.g. don't_say_"lazy").
    unquote(value) {
        const text = String(value ?? '').trim();
        if (!text.startsWith('"') || !text.endsWith('"') || text.length < 2) return text;
        return text.slice(1, -1).replaceAll('""', '"');
    }

    parseTranslateData(translateData) {
        const translateLines = translateData.split('\n').filter(line => line.trim());
        const promptDict = Object.fromEntries(this.prompts.map(p => [p.prompt, p]));

        let index = 0;
        for (const line of translateLines) {
            index++;
            const translation = parseTranslationLine(line);
            if (!translation) {
                console.log(CAT, `Skipping invalid line ${index}: ${line}`);
                continue;
            }

            const { prompt, group, aliases: newAliases } = translation;

            if (shouldSkipArtistTranslation(promptDict[prompt], group)) {
                // Skip artist name translations
                continue;
            }

            if (prompt in promptDict) {
                const existing = promptDict[prompt];
                // the language file's own text is the tag's translation (shared/tagAliases.js);
                // `aliases` below also holds the CSV's synonyms. A repeated line keeps the first.
                existing.translation ||= newAliases;
                if (existing.aliases) {
                    const existingAliases = new Set(existing.aliases.split(','));
                    const newAliasesSet = new Set(newAliases.split(','));
                    existing.aliases = [...existingAliases, ...newAliasesSet].join(',');
                } else {
                    existing.aliases = newAliases;
                }
            } else {
                this.prompts.push({
                    prompt,
                    group,
                    heat: 1,  // translate alias
                    aliases: newAliases,
                    translation: newAliases
                });
                promptDict[prompt] = this.prompts.at(-1);
            }
        }
    }

    sortPromptsByHeat() {
        this.prompts.sort((a, b) => b.heat - a.heat);
    }

    // The first `limit` of every match, ranked (see rankMatches); `this.lastSearch`
    // keeps the count of the whole result so a caller can page through it with
    // searchTags. Keep the existing (text, limit, group[]) contract and also allow
    // getSuggestions(text, limit, options) for internal callers.
    getSuggestions(text, limit = 50, group = null, options = null) {
        if (group && typeof group === 'object' && !Array.isArray(group)) {
            options = group;
            group = null;
        }
        const ranked = this.rankMatches(text, group, options);
        this.lastSearch = { total: ranked.length, offset: 0, limit };
        return ranked.slice(0, limit);
    }

    // Every dictionary entry the last comma-separated word of `text` matches, prefix
    // matches first and the more popular tag first inside each band. The whole
    // dictionary is scanned before anything is cut, so a page never hides a better
    // match behind a more popular one.
    rankMatches(text, group = null, options = null) {
        if (!text) return [];
        const normalizedOptions = normalizeTagFilterOptions(options);
        const hasActiveFilter = normalizedOptions.groupIds !== null || normalizedOptions.category !== null;
        const matchesFilter = hasActiveFilter
            ? createTagFilterMatcher(normalizedOptions, this.categoryIndex)
            : null;

        const parts = text.split(',');
        const typedWord = parts.at(-1).trim().toLowerCase();
        if (!typedWord) return [];
        // The dictionary keys join words with "_" while people type a space ("white d"
        // is on its way to white_dress); the key is matched with the underscore form, an
        // alias (which may hold real spaces) with either.
        const lastWord = typedWord.replaceAll(' ', '_');

        const matches = {};
        for (const promptInfo of this.prompts) {
            // If group filter is specified, only include matching groups
            if (group !== null && Array.isArray(group) && !group.includes(promptInfo.group)) {
                continue;
            }
            if (matchesFilter && !matchesFilter(promptInfo)) continue;

            // lower-cased once per entry: the scan visits every row on every keystroke
            promptInfo.searchPrompt ??= promptInfo.prompt.toLowerCase();
            promptInfo.searchAliases ??= promptInfo.aliases ? promptInfo.aliases.toLowerCase().split(',') : [];
            const prompt = promptInfo.searchPrompt;

            const matchedAlias = this.matchPrompt(lastWord, prompt, promptInfo.searchAliases, typedWord);
            if (this.shouldAddMatch(matchedAlias, lastWord, prompt)) {
                this.addMatch(matches, promptInfo, matchedAlias, prompt);
            }
        }

        const startsWithWord = match => (match.prompt.toLowerCase().startsWith(lastWord) ? 1 : 0);
        return Object.values(matches).sort((a, b) => startsWithWord(b) - startsWithWord(a) || b.heat - a.heat);
    }

    // One page of the ranked matches of `word` as rendered suggestion rows, with the
    // size of the whole result: { items, total, offset, limit }. Unlike
    // updateSuggestions this answers every call, so a list can ask for the next page
    // of the same word. `options` carries the tag filter plus { offset, limit }.
    searchTags(word, options = null) {
        const offset = Math.max(0, Number.parseInt(options?.offset, 10) || 0);
        const limit = Math.min(500, Math.max(1, Number.parseInt(options?.limit, 10) || 50));
        if (!this.dataLoaded) return { items: [], total: 0, offset, limit };
        const ranked = this.rankMatches(String(word ?? '').trim(), null, options);
        return { items: this.formatMatches(ranked.slice(offset, offset + limit)), total: ranked.length, offset, limit };
    }

    // `lastWord` is the typed word with its spaces as "_" (the key form); `typedWord`
    // is what was typed, so an alias with a real space still matches it.
    matchPrompt(lastWord, prompt, aliases, typedWord = lastWord) {
        const aliasWords = typedWord === lastWord ? [lastWord] : [lastWord, typedWord];
        if (lastWord.includes('*')) {
            const promptMatch = this.handleWildcardMatching(lastWord, prompt);
            if (promptMatch) {
                // null means prompt matched
                return null;
            }
            // check aliases
            for (const alias of aliases) {
                if (aliasWords.some(word => this.handleWildcardMatching(word, alias.trim()))) {
                    return alias.trim();
                }
            }
            return null;
        } else {
            // *tag* exact match
            if(prompt.includes(lastWord)) {
                return null;
            }
            return aliases.find(alias => aliasWords.some(word => alias.trim().includes(word))) || null;
        }
    }

    handleWildcardMatching(pattern, text) {
        if (!pattern || !text) return false;
        
        text = text.toLowerCase();
        pattern = pattern.toLowerCase();

        if (pattern.startsWith('*') && pattern.endsWith('*')) {
            const searchText = pattern.slice(1, -1);
            return text.includes(searchText);
        } else if (pattern.startsWith('*')) {
            const searchText = pattern.slice(1);
            return text.endsWith(searchText);
        } else if (pattern.endsWith('*')) {
            const searchText = pattern.slice(0, -1);
            return text.startsWith(searchText);
        }
        return false;
    }

    shouldAddMatch(matchedAlias, lastWord, prompt) {
        // if matched alias found
        if (matchedAlias !== null) {
            return true;
        }
        
        // if prompt matched with wildcard
        if (lastWord.includes('*') && this.handleWildcardMatching(lastWord, prompt)) {
            return true;
        }
        
        // if no wildcard, any substring of the prompt matches (so "hair" also
        // surfaces long_hair etc.); prefix matches are ranked first in the sort
        if (!lastWord.includes('*') && prompt.toLowerCase().includes(lastWord.toLowerCase())) {
            return true;
        }

        return false;
    }

    addMatch(matches, promptInfo, matchedAlias, prompt) {
        if (!(prompt in matches) || promptInfo.heat > matches[prompt].heat) {
            // only the alias the row was found by rides along: the row shows why it is
            // there, not the whole synonym list of the tag
            matches[prompt] = {
                prompt: promptInfo.prompt,
                group: promptInfo.group,
                heat: promptInfo.heat,
                category: getCategoryForPrompt(this.categoryIndex, promptInfo.prompt),
                alias: matchedAlias || null,
                translation: promptInfo.translation || '',
            };
        }
    }

    // eslint-disable-next-line sonarjs/cognitive-complexity
    updateSuggestions(text, options = null) {
        if (!this.dataLoaded) {
            console.log(CAT, `No data loaded. Returning empty dataset.`);
            return [];
        }

        const items = [];
        const normalizedOptions = normalizeTagFilterOptions(options);
        const filterKey = JSON.stringify(normalizedOptions);
        const filterChanged = filterKey !== this.previousFilterKey;
        const currentParts = text ? text.replaceAll('\n', ',').split(',') : [];
        const previousParts = this.previousCustomPrompt ? this.previousCustomPrompt.split(',') : [];

        let modifiedIndex = -1;
        for (let i = 0; i < Math.min(currentParts.length, previousParts.length); i++) {
            if (currentParts[i].trim() !== previousParts[i].trim()) {
                modifiedIndex = i;
                break;
            }
        }

        if (modifiedIndex === -1 && currentParts.length > previousParts.length) {
            modifiedIndex = currentParts.length - 1;
        }

        if (modifiedIndex === -1 && filterChanged && currentParts.length > 0) {
            modifiedIndex = currentParts.length - 1;
        }

        let matches = [];
        if (modifiedIndex >= 0 && modifiedIndex < currentParts.length) {
            const targetWord = currentParts[modifiedIndex].trim();
            // A leading '@' is a cast reference ("@alias" in an Action, see
            // scripts/shared/castMembers.js), not a search prefix: the word is looked
            // up as written, so only tags that really start with '@' (e.g. @_@) match.
            matches = this.getSuggestions(targetWord, 50, null, normalizedOptions);
        }

        this.previousCustomPrompt = this.lastCustomPrompt;
        this.lastCustomPrompt = text;
        this.previousFilterKey = filterKey;

        return this.formatMatches(matches);
    }

    // The rows the renderer shows: [`<b>tag</b>: (aliases) (heat) [group] [category]`].
    formatMatches(matches) {
        const items = [];
        for (const match of matches) {
            // What the row says besides the tag: the translation (the language file's
            // text) and, when the row was found through an alias, that alias - so a
            // row whose tag does not contain the typed word still shows why it matched.
            // The tag's other synonyms stay out; a long list made every row unreadable.
            const translation = this.useTranslate ? String(match.translation ?? '').trim() : '';
            const matchedAlias = String(match.alias ?? '').trim();
            const shown = [];
            if (matchedAlias && matchedAlias !== translation) shown.push(matchedAlias);
            if (translation) shown.push(translation);
            const displayAlias = shown.join(', ');

            const group = Number.parseInt(match.group);
            const groupName = groupNames[group] || 'Unknown';
            const categoryLabel = match.category === 'unknown' ? '' : ` [${escapeHtml(getCategoryLabel(match.category))}]`;
            const safePrompt = escapeHtml(match.prompt);
            const safeAlias = escapeHtml(displayAlias);

            let key = "";
            if(group === 255) { //wildcards
                key = `<b>${safePrompt}</b> | ${groupName}`;
            } else {
                key = displayAlias
                    ? `<b>${safePrompt}</b>: (${safeAlias}) (${match.heat}) ${groupName}${categoryLabel}`
                    : `<b>${safePrompt}</b> (${match.heat}) ${groupName}${categoryLabel}`;
            }
            items.push([key]);
        }
        return items;
    }
}

const tagBackend = new PromptManager();
const tagCategoryPath = path.join(appPath, 'data', 'tag_categories.json');
tagBackend.categoryIndex = loadTagCategories(tagCategoryPath);
let activeLanguage = 'en-US';

const translationFiles = {
    'zh-CN': 'danbooru_e621_merged_zh_cn.csv',
    'ja-JP': 'danbooru_e621_merged_ja.csv',
};

async function reloadData(language = activeLanguage) {
    activeLanguage = translationFiles[language] ? language : 'en-US';
    const tags = path.join(appPath, 'data', 'danbooru_e621_merged.csv');
    const translateName = translationFiles[activeLanguage];
    const translate = translateName ? path.join(appPath, 'data', translateName) : null;
    const isTranslateFile = translate !== null && fs.existsSync(translate);

    if (fs.existsSync(tags))
    {
        await tagBackend.loadPrompts(tags, isTranslateFile?translate:null, isTranslateFile);
    }

    return tagBackend.dataLoaded;
}

async function setupTagAutoCompleteBackend(language = 'en-US'){
    if (await reloadData(language))
    {
        ipcMain.handle('tag-reload', async (event, nextLanguage) => {
            return await tagReload(nextLanguage);
        });

        ipcMain.handle('tag-get-suggestions', async (event, text, options) => {
            return tagGet(text, options);
        });

        ipcMain.handle('tag-search', async (event, word, options) => {
            return tagSearch(word, options);
        });

        ipcMain.handle('tag-lookup', async (event, keys) => {
            return tagLookup(keys);
        });

        ipcMain.handle('tag-aliases', async (event, tags) => {
            return getTagAliases(tags);
        });

        return tagBackend.dataLoaded;
    }

    const tags = path.join(appPath, 'data', 'danbooru_e621_merged.csv');
    console.error(CAT, "Tag file not found: ", tags);
    dialog.showErrorBox(CAT, `Tag file not found: ${tags}`);
    return false;
}

// Which dictionary keys ("long_hair", see shared/tagLint.js) exist. `loaded: false`
// while the tag file is missing, so the renderer never marks tags against an empty
// dictionary.
let tagKeySet = null;
function tagLookup(keys) {
    if (!tagBackend.dataLoaded) return { loaded: false, known: [] };
    tagKeySet ??= new Set(tagBackend.prompts.map(entry => String(entry.prompt).toLocaleLowerCase()));
    const list = Array.isArray(keys) ? keys.filter(key => typeof key === 'string').slice(0, 2000) : [];
    return { loaded: true, known: list.filter(key => tagKeySet.has(key)) };
}

// Translation of each tag (the chip popover's alias line): { value: alias } from the
// language file text kept on each entry, '' when unknown or untranslated. `loaded: false`
// while no tag file is loaded so the renderer does not cache blanks.
let tagEntryMap = null;
export function getTagAliases(tags) {
    if (!tagBackend.dataLoaded) return { loaded: false, aliases: {} };
    tagEntryMap ??= new Map(tagBackend.prompts.map(entry => [String(entry.prompt).toLocaleLowerCase(), entry]));
    const list = Array.isArray(tags) ? tags.filter(tag => typeof tag === 'string').slice(0, 2000) : [];
    return { loaded: true, aliases: aliasMapFor(tagEntryMap, list) };
}

async function tagReload(language = activeLanguage){
    tagKeySet = null;
    tagEntryMap = null;
    tagBackend.prompts = [];
    tagBackend.lastCustomPrompt = "";
    tagBackend.previousCustomPrompt = "";
    tagBackend.previousFilterKey = '';
    tagBackend.dataLoaded = false;
    await reloadData(language);
    return tagBackend.dataLoaded;
}

function tagGet(text, options) {
    return tagBackend.updateSuggestions(text, options);
}

// A page of the matches of one word: { items, total, offset, limit } (options carry
// the tag filter and the page). The lists load the next page as they are scrolled.
function tagSearch(word, options) {
    return tagBackend.searchTags(word, options);
}

// Loaded tag entries ({ prompt, group, heat, aliases }), heat-sorted; empty until loaded.
function getPromptList() {
    return tagBackend.dataLoaded ? tagBackend.prompts : [];
}

export {
    setupTagAutoCompleteBackend,
    tagReload,
    tagGet,
    tagSearch,
    tagLookup,
    getPromptList
};

