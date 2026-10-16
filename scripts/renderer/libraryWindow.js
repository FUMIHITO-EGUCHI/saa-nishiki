// The Library: every image in the folders SAA saves to, by folder (ComfyUI's output by
// day, the pod saves by day) or by view (this session, the stars, the images with an SAA
// recipe, those with only their parameters). Search and filters narrow the grid, which
// runs in time order, a group per day; the panel on the right tells what the selected
// image is and offers Use settings…, Show in folder and Move to trash. The main window's
// viewer stays this session's.
//
// The images and their records come from the main process (library_backend.js); the
// thumbnails are asked for as their tiles come into view.

import { createDialogShell } from './components/dialogShell.js';
import { showDialog } from './components/myDialog.js';
import { FAVORITES_CHANGED_EVENT, isFavorite, loadFavorites, setFavorite, showInFolder } from './libraryClient.js';
import { openUseSettings } from './useSettingsDialog.js';
import { summarizeImage } from '../shared/imageSummary.js';
import { formatDuration } from '../shared/runTiming.js';

const TILE_SIZES = Object.freeze({ S: 120, M: 160, L: 210 });
const STORAGE_KEY = 'saa.library';

function lang() {
    const settings = globalThis.globalSettings ?? {};
    return globalThis.cachedFiles?.language?.[settings.language] ?? {};
}

function text(key, fallback) {
    const value = lang()[key];
    return typeof value === 'string' && value ? value : fallback;
}

function element(tag, className, content) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (content !== undefined && content !== null) node.textContent = String(content);
    return node;
}

function readPrefs() {
    try { return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') ?? {}; } catch { return {}; }
}

function writePrefs(prefs) {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs)); } catch { /* the defaults next time */ }
}

function number(value) {
    return Number.isFinite(value) ? String(Math.round(value * 100) / 100) : '—';
}

function pad(value) {
    return String(value).padStart(2, '0');
}

