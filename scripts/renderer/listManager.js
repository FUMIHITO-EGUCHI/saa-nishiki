// List manager modal (R3 UI): browse the bundled lists, add / override / hide
// entries through the user-diff layer (scripts/shared/userLists.js), set thumbs
// for character entries, export / import the diff file.
//
// Electron-only for now: the management IPC is not exposed over the web-service
// socket, so the trigger button stays hidden in browser mode.

import { openTagPicker } from './tagSelectionModal.js';
import { PARTS_CHANGED_EVENT, applyPartsChange, importPartsDefaults, partList, partsAvailable } from './partsClient.js';
import { sampleTile } from './partsUi.js';
import { PART_CATEGORIES, pickSample, sampleModelLabels } from '../shared/parts.js';

const CAT = '[ListManager]';
const ROW_LIMIT = 200;

const LISTS = [
    { id: 'character', kind: 'keyed', langKey: 'ui_lists_tab_character', fallback: 'Characters' },
    { id: 'oc', kind: 'keyed', langKey: 'ui_lists_tab_oc', fallback: 'Original characters' },
    { id: 'view_angle', kind: 'value', langKey: 'ui_lists_tab_angle', fallback: 'Angle' },
    { id: 'view_camera', kind: 'value', langKey: 'ui_lists_tab_camera', fallback: 'Camera' },
    // Parts (partsUi.js): their own store, not the user-diff layer
    { id: 'part', kind: 'part', langKey: 'ui_lists_tab_parts', fallback: 'Parts' },
];

function lang() {
    return globalThis.cachedFiles?.language?.[globalThis.globalSettings?.language] ?? {};
}

function text(key, fallback) {
    const value = lang()[key];
    return typeof value === 'string' && value ? value : fallback;
}

function el(tag, className, textContent) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (textContent !== undefined) element.textContent = textContent;
    return element;
}

// Current merged rows of one list: [{ name, tag, meta }] (meta from cachedFiles.userListMeta).
function listRows(listId) {
    const FILES = globalThis.cachedFiles ?? {};
    const meta = FILES.userListMeta?.[listId] ?? {};
    if (listId === 'character' || listId === 'oc') {
        const base = listId === 'character' ? FILES.characterList : FILES.ocList;
        const names = new Set([...Object.keys(base ?? {}), ...Object.keys(meta)]);
        return [...names].map(name => ({
            name,
            tag: base?.[name] ?? '',
            meta: meta[name] ?? { source: listId === 'character' ? 'csv' : 'original', overridden: false, hidden: false },
        }));
    }
    const key = listId === 'view_angle' ? 'angle' : 'camera';
    const values = FILES.viewTags?.[key] ?? [];
    const valueByKey = new Map(values.map(item => typeof item === 'string' ? [item, item] : [item.key, item.value]));
    const names = new Set([...valueByKey.keys(), ...Object.keys(meta)]);
    return [...names].map(name => {
        const value = valueByKey.get(name) ?? '';
        return {
            name,
            // only show a preview when the label stands for something else
            tag: value !== name ? value : '',
            meta: meta[name] ?? { source: 'view', overridden: false, hidden: false },
        };
    });
}

// Push the refreshed merged lists from an apply/import payload into the renderer caches
// and rebuild every dropdown that shows them.
async function applyPayload(payload) {
    const FILES = globalThis.cachedFiles;
    if (!payload || !FILES) return;
    FILES.characterList = payload.characters;
    FILES.ocList = payload.ocCharacters;
    FILES.viewTags = payload.viewTags;
    FILES.userListMeta = payload.userListMeta;
    FILES.characterListArray = Object.entries(payload.characters);
    FILES.ocListArray = Object.entries(payload.ocCharacters);

    // Register user thumbs under the md5 of the merged tag (mirrors the main process).
    for (const [name, meta] of Object.entries(payload.userListMeta?.character ?? {})) {
        if (!meta.thumb || meta.hidden) continue;
        const tag = payload.characters[name];
        if (typeof tag !== 'string') continue;
        const escaped = tag.replaceAll('\\', '\\\\').replaceAll('(', String.raw`\(`).replaceAll(')', String.raw`\)`);
        const md5 = await globalThis.api.md5Hash(escaped);
        if (md5) FILES.characterThumb[md5] = meta.thumb;
    }

    const LANG = lang();
    try {
        const characterLabels = [LANG.character1, LANG.character2, LANG.character3];
        globalThis.characterList?.setOptions?.(
            [Object.keys(payload.characters), Object.values(payload.characters)],
            Object.keys(payload.ocCharacters), characterLabels);
        const regionalLabels = [LANG.regional_character_left, LANG.regional_character_right];
        globalThis.characterListRegional?.setOptions?.(
            [Object.keys(payload.characters), Object.values(payload.characters)],
            Object.keys(payload.ocCharacters), regionalLabels);
        const viewLabels = `${LANG.view_angle}, ${LANG.view_camera}`;
        const SETTINGS = globalThis.globalSettings ?? {};
        globalThis.viewList?.setOptions?.(payload.viewTags, null, viewLabels,
            SETTINGS.view_angle ?? 'None', SETTINGS.view_camera ?? 'None', false);
    } catch (error) {
        console.error(CAT, 'dropdown refresh failed:', error);
    }
}

