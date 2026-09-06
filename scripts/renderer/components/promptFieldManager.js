// Custom prompt fields: user-named text fields that join the positive or
// negative chain, a field/order editor, and per-field presets
// (background / style / custom fields).
//
// State lives in settings: prompt_custom_fields [{id, name, polarity, text}],
// prompt_positive_order / prompt_negative_order (unit id arrays; see
// scripts/shared/promptFieldOrder.js), prompt_field_presets {key: [{name, text}]}.
import { setupTextbox } from './myTextbox.js';
import { setupTagSelectionModal } from '../tagSelectionModal.js';
import {
    STRUCTURAL_UNITS,
    makeCustomFieldId,
    normalizeCustomFields,
    normalizeOrder,
    setCustomFieldExtras,
} from '../../shared/promptFieldOrder.js';

const BUILTIN_LABELS = {
    common: 'Common',
    views: 'View (angle / camera)',
    background: 'Background',
    style: 'Style',
    ai: 'AI prompt',
    characters: 'Characters',
    positive: 'Positive',
    negative: 'Negative',
};

// Units with a text container inside .prompt-fields (structural units live elsewhere).
const BUILTIN_CONTAINERS = {
    common: '.prompt-common',
    background: '.prompt-background',
    style: '.prompt-style',
    positive: '.prompt-positive',
    positive_right: '.prompt-positive-right',
    negative: '.prompt-negative',
    exclude: '.prompt-exclude',
};

// Built-in fields whose text a preset can replace, and where the value lives.
const PRESETABLE_BUILTINS = {
    background: 'prompt_background',
    style: 'prompt_style',
};

