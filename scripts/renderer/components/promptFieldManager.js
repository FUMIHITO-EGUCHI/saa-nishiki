// The Scene: every prompt unit as one row (label | chips) in chain order, edited
// in place - drag to reorder, double-click the label to rename, ● to mute the
// whole row, + Add field at the bottom - plus the per-field presets
// (background / style / custom fields). While Regional is on, the LEFT / RIGHT
// units sit in a Regional block inside the Scene; a custom row dragged into a
// side box takes that side.
//
// State lives in settings: prompt_custom_fields [{id, name, polarity, text,
// side?, muted?}], prompt_positive_order / prompt_negative_order (unit id arrays;
// see scripts/shared/promptFieldOrder.js), prompt_field_presets {key: [{name,
// text}]}, prompt_field_collapsed [ids], prompt_field_muted [built-in ids].
import { setupTextbox } from './myTextbox.js';
import { setupTagSelectionModal } from '../tagSelectionModal.js';
import {
    STRUCTURAL_UNITS,
    isFieldMuted,
    makeCustomFieldId,
    normalizeCustomFields,
    normalizeOrder,
    setCustomFieldExtras,
    setFieldMuted,
} from '../../shared/promptFieldOrder.js';
import { sideLabel, sideOf, sideOrder, swapSidesPatch } from '../../shared/regionalSides.js';
import { castEnabled, castRoster, isActionNamed, isCastFieldId, isDiffusionFieldId, syncCastFields } from '../../shared/castMembers.js';

const BUILTIN_LABELS = {
    common: 'Common',
    views: 'View',
    background: 'Background',
    style: 'Style',
    ai: 'AI prompt',
    characters: 'Characters',
    positive: 'Positive',
    positive_right: 'Positive (right)',
    negative: 'Negative',
    negative_left: 'Negative (left)',
    negative_right: 'Negative (right)',
    exclude: 'Exclude',
};

// Units with a text container inside .prompt-fields (structural units live elsewhere).
const BUILTIN_CONTAINERS = {
    common: '.prompt-common',
    background: '.prompt-background',
    style: '.prompt-style',
    positive: '.prompt-positive',
    positive_right: '.prompt-positive-right',
    negative: '.prompt-negative',
    negative_left: '.prompt-negative-left',
    negative_right: '.prompt-negative-right',
    exclude: '.prompt-exclude',
};

const BUILTIN_STRIPES = {
    common: 'common', views: 'view', background: 'view', style: 'view', positive: 'positive',
    positive_right: 'positive', negative: 'negative', negative_left: 'negative', negative_right: 'negative', exclude: 'exclude',
};

// Built-in fields whose text a preset can replace, and where the value lives.
const PRESETABLE_BUILTINS = {
    background: 'prompt_background',
    style: 'prompt_style',
};

// Side-pinned built-ins are not part of the stored orders (regionalSides.js places
// them after positive / negative); exclude applies to everything. None of them moves.
const PINNED_UNITS = new Set(['positive_right', 'negative_left', 'negative_right', 'exclude']);
const NEGATIVE_BUILTINS = new Set(['negative', 'negative_left', 'negative_right']);