export function setupListManager() {
    if (globalThis.inBrowser || typeof globalThis.api?.getUserLists !== 'function') return null;

    const overlay = el('div', 'list-manager-overlay');
    overlay.hidden = true;
    const modal = el('div', 'list-manager-modal');
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    overlay.append(modal);
    document.body.append(overlay);

    const state = { list: 'character', search: '', editing: null };

    function close() {
        overlay.hidden = true;
    }

    function open(listId) {
        if (listId && LISTS.some(list => list.id === listId)) state.list = listId;
        state.search = '';
        state.editing = null;
        overlay.hidden = false;
        render();
    }

    overlay.addEventListener('click', event => { if (event.target === overlay) close(); });
    document.addEventListener('keydown', event => { if (!overlay.hidden && event.key === 'Escape') close(); });
    document.addEventListener(PARTS_CHANGED_EVENT, () => { if (!overlay.hidden && state.list === 'part') render(); });

    // ---- the Parts tab: rows from the parts store, edited through the parts editor ----
    function renderPartsTab(body) {
        const toolbar = el('div', 'list-manager-toolbar');
        const tabs = el('div', 'parts-tabs');
        const all = partList();
        const tab = (category, label) => {
            const button = el('button', `parts-tab${(state.partCategory ?? '') === category ? ' is-active' : ''}`, label);
            button.type = 'button';
            button.addEventListener('click', () => { state.partCategory = category; render(); });
            return button;
        };
        tabs.append(tab('', `${text('parts_category_all', 'All')} ${all.length}`));
        for (const category of PART_CATEGORIES) {
            const count = all.filter(entry => entry.category === category).length;
            tabs.append(tab(category, `${text(`parts_category_${category}`, category)} ${count}`));
        }
        toolbar.append(tabs);
        const search = el('input', 'list-manager-search');
        search.placeholder = text('ui_lists_search', 'Search…');
        search.value = state.search;
        search.addEventListener('input', () => { state.search = search.value; render(); if (state.list === 'part') modal.querySelector('.list-manager-search')?.focus(); });
        toolbar.append(search);
        const add = el('button', 'list-manager-button is-primary', text('parts_new', '+ New part'));
        add.type = 'button';
        add.addEventListener('click', () => globalThis.partsUi?.openEditor({ trigger: add }));
        toolbar.append(add);
        const modelType = globalThis.globalSettings?.api_model_type === 'Diffusion' ? 'Diffusion' : 'Checkpoint';
        const lacking = all.filter(entry => { const sample = pickSample(entry, modelType); return !sample || sample.foreign; }).length;
        const missing = el('button', 'list-manager-button', text('parts_generate_missing', 'Generate missing ({0})').replace('{0}', String(lacking)));
        missing.type = 'button';
        missing.disabled = lacking === 0 || globalThis.generate?.api_interface?.getValue?.() !== 'ComfyUI';
        missing.addEventListener('click', () => globalThis.partsUi?.generateMissing());
        toolbar.append(missing);
        // the bundled starter set, for a store that was emptied or an update that added names
        const starter = el('button', 'list-manager-button parts-starter-button', text('parts_import_defaults', 'Add starter set'));
        starter.type = 'button';
        starter.addEventListener('click', async () => {
            starter.disabled = true;
            const result = await importPartsDefaults();
            state.partsNote = result.ok
                ? text('parts_import_defaults_result', 'Starter set: {0} added, {1} already there').replace('{0}', String(result.added)).replace('{1}', String(result.skipped))
                : text('parts_import_defaults_failed', 'The starter set could not be read');
            render();
        });
        toolbar.append(starter);
        body.append(toolbar);
        if (state.partsNote) body.append(el('div', 'parts-lists-note parts-starter-note', state.partsNote));

        const needle = state.search.trim().toLowerCase();
        const rows = partList(state.partCategory ?? '')
            .filter(entry => !needle || entry.name.toLowerCase().includes(needle) || entry.tags.toLowerCase().includes(needle))
            .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
        body.append(el('div', 'list-manager-count', `${rows.length} parts`));
        const container = el('div', 'list-manager-rows');
        for (const entry of rows) {
            const row = el('div', 'parts-lists-row');
            row.append(sampleTile(entry.id, { className: 'parts-tile-image parts-lists-thumb', empty: '—' }));
            const name = el('span', 'parts-lists-name');
            name.append(el('span', 'parts-prefix', 'parts:'), document.createTextNode(entry.name));
            name.title = entry.name;
            row.append(name);
            const category = el('select', 'parts-category-select');
            category.setAttribute('aria-label', `${text('parts_category', 'Category')}: ${entry.name}`);
            for (const value of PART_CATEGORIES) {
                const option = el('option', '', text(`parts_category_${value}`, value));
                option.value = value;
                category.append(option);
            }
            category.value = entry.category;
            category.addEventListener('change', () => applyPartsChange({ action: 'set', id: entry.id, entry: { name: entry.name, category: category.value, tags: entry.tags } }));
            row.append(category);
            const tags = el('span', 'parts-lists-tags', entry.tags);
            tags.title = entry.tags;
            row.append(tags);
            const labels = sampleModelLabels(entry);
            const samples = el('button', 'list-manager-button parts-lists-samples', entry.samples.length ? `${entry.samples.length} · ${labels.join(' / ')}` : text('parts_no_sample', 'No sample'));
            samples.type = 'button';
            samples.addEventListener('click', () => globalThis.partsUi?.openHistory(entry.id));
            row.append(samples);
            const actions = el('span', 'parts-lists-actions');
            const edit = el('button', 'list-manager-button', text('ui_lists_action_edit', 'Edit'));
            edit.type = 'button';
            edit.addEventListener('click', () => globalThis.partsUi?.openEditor({ id: entry.id, trigger: edit }));
            const remove = el('button', 'list-manager-button is-danger', text('ui_lists_action_delete', 'Delete'));
            remove.type = 'button';
            remove.addEventListener('click', () => applyPartsChange({ action: 'remove', id: entry.id }));
            actions.append(edit, remove);
            row.append(actions);
            container.append(row);
        }
        container.append(el('div', 'parts-lists-note', text('parts_lists_delete_note', 'Deleting a part leaves its chips as plain text until you replace them')));
        body.append(container);
    }

    async function applyChange(change) {
        const payload = await globalThis.api.applyUserListChange(state.list, change);
        if (!payload) {
            console.warn(CAT, 'change refused:', state.list, change.action, change.key);
            return false;
        }
        await applyPayload(payload);
        return true;
    }

    function sourceBadge(meta) {
        if (meta.source === 'user') return { label: text('ui_lists_badge_user', 'user'), cls: 'is-user' };
        if (meta.source === 'original') return { label: text('ui_lists_badge_original', 'original'), cls: 'is-original' };
        if (meta.source === 'view') return { label: text('ui_lists_badge_upstream', 'upstream'), cls: 'is-upstream' };
        return { label: text('ui_lists_badge_csv', 'csv'), cls: 'is-csv' };
    }

    function startEdit(row) {
        state.editing = {
            key: row?.name ?? '',
            isNew: !row,
            tag: row?.tag ?? '',
            thumb: null,
            // view lists: the tag is optional and defaults to the name itself
            optionalTag: state.list.startsWith('view_'),
        };
        render();
    }

    function renderEditForm(body) {
        const editing = state.editing;
        const form = el('div', 'list-manager-edit');
        const nameLabel = el('label', 'list-manager-edit-label', text('ui_lists_edit_name', 'Name'));
        const nameInput = el('input', 'list-manager-edit-input');
        nameInput.value = editing.key;
        nameInput.disabled = !editing.isNew;
        nameLabel.append(nameInput);
        form.append(nameLabel);

        const tagLabel = el('label', 'list-manager-edit-label', editing.optionalTag
            ? text('ui_lists_edit_tag_optional', 'Prompt tags (optional — the name itself is used when empty)')
            : text('ui_lists_edit_tag', 'Prompt tags'));
        const tagInput = el('textarea', 'list-manager-edit-textarea');
        tagInput.rows = 4;
        tagInput.value = editing.tag;
        tagLabel.append(tagInput);
        form.append(tagLabel);

        const pickRow = el('div', 'list-manager-edit-pick');
        const pickButton = el('button', 'list-manager-button', text('ui_lists_pick_tags', 'Choose tags…'));
        pickButton.type = 'button';
        pickButton.title = text('ui_lists_pick_tags_hint', 'Only plain single tags are offered (no wildcards or multi-tag favorites), so entries cannot reference each other.');
        pickButton.addEventListener('click', () => openTagPicker(tagInput, { favGroup: 'positive', singleTagsOnly: true, trigger: pickButton }));
        pickRow.append(pickButton);
        form.append(pickRow);

        let thumbStatus = null;
        if (state.list === 'character') {
            const thumbRow = el('div', 'list-manager-edit-thumb');
            const thumbButton = el('button', 'list-manager-button', text('ui_lists_edit_thumb', 'Choose thumbnail…'));
            thumbButton.type = 'button';
            thumbStatus = el('span', 'list-manager-edit-thumb-status', '');
            thumbButton.addEventListener('click', async () => {
                const thumb = await globalThis.api.pickUserThumb();
                if (thumb) {
                    editing.thumb = thumb;
                    thumbStatus.textContent = text('ui_lists_edit_thumb_set', 'thumbnail selected');
                }
            });
            thumbRow.append(thumbButton, thumbStatus);
            form.append(thumbRow);
        }

        const buttons = el('div', 'list-manager-edit-buttons');
        const save = el('button', 'list-manager-button is-primary', text('ui_lists_edit_save', 'Save'));
        save.type = 'button';
        save.addEventListener('click', async () => {
            const key = nameInput.value.trim();
            const tag = (tagInput?.value ?? '').trim();
            if (!key || (!editing.optionalTag && !tag)) return;
            const entry = tag ? { tag } : {};
            if (editing.thumb) entry.thumb = editing.thumb;
            else if (!editing.isNew) {
                // keep an already stored thumb when re-saving an entry
                const stored = globalThis.cachedFiles?.userListMeta?.[state.list]?.[key]?.thumb;
                if (stored) entry.thumb = stored;
            }
            if (await applyChange({ action: 'set', key, entry })) {
                state.editing = null;
                render();
            }
        });
        const cancel = el('button', 'list-manager-button', text('ui_lists_edit_cancel', 'Cancel'));
        cancel.type = 'button';
        cancel.addEventListener('click', () => { state.editing = null; render(); });
        buttons.append(save, cancel);
        form.append(buttons);
        body.append(form);
        nameInput.disabled ? tagInput?.focus() : nameInput.focus();
    }

    function renderRows(body, rows) {
        const container = el('div', 'list-manager-rows');
        for (const row of rows.slice(0, ROW_LIMIT)) {
            const { meta } = row;
            const rowElement = el('div', `list-manager-row${meta.hidden ? ' is-hidden' : ''}`);

            const nameCell = el('span', 'list-manager-name');
            if (state.list === 'character') nameCell.append(el('span', 'list-manager-initial', (row.name[0] ?? '?').toUpperCase()));
            const nameText = el('span', 'list-manager-name-text', row.name);
            nameText.title = row.name;
            nameCell.append(nameText);
            const badge = sourceBadge(meta);
            nameCell.append(el('span', `list-manager-badge ${badge.cls}`, badge.label));
            if (meta.overridden) nameCell.append(el('span', 'list-manager-badge is-overridden', text('ui_lists_badge_overridden', 'edited')));
            rowElement.append(nameCell);

            const tagCell = el('span', 'list-manager-tag', row.tag);
            tagCell.title = row.tag;
            rowElement.append(tagCell);

            const actions = el('span', 'list-manager-actions');
            const edit = el('button', 'list-manager-button',
                meta.source === 'user' || meta.overridden ? text('ui_lists_action_edit', 'Edit') : text('ui_lists_action_override', 'Override'));
            edit.type = 'button';
            edit.addEventListener('click', () => startEdit(row));
            actions.append(edit);

            let second;
            if (meta.source === 'user' && !meta.overridden) {
                second = el('button', 'list-manager-button is-danger', text('ui_lists_action_delete', 'Delete'));
                second.addEventListener('click', async () => { await applyChange({ action: 'remove', key: row.name }); render(); });
            } else if (meta.overridden) {
                second = el('button', 'list-manager-button', text('ui_lists_action_revert', 'Revert'));
                second.addEventListener('click', async () => { await applyChange({ action: 'remove', key: row.name }); render(); });
            } else if (meta.hidden) {
                second = el('button', 'list-manager-button is-ok', text('ui_lists_action_unhide', 'Restore'));
                second.addEventListener('click', async () => { await applyChange({ action: 'unhide', key: row.name }); render(); });
            } else {
                second = el('button', 'list-manager-button', text('ui_lists_action_hide', 'Hide'));
                second.addEventListener('click', async () => { await applyChange({ action: 'hide', key: row.name }); render(); });
            }
            second.type = 'button';
            actions.append(second);
            rowElement.append(actions);
            container.append(rowElement);
        }
        if (rows.length > ROW_LIMIT) {
            container.append(el('div', 'list-manager-more',
                text('ui_lists_more', 'Showing first {0} — refine the search').replace('{0}', String(ROW_LIMIT))));
        }
        body.append(container);
    }

    function render() {
        modal.replaceChildren();

        const head = el('div', 'list-manager-head');
        head.append(el('span', 'list-manager-title', text('ui_lists_title', 'List manager')));
        const closeButton = el('button', 'list-manager-close', '×');
        closeButton.type = 'button';
        closeButton.addEventListener('click', close);
        head.append(closeButton);
        modal.append(head);

        const layout = el('div', 'list-manager-layout');
        const nav = el('div', 'list-manager-nav');
        for (const list of LISTS) {
            if (list.kind === 'part' && !partsAvailable()) continue;
            const button = el('button', `list-manager-nav-item${state.list === list.id ? ' is-active' : ''}`, text(list.langKey, list.fallback));
            button.type = 'button';
            button.addEventListener('click', () => { state.list = list.id; state.editing = null; state.search = ''; render(); });
            nav.append(button);
        }
        nav.append(el('div', 'list-manager-nav-note', text('ui_lists_note', 'Upstream data stays read-only; edits are saved as your diff.')));
        layout.append(nav);

        const body = el('div', 'list-manager-body');

        if (state.list === 'part') {
            renderPartsTab(body);
        } else if (state.editing) {
            renderEditForm(body);
        } else {
            const toolbar = el('div', 'list-manager-toolbar');
            const search = el('input', 'list-manager-search');
            search.placeholder = text('ui_lists_search', 'Search…');
            search.value = state.search;
            search.addEventListener('input', () => {
                state.search = search.value;
                const rows = filteredRows();
                const rowsHost = body.querySelector('.list-manager-rows');
                const countHost = body.querySelector('.list-manager-count');
                if (rowsHost) {
                    rowsHost.remove();
                    renderRows(body, rows);
                }
                if (countHost) countHost.textContent = countText(rows.length);
            });
            toolbar.append(search);
            const add = el('button', 'list-manager-button is-primary', text('ui_lists_add', 'Add entry'));
            add.type = 'button';
            add.addEventListener('click', () => startEdit(null));
            toolbar.append(add);
            const exportButton = el('button', 'list-manager-button', text('ui_lists_export', 'Export'));
            exportButton.type = 'button';
            exportButton.addEventListener('click', async () => { await globalThis.api.exportUserLists(); });
            toolbar.append(exportButton);
            const importButton = el('button', 'list-manager-button', text('ui_lists_import', 'Import'));
            importButton.type = 'button';
            importButton.addEventListener('click', async () => {
                const result = await globalThis.api.importUserLists('merge');
                if (result?.ok) {
                    await applyPayload(result);
                    render();
                }
            });
            toolbar.append(importButton);
            body.append(toolbar);

            const rows = filteredRows();
            body.append(el('div', 'list-manager-count', countText(rows.length)));
            renderRows(body, rows);
        }

        layout.append(body);
        modal.append(layout);
    }

    function filteredRows() {
        const needle = state.search.trim().toLowerCase();
        const rows = listRows(state.list);
        rows.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
        if (!needle) return rows;
        return rows.filter(row => row.name.toLowerCase().includes(needle) || row.tag.toLowerCase().includes(needle));
    }

    function countText(count) {
        const meta = globalThis.cachedFiles?.userListMeta?.[state.list] ?? {};
        let user = 0;
        let hidden = 0;
        for (const entry of Object.values(meta)) {
            if (entry.source === 'user') user++;
            if (entry.hidden) hidden++;
        }
        return text('ui_lists_count', '{0} entries · {1} yours · {2} hidden')
            .replace('{0}', String(count)).replace('{1}', String(user)).replace('{2}', String(hidden));
    }

    const manager = { open, close, isOpen: () => !overlay.hidden };
    globalThis.listManager = manager;
    return manager;
}