function dayText(date) {
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function timeText(date) {
    return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function dateOf(entry) {
    const date = new Date(entry.created || entry.mtime);
    return Number.isNaN(date.getTime()) ? new Date(entry.mtime) : date;
}

// ------------------------------------------------------------------ pure parts (exported for tests)

/** The entries that pass the search and the filters. */
export function filterEntries(entries, { search = '', model = '', lora = '', character = '', recipe = '' } = {}) {
    const words = String(search).toLowerCase().split(/\s+/).filter(Boolean);
    return entries.filter(entry => {
        if (model && entry.model !== model) return false;
        if (lora && !entry.loras.includes(lora)) return false;
        if (character && !entry.characters.includes(character)) return false;
        if (recipe && entry.state !== recipe) return false;
        if (words.length === 0) return true;
        const haystack = `${entry.text ?? ''} ${entry.name.toLowerCase()}`;
        return words.every(word => haystack.includes(word));
    });
}

/** In time order: newest first, or oldest first. */
export function sortEntries(entries, sort = 'newest') {
    const when = entry => dateOf(entry).getTime();
    return [...entries].sort(sort === 'oldest' ? (a, b) => when(a) - when(b) : (a, b) => when(b) - when(a));
}

/** The grid's groups, one per day, in the order the entries come: [{ day, entries }]. */
export function groupByDay(entries) {
    const groups = [];
    for (const entry of entries) {
        const day = dayText(dateOf(entry));
        if (groups.at(-1)?.day !== day) groups.push({ day, entries: [] });
        groups.at(-1).entries.push(entry);
    }
    return groups;
}

function countText(count) {
    return `${count.toLocaleString()} ${text(count === 1 ? 'ui_viewer_image' : 'ui_viewer_images', count === 1 ? 'image' : 'images')}`;
}

/** The values a filter offers: [{ value, count }], most common first. */
export function filterOptions(entries, pick) {
    const counts = new Map();
    for (const entry of entries) for (const value of pick(entry)) if (value) counts.set(value, (counts.get(value) ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([value, count]) => ({ value, count }));
}

// ------------------------------------------------------------------ the window

function bridge() {
    return globalThis.inBrowser ? null : globalThis.api ?? null;
}

let library = null;

function createLibrary() {
    const shell = createDialogShell({ className: 'library-modal' });
    const prefs = { sort: 'newest', size: 'M', ...readPrefs() };
    const state = {
        roots: [],
        source: null,          // { view } | { root, folder }
        entries: [],
        all: null,             // every image, once read (the views)
        filters: { search: '', model: '', lora: '', character: '', recipe: '' },
        selected: '',
        thumbs: new Map(),
        detailToken: 0,
    };

    // header: the path and the count beside the title
    const path = element('nav', 'library-path');
    path.setAttribute('aria-label', text('library_path', 'Path'));
    const count = element('span', 'library-count');
    shell.heading.after(path, count);

    // toolbar
    const toolbar = element('div', 'library-toolbar');
    const searchLabel = element('label', 'library-search', text('library_search', 'Search'));
    const search = element('input');
    search.type = 'search';
    search.placeholder = text('library_search_hint', 'tag, character, LoRA, seed…');
    searchLabel.append(search);
    toolbar.append(searchLabel);
    const filterSelects = {};
    for (const [key, label] of [['model', text('viewer_model', 'Model')], ['lora', 'LoRA'], ['character', text('library_character', 'Character')], ['recipe', text('library_recipe', 'Recipe')]]) {
        const pill = element('label', 'library-filter');
        pill.append(element('span', 'library-filter-key', label));
        const select = element('select');
        select.addEventListener('change', () => {
            state.filters[key] = select.value;
            renderGrid();
        });
        pill.append(select);
        filterSelects[key] = select;
        toolbar.append(pill);
    }
    toolbar.append(element('span', 'library-spacer'));
    const sortSelect = element('select');
    for (const [value, label] of [['newest', text('library_sort_newest', 'Newest')], ['oldest', text('library_sort_oldest', 'Oldest')]]) sortSelect.append(new Option(label, value));
    sortSelect.value = prefs.sort === 'oldest' ? 'oldest' : 'newest';
    const sortLabel= element('label', 'library-option', text('library_sort', 'Sort'));
    sortLabel.append(sortSelect);
    const sizes = element('div', 'library-sizes');
    sizes.setAttribute('role', 'group');
    for (const size of Object.keys(TILE_SIZES)) {
        const button = element('button', 'library-size', size);
        button.type = 'button';
        button.dataset.size = size;
        button.setAttribute('aria-label', { S: 'Small tiles', M: 'Medium tiles', L: 'Large tiles' }[size]);
        button.addEventListener('click', () => {
            prefs.size = size;
            writePrefs(prefs);
            paintSizes();
        });
        sizes.append(button);
    }
    toolbar.append(sortLabel, sizes);
    sortSelect.addEventListener('change', () => { prefs.sort = sortSelect.value; writePrefs(prefs); renderGrid(); });
    let searchTimer = null;
    search.addEventListener('input', () => {
        clearTimeout(searchTimer);
        searchTimer = setTimeout(() => {
            state.filters.search = search.value;
            renderGrid();
        }, 150);
    });

    // body: rail | grid | detail
    const body = element('div', 'library-body');
    const rail = element('nav', 'library-rail');
    rail.setAttribute('aria-label', text('library_folders', 'Folders'));
    const gridArea = element('div', 'library-grid-area');
    const detail = element('aside', 'library-detail');
    detail.setAttribute('aria-label', text('library_selected', 'Selected image'));
    body.append(rail, gridArea, detail);
    shell.body.replaceChildren(toolbar, body);
    shell.footer.hidden = true;

    function paintSizes() {
        for (const button of sizes.querySelectorAll('.library-size')) {
            const on = button.dataset.size === prefs.size;
            button.classList.toggle('is-on', on);
            button.setAttribute('aria-pressed', String(on));
        }
        gridArea.style.setProperty('--library-tile', `${TILE_SIZES[prefs.size] ?? TILE_SIZES.M}px`);
    }
    paintSizes();

    // ---------------------------------------------------------------- rail

    const VIEWS = [
        ['session', text('library_view_session', 'This session')],
        ['favorites', `★ ${text('library_view_favorites', 'Favourites')}`],
        ['full', text('library_view_recipe', 'With SAA recipe')],
        ['partial', text('library_view_partial', 'Partial recipe')],
    ];

    function viewCount(view) {
        if (view === 'session') return (globalThis.mainGallery?.sessionPaths?.() ?? []).length;
        if (view === 'favorites') return state.favoriteCount ?? '';
        if (!state.all) return '';
        return state.all.filter(entry => entry.state === view).length;
    }

    function railButton(label, countValue, isOn, onClick, nested = false) {
        const button = element('button', `library-rail-item${nested ? ' is-nested' : ''}${isOn ? ' is-on' : ''}`);
        button.type = 'button';
        button.append(element('span', 'library-rail-label', label), element('span', 'library-rail-count', countValue));
        button.addEventListener('click', onClick);
        return button;
    }

    function sameSource(a, b) {
        return a && b && a.view === b.view && a.root === b.root && a.folder === b.folder;
    }

    function renderRail() {
        rail.replaceChildren(element('span', 'library-rail-head', text('library_views', 'VIEWS')));
        for (const [view, label] of VIEWS) {
            rail.append(railButton(label, viewCount(view), sameSource(state.source, { view }), () => select({ view })));
        }
        for (const root of state.roots) {
            rail.append(element('span', 'library-rail-head', root.id === 'comfy' ? text('library_comfy_output', 'COMFYUI OUTPUT') : text('library_pod_saves', 'POD SAVES')));
            for (const folder of root.folders) {
                const source = { root: root.id, folder: folder.id };
                rail.append(railButton(folder.label, folder.count, sameSource(state.source, source), () => select(source), true));
            }
        }
    }

    function sourceLabel() {
        const source = state.source;
        if (!source) return [];
        if (source.view) return [text('library_views_title', 'Views'), VIEWS.find(([view]) => view === source.view)?.[1] ?? source.view];
        const root = state.roots.find(candidate => candidate.id === source.root);
        const folder = root?.folders.find(candidate => candidate.id === source.folder);
        return [root?.label ?? source.root, folder?.label ?? source.folder];
    }

    // ---------------------------------------------------------------- loading

    async function readAll() {
        if (state.all) return state.all;
        const api = bridge();
        state.all = api ? await api.libraryImages({ view: 'all' }) : [];
        renderRail();
        return state.all;
    }

    async function select(source) {
        state.source = source;
        state.selected = '';
        renderRail();
        renderPath();
        gridArea.replaceChildren(element('div', 'library-empty', '…'));
        renderDetail(null);
        const api = bridge();
        let entries = [];
        if (!api) entries = [];
        else if (source.view === 'session') entries = await api.libraryImages({ paths: globalThis.mainGallery?.sessionPaths?.() ?? [] });
        else if (source.view === 'favorites') entries = await api.libraryImages({ view: 'favorites' });
        else if (source.view === 'full' || source.view === 'partial') entries = (await readAll()).filter(entry => entry.state === source.view);
        else entries = await api.libraryImages({ root: source.root, folder: source.folder });
        if (!sameSource(state.source, source)) return;   // another folder was picked meanwhile
        state.entries = entries;
        fillFilters();
        renderGrid();
    }

    function fillFilters() {
        const fill = (key, options, anyLabel) => {
            const select = filterSelects[key];
            const keep = state.filters[key];
            select.replaceChildren(new Option(anyLabel, ''));
            for (const option of options) select.append(new Option(`${option.label ?? option.value} (${option.count})`, option.value));
            select.value = options.some(option => option.value === keep) ? keep : '';
            state.filters[key] = select.value;
        };
        const any = text('library_any', 'Any');
        fill('model', filterOptions(state.entries, entry => [entry.model]), any);
        fill('lora', filterOptions(state.entries, entry => entry.loras), any);
        fill('character', filterOptions(state.entries, entry => entry.characters), any);
        const recipeLabels = { full: text('library_view_recipe', 'With SAA recipe'), partial: text('viewer_partial_recipe', 'partial recipe'), none: text('library_no_recipe', 'No recipe') };
        fill('recipe', filterOptions(state.entries, entry => [entry.state]).map(option => ({ ...option, label: recipeLabels[option.value] ?? option.value })), any);
    }

    function renderPath() {
        path.replaceChildren();
        sourceLabel().forEach((part, index) => {
            if (index > 0) path.append(element('span', 'library-path-sep', '›'));
            path.append(element('span', index === 0 ? 'library-path-root' : 'library-path-leaf', part));
        });
    }

    // ---------------------------------------------------------------- grid

    let observer = null;
    let pending = new Set();
    let thumbTimer = null;

    function requestThumbs() {
        thumbTimer = null;
        const api = bridge();
        const batch = [...pending].slice(0, 24);
        for (const file of batch) pending.delete(file);
        if (!api || batch.length === 0) return;
        api.libraryThumbs(batch).then(result => {
            for (const [file, dataUrl] of Object.entries(result ?? {})) {
                state.thumbs.set(file, dataUrl);
                for (const image of gridArea.querySelectorAll('.library-tile-image')) if (image.dataset.path === file && dataUrl) image.src = dataUrl;
            }
            if (pending.size > 0) requestThumbs();
        }).catch(error => console.warn('[Library] thumbnails failed:', error?.message ?? error));
    }

    function wantThumb(file) {
        pending.add(file);
        if (!thumbTimer) thumbTimer = setTimeout(requestThumbs, 30);
    }

    function tile(entry) {
        const button = element('button', `library-tile${entry.path === state.selected ? ' is-selected' : ''}`);
        button.type = 'button';
        button.dataset.path = entry.path;
        button.setAttribute('aria-label', entry.name);
        const frame = element('span', 'library-tile-frame');
        if (Number.isFinite(entry.width) && Number.isFinite(entry.height) && entry.height > 0) frame.style.aspectRatio = `${entry.width} / ${entry.height}`;
        const image = element('img', 'library-tile-image');
        image.alt = '';
        image.dataset.path = entry.path;
        const known = state.thumbs.get(entry.path);
        if (known) image.src = known;
        frame.append(image);
        if (isFavorite(entry.path)) frame.append(element('span', 'library-tile-star', '★'));
        if (entry.state === 'partial') frame.append(element('span', 'library-tile-badge', text('viewer_partial_recipe', 'partial recipe')));
        button.append(frame);
        const meta = element('span', 'library-tile-meta');
        meta.append(element('span', '', Number.isFinite(entry.seed) ? `#${String(entry.seed).slice(-4)}` : ''), element('span', '', Number.isFinite(entry.time) ? formatDuration(entry.time) : '—'));
        button.append(meta);
        button.addEventListener('click', () => choose(entry.path));
        if (!known) observer?.observe(button);
        return button;
    }

    function renderGrid() {
        observer?.disconnect();
        pending = new Set();
        observer = typeof IntersectionObserver === 'function' ? new IntersectionObserver(items => {
            for (const item of items) {
                if (!item.isIntersecting) continue;
                observer.unobserve(item.target);
                wantThumb(item.target.dataset.path);
            }
        }, { root: gridArea, rootMargin: '400px 0px' }) : null;
        const shown = sortEntries(filterEntries(state.entries, state.filters), prefs.sort);
        count.textContent = countText(shown.length);
        gridArea.replaceChildren();
        if (shown.length === 0) {
            gridArea.append(element('div', 'library-empty', state.entries.length ? text('library_no_match', 'No image matches') : text('library_no_images', 'No images here')));
            return;
        }
        for (const group of groupByDay(shown)) {
            const section = element('section', 'library-group');
            const head = element('div', 'library-group-head');
            head.append(element('span', 'library-group-time', group.day), element('span', 'library-group-summary', countText(group.entries.length)), element('span', 'library-group-rule'));
            section.append(head);
            const grid = element('div', 'library-grid');
            for (const entry of group.entries) grid.append(tile(entry));
            section.append(grid);
            gridArea.append(section);
        }
        if (!shown.some(entry => entry.path === state.selected)) choose(shown[0].path);
    }

    function paintSelection() {
        for (const button of gridArea.querySelectorAll('.library-tile')) button.classList.toggle('is-selected', button.dataset.path === state.selected);
    }

    function paintStars() {
        for (const button of gridArea.querySelectorAll('.library-tile')) {
            const frame = button.querySelector('.library-tile-frame');
            const star = frame.querySelector('.library-tile-star');
            const on = isFavorite(button.dataset.path);
            if (on && !star) frame.append(element('span', 'library-tile-star', '★'));
            if (!on) star?.remove();
        }
        detail.querySelector('.library-detail-star')?.classList.toggle('is-on', isFavorite(state.selected));
    }

    // ---------------------------------------------------------------- detail

    async function choose(file) {
        state.selected = file;
        paintSelection();
        const entry = state.entries.find(candidate => candidate.path === file);
        renderDetail(entry ?? null);
        const token = ++state.detailToken;
        const image = await bridge()?.libraryImage?.(file).catch(() => null);
        if (token !== state.detailToken || !entry) return;
        renderDetail(entry, image);
    }

    function renderDetail(entry, image = null) {
        detail.replaceChildren();
        if (!entry) return;
        const records = image?.records ?? {};
        const summary = summarizeImage({ ...records, path: entry.path, seed: entry.seed });
        const head = element('div', 'library-detail-head');
        const title = element('h3', 'library-detail-name', entry.name);
        title.title = entry.path;
        const star = element('button', `library-detail-star${isFavorite(entry.path) ? ' is-on' : ''}`, '★');
        star.type = 'button';
        star.setAttribute('aria-label', text('viewer_favourite', 'Favourite'));
        star.addEventListener('click', () => setFavorite(entry.path, !isFavorite(entry.path)));
        const date = dateOf(entry);
        head.append(title, star, element('span', 'library-detail-when', `${dayText(date)} ${timeText(date)}`));
        detail.append(head);
        const preview = element('img', 'library-detail-preview');
        preview.alt = '';
        preview.src = image?.dataUrl || state.thumbs.get(entry.path) || '';
        detail.append(preview);

        const list = element('dl', 'library-detail-list');
        const row = (label, value) => {
            list.append(element('dt', '', label));
            const dd = element('dd', '');
            if (value && typeof value === 'object') dd.append(value);
            else dd.textContent = value;
            list.append(dd);
        };
        const model = summary.model || entry.model;
        if (model) row(text('viewer_model', 'Model'), summary.type ? `${model} · ${summary.type}` : model);
        if (summary.sampler) row(text('viewer_sampler', 'Sampler'), [summary.sampler, summary.scheduler, Number.isFinite(summary.steps) ? `${summary.steps}` : '', Number.isFinite(summary.cfg) ? `CFG ${number(summary.cfg)}` : ''].filter(Boolean).join(' · '));
        if (Number.isFinite(summary.seed)) {
            const seed = element('span', 'viewer-recipe-seed');
            const put = element('button', 'viewer-seed-button');
            put.type = 'button';
            const label = text('viewer_seed_to_field', 'Put this seed in the Seed field');
            put.setAttribute('aria-label', label);
            put.title = label;
            put.innerHTML = '<svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M7 2.5h3v7H7M1.5 6h6M5 3.5L7.5 6 5 8.5"></path></svg>';
            put.addEventListener('click', () => globalThis.generate?.seed?.setValue?.(summary.seed));
            seed.append(put, document.createTextNode(String(summary.seed)));
            row(text('viewer_seed', 'Seed'), seed);
        }
        row(text('library_time', 'Time'), summary.time ? formatDuration(summary.time.total) : '—');
        if (summary.characters.length) row(text('library_characters', 'Characters'), summary.characters.join(', '));
        detail.append(list);
        if (summary.loras.length) {
            const loras = element('div', 'library-detail-loras');
            loras.append(element('span', 'viewer-info-label', 'LoRA'));
            const chips = element('div', 'viewer-lora-chips');
            for (const lora of summary.loras) {
                const chip = element('span', 'viewer-lora-chip', lora.name);
                chip.title = lora.file;
                chip.append(element('span', 'viewer-lora-weight', lora.fast ? `${number(lora.weight)} · Fast` : number(lora.weight)));
                chips.append(chip);
            }
            loras.append(chips);
            detail.append(loras);
        }

        const actions = element('div', 'library-detail-actions');
        if (summary.state !== 'none' && image) {
            const use = element('button', 'viewer-primary-button', text('viewer_use_settings', 'Use settings…'));
            use.type = 'button';
            use.addEventListener('click', async () => {
                const loaded = await openUseSettings({ recipe: records.recipe, parameters: records.parameters, image: image.dataUrl, name: entry.name, trigger: use });
                if (loaded) close();
            });
            actions.append(use);
        }
        const pair = element('div', 'library-detail-pair');
        const reveal = element('button', 'library-button', text('viewer_show_in_folder', 'Show in folder'));
        reveal.type = 'button';
        reveal.addEventListener('click', () => showInFolder(entry.path));
        const trash = element('button', 'library-button is-danger', text('library_trash', 'Move to trash'));
        trash.type = 'button';
        trash.addEventListener('click', () => moveToTrash(entry));
        pair.append(reveal, trash);
        actions.append(pair);
        detail.append(actions);
    }

    async function moveToTrash(entry) {
        const yes = await showDialog('confirm', {
            message: text('library_trash_confirm', 'Move {0} to the trash?').replace('{0}', entry.name),
            yesText: text('library_trash', 'Move to trash'),
            noText: text('setup_cancel', 'Cancel'),
        });
        if (!yes) return;
        if (!await bridge()?.libraryTrash?.(entry.path)) return;
        const at = state.entries.findIndex(candidate => candidate.path === entry.path);
        state.entries = state.entries.filter(candidate => candidate.path !== entry.path);
        if (state.all) state.all = state.all.filter(candidate => candidate.path !== entry.path);
        for (const root of state.roots) {
            const folder = root.folders.find(candidate => candidate.id === state.source?.folder && root.id === state.source?.root);
            if (folder) folder.count = Math.max(0, folder.count - 1);
        }
        state.selected = state.entries[Math.min(at, state.entries.length - 1)]?.path ?? '';
        renderRail();
        renderGrid();
    }

    document.addEventListener(FAVORITES_CHANGED_EVENT, () => {
        if (!shell.isOpen()) return;
        state.favoriteCount = undefined;
        paintStars();
        bridge()?.libraryFavorites?.().then(list => { state.favoriteCount = list.length; renderRail(); });
    });

    // ---------------------------------------------------------------- open / close

    async function open({ trigger = null } = {}) {
        shell.open({ trigger, title: text('viewer_library', 'Library'), initialFocus: () => search });
        await loadFavorites();
        const api = bridge();
        state.roots = api ? await api.libraryRoots().catch(() => []) : [];
        state.all = null;
        state.favoriteCount = (await api?.libraryFavorites?.().catch(() => []) ?? []).length;
        const first = state.roots[0]?.folders?.[0];
        const keep = state.source && (state.source.view || state.roots.some(root => root.id === state.source.root && root.folders.some(folder => folder.id === state.source.folder)));
        await select(keep ? state.source : first ? { root: state.roots[0].id, folder: first.id } : { view: 'session' });
        // the views' counts need every image read once; the folders do not wait for it
        readAll().catch(error => console.warn('[Library] reading every image failed:', error?.message ?? error));
    }

    function close() {
        shell.close({ apply: false });
    }

    return { open, close, isOpen: () => shell.isOpen(), state };
}

/** The Library window, made on first use. */
export function openLibrary(options) {
    library ??= createLibrary();
    return library.open(options);
}

export function setupLibrary() {
    const button = document.getElementById('viewer-library-open');
    if (!button) return;
    if (globalThis.inBrowser) {
        button.hidden = true;
        return;
    }
    button.addEventListener('click', () => openLibrary({ trigger: button }));
}
