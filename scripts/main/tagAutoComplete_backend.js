import { app, ipcMain, dialog } from 'electron';
import path from 'node:path';
import * as fs from 'node:fs';
import { getWildcardsList } from './wildCards.js';
import { escapeHtml, parseTranslationLine } from './tagTranslation.js';
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
        const parts = line.split(',', 4);
        if (parts.length < 2) return null;

        const prompt = parts[0].trim();
        const group = this.parseNumber(parts[1]);
        const heat = parts.length > 2 ? this.parseNumber(parts[2]) : 0;
        const aliases = parts.length > 3 ? parts[3].trim().replaceAll(/(^")|("$)/g, '') : "";

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

            if (group === 1 || group === 8) {
                // Skip artist name translations
                continue;
            }

            if (prompt in promptDict) {
                const existing = promptDict[prompt];
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
                    aliases: newAliases
                });
                promptDict[prompt] = this.prompts.at(-1);
            }
        }
    }

    sortPromptsByHeat() {
        this.prompts.sort((a, b) => b.heat - a.heat);
    }

    getSuggestions(text, limit = 50, group = null, options = null) {
        if (!text) return [];

        // Keep the existing (text, limit, group[]) contract and also allow
        // getSuggestions(text, limit, options) for internal callers.
        if (group && typeof group === 'object' && !Array.isArray(group)) {
            options = group;
            group = null;
        }
        const normalizedOptions = normalizeTagFilterOptions(options);
        const hasActiveFilter = normalizedOptions.groupIds !== null || normalizedOptions.category !== null;
        const matchesFilter = hasActiveFilter
            ? createTagFilterMatcher(normalizedOptions, this.categoryIndex)
            : null;

        const parts = text.split(',');
        const lastWord = parts.at(-1).trim().toLowerCase();

        if (!lastWord) return [];

        const matches = {};
        for (const promptInfo of this.prompts) {
            // If group filter is specified, only include matching groups
            if (group !== null && Array.isArray(group) && !group.includes(promptInfo.group)) {
                continue;
            }
            if (matchesFilter && !matchesFilter(promptInfo)) continue;

            const prompt = promptInfo.prompt.toLowerCase();
            const aliases = promptInfo.aliases ? promptInfo.aliases.toLowerCase().split(',') : [];

            const matchedAlias = this.matchPrompt(lastWord, prompt, aliases);
            
            if (this.shouldAddMatch(matchedAlias, lastWord, prompt)) {                
                this.addMatch(matches, promptInfo, matchedAlias, prompt);
            }

            if (Object.keys(matches).length >= limit) break;
        }

        // Prefix matches first, then by popularity within each band.
        const startsWithWord = match => (match.prompt.toLowerCase().startsWith(lastWord) ? 1 : 0);
        return Object.values(matches).sort((a, b) => startsWithWord(b) - startsWithWord(a) || b.heat - a.heat);
    }

    matchPrompt(lastWord, prompt, aliases) {
        if (lastWord.includes('*')) {
            const promptMatch = this.handleWildcardMatching(lastWord, prompt);
            if (promptMatch) {
                // null means prompt matched
                return null;
            }
            // check aliases
            for (const alias of aliases) {
                if (this.handleWildcardMatching(lastWord, alias.trim())) {
                    return alias.trim();
                }
            }
            return null;
        } else {
            // *tag* exact match
            if(prompt.includes(lastWord)) {
                return null;
            }
            return aliases.find(alias => alias.trim().includes(lastWord)) || null;
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
            const aliasDisplay = matchedAlias || (promptInfo.aliases ? promptInfo.aliases.split(',').map(a => a.trim()).join(', ') : '');
            matches[prompt] = {
                prompt: promptInfo.prompt,
                group: promptInfo.group,
                heat: promptInfo.heat,
                category: getCategoryForPrompt(this.categoryIndex, promptInfo.prompt),
                alias: aliasDisplay || null
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
            let targetWord = currentParts[modifiedIndex].trim();
            let artistOnly = false;
            
            // Special case: @ prefix handling
            // Search artist tags for Anima Model
            if (targetWord.startsWith('@')) {
                const atCount = (targetWord.match(/@/g) || []).length;
                if (atCount === 1) {
                    // Remove the single @ at the beginning and mark as artist-only search
                    targetWord = targetWord.substring(1) + '*'; // add wildcard to match any artist tag starting with the given text
                    artistOnly = true;
                }
                // if there are multiple @, treat it as normal search (e.g., for tags @_@ or @@@)
            }                    
            
            if (artistOnly) {
                matches = this.getSuggestions(targetWord, 50, [1, 8], normalizedOptions);
                matches = matches.filter(match => Number.parseInt(match.group) === 1 || Number.parseInt(match.group) === 8);
            } else {
                matches = this.getSuggestions(targetWord, 50, null, normalizedOptions);
            }
        }

        for (const match of matches) {
            let displayAlias = match.alias ? match.alias.split(',').map(a => a.trim()).join(', ') : '';      
            
            // If translation is enabled and an alias was matched, use translated aliases
            if (this.useTranslate && match.alias) {
                const promptInfo = this.prompts.find(p => p.prompt === match.prompt);
                if (promptInfo?.aliases) {
                    displayAlias = promptInfo.aliases.split(',').map(a => a.trim()).join(', ');
                }
            }

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

        this.previousCustomPrompt = this.lastCustomPrompt;
        this.lastCustomPrompt = text;
        this.previousFilterKey = filterKey;

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

        return tagBackend.dataLoaded;
    }

    const tags = path.join(appPath, 'data', 'danbooru_e621_merged.csv');
    console.error(CAT, "Tag file not found: ", tags);
    dialog.showErrorBox(CAT, `Tag file not found: ${tags}`);
    return false;
}

async function tagReload(language = activeLanguage){
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

export {
    setupTagAutoCompleteBackend,
    tagReload,
    tagGet
};

