// The Artist card (Diffusion only): up to three slots, each holding one Danbooru artist
// tag, picked from a search modal. The card is built like the character slots — trigger
// button, weight box, +/− — and reuses their CSS, so only the artist-specific bits live
// here: the "@" spelling, the profile panel beside the list, and the search itself.
//
// One search box covers both ways in: the typed word is matched against artist names and
// against the tags a profile says the artist draws, and the panel lights up the tag that
// answered the query (scripts/shared/artistSearch.js does the ranking in the backend).
import { createSelectionModal } from './selectionModal.js';
import { normalizeSelectionKey } from './selectionModalLogic.js';
import { searchArtists, clearArtistSearchCache } from '../artistClient.js';
import { MAX_ARTIST_SLOTS, normalizeArtistSlots } from '../../shared/artistSlots.js';
import { matchRange } from '../../shared/artistSearch.js';

const RECENT_LIMIT = 8;
// Per group, not per list: a common word matches hundreds of names, and without its own
// budget the "what they draw" group would fall off the end of the list every time.
const GROUP_LIMIT = 24;
const OPTION_LIMIT = GROUP_LIMIT * 3;

function lang() {
    return globalThis.cachedFiles?.language?.[globalThis.globalSettings?.language] ?? {};
}

function uiText(key, fallback) {
    const value = lang()[key];
    return typeof value === 'string' && value ? value : fallback;
}

// Danbooru spelling → what the user reads: spaces, and the "@" the model wants.
export function artistDisplayName(key) {
    const name = String(key ?? '').trim();
    return name ? `@${name.replaceAll('_', ' ')}` : '';
}

function favoriteList() {
    return Array.isArray(globalThis.globalSettings?.fav_artists) ? globalThis.globalSettings.fav_artists : [];
}

function recentList() {
    return Array.isArray(globalThis.globalSettings?.artist_recent) ? globalThis.globalSettings.artist_recent : [];
}

function rememberRecent(key) {
    const name = String(key ?? '').trim();
    if (!name) return;
    const rest = recentList().filter(item => String(item ?? '').trim().toLowerCase() !== name.toLowerCase());
    globalThis.globalSettings.artist_recent = [name, ...rest].slice(0, RECENT_LIMIT);
}

function toggleFavorite(key) {
    const name = String(key ?? '').trim();
    if (!name) return;
    const list = favoriteList();
    const stored = list.find(item => normalizeSelectionKey(item) === normalizeSelectionKey(name));
    globalThis.globalSettings.fav_artists = stored === undefined
        ? [...list, name].sort((a, b) => String(a).localeCompare(String(b), undefined, { sensitivity: 'base' }))
        : list.filter(item => item !== stored);
    clearArtistSearchCache();
}

function artistFavoritesConfig() {
    return {
        isFavorite: key => favoriteList().some(item => normalizeSelectionKey(item) === key),
        toggle: option => toggleFavorite(option?.key ?? option?.value),
    };
}

// One search result → an option the shared modal understands. The draw tags ride along in
// `keywords` so the modal's own filtering keeps an artist matched by what they draw, whose
// name does not contain the query at all.
function artistOption(entry, group) {
    const drawTags = (entry.draws ?? []).map(draw => draw.tag);
    const seriesTags = (entry.series ?? []).map(item => item.tag);
    return {
        key: entry.key,
        value: entry.key,
        category: group === 'tag' ? uiText('artist_match_draws', 'draws') : '',
        label: artistDisplayName(entry.key),
        description: () => (entry.matchedTags?.length
            ? entry.matchedTags.map(tag => tag.tag.replaceAll('_', ' ')).join(' · ')
            : drawTags.slice(0, 3).map(tag => tag.replaceAll('_', ' ')).join(' · ')),
        keywords: [entry.key, ...(entry.aliases ?? []), ...drawTags, ...seriesTags],
        artist: entry,
    };
}

function groupOptions(groups) {
    const options = [];
    for (const group of groups ?? []) {
        for (const entry of group.entries ?? []) options.push(artistOption(entry, group.group));
    }
    return options;
}

