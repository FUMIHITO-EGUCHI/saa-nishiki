import { getLocalizedCharacterName } from '../characterLocalization.js';
import { decodeThumb } from '../customThumbGallery.js';
import { createSelectionModal } from './selectionModal.js';
import { normalizeSearchText } from './selectionModalLogic.js';

function splitLabels(value, count) {
    const labels = Array.isArray(value)
        ? value
        : String(value ?? '').split(',').map(label => label.trim());
    return Array.from({ length: count }, (_, index) => labels[index] || `Character ${index + 1}`);
}

function characterAttributes(tag) {
    const tagAssist = globalThis.cachedFiles?.tagAssist;
    const raw = tagAssist?.[tag] ?? tagAssist?.[String(tag).toLowerCase()] ?? '';
    return String(raw).split(',').map(item => item.trim()).filter(Boolean);
}

function characterOption(key, value, category) {
    return {
        key,
        value,
        category,
        attributes: characterAttributes(value),
        label: () => getLocalizedCharacterName({
            key,
            tag: value,
            language: globalThis.globalSettings?.language,
            characterNames: globalThis.cachedFiles?.characterNames,
        }),
    };
}

function specialOption(key, value, category) {
    return { key, value, category, attributes: [], label: key };
}

function makeOptions(characterData, originalData) {
    const characterEntries = Array.isArray(characterData?.[0]) && Array.isArray(characterData?.[1])
        ? characterData[0].map((key, index) => characterOption(key, characterData[1][index], 'character'))
        : [];
    const originalEntries = Array.isArray(originalData)
        ? originalData.map(key => characterOption(key, key, 'original'))
        : [];
    return {
        character: [specialOption('Random', 'random', 'character'), specialOption('None', 'none', 'character'), ...characterEntries],
        original: [specialOption('Random', 'random', 'original'), specialOption('None', 'none', 'original'), ...originalEntries],
    };
}

function findOption(options, value) {
    const normalizedValue = normalizeSearchText(value);
    return options.find(option => [option.key, option.value, option.label]
        .map(item => typeof item === 'function' ? item() : item)
        .some(item => normalizeSearchText(item) === normalizedValue)) || null;
}

function uniqueFilterOptions(options, property) {
    return [...new Set(options.flatMap(option => Array.isArray(option[property]) ? option[property] : []))]
        .filter(Boolean)
        .sort((left, right) => String(left).localeCompare(String(right)));
}

function optionDisplay(option, valueOnly) {
    if (!option) return '';
    const label = typeof option.label === 'function' ? option.label() : option.label;
    return valueOnly ? option.value : label || option.value || option.key;
}

function hideCharacterThumbPreview() {
    const overlay = document.getElementById('cg-thumb-overlay');
    if (overlay) overlay.style.display = 'none';
}

function createCharacterThumbPreview() {
    let previewTask = 0;
    let lastKey = null;

    return {
        async show(option, item, modal) {
            const key = String(option?.key ?? '').trim();
            if (!key || ['random', 'none'].includes(key.toLowerCase())) {
                this.hide();
                return;
            }

            const task = ++previewTask;
            lastKey = key;
            const image = await decodeThumb(key);
            if (task !== previewTask || lastKey !== key || !modal.isOpen()) return;

            if (typeof globalThis.updateThumbOverlay === 'function') {
                globalThis.updateThumbOverlay(key, image);
            }

            requestAnimationFrame(() => {
                if (task !== previewTask || !modal.isOpen()) return;
                const overlay = document.getElementById('cg-thumb-overlay');
                if (!overlay || !overlay.querySelector('img')) {
                    hideCharacterThumbPreview();
                    return;
                }

                const dialog = modal.element.querySelector('.selection-modal-dialog');
                const dialogRect = dialog?.getBoundingClientRect();
                const itemRect = item.getBoundingClientRect();
                const overlayWidth = overlay.offsetWidth || 327;
                const overlayHeight = overlay.offsetHeight || 480;
                const gap = 12;
                let left = (dialogRect?.right ?? itemRect.right) + gap;
                if (left + overlayWidth > globalThis.innerWidth - 10) {
                    left = (dialogRect?.left ?? itemRect.left) - overlayWidth - gap;
                }
                left = Math.max(10, Math.min(left, globalThis.innerWidth - overlayWidth - 10));
                const top = Math.max(10, Math.min(itemRect.top, globalThis.innerHeight - overlayHeight - 10));

                overlay.style.display = 'block';
                overlay.style.background = 'rgba(39, 39, 42, 0.2)';
                overlay.style.border = 'none';
                overlay.style.transform = `translate(${left}px, ${top}px)`;
                overlay.style.left = '0';
                overlay.style.top = '0';
                overlay.style.zIndex = '11001';
            });
        },
        hide() {
            previewTask++;
            lastKey = null;
            hideCharacterThumbPreview();
        },
    };
}

