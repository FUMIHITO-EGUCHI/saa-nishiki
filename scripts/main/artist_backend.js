// Offline artist lookup for the Artist card's picker.
//   search : Danbooru artist tags from the autocomplete list, matched by name, by alias,
//            and by the tags data/artist_profiles.txt says the artist draws
//   profile: one artist's "draws" and "series" rows, for the panel beside the list
// The profile file is read lazily on first use and the artist rows are taken from the
// already-loaded tag list rather than re-parsing the 220k-line CSV.
import { app, ipcMain } from 'electron';
import path from 'node:path';
import * as fs from 'node:fs';
import { parseArtistProfiles, profileKey } from '../shared/artistProfiles.js';
import { rankArtists } from '../shared/artistSearch.js';
import { getPromptList } from './tagAutoComplete_backend.js';

const CAT = '[ArtistBackend]';
const appPath = app.isPackaged ? path.join(path.dirname(app.getPath('exe')), 'resources', 'app') : app.getAppPath();
const PROFILES_PATH = path.join(appPath, 'data', 'artist_profiles.txt');

// Danbooru artist (see groupNames in tagAutoComplete_backend.js). e621 artists (8) are
// left out: Anima is trained on Danbooru spellings.
const ARTIST_GROUP = 1;

let profiles = null;
let profileError = null;
let artists = null;
let artistsBuiltFrom = 0;

function loadProfiles() {
    if (profiles || profileError) return profiles;
    try {
        const started = Date.now();
        profiles = parseArtistProfiles(fs.readFileSync(PROFILES_PATH, 'utf8'));
        console.log(CAT, `Loaded ${profiles.size} artist profiles in ${Date.now() - started} ms`);
    } catch (error) {
        profileError = error;
        profiles = null;
        console.warn(CAT, `Profiles not available (${PROFILES_PATH}):`, error.message);
    }
    return profiles;
}

// The artist rows of the tag list, as rankArtists wants them. Rebuilt when the tag list
// is reloaded (a language or dictionary change grows or shrinks it).
function artistList() {
    const prompts = getPromptList();
    if (artists && artistsBuiltFrom === prompts.length) return artists;
    const started = Date.now();
    artists = [];
    for (const entry of prompts) {
        if (Number(entry?.group) !== ARTIST_GROUP) continue;
        const aliases = typeof entry.aliases === 'string' && entry.aliases
            ? entry.aliases.split(',').map(alias => alias.trim()).filter(Boolean)
            : [];
        artists.push({ tag: entry.prompt, heat: Number(entry.heat) || 0, aliases });
    }
    artistsBuiltFrom = prompts.length;
    if (artists.length > 0) console.log(CAT, `Indexed ${artists.length} artist tags in ${Date.now() - started} ms`);
    return artists;
}

export function hasArtistProfiles() {
    return fs.existsSync(PROFILES_PATH);
}

// One query → the groups the picker renders ({group, entries}).
export function searchArtists(query, options = {}) {
    const { limit = 50, favorites = [], recent = [] } = options ?? {};
    return rankArtists(query, { artists: artistList(), profiles: loadProfiles(), favorites, recent, limit });
}

export function getArtistProfile(name) {
    const key = profileKey(name);
    if (!key) return null;
    return loadProfiles()?.get(key) ?? null;
}

export function setupArtistBackend() {
    ipcMain.handle('artist-search', async (event, query, options) => searchArtists(query, options));
    ipcMain.handle('artist-profile', async (event, name) => getArtistProfile(name));
    ipcMain.handle('artist-profiles-available', async () => hasArtistProfiles());
    if (!hasArtistProfiles()) console.warn(CAT, `No profiles at ${PROFILES_PATH}; the picker searches names only.`);
    return true;
}
