import { app, ipcMain, dialog, nativeImage } from 'electron';
import * as fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { createHash } from 'node:crypto';
import { loadCSVFile, loadJSONFile } from './fileHandlers.js';
import { requestDownloadOldThumbs, requestDownloadAnimaThumbs } from './downloadFiles.js';
import { createUserListsStore } from './userListsStore.js';
import { mergeKeyedList, mergeValueList, summarizeUserLists } from '../shared/userLists.js';

const CAT = '[FileCache]';

// Upstream data as loaded from disk (read-only) …
let cachedCharacterBase = {};
let cachedOCCharacterBase = {};
let cachedViewTagsBase = {};
let cachedCharacterThumbBase = {};
// … and the user-diff-merged views the rest of the app consumes.
let cachedCharacterThumb = {};
let cachedLanguages = {};
let cachedCharacter = {};
let cachedCharacterNames = {};
let cachedOCCharacter = {};
let cachedViewTags = {};
let cachedUserListMeta = {};
let cachedTagAssist = {}
let cachedLoadingWait = {};
let cachedLoadingFailed = {};
let cachedPrivacyBall = {};

let userListsStore = null;

const appPath = app.isPackaged ? path.join(path.dirname(app.getPath('exe')), 'resources', 'app') : app.getAppPath();

// Same escaping the renderer applies before hashing a tag for a thumb lookup.
function thumbKeyForTag(tag) {
    const escaped = String(tag ?? '').replaceAll('\\', '\\\\').replaceAll('(', String.raw`\(`).replaceAll(')', String.raw`\)`);
    return createHash('md5').update(escaped).digest('hex'); // NOSONAR S4790 — cache key, not security
}

// Rebuild the merged views from the upstream bases + the current user diff.
function applyUserDiffs() {
    const doc = userListsStore?.get() ?? null;

    const character = mergeKeyedList(cachedCharacterBase, doc?.character, 'csv');
    const oc = mergeKeyedList(cachedOCCharacterBase, doc?.oc, 'original');
    const angle = mergeValueList(cachedViewTagsBase.angle ?? [], doc?.view_angle);
    const camera = mergeValueList(cachedViewTagsBase.camera ?? [], doc?.view_camera);

    cachedCharacter = character.merged;
    cachedOCCharacter = oc.merged;
    cachedViewTags = { ...cachedViewTagsBase, angle: angle.merged, camera: camera.merged };
    cachedUserListMeta = { character: character.meta, oc: oc.meta, view_angle: angle.meta, view_camera: camera.meta };

    // User thumbs are stored on the entry (gzip → base64, same envelope as the upstream
    // thumbs file) and registered under the md5 of the entry's merged tag.
    cachedCharacterThumb = { ...cachedCharacterThumbBase };
    for (const [name, meta] of Object.entries(character.meta)) {
        if (!meta.thumb || meta.hidden) continue;
        const tag = cachedCharacter[name];
        if (typeof tag === 'string') cachedCharacterThumb[thumbKeyForTag(tag)] = meta.thumb;
    }
}

// A picked image file → downscaled PNG → gzip → base64 (the thumbs-file envelope).
function prepareUserThumb(filePath) {
    try {
        const image = nativeImage.createFromPath(filePath);
        if (image.isEmpty()) return null;
        const { width } = image.getSize();
        const resized = width > 256 ? image.resize({ width: 256 }) : image;
        return zlib.gzipSync(resized.toPNG()).toString('base64');
    } catch (error) {
        console.error(`${CAT}: prepareUserThumb failed for ${filePath}:`, error.message);
        return null;
    }
}

function mergedListsPayload() {
    return {
        characters: cachedCharacter,
        ocCharacters: cachedOCCharacter,
        viewTags: cachedViewTags,
        userListMeta: cachedUserListMeta,
        summary: summarizeUserLists(userListsStore?.get() ?? null),
    };
}

function loadFileEx(saveDir, fileName, dataPointer)
{
    const filePath = path.join(appPath, saveDir, fileName);
    if (fs.existsSync(filePath)) {       
        
        const ext = path.extname(filePath).toLowerCase();
                    
        if (ext === '.csv') {
            const data = loadCSVFile(filePath);      
            Object.assign(dataPointer, data);            
        } else if (ext === '.json') {
            const data = loadJSONFile(filePath);      
            Object.assign(dataPointer, data); 
        } else {
            console.error(`${CAT}: ${fileName} load failed`);
            return false;
        }
        console.log(`${CAT}: ${fileName} loaded into memory`);
    } else {
        console.error(`${CAT}: ${fileName} load failed`);
        dialog.showErrorBox(CAT, `${fileName} load failed`);
        return false;
    }
    return true;
}