function createCharacterControl({ containerId, dropdownCount, labels, getKind, callback }) {
    const container = document.querySelector(`.${containerId}`);
    if (!container) return null;
    container.__characterSelectionControl?.cleanup?.();
    container.replaceChildren();

    const grid = document.createElement('div');
    grid.className = `character-selection-grid mydropdown-container-${dropdownCount} mydropdown-with-number`;
    container.appendChild(grid);

    let valueOnly = globalThis.globalSettings?.language === 'en-US';
    let optionsByKind = makeOptions([[], []], []);
    let committed = Array(dropdownCount).fill(null);
    let weights = Array(dropdownCount).fill('1.0');
    let activeIndex = 0;
    const fields = [];
    const thumbPreview = createCharacterThumbPreview();

    const modal = createSelectionModal({
        mode: 'single',
        optionLimit: 200,
        categoryOptions: [
            { value: 'character', label: 'Character' },
            { value: 'original', label: 'Original' },
        ],
        onOpen: () => {
            const trigger = fields[activeIndex]?.trigger;
            if (trigger) trigger.setAttribute('aria-expanded', 'true');
        },
        onClose: () => {
            const trigger = fields[activeIndex]?.trigger;
            if (trigger) trigger.setAttribute('aria-expanded', 'false');
            thumbPreview.hide();
        },
        onOptionHover: (option, item) => thumbPreview.show(option, item, modal),
        onOptionLeave: () => thumbPreview.hide(),
        onApply: selected => {
            const field = fields[activeIndex];
            if (!field) return;
            const selectedOption = selected[0] || findOption(field.options, 'none');
            if (!selectedOption) return;
            committed[activeIndex] = selectedOption;
            field.trigger.textContent = optionDisplay(selectedOption, valueOnly);
            field.trigger.title = optionDisplay(selectedOption, valueOnly);
            if (typeof callback === 'function') callback(activeIndex, committed.map(option => option?.key || 'None'));
        },
    });

    function renderField(index) {
        const kind = getKind(index);
        const fieldOptions = optionsByKind[kind] || [];
        const field = fields[index];
        field.options = fieldOptions;
        const selected = findOption(fieldOptions, committed[index]?.key || committed[index]?.value || 'None')
            || findOption(fieldOptions, 'None');
        committed[index] = selected;
        field.trigger.textContent = optionDisplay(selected, valueOnly);
        field.trigger.title = labels[index];
        field.trigger.setAttribute('aria-label', labels[index]);
        field.weight.value = weights[index];
    }

    for (let index = 0; index < dropdownCount; index++) {
        const fieldElement = document.createElement('div');
        fieldElement.className = 'character-selection-field';
        fieldElement.dataset.index = String(index);
        const label = document.createElement('label');
        label.className = 'character-selection-label';
        label.textContent = labels[index];
        const controls = document.createElement('div');
        controls.className = 'character-selection-controls';
        const trigger = document.createElement('button');
        trigger.type = 'button';
        trigger.className = 'character-selection-trigger';
        trigger.setAttribute('aria-haspopup', 'dialog');
        trigger.setAttribute('aria-expanded', 'false');
        const weight = document.createElement('input');
        weight.type = 'text';
        weight.className = 'character-selection-weight';
        weight.inputMode = 'decimal';
        weight.value = '1.0';
        weight.setAttribute('aria-label', `${labels[index]} weight`);
        controls.append(trigger, weight);
        fieldElement.append(label, controls);
        grid.appendChild(fieldElement);
        fields.push({ trigger, weight, label, options: [] });

        trigger.addEventListener('click', event => {
            event.preventDefault();
            activeIndex = index;
            const fieldOptions = fields[index].options;
            const selectedOption = committed[index];
            modal.open({
                trigger,
                fallback: trigger,
                selection: selectedOption ? [selectedOption] : [],
                options: fieldOptions,
                attributes: uniqueFilterOptions(fieldOptions, 'attributes').map(value => ({ value, label: value })),
                modalTitle: labels[index],
            });
        });

        let previousWeight = '1.0';
        weight.addEventListener('input', event => {
            if (/^\d*\.?\d*$/.test(event.target.value)) previousWeight = event.target.value;
            else event.target.value = previousWeight;
            weights[index] = event.target.value;
        });
        weight.addEventListener('blur', event => {
            let value = Number.parseFloat(event.target.value);
            if (!Number.isFinite(value)) value = 1;
            value = Math.min(2, Math.max(0.1, value));
            event.target.value = value.toFixed(1);
            weights[index] = event.target.value;
            previousWeight = event.target.value;
        });
    }

    const api = {
        setOptions(data, originalData, labelPrefixList) {
            optionsByKind = makeOptions(data, originalData);
            const nextLabels = splitLabels(labelPrefixList, dropdownCount);
            nextLabels.forEach((label, index) => {
                labels[index] = label;
                fields[index].label.textContent = label;
            });
            fields.forEach((_, index) => renderField(index));
            return api;
        },
        updateDefaults(...defaults) {
            const values = Array.isArray(defaults[0]) ? defaults[0] : defaults;
            fields.forEach((_, index) => {
                const option = findOption(fields[index].options, values[index] || 'None');
                committed[index] = option || findOption(fields[index].options, 'None');
                renderField(index);
            });
            return api;
        },
        getKey() {
            return committed.map(option => option?.key || 'None');
        },
        getValue() {
            const values = committed.map(option => option?.value || 'none');
            return values.length === 1 ? values[0] : values;
        },
        getTextValue(index) {
            return Number.parseFloat(weights[index]) || 1;
        },
        setTextValue(index, value) {
            const parsed = Number.parseFloat(value) || 1;
            weights[index] = parsed === 1 ? '1.0' : String(parsed);
            if (fields[index]) fields[index].weight.value = weights[index];
        },
        setValueOnly(trigger) {
            valueOnly = Boolean(trigger);
            fields.forEach((_, index) => renderField(index));
        },
        isValueOnly() {
            return valueOnly;
        },
        setTitle(newLabels) {
            const nextLabels = splitLabels(newLabels, dropdownCount);
            nextLabels.forEach((label, index) => {
                labels[index] = label;
                fields[index].label.textContent = label;
                fields[index].trigger.setAttribute('aria-label', label);
                fields[index].weight.setAttribute('aria-label', `${label} weight`);
            });
            return api;
        },
        cleanup() {
            modal.destroy();
            container.replaceChildren();
            if (container.__characterSelectionControl === api) delete container.__characterSelectionControl;
        },
    };

    fields.forEach((_, index) => renderField(index));
    container.__characterSelectionControl = api;
    return api;
}

export function myCharacterSelectionModal(containerId, waiCharacters, originalCharacters, callback, initialLabels = null) {
    const labels = initialLabels || ['Character list 1', 'Character list 2', 'Character list 3', 'Original Character'];
    const control = createCharacterControl({
        containerId,
        dropdownCount: 4,
        labels,
        getKind: index => index === 3 ? 'original' : 'character',
        callback,
    });
    if (control) control.setOptions([Object.keys(waiCharacters || {}), Object.values(waiCharacters || {})], Object.keys(originalCharacters || {}), labels);
    return control;
}

export function myRegionalCharacterSelectionModal(containerId, waiCharacters, originalCharacters, callback, initialLabels = null) {
    const labels = initialLabels || ['Character Left', 'Character Right', 'Original Character Left', 'Original Character Right'];
    const control = createCharacterControl({
        containerId,
        dropdownCount: 4,
        labels,
        getKind: index => index < 2 ? 'character' : 'original',
        callback,
    });
    if (control) control.setOptions([Object.keys(waiCharacters || {}), Object.values(waiCharacters || {})], Object.keys(originalCharacters || {}), labels);
    return control;
}