export function setupPromptFieldManager() {
    const SETTINGS = globalThis.globalSettings;
    const fieldsHost = document.querySelector('.prompt-fields');
    const toolsHost = document.querySelector('#prompt-text-container .ui-card-tools');
    if (!fieldsHost || !toolsHost) {
        console.error('[promptFieldManager] prompt card containers not found');
        return null;
    }

    const LANG = () => globalThis.cachedFiles?.language?.[SETTINGS.language] ?? {};
    const text = (key, fallback) => {
        const value = LANG()[key];
        return typeof value === 'string' && value !== '' ? value : fallback;
    };

    // One "@alias" row per character slot (scripts/shared/castMembers.js): the rows
    // follow the slots and their aliases, so the settings are re-synced before the
    // custom fields are read.
    function syncCast() {
        const patch = syncCastFields(SETTINGS, LANG());
        if (!patch.changed) return false;
        SETTINGS.prompt_custom_fields = patch.prompt_custom_fields;
        SETTINGS.prompt_positive_order = patch.prompt_positive_order;
        return true;
    }

    syncCast();
    let fields = normalizeCustomFields(SETTINGS.prompt_custom_fields);
    persistFields();

    function persistFields() {
        SETTINGS.prompt_custom_fields = fields.map(field => ({ ...field }));
        SETTINGS.prompt_positive_order = normalizeOrder(SETTINGS.prompt_positive_order, 'positive', fields);
        SETTINGS.prompt_negative_order = normalizeOrder(SETTINGS.prompt_negative_order, 'negative', fields);
    }

    // A text edit changes no id, name or polarity, so the orders stay valid: one
    // settings write (one edit-history transaction) per keystroke, not three.
    function persistFieldTexts() {
        SETTINGS.prompt_custom_fields = fields.map(field => ({ ...field }));
    }

    // Looked up by id at call time: `fields` is replaced wholesale when the settings
    // are reloaded (preset load, undo), so a closure over a field object would go stale.
    function setFieldText(id, text) {
        const field = fields.find(entry => entry.id === id);
        if (!field || field.text === text) return;
        field.text = text;
        persistFieldTexts();
    }

    const customColor = () => (SETTINGS.css_style === 'dark' ? 'orchid' : 'DarkMagenta');
    const isRegional = () => Boolean(SETTINGS.regional_condition);

    // ------------------------------------------------------------ custom fields

    // the tag picker of each custom field (its modal overlay lives under <body>)
    const pickers = new Map();

    function renderCustomFields() {
        const wanted = new Set(fields.map(field => field.id));
        for (const container of fieldsHost.querySelectorAll('.prompt-custom-field')) {
            const id = container.dataset.fieldId;
            if (!wanted.has(id)) {
                // A field can vanish because a prompt preset without it was loaded;
                // its per-field presets stay so the field returns intact with the
                // preset that has it (the row's delete drops them explicitly).
                container.remove();
                delete globalThis.prompt[id];
                globalThis.prompt.tagCapsuleFields?.remove?.(id);
                for (const picker of pickers.get(id) ?? []) picker.modal?.destroy?.();
                pickers.delete(id);
            }
        }
        const cast = castEnabled(SETTINGS);
        for (const field of fields) {
            const containerClass = `prompt-${field.id}`;
            const isCast = isCastFieldId(field.id);
            const diffusionOnly = isDiffusionFieldId(field.id);
            let container = fieldsHost.querySelector(`.${containerClass}`);
            if (!container) {
                container = document.createElement('div');
                container.className = `${containerClass} prompt-field prompt-custom-field${isCast ? ' prompt-cast-field' : ''}`;
                container.dataset.fieldId = field.id;
                container.dataset.stripe = field.polarity === 'negative' ? 'negative' : 'view';
                fieldsHost.appendChild(container);
                globalThis.prompt[field.id] = setupTextbox(containerClass, field.name, {
                    value: field.text,
                    defaultTextColor: customColor(),
                    minLines: 2,
                    maxLines: 10,
                }, true, (value) => setFieldText(field.id, value));
                // Same tag picker + capsule view as the built-in fields (the picker's
                // trigger must exist before the capsule header adopts it).
                const control = globalThis.prompt[field.id];
                pickers.set(field.id, setupTagSelectionModal([control], [field.id]));
                // an Action is a sentence: it stays text when the card shows capsules
                if (isActionNamed(field)) globalThis.prompt.tagCapsuleFields?.setSentence?.(field.id, true);
                globalThis.prompt.tagCapsuleFields?.add?.(control, field.id);
                attachPresetButton(container, field.id, () => globalThis.prompt[field.id],
                    (text) => setFieldText(field.id, text));
            } else {
                const control = globalThis.prompt[field.id];
                control?.setTitle?.(field.name);
                // settings reload (preset, undo): push the stored text into the live textbox
                if (control?.getValue && String(control.getValue() ?? '') !== field.text) control.setValue(field.text);
                // setTitle rewrites the textbox header's textContent, which used to wipe a
                // preset button parked there - put it back if it is gone
                if (!container.querySelector('.prompt-preset-button')) {
                    attachPresetButton(container, field.id, () => globalThis.prompt[field.id],
                        (text) => setFieldText(field.id, text));
                }
            }
            // a cast row and the Action row are Diffusion fields: hidden the way the
            // regional rows are (inline display), so the Scene leaves them out for Checkpoint
            if (diffusionOnly) container.style.display = cast ? '' : 'none';
            container.classList.toggle('prompt-action-field', isActionNamed(field));
            globalThis.prompt.tagCapsuleFields?.setSentence?.(field.id, isActionNamed(field));
            renderCastChips(container, field, cast);
        }
    }

    // "@alias" buttons over an Action field: each inserts the reference at the caret.
    function renderCastChips(container, field, cast) {
        let row = container.querySelector('.prompt-action-cast');
        const roster = cast && isActionNamed(field) ? castRoster(SETTINGS, LANG()) : [];
        if (roster.length === 0) { row?.remove(); return; }
        if (!row) {
            row = document.createElement('div');
            row.className = 'prompt-action-cast';
            const header = container.querySelector('.tag-field-header') ?? container.querySelector('div[class^="myTextbox-"][class*="-header"]');
            if (header) header.insertAdjacentElement('afterend', row); else container.prepend(row);
        }
        row.replaceChildren(...roster.map(member => {
            const chip = document.createElement('button');
            chip.type = 'button';
            chip.className = 'prompt-action-cast-chip';
            chip.textContent = `@${member.alias}`;
            chip.title = member.key === 'None' ? `@${member.index}` : `${member.key} → @${member.index}`;
            chip.addEventListener('click', () => {
                const textarea = container.querySelector('textarea');
                if (!textarea) return;
                const start = textarea.selectionStart ?? textarea.value.length;
                const end = textarea.selectionEnd ?? start;
                const before = textarea.value.slice(0, start);
                const insert = `${before && !/\s$/.test(before) ? ' ' : ''}@${member.alias} `;
                textarea.setRangeText(insert, start, end, 'end');
                textarea.dispatchEvent(new Event('input', { bubbles: true }));
                textarea.focus();
            });
            return chip;
        }));
    }

    function unitContainer(id) {
        if (id === 'views') return viewsRow;
        if (BUILTIN_CONTAINERS[id]) return fieldsHost.querySelector(BUILTIN_CONTAINERS[id]);
        return fieldsHost.querySelector(`.prompt-${id}`);
    }

    function idOfContainer(container) {
        if (container.dataset.fieldId) return container.dataset.fieldId;
        return Object.keys(BUILTIN_CONTAINERS).find(id => container.matches(BUILTIN_CONTAINERS[id])) ?? '';
    }

    function customOf(id) {
        return fields.find(field => field.id === id) ?? null;
    }

    // positive_right toggles via inline display (regional mode); the Scene mirrors it
    function isAvailable(container) {
        return Boolean(container) && container.style.display !== 'none';
    }

    function fieldValue(id) {
        if (id === 'views') return '';
        return String(globalThis.prompt?.[id]?.getValue?.() ?? '');
    }

    function tagCount(id) {
        return fieldValue(id).split(/[,\n]/).map(part => part.trim()).filter(Boolean).length;
    }

    function fieldLabel(id) {
        const custom = customOf(id);
        if (custom) return custom.name;
        const container = unitContainer(id);
        const capsuleLabel = container?.querySelector('.tag-field-label');
        const label = capsuleLabel ? [...capsuleLabel.childNodes].filter(node => node.nodeType === Node.TEXT_NODE).map(node => node.textContent).join('') : '';
        if (label && label.trim() !== '') return label.trim();
        return BUILTIN_LABELS[id] || id;
    }

    // The chain a unit belongs to (the stored order it can move in).
    function chainOf(id) {
        const custom = customOf(id);
        if (custom) return custom.polarity === 'negative' ? 'prompt_negative_order' : 'prompt_positive_order';
        return NEGATIVE_BUILTINS.has(id) ? 'prompt_negative_order' : 'prompt_positive_order';
    }

    function isMovable(id) {
        return !PINNED_UNITS.has(id) && !STRUCTURAL_UNITS.has(id) || id === 'views';
    }

    // fixed rows: no rename, no delete (cast rows follow their slot, the Action row is the Action)
    function isFixed(id) {
        const custom = customOf(id);
        if (!custom || isDiffusionFieldId(custom.id)) return true;
        // a hand-made "Action" field serves as the Action row while the Cast is on
        return isActionNamed(custom) && castEnabled(SETTINGS);
    }

    // ------------------------------------------------------------------ icons
    function svgIcon(path, size = 10) {
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('width', String(size));
        svg.setAttribute('height', String(size));
        svg.setAttribute('viewBox', '0 0 16 16');
        svg.setAttribute('fill', 'none');
        svg.setAttribute('stroke', 'currentColor');
        svg.setAttribute('stroke-width', '1.7');
        svg.setAttribute('stroke-linecap', 'round');
        svg.setAttribute('stroke-linejoin', 'round');
        svg.setAttribute('aria-hidden', 'true');
        for (const d of [].concat(path)) {
            const element = document.createElementNS('http://www.w3.org/2000/svg', 'path');
            element.setAttribute('d', d);
            svg.appendChild(element);
        }
        return svg;
    }
    const ICON_CHEVRON_RIGHT = 'M6 4l4 4-4 4';
    const ICON_SWAP = ['M2 5.5h10M9.5 3l2.5 2.5L9.5 8', 'M14 10.5H4M6.5 8L4 10.5 6.5 13'];
    const ICON_PERSON = ['M8 8.3a2.8 2.8 0 1 0 0-5.6 2.8 2.8 0 0 0 0 5.6z', 'M2.8 13.5c.7-2.6 2.6-4 5.2-4s4.5 1.4 5.2 4'];
    const ICON_GRIP = ['M6 4h.01M10 4h.01M6 8h.01M10 8h.01M6 12h.01M10 12h.01'];

    // ------------------------------------------------------------ mute / collapse

    function collapsedIds() {
        return new Set(Array.isArray(SETTINGS.prompt_field_collapsed) ? SETTINGS.prompt_field_collapsed : []);
    }

    function toggleCollapsed(id) {
        const collapsed = collapsedIds();
        if (collapsed.has(id)) collapsed.delete(id); else collapsed.add(id);
        SETTINGS.prompt_field_collapsed = [...collapsed];
        applyRowStates();
    }

    function isMuted(id) {
        return isFieldMuted(SETTINGS, id);
    }

    function setMuted(id, muted) {
        const patch = setFieldMuted(SETTINGS, id, muted);
        for (const [key, value] of Object.entries(patch)) SETTINGS[key] = value;
        if (Object.hasOwn(patch, 'prompt_custom_fields')) fields = normalizeCustomFields(SETTINGS.prompt_custom_fields);
        globalThis.prompt?.tagCapsuleFields?.setMuted?.(id, muted);
        applyRowStates();
        globalThis.prompt?.tagCapsuleFields?.refreshFinalPrompt?.();
    }

    function applyRowStates() {
        const collapsed = collapsedIds();
        let muted = 0;
        for (const container of sceneRows()) {
            const id = idOfContainer(container);
            container.classList.toggle('is-collapsed', collapsed.has(id));
            const isOff = isMuted(id);
            container.classList.toggle('is-muted', isOff);
            if (isOff && isAvailable(container)) muted += 1;
            globalThis.prompt?.tagCapsuleFields?.setMuted?.(id, isOff);
            const mute = container.querySelector('.scene-mute');
            if (mute) {
                mute.setAttribute('aria-pressed', isOff ? 'false' : 'true');
                mute.title = isOff ? text('ui_scene_unmute', 'Enable this row') : text('ui_scene_mute', 'Disable this row (tags are kept)');
            }
            const count = container.querySelector('.scene-count');
            if (count) {
                const n = tagCount(id);
                count.textContent = n > 0 ? String(n) : '';
            }
        }
        mutedNote.textContent = muted > 0 ? text('ui_scene_muted_count', '{0} off').replace('{0}', String(muted)) : '';
    }

    // ---------------------------------------------------------------- the rows

    let scene = null;      // .prompt-scene, the rows host
    let viewsRow = null;   // the View row (Angle / Camera dropdowns)
    let group = null;      // the Regional block (built once, attached while Regional is on)
    let addFooter = null;  // "+ Add field"

    function ensureScene() {
        if (scene) return scene;
        scene = document.createElement('div');
        scene.className = 'prompt-scene';
        fieldsHost.insertBefore(scene, fieldsHost.querySelector('.ai-card'));
        scene.addEventListener('input', () => scheduleCountRefresh());
        attachRowDrag(scene);
        addFooter = document.createElement('div');
        addFooter.className = 'scene-add';
        const add = document.createElement('button');
        add.type = 'button';
        add.className = 'scene-add-button';
        add.addEventListener('click', () => openAddPopover(add, 'both'));
        addFooter.appendChild(add);
        fieldsHost.insertBefore(addFooter, scene.nextSibling);
        return scene;
    }

    function sceneRows() {
        return scene ? [...scene.querySelectorAll('.prompt-field[data-scene-row]')] : [];
    }

    // In the Scene the Angle / Camera dropdowns are the View row at the chain's "views"
    // slot (the Characters card keeps only the slots).
    function ensureViewsRow() {
        if (viewsRow) return viewsRow;
        const view = document.querySelector('.dropdown-view');
        if (!view) return null;
        viewsRow = document.createElement('div');
        viewsRow.className = 'prompt-views-row prompt-field';
        viewsRow.dataset.fieldId = 'views';
        viewsRow.dataset.stripe = 'view';
        const wrapper = document.createElement('div');
        wrapper.className = 'myTextbox-wrapper';
        const header = document.createElement('div');
        header.className = 'tag-field-header';
        const label = document.createElement('span');
        label.className = 'tag-field-label';
        label.textContent = text('ui_field_views', 'View');
        const tools = document.createElement('div');
        tools.className = 'tag-field-tools';
        header.append(label, tools);
        wrapper.append(header, view);
        viewsRow.appendChild(wrapper);
        return viewsRow;
    }

    // Row chrome, added once per container: grip · chevron · ● before the label,
    // polarity / delete / ⋯ after the tools. Double-click on a custom label renames.
    function decorateRow(container, id) {
        const header = container.querySelector('.tag-field-header');
        if (!header || header.querySelector(':scope > .scene-handle')) return;
        const handle = document.createElement('span');
        handle.className = 'scene-handle';

        const grip = document.createElement('span');
        grip.className = 'scene-grip';
        grip.title = text('ui_scene_drag', 'Drag to move');
        grip.appendChild(svgIcon(ICON_GRIP, 12));
        grip.hidden = !isMovable(id);
        grip.addEventListener('mousedown', () => armDrag(container));

        const chevron = document.createElement('button');
        chevron.type = 'button';
        chevron.className = 'scene-chevron';
        chevron.title = text('ui_scene_collapse', 'Collapse / expand');
        chevron.appendChild(svgIcon(ICON_CHEVRON_RIGHT, 12));
        chevron.addEventListener('click', () => toggleCollapsed(id));

        const mute = document.createElement('button');
        mute.type = 'button';
        mute.className = 'scene-mute';
        mute.addEventListener('click', () => setMuted(id, !isMuted(id)));

        handle.append(grip, chevron, mute);
        header.prepend(handle);

        const label = header.querySelector('.tag-field-label');
        if (label) {
            label.classList.add('scene-label');
            label.addEventListener('click', () => toggleCollapsed(id));
            if (!isFixed(id)) {
                label.title = text('ui_scene_rename_hint', 'Double-click to rename');
                label.addEventListener('dblclick', event => { event.preventDefault(); startRename(container, id); });
            }
            const count = document.createElement('span');
            count.className = 'scene-count';
            label.insertAdjacentElement('afterend', count);
        }

        let tools = header.querySelector('.tag-field-tools');
        if (!tools) {
            tools = document.createElement('div');
            tools.className = 'tag-field-tools';
            header.appendChild(tools);
        }
        const custom = customOf(id);
        if (custom && !isFixed(id)) {
            const polarity = document.createElement('button');
            polarity.type = 'button';
            polarity.className = `scene-polarity is-${custom.polarity}`;
            polarity.textContent = custom.polarity === 'negative' ? '−' : '+';
            polarity.title = text('ui_scene_polarity', 'Positive / negative chain');
            polarity.addEventListener('click', () => togglePolarity(id));
            const remove = document.createElement('button');
            remove.type = 'button';
            remove.className = 'scene-delete';
            remove.textContent = '×';
            remove.title = text('ui_scene_delete', 'Delete field');
            remove.addEventListener('click', () => deleteField(id));
            tools.append(polarity, remove);
        }
        const menu = document.createElement('button');
        menu.type = 'button';
        menu.className = 'scene-menu-button';
        menu.textContent = '⋯';
        menu.title = text('ui_scene_more', 'More');
        menu.addEventListener('click', event => { event.stopPropagation(); toggleRowMenu(container, id, menu); });
        tools.appendChild(menu);
        // the tools sit at the row's right end (the design), not under the label:
        // out of the header, as the wrapper's own grid cell
        const wrapper = header.parentElement;
        if (wrapper && tools.parentElement === header) wrapper.appendChild(tools);

        attachCapsuleDropTarget(header, id);
    }

    // inline rename: swap the label for a text input (no blocking dialogs)
    function startRename(container, id) {
        const custom = customOf(id);
        const label = container.querySelector('.tag-field-label');
        if (!custom || !label || label.hidden) return;
        const input = document.createElement('input');
        input.type = 'text';
        input.value = custom.name;
        input.maxLength = 40;
        input.className = 'scene-rename';
        let done = false;
        const finish = (commit) => {
            if (done) return;
            done = true;
            const name = input.value.trim();
            if (commit && name !== '' && name !== custom.name) {
                custom.name = name.slice(0, 40);
                persistFields();
                renderCustomFields();
                globalThis.prompt?.tagCapsuleFields?.updateLanguage?.();
            }
            input.replaceWith(label);
            label.hidden = false;
        };
        input.addEventListener('keydown', event => {
            if (event.key === 'Enter') { event.preventDefault(); finish(true); }
            if (event.key === 'Escape') { event.preventDefault(); finish(false); }
        });
        input.addEventListener('blur', () => finish(true));
        label.replaceWith(input);
        input.focus();
        input.select();
    }

    function togglePolarity(id) {
        const custom = customOf(id);
        if (!custom || isFixed(id)) return;
        const from = chainOf(id);
        custom.polarity = custom.polarity === 'negative' ? 'positive' : 'negative';
        SETTINGS[from] = SETTINGS[from].filter(unitId => unitId !== id);
        persistFields();
        const container = unitContainer(id);
        if (container) {
            container.dataset.stripe = custom.polarity === 'negative' ? 'negative' : 'view';
            const badge = container.querySelector('.scene-polarity');
            if (badge) {
                badge.className = `scene-polarity is-${custom.polarity}`;
                badge.textContent = custom.polarity === 'negative' ? '−' : '+';
            }
        }
        layoutScene();
    }

    function deleteField(id) {
        const custom = customOf(id);
        if (!custom || isFixed(id)) return;
        fields = fields.filter(field => field.id !== id);
        for (const key of ['prompt_positive_order', 'prompt_negative_order']) SETTINGS[key] = SETTINGS[key].filter(unitId => unitId !== id);
        // explicit delete: the field's preset bucket goes with it
        if (SETTINGS.prompt_field_presets && typeof SETTINGS.prompt_field_presets === 'object' && id in SETTINGS.prompt_field_presets) {
            const store = { ...SETTINGS.prompt_field_presets };
            delete store[id];
            SETTINGS.prompt_field_presets = store;
        }
        persistFields();
        renderCustomFields();
        layoutScene();
    }

    function addField({ name, polarity, side = 'both' }) {
        const field = { id: makeCustomFieldId(), name: name.slice(0, 40), polarity, text: '' };
        if (isRegional() && (side === 'left' || side === 'right')) field.side = side;
        fields.push(field);
        persistFields();
        renderCustomFields();
        layoutScene();
        return field.id;
    }

    function moveUnit(id, delta) {
        const orderKey = chainOf(id);
        const order = [...SETTINGS[orderKey]];
        const index = order.indexOf(id);
        const target = index + delta;
        if (index < 0 || target < 0 || target >= order.length) return;
        [order[index], order[target]] = [order[target], order[index]];
        SETTINGS[orderKey] = order;
        layoutScene();
    }

    // ------------------------------------------------------------- row menu (⋯)
    let openMenu = null;
    function closeRowMenu() {
        openMenu?.remove();
        openMenu = null;
    }
    function toggleRowMenu(container, id, anchor) {
        if (openMenu && container.contains(openMenu)) { closeRowMenu(); return; }
        closeRowMenu();
        closePanels();
        const custom = customOf(id);
        const menu = document.createElement('div');
        menu.className = 'scene-row-menu';
        const item = (label, action, { danger = false, disabled = false } = {}) => {
            const button = document.createElement('button');
            button.type = 'button';
            button.textContent = label;
            button.disabled = disabled;
            button.classList.toggle('is-danger', danger);
            button.addEventListener('click', () => { closeRowMenu(); action(); });
            menu.appendChild(button);
        };
        item(isMuted(id) ? text('ui_scene_unmute', 'Enable this row') : text('ui_scene_mute', 'Disable this row (tags are kept)'), () => setMuted(id, !isMuted(id)));
        if (isMovable(id)) {
            item(text('ui_scene_move_up', 'Move up'), () => moveUnit(id, -1));
            item(text('ui_scene_move_down', 'Move down'), () => moveUnit(id, 1));
        }
        // Text / Chips for the whole card (the per-field toggle is hidden in the Scene)
        const set = globalThis.prompt?.tagCapsuleFields;
        if (set?.getMode && !container.classList.contains('prompt-action-field') && container.querySelector('.tag-view-toggle')) {
            const chips = set.getMode() === 'capsule';
            item(chips ? text('ui_scene_view_text', 'Show as text') : text('ui_scene_view_chips', 'Show as chips'), () => set.setMode(chips ? 'string' : 'capsule'));
        }
        const batch = container.querySelector('.tag-capsule-batch');
        if (batch) item(text('ui_scene_batch', 'Weights per image…'), () => batch.click());
        const preset = container.querySelector('.prompt-preset-button');
        if (preset) item(text('ui_scene_presets', 'Presets…'), () => preset.click());
        if (custom && !isFixed(id)) {
            item(text('ui_scene_rename', 'Rename'), () => startRename(container, id));
            item(text('ui_scene_delete', 'Delete field'), () => deleteField(id), { danger: true });
        }
        // right under the ⋯ button (its tool row is the positioning box)
        (anchor.parentElement ?? container).appendChild(menu);
        openMenu = menu;
        anchor.setAttribute('aria-expanded', 'true');
    }
    document.addEventListener('click', event => {
        if (openMenu && !event.target.closest?.('.scene-row-menu')) closeRowMenu();
        if (openAdd && !event.target.closest?.('.scene-add-pop') && !event.target.closest?.('.scene-add-button')) closeAddPopover();
    });

    // -------------------------------------------------------- "+ Add field" popover
    let openAdd = null;
    function closeAddPopover() {
        openAdd?.remove();
        openAdd = null;
    }
    function openAddPopover(anchor, side) {
        if (openAdd && openAdd.dataset.side === side) { closeAddPopover(); return; }
        closeAddPopover();
        closeRowMenu();
        const pop = document.createElement('div');
        pop.className = 'scene-add-pop';
        pop.dataset.side = side;
        const input = document.createElement('input');
        input.type = 'text';
        input.maxLength = 40;
        input.placeholder = text('ui_scene_add_name', 'Field name');
        let polarity = 'positive';
        const seg = document.createElement('div');
        seg.className = 'scene-add-polarity';
        const options = [['positive', text('ui_scene_add_positive', '+ Pos')], ['negative', text('ui_scene_add_negative', '− Neg')]];
        const buttons = options.map(([value, label]) => {
            const button = document.createElement('button');
            button.type = 'button';
            button.textContent = label;
            button.dataset.polarity = value;
            button.classList.toggle('is-selected', value === polarity);
            button.addEventListener('click', () => {
                polarity = value;
                for (const other of buttons) other.classList.toggle('is-selected', other.dataset.polarity === polarity);
                input.focus();
            });
            seg.appendChild(button);
            return button;
        });
        const submit = document.createElement('button');
        submit.type = 'button';
        submit.className = 'scene-add-submit';
        submit.textContent = text('ui_scene_add_submit', 'Add');
        const commit = () => {
            const name = input.value.trim();
            if (name === '') { input.focus(); return; }
            const id = addField({ name, polarity, side });
            closeAddPopover();
            const container = unitContainer(id);
            container?.querySelector('textarea')?.focus();
        };
        submit.addEventListener('click', commit);
        input.addEventListener('keydown', event => {
            if (event.key === 'Enter') { event.preventDefault(); commit(); }
            if (event.key === 'Escape') { event.preventDefault(); closeAddPopover(); }
        });
        pop.append(input, seg, submit);
        anchor.parentElement.appendChild(pop);
        openAdd = pop;
        input.focus();
    }

    // ------------------------------------------------------------- row drag
    // The grip arms a native drag of the whole row; chips keep their own drag
    // (their dragstart bubbles through the row and is left alone).
    const UNIT_MIME = 'application/x-saa-field-unit';
    let armed = null;    // the container whose grip is held
    let dragging = null; // { id, orderKey }
    document.addEventListener('mouseup', () => { if (armed && !dragging) disarmDrag(); });

    function armDrag(container) {
        armed = container;
        container.draggable = true;
    }
    function disarmDrag() {
        if (armed) armed.draggable = false;
        armed = null;
    }

    function attachRowDrag(host) {
        host.addEventListener('dragstart', event => {
            const container = event.target.closest?.('.prompt-field[data-scene-row]');
            if (!container || container !== armed || event.target.closest('.tag-capsule-chip')) return;
            const id = idOfContainer(container);
            if (!isMovable(id)) { event.preventDefault(); return; }
            dragging = { id, orderKey: chainOf(id) };
            event.dataTransfer.effectAllowed = 'move';
            event.dataTransfer.setData(UNIT_MIME, JSON.stringify(dragging));
            event.dataTransfer.setData('text/plain', fieldLabel(id));
            container.classList.add('is-dragging');
        });
        host.addEventListener('dragend', event => {
            const container = event.target.closest?.('.prompt-field');
            container?.classList.remove('is-dragging');
            dragging = null;
            disarmDrag();
            clearDropMarks();
        });
        host.addEventListener('dragover', event => {
            if (!dragging) return;
            const target = dropTarget(event);
            if (!target) { clearDropMarks(); return; }
            event.preventDefault();
            event.dataTransfer.dropEffect = 'move';
            clearDropMarks();
            if (target.row) target.row.classList.add('is-drop-before');
            else target.zone.classList.add('is-drop-target');
        });
        host.addEventListener('dragleave', event => {
            if (!host.contains(event.relatedTarget)) clearDropMarks();
        });
        host.addEventListener('drop', event => {
            if (!dragging) return;
            const target = dropTarget(event);
            clearDropMarks();
            if (!target) return;
            event.preventDefault();
            const { id, orderKey } = dragging;
            dragging = null;
            disarmDrag();
            placeUnit(orderKey, id, target);
        });
    }

    // Where a dragged row would land: before the row under the pointer when that row
    // is of the same chain (and, while Regional is on, of a side the unit may take),
    // else at the end of the zone (a side box or the Scene itself).
    function dropTarget(event) {
        const zoneEl = event.target.closest?.('.scene-side') ?? scene;
        const side = zoneEl?.classList.contains('scene-side') ? zoneEl.dataset.side : 'both';
        if (!sideAllowed(dragging.id, side)) return null;
        const row = event.target.closest?.('.prompt-field[data-scene-row]');
        if (row && row !== unitContainer(dragging.id) && zoneEl.contains(row) && chainOf(idOfContainer(row)) === dragging.orderKey && isMovable(idOfContainer(row))) {
            return { row, zone: zoneEl, side, beforeId: idOfContainer(row) };
        }
        return { row: null, zone: zoneEl, side, beforeId: null };
    }

    // a built-in keeps its side (positive is LEFT, common is both …); a custom row takes any
    function sideAllowed(id, side) {
        if (!isRegional()) return true;
        if (customOf(id)) return true;
        return sideOf(id, fields) === side;
    }

    function clearDropMarks() {
        if (!scene) return;
        for (const node of scene.querySelectorAll('.is-drop-before, .is-drop-target')) node.classList.remove('is-drop-before', 'is-drop-target');
    }

    // Puts `id` back into its chain before `beforeId` (null = after the last unit of
    // the zone, or at the chain end) and moves a custom field to `side`.
    function placeUnit(orderKey, id, { beforeId = null, side = 'both', zone = null } = {}) {
        const order = SETTINGS[orderKey].filter(unitId => unitId !== id);
        let position = order.length;
        if (beforeId && beforeId !== id && order.includes(beforeId)) {
            position = order.indexOf(beforeId);
        } else if (zone) {
            const zoneIds = [...zone.querySelectorAll('.prompt-field[data-scene-row]')].map(idOfContainer).filter(unitId => unitId !== id && order.includes(unitId));
            const last = zoneIds.at(-1);
            if (last) position = order.indexOf(last) + 1;
            else if (zone !== scene && zone.dataset.side) {
                // an empty side box: after the box's own pinned unit (positive / negative)
                const anchor = orderKey === 'prompt_negative_order' ? 'negative' : 'positive';
                if (order.includes(anchor)) position = order.indexOf(anchor) + 1;
            }
        }
        order.splice(position, 0, id);
        SETTINGS[orderKey] = order;
        const custom = customOf(id);
        if (custom && isRegional()) {
            if (side === 'both') delete custom.side; else custom.side = side;
            persistFields();
        }
        layoutScene();
    }

    // A capsule (or a selection of capsules) dragged from a row can be dropped on
    // another row's header: same payload as the chip rows
    // (scripts/renderer/components/tagCapsuleField.js); Ctrl / Alt copies instead of moving.
    const CAPSULE_MIME = 'application/x-saa-capsule';
    function attachCapsuleDropTarget(row, fieldId) {
        const carriesCapsule = event => Array.from(event.dataTransfer?.types ?? []).includes(CAPSULE_MIME);
        row.addEventListener('dragover', event => {
            if (!carriesCapsule(event)) return;
            event.preventDefault();
            event.dataTransfer.dropEffect = event.ctrlKey || event.altKey ? 'copy' : 'move';
            row.classList.add('is-drop-target');
        });
        row.addEventListener('dragleave', () => row.classList.remove('is-drop-target'));
        row.addEventListener('drop', event => {
            row.classList.remove('is-drop-target');
            if (!carriesCapsule(event)) return;
            event.preventDefault();
            let payload = null;
            try { payload = JSON.parse(event.dataTransfer.getData(CAPSULE_MIME) || 'null'); } catch { payload = null; }
            if (!payload?.field || !payload?.id || payload.field === fieldId) return;
            const what = Array.isArray(payload.ids) && payload.ids.length > 1 ? payload.ids : payload.id;
            const moved = globalThis.prompt?.tagCapsuleFields?.transfer?.(payload.field, what, fieldId, { copy: event.ctrlKey || event.altKey });
            if (moved) scheduleCountRefresh(); // the tag counts of both rows change
        });
    }

    // ------------------------------------------------------------- regional block
    // The Regional settings (split, ratios, strengths, swap) move from the Characters
    // card into the block's head; the LEFT / RIGHT boxes hold the side units.

    // The side's characters come from the regional character control in the
    // Characters card: its slot triggers carry the display name and open the picker.
    function sideCharacterTriggers(side) {
        const index = side === 'left' ? 0 : 1;
        const trigger = document.querySelector(`.dropdown-character-regional .character-selection-field[data-index="${index}"] .character-selection-trigger`);
        return trigger ? [trigger] : [];
    }
    function sideCharacterName(side) {
        return sideCharacterTriggers(side)
            .map(trigger => {
                const name = (trigger.querySelector('.character-selection-name')?.textContent ?? trigger.textContent).trim();
                return trigger.querySelector('.character-selection-oc-badge') ? `${name} (OC)` : name;
            })
            .filter(name => name !== '' && name.toLowerCase() !== 'none')
            .join(' · ');
    }

    function ensureGroup() {
        if (group) return group;
        group = document.createElement('div');
        group.className = 'scene-regional';
        const head = document.createElement('div');
        head.className = 'scene-regional-head';
        const title = document.createElement('span');
        title.className = 'scene-regional-title';
        head.appendChild(title);
        const swap = document.createElement('button');
        swap.type = 'button';
        swap.className = 'prompt-side-swap';
        swap.title = 'Swap left and right: prompts, negatives, characters, strengths';
        swap.appendChild(svgIcon(ICON_SWAP, 12));
        swap.appendChild(document.createTextNode('Swap'));
        swap.addEventListener('click', () => swapSides());
        head.appendChild(swap);
        group.appendChild(head);
        const settings = document.createElement('div');
        settings.className = 'scene-regional-settings';
        const regionalContainer = document.querySelector('.regional-condition-container');
        if (regionalContainer) settings.appendChild(regionalContainer);
        group.appendChild(settings);
        for (const side of ['left', 'right']) {
            const box = document.createElement('div');
            box.className = `scene-side is-${side}`;
            box.dataset.side = side;
            const sideHead = document.createElement('div');
            sideHead.className = 'scene-side-head';
            const name = document.createElement('span');
            name.className = 'scene-side-name';
            sideHead.appendChild(name);
            const character = document.createElement('button');
            character.type = 'button';
            character.className = `prompt-side-character is-${side}`;
            character.appendChild(svgIcon(ICON_PERSON, 12));
            const characterName = document.createElement('span');
            characterName.className = 'prompt-side-character-name';
            character.appendChild(characterName);
            character.appendChild(svgIcon(ICON_CHEVRON_RIGHT));
            character.addEventListener('click', () => sideCharacterTriggers(side)[0]?.click());
            sideHead.appendChild(character);
            const add = document.createElement('button');
            add.type = 'button';
            add.className = 'scene-add-button is-side';
            add.addEventListener('click', () => openAddPopover(add, side));
            const addHost = document.createElement('span');
            addHost.className = 'scene-add';
            addHost.appendChild(add);
            sideHead.appendChild(addHost);
            box.appendChild(sideHead);
            const rows = document.createElement('div');
            rows.className = 'scene-side-rows';
            box.appendChild(rows);
            group.appendChild(box);
        }
        return group;
    }

    // writes a text node only when the text changed (no DOM churn on a no-op refresh)
    function setText(element, value) {
        if (element && element.textContent !== value) element.textContent = value;
    }

    function renderGroupText() {
        if (!group) return;
        setText(group.querySelector('.scene-regional-title'), text('regional_condition', 'Regional Condition'));
        // the settings container is hidden by callback_regional_condition while it can
        // find it; inside the block it is shown whenever the block is
        group.querySelector('.regional-condition-container')?.removeAttribute('hidden');
        for (const side of ['left', 'right']) {
            const box = group.querySelector(`.scene-side.is-${side}`);
            setText(box.querySelector('.scene-side-name'), sideLabel(side, SETTINGS.regional_split));
            // inside a box the side is the box: "Positive (right)" reads "Positive"
            for (const row of box.querySelectorAll('.prompt-field[data-scene-row]')) {
                const id = idOfContainer(row);
                const short = id.startsWith('positive') ? text('ui_field_positive', 'Positive') : id.startsWith('negative') ? text('ui_field_negative', 'Negative') : null;
                const label = row.querySelector('.tag-field-label');
                const node = label && [...label.childNodes].find(child => child.nodeType === Node.TEXT_NODE);
                if (short && node && node.textContent !== short) node.textContent = short;
            }
            const character = box.querySelector('.prompt-side-character');
            const name = sideCharacterName(side);
            character.classList.toggle('is-empty', name === '');
            character.title = `Change the ${side} character`;
            setText(character.querySelector('.prompt-side-character-name'), name || text('ui_scene_choose_character', 'Choose character…'));
        }
    }

    // Swap left and right: prompts, negatives, weight plans, characters, strengths
    // and the side of every custom field - one undo step. The controls are pushed
    // the new values; the settings were already patched, so nothing fires twice.
    function swapSides() {
        const patch = swapSidesPatch(SETTINGS);
        const mutate = () => {
            for (const [key, value] of Object.entries(patch)) SETTINGS[key] = value;
            globalThis.prompt?.positive?.setValue?.(SETTINGS.api_prompt);
            globalThis.prompt?.positive_right?.setValue?.(SETTINGS.api_prompt_right);
            globalThis.prompt?.negative_left?.setValue?.(SETTINGS.api_neg_prompt_left);
            globalThis.prompt?.negative_right?.setValue?.(SETTINGS.api_neg_prompt_right);
            globalThis.regional?.str_left?.setValue?.(SETTINGS.regional_str_left);
            globalThis.regional?.str_right?.setValue?.(SETTINGS.regional_str_right);
            globalThis.regional?.option_left?.updateDefaults?.(SETTINGS.regional_option_left);
            globalThis.regional?.option_right?.updateDefaults?.(SETTINGS.regional_option_right);
            const list = globalThis.characterListRegional;
            if (list?.getKey) {
                const keys = list.getKey();
                const weights = [0, 1].map(index => list.getTextValue(index));
                list.updateDefaults(keys[1], keys[0]);
                [1, 0].forEach((from, to) => list.setTextValue(to, weights[from]));
                document.dispatchEvent(new CustomEvent('saa:regional-characters-changed'));
            }
            fields = normalizeCustomFields(SETTINGS.prompt_custom_fields);
            persistFields();
            renderCustomFields();
            globalThis.prompt?.tagCapsuleFields?.loadFromSettings?.(SETTINGS);
            layoutScene();
        };
        const persistence = globalThis.settingsPersistence;
        if (persistence?.runEditTransaction) return persistence.runEditTransaction({ source: 'regional-swap', sections: ['prompt', 'generation'] }, mutate);
        return mutate();
    }

    // ---------------------------------------------------------------- layout

    // Rows in Scene order. Regional: the units of one side go into that side's box,
    // the block sits where the (left) Positive would be; everything else is shared.
    function layoutScene() {
        const host = ensureScene();
        ensureViewsRow();
        const regional = isRegional();
        const placed = new Set();
        const sequence = []; // { id } | { block: true }
        const boxes = { left: [], right: [] };

        const put = (id, side) => {
            if (regional && side !== 'both') {
                if (boxes[side].length === 0 && boxes.left.length === 0 && boxes.right.length === 0) sequence.push({ block: true });
                boxes[side].push(id);
            } else {
                sequence.push({ id });
            }
            placed.add(id);
        };
        const unitSide = id => (regional && id !== 'exclude' ? sideOf(id, fields) : 'both');

        for (const id of SETTINGS.prompt_positive_order) {
            if (STRUCTURAL_UNITS.has(id) && id !== 'views') continue;
            put(id, unitSide(id));
            if (id === 'positive' && regional) put('positive_right', 'right');
        }
        for (const id of SETTINGS.prompt_negative_order) {
            put(id, unitSide(id));
            if (id === 'negative' && regional) {
                put('negative_left', 'left');
                put('negative_right', 'right');
            }
        }
        sequence.push({ id: 'exclude' });
        placed.add('exclude');

        const prepare = (id) => {
            const container = unitContainer(id);
            if (!container) return null;
            container.dataset.sceneRow = chainOf(id);
            decorateRow(container, id);
            return container;
        };

        // bring the host into order (the containers are live components: only the
        // ones out of place move, an unchanged order moves nothing)
        const ordered = [];
        for (const entry of sequence) {
            if (entry.block) {
                const block = ensureGroup();
                for (const side of ['left', 'right']) {
                    const rows = block.querySelector(`.scene-side.is-${side} .scene-side-rows`);
                    syncChildren(rows, boxes[side].map(prepare).filter(Boolean));
                }
                ordered.push(block);
                continue;
            }
            const container = prepare(entry.id);
            if (container) ordered.push(container);
        }
        // containers that are not in this layout (side fields while Regional is off)
        // stay in the DOM, hidden by their inline display
        for (const id of [...Object.keys(BUILTIN_CONTAINERS), ...fields.map(field => field.id)]) {
            if (placed.has(id)) continue;
            const container = prepare(id);
            if (container) ordered.push(container);
        }
        if (!regional && group?.parentElement) group.remove();
        syncChildren(host, ordered);
        if (regional) renderGroupText();
        addFooter.querySelector('.scene-add-button').textContent = text('ui_scene_add_field', '+ Add field');
        for (const button of group?.querySelectorAll('.scene-add-button.is-side') ?? []) button.textContent = text('ui_scene_add_field', '+ Add field');
        applyRowStates();
    }

    // Makes `nodes` the children of `parent` in that order, moving only what is out
    // of place (a cursor walk: same idea as the chip renderer).
    function syncChildren(parent, nodes) {
        let cursor = parent.firstChild;
        for (const node of nodes) {
            if (node === cursor) { cursor = cursor.nextSibling; continue; }
            parent.insertBefore(node, cursor);
        }
        while (cursor) {
            const next = cursor.nextSibling;
            cursor.remove();
            cursor = next;
        }
    }

    let countTimer = 0;
    function scheduleCountRefresh() {
        clearTimeout(countTimer);
        countTimer = setTimeout(() => {
            for (const container of sceneRows()) {
                const count = container.querySelector('.scene-count');
                if (!count) continue;
                const n = tagCount(idOfContainer(container));
                count.textContent = n > 0 ? String(n) : '';
            }
        }, 400);
    }
    // capsule edits fire a bubbling input event; a preset apply / undo sets the
    // value through the textbox control, which raises this (non-bubbling) event
    document.addEventListener('mytextbox-value-set', event => {
        if (scene?.contains(event.target)) scheduleCountRefresh();
    }, true);

    // LEFT / RIGHT read TOP / BOTTOM for a top-bottom split (renderer.js Split dropdown)
    document.addEventListener('saa:regional-split-changed', () => renderGroupText());
    document.addEventListener('saa:regional-characters-changed', () => renderGroupText());

    // ---------------------------------------------------------------- presets

    function fieldPresets(key) {
        const store = SETTINGS.prompt_field_presets;
        return (store && typeof store === 'object' && Array.isArray(store[key])) ? store[key] : [];
    }

    function saveFieldPresets(key, presets) {
        const store = (SETTINGS.prompt_field_presets && typeof SETTINGS.prompt_field_presets === 'object')
            ? { ...SETTINGS.prompt_field_presets } : {};
        store[key] = presets;
        SETTINGS.prompt_field_presets = store;
    }

    function attachPresetButton(container, key, getComponent, onApplied) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'prompt-preset-button';
        button.title = 'Presets';
        const glyph = document.createElement('span');
        glyph.className = 'preset-icon';
        glyph.setAttribute('role', 'img');
        glyph.setAttribute('aria-label', 'presets');
        glyph.style.webkitMask = "url('scripts/svg/preset.svg') no-repeat center / contain";
        glyph.style.mask = "url('scripts/svg/preset.svg') no-repeat center / contain";
        button.appendChild(glyph);
        button.addEventListener('click', (event) => {
            event.stopPropagation();
            togglePresetPanel(container, key, getComponent, onApplied);
        });
        // Sit inside the field's header tool row (next to the text/capsule toggle)
        // rather than floating over it; absolute placement is the last resort.
        const tools = container.querySelector('.tag-field-tools');
        const header = container.querySelector('div[class^="myTextbox-"][class*="-header"]');
        if (tools) {
            button.classList.add('is-inline');
            tools.insertBefore(button, tools.firstChild);
        } else if (header) {
            button.classList.add('is-inline');
            header.classList.add('has-preset-button');
            header.appendChild(button);
        } else {
            container.appendChild(button);
        }
    }

    function togglePresetPanel(container, key, getComponent, onApplied) {
        const existing = container.querySelector('.prompt-preset-panel');
        if (existing) { existing.remove(); return; }
        closePanels();

        const panel = document.createElement('div');
        panel.className = 'prompt-preset-panel';

        const renderRows = () => {
            for (const row of panel.querySelectorAll('.prompt-preset-row')) row.remove();
            for (const preset of fieldPresets(key)) {
                const row = document.createElement('div');
                row.className = 'prompt-preset-row';
                const apply = document.createElement('button');
                apply.type = 'button';
                apply.className = 'prompt-preset-apply';
                apply.textContent = preset.name;
                apply.title = preset.text;
                apply.addEventListener('click', () => {
                    getComponent()?.setValue?.(preset.text);
                    onApplied(preset.text); // setValue does not fire the input callback
                    panel.remove();
                });
                const remove = document.createElement('button');
                remove.type = 'button';
                remove.className = 'prompt-preset-delete';
                remove.textContent = '×';
                remove.title = 'Delete preset';
                remove.addEventListener('click', () => {
                    saveFieldPresets(key, fieldPresets(key).filter(item => item !== preset));
                    renderRows();
                });
                row.append(apply, remove);
                panel.insertBefore(row, saveRow);
            }
        };

        const saveRow = document.createElement('div');
        saveRow.className = 'prompt-preset-save-row';
        const nameInput = document.createElement('input');
        nameInput.type = 'text';
        nameInput.placeholder = 'Preset name';
        nameInput.maxLength = 40;
        const saveButton = document.createElement('button');
        saveButton.type = 'button';
        saveButton.textContent = 'Save';
        saveButton.addEventListener('click', () => {
            const name = nameInput.value.trim();
            const text = String(getComponent()?.getValue?.() ?? '');
            if (name === '') return;
            const presets = fieldPresets(key).filter(item => item.name !== name);
            presets.push({ name, text });
            saveFieldPresets(key, presets);
            nameInput.value = '';
            renderRows();
        });
        saveRow.append(nameInput, saveButton);
        panel.appendChild(saveRow);

        renderRows();
        container.appendChild(panel);
    }

    function closePanels() {
        for (const panel of document.querySelectorAll('.prompt-preset-panel')) panel.remove();
    }
    document.addEventListener('click', (event) => {
        if (!event.target.closest?.('.prompt-preset-panel') && !event.target.closest?.('.prompt-preset-button')) {
            closePanels();
        }
    });

    function attachBuiltinPresetButtons() {
        for (const [unitId, settingsKey] of Object.entries(PRESETABLE_BUILTINS)) {
            const container = unitContainer(unitId);
            if (!container || container.querySelector('.prompt-preset-button')) continue;
            attachPresetButton(container, unitId, () => globalThis.prompt[unitId],
                (text) => { SETTINGS[settingsKey] = text; });
        }
    }

    // ---------------------------------------------------------------- card tools
    // The Regional switch moves from the Characters card into the Scene's head (its
    // block lives in the Scene now); the "n off" note follows it.
    const regionalSwitch = document.querySelector('.regional-condition-trigger-dummy');
    if (regionalSwitch) toolsHost.insertBefore(regionalSwitch, toolsHost.firstChild);
    const mutedNote = document.createElement('span');
    mutedNote.className = 'scene-muted-note';
    toolsHost.insertBefore(mutedNote, toolsHost.firstChild);

    renderCustomFields();
    attachBuiltinPresetButtons();
    layoutScene();

    return {
        // Re-syncs the containers from the settings (definitions, texts, order):
        // called after a preset load / undo has rewritten prompt_custom_fields.
        refresh: () => {
            syncCast();
            fields = normalizeCustomFields(SETTINGS.prompt_custom_fields);
            persistFields();
            renderCustomFields();
            layoutScene();
        },
        // the old Fields… editor: opening it now opens the "+ Add field" popover
        openEditor: () => openAddPopover(addFooter.querySelector('.scene-add-button'), 'both'),
        // re-render the rows only (character names, counts, labels)
        renderList: () => { applyRowStates(); if (isRegional()) renderGroupText(); },
        updateLanguage: () => layoutScene(),
        swapSides,
        setMuted,
        // Weight plans / batch of a custom field live in its entry (tagCapsuleField
        // writes them through here so a later rename / reorder cannot clobber them).
        setFieldExtras: (id, extras) => {
            // The settings are the source of truth: a preset load / undo rewrites
            // prompt_custom_fields before this manager re-syncs, and the capsule
            // fields write their plans back during that reload - persisting the
            // manager's copy here would put the previous field set back.
            const current = normalizeCustomFields(SETTINGS.prompt_custom_fields);
            if (!current.some(field => field.id === id)) return;
            fields = setCustomFieldExtras(current, id, extras);
            persistFields();
        },
        // visible prompt fields in Scene order (right-click "Move to" targets)
        listFields: () => sceneRows()
            .filter(container => isAvailable(container) && idOfContainer(container) !== 'views')
            .map(container => ({ id: idOfContainer(container), label: fieldLabel(idOfContainer(container)) })),
    };
}