export function setupPromptFieldManager() {
    const SETTINGS = globalThis.globalSettings;
    const fieldsHost = document.querySelector('.prompt-fields');
    const toolsHost = document.querySelector('#prompt-text-container .ui-card-tools');
    if (!fieldsHost || !toolsHost) {
        console.error('[promptFieldManager] prompt card containers not found');
        return null;
    }

    let fields = normalizeCustomFields(SETTINGS.prompt_custom_fields);
    persistFields();

    function persistFields() {
        SETTINGS.prompt_custom_fields = fields.map(field => ({ ...field }));
        SETTINGS.prompt_positive_order = normalizeOrder(SETTINGS.prompt_positive_order, 'positive', fields);
        SETTINGS.prompt_negative_order = normalizeOrder(SETTINGS.prompt_negative_order, 'negative', fields);
    }

    // Looked up by id at call time: `fields` is replaced wholesale when the settings
    // are reloaded (preset load, undo), so a closure over a field object would go stale.
    function setFieldText(id, text) {
        const field = fields.find(entry => entry.id === id);
        if (!field) return;
        field.text = text;
        persistFields();
    }

    const customColor = () => (SETTINGS.css_style === 'dark' ? 'orchid' : 'DarkMagenta');

    function renderCustomFields() {
        const wanted = new Set(fields.map(field => field.id));
        for (const container of fieldsHost.querySelectorAll('.prompt-custom-field')) {
            const id = container.dataset.fieldId;
            if (!wanted.has(id)) {
                // A field can vanish because a prompt preset without it was loaded;
                // its per-field presets stay so the field returns intact with the
                // preset that has it (the editor's delete drops them explicitly).
                container.remove();
                delete globalThis.prompt[id];
                globalThis.prompt.tagCapsuleFields?.remove?.(id);
            }
        }
        for (const field of fields) {
            const containerClass = `prompt-${field.id}`;
            let container = fieldsHost.querySelector(`.${containerClass}`);
            if (!container) {
                container = document.createElement('div');
                container.className = `${containerClass} prompt-field prompt-custom-field`;
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
                setupTagSelectionModal([control], [field.id]);
                globalThis.prompt.tagCapsuleFields?.add?.(control, field.id);
                attachPresetButton(container, field.id, () => globalThis.prompt[field.id],
                    (text) => setFieldText(field.id, text));
            } else {
                const control = globalThis.prompt[field.id];
                control?.setTitle?.(field.name);
                // settings reload (preset, undo): push the stored text into the live textbox
                if (control?.getValue && String(control.getValue() ?? '') !== field.text) control.setValue(field.text);
                // setTitle rewrites the textbox header's textContent, which used to wipe a
                // preset button parked there — put it back if it is gone
                if (!container.querySelector('.prompt-preset-button')) {
                    attachPresetButton(container, field.id, () => globalThis.prompt[field.id],
                        (text) => setFieldText(field.id, text));
                }
            }
        }
    }

    function unitContainer(id) {
        if (BUILTIN_CONTAINERS[id]) return fieldsHost.querySelector(BUILTIN_CONTAINERS[id]);
        return fieldsHost.querySelector(`.prompt-${id}`);
    }

    // ------------------------------------------------- list + focus editor layout
    // One field list on the left (both chains, always visible), one large editor
    // on the right showing the selected field's existing container - the field
    // components (capsule view, choose-tags, presets) move with their container.

    const BUILTIN_STRIPES = {
        common: 'common', background: 'view', style: 'view', positive: 'positive',
        positive_right: 'positive', negative: 'negative', exclude: 'exclude',
    };

    let selectedField = '';
    try { selectedField = localStorage.getItem('saa.promptField') || 'positive'; } catch { selectedField = 'positive'; }

    function ensureLayout() {
        let layout = fieldsHost.querySelector('.prompt-layout');
        if (!layout) {
            layout = document.createElement('div');
            layout.className = 'prompt-layout';
            const list = document.createElement('div');
            list.className = 'prompt-field-list';
            const editor = document.createElement('div');
            editor.className = 'prompt-editor-host';
            layout.append(list, editor);
            fieldsHost.appendChild(layout);
            editor.addEventListener('input', () => scheduleCountRefresh());
        }
        return layout;
    }

    function fieldValue(id) {
        return String(globalThis.prompt?.[id]?.getValue?.() ?? '');
    }

    function tagCount(id) {
        return fieldValue(id).split(/[,\n]/).map(part => part.trim()).filter(Boolean).length;
    }

    function listEntries() {
        const entries = [];
        entries.push({ section: 'POSITIVE', stripe: 'positive' });
        for (const id of SETTINGS.prompt_positive_order) {
            if (STRUCTURAL_UNITS.has(id)) continue;
            entries.push({ id });
            if (id === 'positive') entries.push({ id: 'positive_right' });
        }
        entries.push({ section: 'NEGATIVE', stripe: 'negative' });
        for (const id of SETTINGS.prompt_negative_order) entries.push({ id });
        entries.push({ section: 'BOTH', stripe: 'exclude' });
        entries.push({ id: 'exclude' });
        return entries;
    }

    function fieldLabel(id) {
        const custom = fields.find(field => field.id === id);
        if (custom) return custom.name;
        const container = unitContainer(id);
        const label = container?.querySelector('.tag-field-label')?.textContent
            || container?.querySelector('div[class^="myTextbox-"][class*="-header"]')?.firstChild?.textContent;
        if (label && label.trim() !== '') return label.trim();
        return { common: 'Common', background: 'Background', style: 'Style', positive: 'Positive', positive_right: 'Positive (right)', negative: 'Negative', exclude: 'Exclude' }[id] || id;
    }

    // positive_right toggles via inline display (regional mode); a class with
    // !important is the only hiding that wins over that inline style.
    function isAvailable(container) {
        return Boolean(container) && container.style.display !== 'none';
    }

    function selectField(id) {
        selectedField = id;
        try { localStorage.setItem('saa.promptField', id); } catch { /* ignore */ }
        const layout = ensureLayout();
        const editor = layout.querySelector('.prompt-editor-host');
        const target = unitContainer(id);
        for (const container of editor.querySelectorAll('.prompt-field')) {
            container.classList.toggle('is-off-screen', container !== target);
        }
        renderFieldList();
    }

    function renderFieldList() {
        const layout = ensureLayout();
        const list = layout.querySelector('.prompt-field-list');
        list.innerHTML = '';
        for (const entry of listEntries()) {
            if (entry.section) {
                const heading = document.createElement('div');
                heading.className = `prompt-field-list-section is-${entry.stripe}`;
                heading.textContent = entry.section;
                list.appendChild(heading);
                continue;
            }
            const container = unitContainer(entry.id);
            // mirror app-side visibility (e.g. positive_right only in regional mode)
            if (!isAvailable(container)) continue;
            const row = document.createElement('button');
            row.type = 'button';
            row.className = 'prompt-field-list-row';
            row.classList.toggle('is-selected', entry.id === selectedField);
            row.dataset.fieldId = entry.id;
            const dot = document.createElement('span');
            dot.className = 'prompt-field-list-dot';
            dot.dataset.stripe = container.dataset.stripe || BUILTIN_STRIPES[entry.id] || 'view';
            const name = document.createElement('span');
            name.className = 'prompt-field-list-name';
            name.textContent = fieldLabel(entry.id);
            const count = document.createElement('span');
            count.className = 'prompt-field-list-count';
            const n = tagCount(entry.id);
            count.textContent = n > 0 ? String(n) : '';
            row.append(dot, name, count);
            row.addEventListener('click', () => selectField(entry.id));
            list.appendChild(row);
        }
        const add = document.createElement('button');
        add.type = 'button';
        add.className = 'prompt-field-list-add';
        add.textContent = '+ Add field';
        add.addEventListener('click', openEditor);
        list.appendChild(add);
    }

    let countTimer = 0;
    function scheduleCountRefresh() {
        clearTimeout(countTimer);
        countTimer = setTimeout(() => {
            const layout = fieldsHost.querySelector('.prompt-layout');
            if (!layout) return;
            for (const row of layout.querySelectorAll('.prompt-field-list-row')) {
                const n = tagCount(row.dataset.fieldId);
                row.querySelector('.prompt-field-list-count').textContent = n > 0 ? String(n) : '';
            }
        }, 400);
    }
    // capsule edits and preset applies bypass textarea input events, and the
    // regional toggle changes which fields exist; a slow poll keeps the counts
    // honest and re-renders the list when availability changes
    let availabilityKey = '';
    setInterval(() => {
        if (document.hidden) return;
        const key = listEntries().filter(entry => entry.id && isAvailable(unitContainer(entry.id))).map(entry => entry.id).join(',');
        if (key !== availabilityKey) {
            availabilityKey = key;
            renderFieldList();
        }
        scheduleCountRefresh();
    }, 2500);

    function applyDomOrder() {
        const layout = ensureLayout();
        const editor = layout.querySelector('.prompt-editor-host');
        for (const entry of listEntries()) {
            if (entry.section) continue;
            const container = unitContainer(entry.id);
            if (container) editor.appendChild(container);
        }
        const aiCard = fieldsHost.querySelector('.ai-card');
        if (aiCard) fieldsHost.appendChild(aiCard);
        if (!unitContainer(selectedField)) selectedField = 'positive';
        selectField(selectedField);
    }

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

    // ------------------------------------------------------------ field editor

    function moveUnit(orderKey, id, delta) {
        const order = [...SETTINGS[orderKey]];
        const index = order.indexOf(id);
        const target = index + delta;
        if (index < 0 || target < 0 || target >= order.length) return;
        [order[index], order[target]] = [order[target], order[index]];
        SETTINGS[orderKey] = order;
        applyDomOrder();
        renderEditorLists();
    }

    let editor = null;
    let renderEditorLists = () => {};

    function openEditor() {
        if (editor) { closeEditor(); return; }
        editor = document.createElement('div');
        editor.className = 'prompt-field-editor-backdrop';
        editor.addEventListener('click', (event) => { if (event.target === editor) closeEditor(); });

        const panel = document.createElement('div');
        panel.className = 'prompt-field-editor';
        panel.innerHTML = `
            <div class="prompt-field-editor-head">
                <span>Prompt fields &amp; order</span>
                <button type="button" class="prompt-field-editor-close">×</button>
            </div>
            <div class="prompt-field-editor-columns">
                <div><h4>Positive chain</h4><div class="prompt-field-editor-list" data-order="prompt_positive_order"></div></div>
                <div><h4>Negative chain</h4><div class="prompt-field-editor-list" data-order="prompt_negative_order"></div></div>
            </div>
            <div class="prompt-field-editor-add">
                <input type="text" class="prompt-field-editor-name" placeholder="New field name" maxlength="40">
                <select class="prompt-field-editor-polarity">
                    <option value="positive">Positive</option>
                    <option value="negative">Negative</option>
                </select>
                <button type="button" class="prompt-field-editor-add-button">+ Add field</button>
            </div>`;
        editor.appendChild(panel);
        document.body.appendChild(editor);

        panel.querySelector('.prompt-field-editor-close').addEventListener('click', closeEditor);
        panel.querySelector('.prompt-field-editor-add-button').addEventListener('click', () => {
            const nameInput = panel.querySelector('.prompt-field-editor-name');
            const name = nameInput.value.trim();
            if (name === '') return;
            const polarity = panel.querySelector('.prompt-field-editor-polarity').value;
            fields.push({ id: makeCustomFieldId(), name, polarity, text: '' });
            nameInput.value = '';
            persistFields();
            renderCustomFields();
            applyDomOrder();
            renderEditorLists();
        });

        renderEditorLists = () => {
            for (const list of panel.querySelectorAll('.prompt-field-editor-list')) {
                const orderKey = list.dataset.order;
                list.innerHTML = '';
                const order = SETTINGS[orderKey];
                for (const id of order) {
                    const custom = fields.find(field => field.id === id);
                    const row = document.createElement('div');
                    row.className = 'prompt-field-editor-row';

                    const label = document.createElement('span');
                    label.className = 'prompt-field-editor-label';
                    label.textContent = custom ? custom.name : (BUILTIN_LABELS[id] || id);
                    if (STRUCTURAL_UNITS.has(id)) label.classList.add('is-structural');
                    row.appendChild(label);

                    const up = document.createElement('button');
                    up.type = 'button';
                    up.textContent = '↑';
                    up.addEventListener('click', () => moveUnit(orderKey, id, -1));
                    const down = document.createElement('button');
                    down.type = 'button';
                    down.textContent = '↓';
                    down.addEventListener('click', () => moveUnit(orderKey, id, 1));
                    row.append(up, down);

                    if (custom) {
                        const rename = document.createElement('button');
                        rename.type = 'button';
                        rename.textContent = '✎';
                        rename.title = 'Rename';
                        rename.addEventListener('click', () => {
                            // inline rename: swap the label for a text input (no blocking dialogs)
                            const input = document.createElement('input');
                            input.type = 'text';
                            input.value = custom.name;
                            input.maxLength = 40;
                            input.className = 'prompt-field-editor-rename';
                            const commit = () => {
                                const name = input.value.trim();
                                if (name !== '') custom.name = name.slice(0, 40);
                                persistFields();
                                renderCustomFields();
                                renderEditorLists();
                            };
                            input.addEventListener('keydown', (event) => {
                                if (event.key === 'Enter') commit();
                                if (event.key === 'Escape') renderEditorLists();
                            });
                            input.addEventListener('blur', commit);
                            label.replaceWith(input);
                            input.focus();
                            input.select();
                        });
                        const remove = document.createElement('button');
                        remove.type = 'button';
                        remove.textContent = '×';
                        remove.title = 'Delete field';
                        remove.addEventListener('click', () => {
                            fields = fields.filter(field => field.id !== custom.id);
                            SETTINGS[orderKey] = SETTINGS[orderKey].filter(unitId => unitId !== custom.id);
                            // explicit delete: the field's preset bucket goes with it
                            if (SETTINGS.prompt_field_presets && typeof SETTINGS.prompt_field_presets === 'object' && custom.id in SETTINGS.prompt_field_presets) {
                                const store = { ...SETTINGS.prompt_field_presets };
                                delete store[custom.id];
                                SETTINGS.prompt_field_presets = store;
                            }
                            persistFields();
                            renderCustomFields();
                            applyDomOrder();
                            renderEditorLists();
                        });
                        row.append(rename, remove);
                    }
                    list.appendChild(row);
                }
            }
        };
        renderEditorLists();
    }

    function closeEditor() {
        editor?.remove();
        editor = null;
        renderEditorLists = () => {};
    }

    const editorButton = document.createElement('button');
    editorButton.type = 'button';
    editorButton.className = 'prompt-field-editor-open';
    editorButton.textContent = 'Fields ⇅';
    editorButton.title = 'Add, remove, and reorder prompt fields';
    editorButton.addEventListener('click', openEditor);
    toolsHost.insertBefore(editorButton, toolsHost.firstChild);

    renderCustomFields();
    attachBuiltinPresetButtons();
    applyDomOrder();

    return {
        // Re-syncs the containers from the settings (definitions, texts, order):
        // called after a preset load / undo has rewritten prompt_custom_fields.
        refresh: () => {
            fields = normalizeCustomFields(SETTINGS.prompt_custom_fields);
            persistFields();
            renderCustomFields();
            applyDomOrder();
        },
        openEditor,
        // Weight plans / batch of a custom field live in its entry (tagCapsuleField
        // writes them through here so a later rename / reorder cannot clobber them).
        setFieldExtras: (id, extras) => {
            if (!fields.some(field => field.id === id)) return;
            fields = setCustomFieldExtras(fields, id, extras);
            persistFields();
        },
        // visible prompt fields in chain order (right-click "Move to" targets)
        listFields: () => listEntries()
            .filter(entry => entry.id && isAvailable(unitContainer(entry.id)))
            .map(entry => ({ id: entry.id, label: fieldLabel(entry.id) })),
    };
}
