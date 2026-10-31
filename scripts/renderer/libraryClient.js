// The renderer's view of the Library store (scripts/main/library_backend.js): which saved
// images carry a star, and the file-manager hand-off. The stars are read once and kept
// here; FAVORITES_CHANGED_EVENT tells the viewer and the Library to repaint.
// File work is the Electron window's alone: a browser client sees no stars.

export const FAVORITES_CHANGED_EVENT = 'saa:library-favorites';

let favorites = null;   // Set of lower-cased paths (Windows paths do not care about case)
let loading = null;

const keyOf = file => String(file ?? '').replaceAll('/', '\\').toLowerCase();

function bridge() {
    return globalThis.inBrowser ? null : globalThis.api ?? null;
}

function replace(list) {
    favorites = new Set((Array.isArray(list) ? list : []).map(keyOf));
    document.dispatchEvent(new CustomEvent(FAVORITES_CHANGED_EVENT));
}

/** Reads the stars once; later calls share the first read. */
export function loadFavorites() {
    if (favorites) return Promise.resolve(favorites);
    if (!loading) {
        loading = Promise.resolve(bridge()?.libraryFavorites?.())
            .then(list => { replace(list); return favorites; })
            .catch(error => {
                console.warn('[Library] stars could not be read:', error?.message ?? error);
                favorites = new Set();
                return favorites;
            });
    }
    return loading;
}

export function isFavorite(file) {
    return Boolean(file) && favorites?.has(keyOf(file)) === true;
}

/** Stars or unstars a saved image; false when there is no store to keep it in. */
export async function setFavorite(file, on) {
    const api = bridge();
    if (!file || !api?.librarySetFavorite) return false;
    replace(await api.librarySetFavorite(file, on === true));
    return true;
}

export async function showInFolder(file) {
    const api = bridge();
    if (!file || !api?.libraryShowInFolder) return false;
    return Boolean(await api.libraryShowInFolder(file));
}

/** For tests: forget what was read. */
export function resetLibraryClient() {
    favorites = null;
    loading = null;
}