function loadImageEx(filePath, fileName, dataPointer) {
    const fileFullPath = path.join(appPath, filePath, fileName);
    if (fs.existsSync(fileFullPath)) {
        try {
            const fileBuffer = fs.readFileSync(fileFullPath);               
            const base64Data = fileBuffer.toString('base64');
            dataPointer.data = base64Data;

            console.log(`${CAT}: ${fileName} loaded into memory, size: ${fileBuffer.length} bytes`);
            return true;
        } catch (error) {
            console.error(`${CAT}: Error loading ${fileName}: ${error.message}`);
            return false;
        }
    } else {
        console.error(`${CAT}: ${fileName} load failed - file does not exist at ${fileFullPath}`);
        return false;
    }
}

function setupCachedFiles(thumbSelect) {
    const thumb_name = `${thumbSelect}_thumbs.json`;
    const characters_name = `${thumbSelect}_characters.csv`;
    const tag_assist_name = `${thumbSelect}_tag_assist.json`;
    console.log(`${CAT}: Loading cached files for thumbnail selection: ${thumbSelect}`);

    const thumb = loadFileEx('data', thumb_name, cachedCharacterThumbBase);
    const characters = loadFileEx('data', characters_name, cachedCharacterBase);
    const character_tag_assist = loadFileEx('data', tag_assist_name, cachedTagAssist);

    const language = loadFileEx('data', 'language.json', cachedLanguages);
    // Japanese intentionally reuses the English UI strings. Character names
    // are localized separately so the rest of the application stays English.
    if (language && cachedLanguages['en-US']) {
        cachedLanguages['ja-JP'] = {
            ...cachedLanguages['en-US'],
            language: '日本語'
        };
    }
    const character_names = loadFileEx('data', 'character_names.json', cachedCharacterNames);
    const official_work_names = loadFileEx('data', 'official_work_names.json', cachedCharacterNames);
    const oc_characters = loadFileEx('data', 'original_character.json', cachedOCCharacterBase);
    const view_tags = loadFileEx('data', 'view_tags.json', cachedViewTagsBase);

    userListsStore = createUserListsStore({
        rootDir: path.join(appPath, 'settings'),
        saaVersion: app.getVersion?.() ?? '',
        log: console,
    });
    userListsStore.load();
    applyUserDiffs();
    const listSummary = summarizeUserLists(userListsStore.get());
    console.log(`${CAT}: User list diff loaded:`, JSON.stringify(listSummary));

    let filePath = path.join('data', 'imgs');
    const loadingWait = loadImageEx(filePath, 'loading_wait.png', cachedLoadingWait);
    const loadingFailed = loadImageEx(filePath, 'loading_failed.png', cachedLoadingFailed);
    const privacyBall = loadImageEx(filePath, 'privacy_ball.png', cachedPrivacyBall);

    ipcMain.handle('get-cached-files', async () => {
        return {
            characterThumb: cachedCharacterThumb,
            languages: cachedLanguages,
            characters: cachedCharacter,
            characterNames: cachedCharacterNames,
            ocCharacters: cachedOCCharacter,
            viewTags: cachedViewTags,
            userListMeta: cachedUserListMeta,
            tagAssist: cachedTagAssist,
            loadingWait: cachedLoadingWait,
            loadingFailed: cachedLoadingFailed,
            privacyBall: cachedPrivacyBall
        };
    });

    ipcMain.handle('update-cached-character-thumb', async (event, thumbSelect) => {
        return await updateCharacterThumb(thumbSelect);
    });

    // ---- user list management (R3 data layer) ----
    ipcMain.handle('get-user-lists', async () => {
        return { doc: userListsStore.get(), meta: cachedUserListMeta, summary: summarizeUserLists(userListsStore.get()) };
    });

    // change = { action: 'set'|'remove'|'hide'|'unhide', key, entry? }; returns the refreshed
    // merged lists (null when the change was refused).
    ipcMain.handle('apply-user-list-change', async (event, list, change) => {
        const applied = userListsStore.apply(list, change);
        if (!applied) return null;
        applyUserDiffs();
        return mergedListsPayload();
    });

    // filePath → gzip+base64 thumb payload for a 'set' entry (null when unreadable).
    ipcMain.handle('prepare-user-thumb', async (event, filePath) => {
        return prepareUserThumb(filePath);
    });

    ipcMain.handle('export-user-lists', async () => {
        const { canceled, filePath: target } = await dialog.showSaveDialog({
            title: 'Export user lists',
            defaultPath: 'saa_user_lists.json',
            filters: [{ name: 'JSON', extensions: ['json'] }],
        });
        if (canceled || !target) return null;
        return userListsStore.exportTo(target);
    });

    ipcMain.handle('import-user-lists', async (event, mode = 'merge') => {
        const { canceled, filePaths } = await dialog.showOpenDialog({
            title: 'Import user lists',
            filters: [{ name: 'JSON', extensions: ['json'] }],
            properties: ['openFile'],
        });
        if (canceled || !filePaths?.[0]) return null;
        const result = userListsStore.importFrom(filePaths[0], mode === 'replace' ? 'replace' : 'merge');
        if (!result.ok) return { ok: false };
        applyUserDiffs();
        return { ok: true, ...mergedListsPayload() };
    });

    console.log(`${CAT}: Number of characters loaded: ${Object.entries(cachedCharacter).length}`);

    return thumb && language && characters && character_names && official_work_names && oc_characters && view_tags && character_tag_assist && loadingWait && loadingFailed && privacyBall;
}