// The panel beside the list: who the artist is, what they draw, what they draw it in.
function createProfilePanel() {
    const panel = document.createElement('div');
    panel.className = 'artist-profile-panel';
    panel.hidden = true;

    const title = document.createElement('div');
    title.className = 'artist-profile-title';
    const posts = document.createElement('span');
    posts.className = 'artist-profile-posts';
    const head = document.createElement('div');
    head.className = 'artist-profile-head';
    head.append(title, posts);

    const drawsLabel = document.createElement('div');
    drawsLabel.className = 'artist-profile-section';
    const draws = document.createElement('div');
    draws.className = 'artist-profile-tags';
    const seriesLabel = document.createElement('div');
    seriesLabel.className = 'artist-profile-section';
    const series = document.createElement('div');
    series.className = 'artist-profile-series';
    const empty = document.createElement('div');
    empty.className = 'artist-profile-empty';

    panel.append(head, drawsLabel, draws, seriesLabel, series, empty);

    // The query is highlighted inside a tag, so a tag search shows why the artist is here.
    const tagChip = (tag, percent, query) => {
        const chip = document.createElement('span');
        chip.className = 'artist-profile-tag';
        const text = tag.replaceAll('_', ' ');
        const range = matchRange(text, query);
        if (range) {
            chip.classList.add('is-match');
            chip.append(
                document.createTextNode(text.slice(0, range.start)),
                Object.assign(document.createElement('mark'), { textContent: text.slice(range.start, range.start + range.length) }),
                document.createTextNode(text.slice(range.start + range.length)),
            );
        } else {
            chip.textContent = text;
        }
        const value = document.createElement('span');
        value.className = 'artist-profile-percent';
        value.textContent = `${percent}%`;
        chip.appendChild(value);
        return chip;
    };

    const seriesRow = (tag, percent, max) => {
        const row = document.createElement('div');
        row.className = 'artist-profile-series-row';
        const name = document.createElement('span');
        name.className = 'artist-profile-series-name';
        name.textContent = tag.replaceAll('_', ' ');
        const bar = document.createElement('span');
        bar.className = 'artist-profile-bar';
        const fill = document.createElement('i');
        fill.style.width = `${Math.max(4, Math.round((percent / Math.max(max, 1)) * 100))}%`;
        bar.appendChild(fill);
        const value = document.createElement('span');
        value.className = 'artist-profile-percent';
        value.textContent = `${percent}%`;
        row.append(name, bar, value);
        return row;
    };

    return {
        element: panel,
        clear() {
            panel.hidden = true;
        },
        show(entry, query) {
            if (!entry) {
                panel.hidden = true;
                return;
            }
            panel.hidden = false;
            title.textContent = artistDisplayName(entry.key);
            posts.textContent = entry.posts ? uiText('artist_profile_posts', '{0} posts').replace('{0}', entry.posts) : '';
            drawsLabel.textContent = uiText('artist_profile_draws', 'Draws');
            seriesLabel.textContent = uiText('artist_profile_series', 'Series');
            draws.replaceChildren(...(entry.draws ?? []).map(draw => tagChip(draw.tag, draw.percent, query)));
            const max = Math.max(...(entry.series ?? []).map(item => item.percent), 1);
            series.replaceChildren(...(entry.series ?? []).map(item => seriesRow(item.tag, item.percent, max)));
            const known = (entry.draws?.length ?? 0) > 0 || (entry.series?.length ?? 0) > 0;
            drawsLabel.hidden = !known;
            seriesLabel.hidden = (entry.series?.length ?? 0) === 0;
            empty.textContent = known ? '' : uiText('artist_profile_none', 'No profile for this artist');
            empty.hidden = known;
        },
    };
}

/**
 * The Artist card's slot control.
 *
 * `callback(index, key, weight)` fires whenever a slot changes, the same contract the
 * character slots use, so the caller can persist and refresh the prompt preview.
 */
