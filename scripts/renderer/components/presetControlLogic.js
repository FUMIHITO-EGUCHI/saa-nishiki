// Pure helpers for the per-section preset control (select + save + delete).
import { sanitizePresetName } from '../../shared/settingsSections.js';

/** Options for the <select>: a placeholder row followed by the preset names, current one selected. */
export function buildPresetOptions(names, current, placeholder) {
    const list = Array.isArray(names) ? names.filter(name => typeof name === 'string' && name) : [];
    const options = [{ value: '', label: placeholder, selected: !current || !list.includes(current) }];
    for (const name of list) options.push({ value: name, label: name, selected: name === current });
    return options;
}

/** Name to save under: user input wins, otherwise the current preset; null when nothing usable. */
export function resolveSaveName(input, current) {
    return sanitizePresetName(input) ?? sanitizePresetName(current) ?? null;
}

/** After deleting `deleted`, what should the control show as current? */
export function nextCurrentAfterDelete(names, current, deleted) {
    if (current !== deleted) return current;
    return '';
}

/** Text of the save / delete dialogs with {0} = section label, {1} = preset name. */
export function formatPresetMessage(template, sectionLabel, presetName = '') {
    return String(template ?? '').replaceAll('{0}', sectionLabel).replaceAll('{1}', presetName);
}