function getCachedFiles() {
    return {
        characterThumb: cachedCharacterThumb,
        languages: cachedLanguages,
        characters: cachedCharacter,
        characterNames: cachedCharacterNames,
        ocCharacters: cachedOCCharacter,
        viewTags: cachedViewTags,
        userListMeta: cachedUserListMeta,
        tagAssist: cachedTagAssist,
        loadingWait: cachedLoadingWait,
        loadingFailed: cachedLoadingFailed,
        privacyBall: cachedPrivacyBall
    };
}

function getCachedFilesWithoutThumb() {
    return {
        //characterThumb: cachedCharacterThumb,
        languages: cachedLanguages,
        characters: cachedCharacter,
        characterNames: cachedCharacterNames,
        ocCharacters: cachedOCCharacter,
        viewTags: cachedViewTags,
        userListMeta: cachedUserListMeta,
        tagAssist: cachedTagAssist,
        loadingWait: cachedLoadingWait,
        loadingFailed: cachedLoadingFailed,
        privacyBall: cachedPrivacyBall
    };
}

function getCharacterThumb(md5Chara) {
    if (cachedCharacterThumb[md5Chara] === undefined) {
        console.warn(CAT, `Character thumb for ${md5Chara} not found in cache.`);
        return null;
    }
    
    return cachedCharacterThumb[md5Chara];
}

async function updateCharacterThumb(thumbSelect) {
    console.log(`${CAT}: Updating cached files for thumbnail selection: ${thumbSelect}`);

    if (thumbSelect === `waiNSFWIllustrious_v120`) {
        console.log(`${CAT}: Requesting download of waiNSFWIllustrious_v120 thumbs...`);
        await requestDownloadOldThumbs();
    } else if (thumbSelect === `waiANIMA_v10Base10`) {
        console.log(`${CAT}: Requesting download of waiANIMA_v10Base10 thumbs...`);
        await requestDownloadAnimaThumbs();
    }
    
    const temp_cachedCharacterThumb = {};
    const temp_cachedCharacter = {};
    const temp_cachedTagAssist = {};

    const thumb_name = `${thumbSelect}_thumbs.json`;
    const characters_name = `${thumbSelect}_characters.csv`;
    const tag_assist_name = `${thumbSelect}_tag_assist.json`;

    const thumb = loadFileEx('data', thumb_name, temp_cachedCharacterThumb);
    const characters = loadFileEx('data', characters_name, temp_cachedCharacter);
    const character_tag_assist = loadFileEx('data', tag_assist_name, temp_cachedTagAssist);

    const success = thumb && characters && character_tag_assist;
    if (success) {
        cachedCharacterThumbBase = temp_cachedCharacterThumb;
        cachedCharacterBase = temp_cachedCharacter;
        cachedTagAssist = temp_cachedTagAssist;
        applyUserDiffs();
        console.log(`${CAT}: Number of characters loaded: ${Object.entries(cachedCharacter).length}`);
    } else {
        console.error(`${CAT}: Failed to update cached files for thumbnail selection: ${thumbSelect}`);
    }

    return success;
}

export {
    setupCachedFiles,
    getCachedFiles,
    getCachedFilesWithoutThumb,
    getCharacterThumb,
    updateCharacterThumb
};