export function myArtistList(containerId, callback, options = {}) {
    const { maxSlots = MAX_ARTIST_SLOTS, minSlots = 1 } = options;
    const container = document.getElementById(containerId);
    if (!container) return null;

    let slots = normalizeArtistSlots(globalThis.globalSettings?.artist_slots);
    let activeIndex = 0;
    let lastQuery = '';
    const triggers = [];
    const weights = [];

    const profile = createProfilePanel();
    const modal = createSelectionModal({
        mode: 'single',
        optionLimit: OPTION_LIMIT,
        emptyMessage: uiText('artist_search_empty', 'No artist matches that name or tag.'),
        searchPrompt: uiText('artist_search_prompt', 'Type a name, or a tag the artist is known for.'),
        onOpen: () => { profile.clear(); },
        onClose: () => { profile.clear(); },
        onOptionHover: option => profile.show(option?.artist, lastQuery),
        onActiveOption: option => profile.show(option?.artist, lastQuery),
        onApply: selected => {
            const key = String(selected?.[0]?.key ?? '').trim();
            setSlot(activeIndex, key);
            if (key) rememberRecent(key);
        },
    });
    // the dialog stacks its parts; the list and the profile panel share one row instead
    modal.element.querySelector('.selection-modal-dialog')?.classList.add('artist-selection-dialog');
    const listbox = modal.element.querySelector('.selection-modal-list');
    if (listbox) {
        const body = document.createElement('div');
        body.className = 'artist-selection-body';
        listbox.replaceWith(body);
        body.append(listbox, profile.element);
    }

    function setSlot(index, key) {
        if (!slots[index]) return;
        slots[index] = { ...slots[index], key };
        render();
        persist();
        callback?.(index, key, slots[index].weight);
    }

    function setWeight(index, value) {
        if (!slots[index]) return;
        const weight = Number.parseFloat(value);
        slots[index] = { ...slots[index], weight: Number.isFinite(weight) && weight > 0 ? weight : 1 };
        persist();
        callback?.(index, slots[index].key, slots[index].weight);
    }

    function persist() {
        if (globalThis.globalSettings) globalThis.globalSettings.artist_slots = getSlots();
    }

    async function loadOptions({ query }) {
        lastQuery = String(query ?? '').trim();
        const groups = await searchArtists(lastQuery, {
            favorites: favoriteList(),
            recent: recentList(),
            limit: GROUP_LIMIT,
        });
        return groupOptions(groups);
    }

    function openPicker(index) {
        activeIndex = index;
        const key = slots[index]?.key ?? '';
        const selection = key ? [{ key, value: key, label: artistDisplayName(key) }] : [];
        modal.open({
            trigger: triggers[index],
            fallback: triggers[index],
            selection,
            options: [],
            modalTitle: uiText('artist_slot_n', 'Artist {0}').replace('{0}', index + 1),
            dynamicLoadOptions: loadOptions,
            favorites: artistFavoritesConfig(),
        });
    }

    function render() {
        container.replaceChildren();
        triggers.length = 0;
        weights.length = 0;
        const grid = document.createElement('div');
        grid.className = 'character-selection-grid artist-selection-grid';

        slots.forEach((slot, index) => {
            const field = document.createElement('div');
            field.className = 'character-selection-field';
            field.dataset.index = String(index);

            const label = document.createElement('label');
            label.className = 'character-selection-label';
            label.textContent = uiText('artist_slot_n', 'Artist {0}').replace('{0}', index + 1);

            const controls = document.createElement('div');
            controls.className = 'character-selection-controls artist-selection-controls';

            const trigger = document.createElement('button');
            trigger.type = 'button';
            trigger.className = 'character-selection-trigger artist-selection-trigger';
            trigger.setAttribute('aria-haspopup', 'dialog');
            trigger.textContent = slot.key ? artistDisplayName(slot.key) : uiText('artist_slot_empty', 'None');
            trigger.classList.toggle('is-empty', !slot.key);
            trigger.addEventListener('click', () => openPicker(index));

            const weight = document.createElement('input');
            weight.type = 'text';
            weight.className = 'character-selection-weight';
            weight.inputMode = 'decimal';
            weight.value = Number(slot.weight ?? 1).toFixed(2);
            weight.addEventListener('change', () => setWeight(index, weight.value));
            weight.addEventListener('blur', () => { weight.value = Number(slots[index]?.weight ?? 1).toFixed(2); });

            controls.append(trigger, weight);
            field.append(label, controls);
            grid.appendChild(field);
            triggers.push(trigger);
            weights.push(weight);
        });

        container.appendChild(grid);

        const row = document.createElement('div');
        row.className = 'character-slot-buttons';
        const add = document.createElement('button');
        add.type = 'button';
        add.className = 'character-slot-button';
        add.textContent = '+';
        add.disabled = slots.length >= maxSlots;
        add.addEventListener('click', () => setSlotCount(slots.length + 1));
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'character-slot-button';
        remove.textContent = '−';
        remove.disabled = slots.length <= minSlots;
        remove.addEventListener('click', () => setSlotCount(slots.length - 1));
        row.append(add, remove);
        container.appendChild(row);
    }

    function setSlotCount(next) {
        const count = Math.min(Math.max(next, minSlots), maxSlots);
        if (count === slots.length) return;
        slots = count > slots.length
            ? [...slots, ...Array.from({ length: count - slots.length }, () => ({ key: '', weight: 1 }))]
            : slots.slice(0, count);
        render();
        persist();
        callback?.(-1, '', 1);
    }

    function getSlots() {
        return slots.map(slot => ({ key: slot.key, weight: slot.weight }));
    }

    render();

    const api = {
        getSlots,
        getSlotCount: () => slots.length,
        setSlots(next) {
            slots = normalizeArtistSlots(next);
            render();
        },
        updateLanguage() {
            render();
        },
        cleanup() {
            modal.destroy?.();
            container.replaceChildren();
        },
    };
    container.__artistSelectionControl = api;
    return api;
}
