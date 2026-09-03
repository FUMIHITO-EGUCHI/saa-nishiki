// Custom prompt fields: user-named text fields that join the positive or
// negative chain, a field/order editor, and per-field presets
// (background / style / custom fields).
//
// State lives in settings: prompt_custom_fields [{id, name, polarity, text}],
// prompt_positive_order / prompt_negative_order (unit id arrays; see
// scripts/shared/promptFieldOrder.js), prompt_field_presets {key: [{name, text}]}.
import { setupTextbox } from './myTextbox.js';
import {
    STRUCTURAL_UNITS,
    makeCustomFieldId,
    normalizeCustomFields,
    normalizeOrder,
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
    negative: '.prompt-negative',
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

    const customColor = () => (SETTINGS.css_style === 'dark' ? 'orchid' : 'DarkMagenta');

    function renderCustomFields() {
        const wanted = new Set(fields.map(field => field.id));
        for (const container of fieldsHost.querySelectorAll('.prompt-custom-field')) {
            const id = container.dataset.fieldId;
            if (!wanted.has(id)) {
                container.remove();
                delete globalThis.prompt[id];
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
                }, true, (value) => {
                    field.text = value;
                    persistFields();
                });
                attachPresetButton(container, field.id, () => globalThis.prompt[field.id],
                    (text) => { field.text = text; persistFields(); });
            } else {
                globalThis.prompt[field.id]?.setTitle?.(field.name);
            }
        }
    }

    function unitContainer(id) {
        if (BUILTIN_CONTAINERS[id]) return fieldsHost.querySelector(BUILTIN_CONTAINERS[id]);
        return fieldsHost.querySelector(`.prompt-${id}`);
    }

    function ensureGroup(name, title) {
        let group = fieldsHost.querySelector(`.prompt-group-${name}`);
        if (!group) {
            group = document.createElement('section');
            group.className = `prompt-group prompt-group-${name}`;
            const heading = document.createElement('div');
            heading.className = 'prompt-group-title';
            heading.textContent = title;
            group.appendChild(heading);
            fieldsHost.appendChild(group);
        }
        return group;
    }

    // Display order mirrors the concatenation order. Text fields live inside a
    // Positive and a Negative frame (positive-right pinned after positive);
    // exclude (applies to both) and the AI card stay outside the frames.
    function applyDomOrder() {
        const positiveGroup = ensureGroup('positive', 'Positive');
        const negativeGroup = ensureGroup('negative', 'Negative');
        fieldsHost.appendChild(positiveGroup);
        for (const id of SETTINGS.prompt_positive_order) {
            if (STRUCTURAL_UNITS.has(id)) continue;
            const element = unitContainer(id);
            if (element) positiveGroup.appendChild(element);
            if (id === 'positive') {
                const right = fieldsHost.querySelector('.prompt-positive-right');
                if (right) positiveGroup.appendChild(right);
            }
        }
        fieldsHost.appendChild(negativeGroup);
        for (const id of SETTINGS.prompt_negative_order) {
            const element = unitContainer(id);
            if (element) negativeGroup.appendChild(element);
        }
        for (const selector of ['.prompt-exclude', '.ai-card']) {
            const element = fieldsHost.querySelector(selector);
            if (element) fieldsHost.appendChild(element);
        }
        wireCollapseButtons();
    }

    // -------------------------------------------------------------- collapsing
    // Collapsing only hides a field's editor; its text still joins the prompt.

    function collapsedSet() {
        return new Set(Array.isArray(SETTINGS.prompt_field_collapsed) ? SETTINGS.prompt_field_collapsed : []);
    }

    function attachCollapseButton(container, id) {
        if (!container || container.querySelector('.prompt-field-collapse')) return;
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'prompt-field-collapse';
        button.title = 'Collapse / expand this field';
        const applyState = () => {
            const collapsed = collapsedSet().has(id);
            container.classList.toggle('is-collapsed', collapsed);
            button.textContent = collapsed ? '▸' : '▾';
        };
        button.addEventListener('click', () => {
            const set = collapsedSet();
            set.has(id) ? set.delete(id) : set.add(id);
            SETTINGS.prompt_field_collapsed = [...set];
            applyState();
        });
        const tools = container.querySelector('.tag-field-tools');
        const header = container.querySelector('div[class^="myTextbox-"][class*="-header"]');
        if (tools) tools.appendChild(button);
        else if (header) { header.classList.add('has-preset-button'); header.appendChild(button); }
        else return;
        applyState();
    }

    function wireCollapseButtons() {
        for (const id of [...SETTINGS.prompt_positive_order, ...SETTINGS.prompt_negative_order]) {
            if (STRUCTURAL_UNITS.has(id)) continue;
            attachCollapseButton(unitContainer(id), id);
        }
        attachCollapseButton(fieldsHost.querySelector('.prompt-positive-right'), 'positive_right');
        attachCollapseButton(fieldsHost.querySelector('.prompt-exclude'), 'exclude');
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
        button.textContent = '📑';
        button.title = 'Presets';
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
        refresh: () => { renderCustomFields(); applyDomOrder(); },
        openEditor,
    };
}
