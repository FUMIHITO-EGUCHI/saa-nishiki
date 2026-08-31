// Per-section preset control: [Preset ▾] [save] [delete], mounted into a card / row head.
// DOM only — list / save / load / remove / collect / apply are injected (see settingsPersistence.js).
import { buildPresetOptions, resolveSaveName, nextCurrentAfterDelete, formatPresetMessage } from './presetControlLogic.js';

const CAT = '[PresetControl]';

function icon(src, alt) {
    const image = document.createElement('img');
    image.src = src;
    image.alt = alt;
    image.setAttribute('fill', 'currentColor');
    return image;
}

export function createPresetControl({
    section,
    host,
    text,            // () => { placeholder, sectionLabel, save, delete, saveTitle, saved, saveFailed, deleteTitle, deleted, deleteFailed, loadFailed, yes, no }
    list,            // async () => string[]
    save,            // async (name, data) => { ok, name }
    load,            // async (name) => data | null
    remove,          // async (name) => boolean
    getCurrent,      // () => string
    setCurrent,      // (name) => void
    collect,         // () => data
    apply,           // (data, name) => void
    dialog,          // { input(opts), confirm(opts), info(opts) }
    log = console,
}) {
    if (!host) return null;

    const root = document.createElement('div');
    root.className = 'preset-control';
    root.dataset.presetSection = section;

    const select = document.createElement('select');
    select.className = 'preset-select';

    const saveButton = document.createElement('button');
    saveButton.type = 'button';
    saveButton.className = 'preset-button preset-save';
    saveButton.append(icon('scripts/svg/save.svg', 'save'));

    const deleteButton = document.createElement('button');
    deleteButton.type = 'button';
    deleteButton.className = 'preset-button preset-delete';
    deleteButton.append(icon('scripts/svg/delete.svg', 'delete'));

    root.append(select, saveButton, deleteButton);
    host.replaceChildren(root);

    let names = [];
    let busy = false;

    function T() {
        return text?.() ?? {};
    }

    function render() {
        const t = T();
        const options = buildPresetOptions(names, getCurrent(), t.placeholder ?? 'Preset…');
        select.replaceChildren(...options.map(option => {
            const element = document.createElement('option');
            element.value = option.value;
            element.textContent = option.label;
            element.selected = option.selected;
            return element;
        }));
        select.title = `${t.sectionLabel ?? section} · ${t.placeholder ?? 'Preset'}`;
        select.setAttribute('aria-label', select.title);
        saveButton.title = t.save ?? 'Save preset';
        deleteButton.title = t.delete ?? 'Delete preset';
        deleteButton.disabled = !getCurrent() || !names.includes(getCurrent());
        root.classList.toggle('has-current', Boolean(getCurrent()) && names.includes(getCurrent()));
    }

    async function refresh() {
        try {
            names = await list();
        } catch (error) {
            log?.warn?.(CAT, `${section}: list failed`, error);
            names = [];
        }
        render();
    }

    async function onSelect() {
        const name = select.value;
        if (!name) { setCurrent(''); render(); return; }
        if (busy) return;
        busy = true;
        try {
            const data = await load(name);
            const t = T();
            if (!data) {
                await dialog.info({ message: formatPresetMessage(t.loadFailed, t.sectionLabel ?? section, name) });
                await refresh();
                return;
            }
            apply(data, name);
            setCurrent(name);
            render();
        } catch (error) {
            log?.error?.(CAT, `${section}: load "${name}" failed`, error);
        } finally {
            busy = false;
        }
    }

    async function onSave() {
        if (busy) return;
        busy = true;
        try {
            const t = T();
            const label = t.sectionLabel ?? section;
            const input = await dialog.input({
                message: formatPresetMessage(t.saveTitle, label),
                placeholder: label,
                defaultValue: getCurrent() || '',
            });
            if (input === null || input === undefined) return;
            const name = resolveSaveName(input, getCurrent());
            if (!name) return;
            const result = await save(name, collect());
            if (result?.ok) {
                setCurrent(result.name);
                await refresh();
                await dialog.info({ message: formatPresetMessage(t.saved, label, result.name) });
            } else {
                await dialog.info({ message: formatPresetMessage(t.saveFailed, label, name) });
            }
        } catch (error) {
            log?.error?.(CAT, `${section}: save failed`, error);
        } finally {
            busy = false;
        }
    }

    async function onDelete() {
        const current = getCurrent();
        if (busy || !current) return;
        busy = true;
        try {
            const t = T();
            const label = t.sectionLabel ?? section;
            const confirmed = await dialog.confirm({ message: formatPresetMessage(t.deleteTitle, label, current), yesText: t.yes, noText: t.no });
            if (!confirmed) return;
            const ok = await remove(current);
            if (ok) {
                setCurrent(nextCurrentAfterDelete(names, current, current));
                await refresh();
                await dialog.info({ message: formatPresetMessage(t.deleted, label, current) });
            } else {
                await dialog.info({ message: formatPresetMessage(t.deleteFailed, label, current) });
            }
        } catch (error) {
            log?.error?.(CAT, `${section}: delete failed`, error);
        } finally {
            busy = false;
        }
    }

    // Keep the row / card heads from treating these as "toggle" clicks.
    for (const element of [select, saveButton, deleteButton]) {
        element.addEventListener('click', event => event.stopPropagation());
        element.addEventListener('pointerdown', event => event.stopPropagation());
    }
    select.addEventListener('change', onSelect);
    saveButton.addEventListener('click', onSave);
    deleteButton.addEventListener('click', onDelete);

    render();
    refresh();

    return { root, refresh, render, updateLanguage: render, section };
}
