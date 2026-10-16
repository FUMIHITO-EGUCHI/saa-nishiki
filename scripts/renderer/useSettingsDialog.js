// "Use settings…": an image's recipe beside the editor as it is now, a row per part of it
// (tags, Prose paragraph, LoRA, model and sampler, size and passes, Regional, seed), each
// row's own checkbox, and Load. The rows that differ start checked, except the seed; all
// of them checked is the picture made again. Generating stays with the main window.
//
// Loading is one undo step (settingsPersistence.runEditTransaction) for the sections, and
// the notice after it has its own Undo, which also puts back what the undo history does
// not keep (the model type, the VAE and text encoder, Fast mode).
//
// The rules of what loading changes are in scripts/shared/recipeApply.js.

import { createDialogShell } from './components/dialogShell.js';
import { parsePromptToCapsules } from './components/tagCapsuleLogic.js';
import { getLocalizedCharacterName } from './characterLocalization.js';
import { captureRecipeSections } from './imageRecipe.js';
import { pinProseParagraph, proseState } from './prosePipeline.js';
import { callback_api_model_type } from './callbacks.js';
import { addViewerInfoAction } from './viewerInfo.js';
import { RECIPE_APP_KEYS, parseRecipe, recipeFromParameters, recipeModel, recipeSize } from '../shared/recipe.js';
import { compareRecipeFields, planRecipeLoad, recipeLoraRows, rowDiffers } from '../shared/recipeApply.js';
import { detailerLabel, modelLabel } from '../shared/imageSummary.js';

const ROWS = ['tags', 'prose', 'lora', 'model', 'size', 'regional', 'seed'];

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

function number(value) {
    return Number.isFinite(value) ? String(Math.round(value * 100) / 100) : '—';
}

function pickApp(settings) {
    return Object.fromEntries(RECIPE_APP_KEYS.filter(key => settings[key] !== undefined).map(key => [key, settings[key]]));
}

/** The editor as it is now, in the shape planRecipeLoad compares against. */
export function currentEditor() {
    return { sections: captureRecipeSections() ?? {}, app: pickApp(globalThis.globalSettings ?? {}) };
}

// ------------------------------------------------------------------ descriptions

function modelText(recipe) {
    const model = recipeModel(recipe);
    const parts = [modelLabel(model.model), model.sampler, model.scheduler, `${number(model.steps)} steps`, `CFG ${number(model.cfg)}`].filter(Boolean);
    const sent = model.sent;
    const fast = sent?.fast ? ` (Fast sent ${number(sent.steps)} · ${number(sent.cfg)})` : '';
    return `${parts.join(' · ')}${fast}`;
}

function sizeText(recipe) {
    const size = recipeSize(recipe);
    const parts = [];
    if (Number.isFinite(size.width) && Number.isFinite(size.height)) parts.push(`${size.width} × ${size.height}`);
    parts.push(size.hires ? `Hires ${number(size.hires.scale)}×` : text('viewer_hires_off', 'Hires off'));
    if (size.detailers.length > 0) parts.push(`${text('viewer_time_detailer', 'Detailer')} ${size.detailers.map(detailerLabel).join(', ')}`);
    return parts.join(' · ');
}

function regionalText(generation = {}) {
    if (generation.regional_condition !== true) return text('use_settings_off', 'off');
    return [text('use_settings_on', 'on'), generation.regional_split, `${number(generation.regional_image_ratio)}%`].filter(Boolean).join(' · ');
}

function writerText(writer) {
    return writer === 'student' ? 'Student' : 'LLM';
}

function shorten(value, limit = 90) {
    const plain = String(value ?? '').replace(/\s+/g, ' ').trim();
    return plain.length > limit ? `${plain.slice(0, limit - 1)}…` : plain;
}

function fieldLabels() {
    const labels = {};
    for (const field of globalThis.prompt?.fieldManager?.listFields?.() ?? []) labels[field.id] = field.label;
    return labels;
}

function characterName(key) {
    if (String(key).startsWith('oc:')) return String(key).slice(3);
    const files = globalThis.cachedFiles ?? {};
    try {
        return getLocalizedCharacterName({ key, tag: files.characterList?.[key], language: globalThis.globalSettings?.language, characterNames: files.characterNames }) || key;
    } catch {
        return key;
    }
}

function chip(value, { weight = 1, disabled = false } = {}) {
    const isPart = value.startsWith('parts:');
    const node = element('span', `tag-capsule-chip recipe-chip${isPart ? ' is-part' : ''}${disabled ? ' is-disabled' : ''}`);
    const name = element('span', 'tag-capsule-chip-name');
    if (isPart) name.append(element('span', 'tag-capsule-chip-prefix', 'parts:'));
    name.append(document.createTextNode(isPart ? value.slice(6) : value));
    node.append(name);
    if (Number.isFinite(weight) && weight !== 1) node.append(element('span', 'tag-capsule-chip-weight', number(weight)));
    return node;
}

function chipsFor(field, side) {
    const box = element('div', 'recipe-field-chips');
    const value = field[side];
    if (value === null || value === undefined || (Array.isArray(value) ? value.length === 0 : value === '')) {
        box.append(element('span', 'recipe-field-empty', '—'));
        return box;
    }
    if (field.kind === 'characters') {
        for (const key of value) box.append(chip(characterName(key)));
    } else if (field.kind === 'artists') {
        for (const key of value) box.append(chip(`@${key}`));
    } else {
        for (const capsule of parsePromptToCapsules(value)) box.append(chip(capsule.value, { weight: capsule.weightPlan?.min ?? 1, disabled: capsule.disabled }));
    }
    return box;
}

function statusTag(status) {
    const labels = {
        same: text('use_settings_same', 'same'),
        differs: text('use_settings_differs', 'differs'),
        'new field': text('use_settings_new_field', 'new field'),
        muted: text('use_settings_muted', 'muted'),
    };
    const tag = element('span', `recipe-status is-${status.replace(' ', '-')}`, labels[status] ?? status);
    return tag;
}

// ------------------------------------------------------------------ the dialog

let shell = null;

function ensureShell() {
    if (!shell) shell = createDialogShell({ className: 'use-settings-modal' });
    return shell;
}

/**
 * The rows the dialog offers for `recipe` against `current`, with what each side says.
 * Exported for tests.
 */
export function describeRows(recipe, current, { loraList = globalThis.cachedFiles?.loraList ?? [], prose = proseState(), labels = fieldLabels() } = {}) {
    const rows = [];
    const imagePrompt = recipe.sections.prompt ?? {};
    const nowPrompt = current.sections.prompt ?? {};
    const fields = compareRecipeFields(imagePrompt, nowPrompt, { picked: recipe.run.characters, labels });
    const fieldCount = side => fields.filter(field => field[side] !== null && (Array.isArray(field[side]) ? field[side].length > 0 : field[side] !== '')).length;
    const fieldsText = count => `${count} ${text(count === 1 ? 'use_settings_field' : 'use_settings_fields', count === 1 ? 'field' : 'fields')}`;
    rows.push({ id: 'tags', label: text('use_settings_tags', 'Tags'), image: fieldsText(fieldCount('image')), now: fieldsText(fieldCount('now')), differs: fields.some(field => field.status !== 'same'), fields });

    const paragraph = recipe.run.prose?.applied ? recipe.run.prose.paragraph : '';
    if (paragraph) {
        rows.push({
            id: 'prose',
            label: text('use_settings_prose', 'Prose paragraph'),
            image: `${writerText(recipe.run.prose.writer)} · "${shorten(paragraph)}"`,
            now: `${text('use_settings_writer', 'Writer')}: ${writerText(globalThis.globalSettings?.ai_prose_writer)}`,
            differs: prose?.prompt !== paragraph,
        });
    }

    const loras = recipeLoraRows(recipe, loraList);
    const nowLoras = (current.sections.lora?.lora_slot ?? []).filter(row => Array.isArray(row) && row[0] && String(row[0]).toLowerCase() !== 'none');
    const missing = loras.filter(row => !row.found).length;
    const rowsText = count => `${count} ${text(count === 1 ? 'use_settings_row' : 'use_settings_rows', count === 1 ? 'row' : 'rows')}`;
    rows.push({
        id: 'lora',
        label: 'LoRA',
        image: missing > 0 ? `${rowsText(loras.length)} (${missing} ${text('use_settings_not_found', 'not found')})` : rowsText(loras.length),
        now: rowsText(nowLoras.length),
        differs: rowDiffers('lora', recipe, current),
        loras,
    });

    const nowRecipe = { ...recipe, sections: current.sections, app: current.app, run: { ...recipe.run, sent: null, width: null, height: null } };
    const modelDiffers = rowDiffers('model', recipe, current);
    rows.push({ id: 'model', label: text('use_settings_model', 'Model & sampler'), image: modelText(recipe), now: modelDiffers ? modelText(nowRecipe) : text('use_settings_same_as_image', 'same as the image'), differs: modelDiffers });
    const sizeDiffers = rowDiffers('size', recipe, current);
    rows.push({ id: 'size', label: text('use_settings_size', 'Size & passes'), image: sizeText(recipe), now: sizeDiffers ? sizeText(nowRecipe) : text('use_settings_same_as_image', 'same as the image'), differs: sizeDiffers });
    rows.push({ id: 'regional', label: 'Regional', image: regionalText(recipe.sections.generation), now: regionalText(current.sections.generation), differs: rowDiffers('regional', recipe, current) });
    const nowSeed = Number(current.sections.generation?.random_seed);
    rows.push({ id: 'seed', label: text('viewer_seed', 'Seed'), image: String(recipe.run.seed ?? '—'), now: nowSeed === -1 || !Number.isFinite(nowSeed) ? text('use_settings_random', 'random') : String(nowSeed), differs: rowDiffers('seed', recipe, current) });
    return rows;
}

function fieldGrid(fields) {
    const grid = element('div', 'recipe-field-grid');
    for (const field of fields) {
        const line = element('div', 'recipe-field-row');
        line.append(element('span', 'recipe-field-name', field.name), chipsFor(field, 'image'), chipsFor(field, 'now'), statusTag(field.status));
        grid.append(line);
    }
    return grid;
}

function loraList(rows) {
    const list = element('div', 'recipe-lora-list');
    for (const row of rows) {
        const line = element('div', 'recipe-lora-row');
        const name = element('span', 'recipe-lora-name', modelLabel(row.name));
        name.title = row.name;
        line.append(
            name,
            element('span', 'recipe-lora-weight', `M ${number(row.model)}`),
            element('span', 'recipe-lora-stage', row.stage),
            element('span', `recipe-lora-state ${row.found ? 'is-found' : 'is-missing'}`, row.found ? text('use_settings_found', 'found') : `${text('use_settings_not_found', 'not found')} · OFF`),
        );
        list.append(line);
    }
    return list;
}

/** The recipe of an image from its records: its own, else one made from its parameters text. */
export function recipeOfImage({ recipe = null, parameters = '' } = {}) {
    const files = globalThis.cachedFiles ?? {};
    return parseRecipe(recipe) ?? parseRecipe(recipeFromParameters(parameters, { checkpoints: files.modelList ?? [], diffusion: files.diffusionList ?? [] }));
}

/**
 * Opens the dialog for an image: its `recipe` (parsed or the chunk text) or, without one,
 * its `parameters` text; `image` (a data URL for the header thumbnail) and `name` (its
 * file name). Resolves with the load result (loadRecipe), or null when cancelled.
 */
export function openUseSettings({ recipe: source = null, parameters = '', image = '', name = '', trigger = null } = {}) {
    const recipe = recipeOfImage({ recipe: source, parameters });
    if (!recipe) return Promise.resolve(null);
    const dialog = ensureShell();
    const current = currentEditor();
    const rows = describeRows(recipe, current);
    const checked = new Set(rows.filter(row => row.differs && row.id !== 'seed').map(row => row.id));

    return new Promise(resolve => {
        dialog.body.replaceChildren();
        dialog.footer.replaceChildren();
        dialog.dialog.classList.add('use-settings-dialog');

        // header: the thumbnail and when / what the image was
        const head = element('div', 'use-settings-head');
        if (image) {
            const thumb = element('img', 'use-settings-thumb');
            thumb.src = image;
            thumb.alt = '';
            head.append(thumb);
        }
        const model = recipeModel(recipe);
        const created = recipe.created ? new Date(recipe.created) : null;
        const when = created && !Number.isNaN(created.getTime())
            ? `${created.getFullYear()}-${String(created.getMonth() + 1).padStart(2, '0')}-${String(created.getDate()).padStart(2, '0')} ${String(created.getHours()).padStart(2, '0')}:${String(created.getMinutes()).padStart(2, '0')}`
            : '';
        const kind = recipe.partial ? text('viewer_partial_recipe', 'partial recipe') : `SAA recipe v${recipe.v}`;
        head.append(element('span', 'use-settings-sub', [when, modelLabel(model.model), Number.isFinite(recipe.run.seed) ? `seed ${recipe.run.seed}` : '', kind].filter(Boolean).join(' · ')));
        dialog.body.append(head);

        const table = element('div', 'use-settings-rows');
        const heads = element('div', 'use-settings-grid use-settings-heads');
        const all = element('input');
        all.type = 'checkbox';
        all.setAttribute('aria-label', text('use_settings_all', 'All sections'));
        heads.append(all, element('span', '', text('use_settings_section', 'Section')), element('span', '', text('use_settings_from_image', 'From the image')), element('span', '', text('use_settings_now', 'You have now')), element('span', '', ''));
        table.append(heads);
        const boxes = new Map();
        const paintAll = () => {
            all.checked = rows.every(row => checked.has(row.id));
            all.indeterminate = !all.checked && checked.size > 0;
            for (const [id, box] of boxes) box.closest('.use-settings-row')?.classList.toggle('is-on', checked.has(id));
            load.disabled = checked.size === 0;
        };
        for (const row of rows) {
            const block = element('div', 'use-settings-row');
            block.dataset.row = row.id;
            const line = element('div', 'use-settings-grid');
            const box = element('input');
            box.type = 'checkbox';
            box.id = `use-settings-${row.id}`;
            box.checked = checked.has(row.id);
            box.addEventListener('change', () => {
                if (box.checked) checked.add(row.id); else checked.delete(row.id);
                paintAll();
            });
            boxes.set(row.id, box);
            const label = element('label', 'use-settings-label', row.label);
            label.htmlFor = box.id;
            line.append(box, label, element('span', 'use-settings-image', row.image), element('span', 'use-settings-now', row.now), statusTag(row.differs ? 'differs' : 'same'));
            block.append(line);
            if (row.fields?.length) block.append(fieldGrid(row.fields));
            if (row.loras?.length) block.append(loraList(row.loras));
            table.append(block);
        }
        all.addEventListener('change', () => {
            const on = all.checked;
            for (const row of rows) {
                if (on) checked.add(row.id); else checked.delete(row.id);
                boxes.get(row.id).checked = on;
            }
            paintAll();
        });
        dialog.body.append(table);

        const cancel = element('button', 'selection-modal-cancel', text('setup_cancel', 'Cancel'));
        cancel.type = 'button';
        const load = element('button', 'selection-modal-apply', text('use_settings_load', 'Load'));
        load.type = 'button';
        dialog.footer.append(cancel, load);
        paintAll();

        let settled = false;
        const finish = value => {
            if (settled) return;
            settled = true;
            resolve(value);
        };
        dialog.setCloseHandler(() => finish(null));
        cancel.addEventListener('click', () => dialog.close({ apply: false }));
        load.addEventListener('click', async () => {
            const chosen = ROWS.filter(id => checked.has(id));
            load.disabled = true;
            dialog.setCloseHandler(null);
            dialog.close({ apply: true });
            try {
                const result = await loadRecipe(recipe, chosen);
                showLoadedNotice(result, name);
                finish(result);
            } catch (error) {
                console.error('[UseSettings] load failed:', error);
                finish(null);
            }
        });
        dialog.open({ trigger, title: `${text('use_settings_title', 'Use settings from')} ${name || 'image'}`, initialFocus: () => load });
    });
}

// ------------------------------------------------------------------ loading

const nextFrame = () => new Promise(resolve => requestAnimationFrame(() => resolve()));

function applyAppKeys(values) {
    const SETTINGS = globalThis.globalSettings;
    const dropdowns = globalThis.dropdownList ?? {};
    for (const [key, value] of Object.entries(values)) {
        if (key === 'api_model_type') continue;
        SETTINGS[key] = value;
    }
    if ('api_vae_sdxl_model' in values) dropdowns.vae_sdxl?.updateDefaults?.(values.api_vae_sdxl_model);
    if ('api_vae_sdxl_override' in values) dropdowns.vae_sdxl_override?.setValue?.(values.api_vae_sdxl_override);
    if ('api_vae_unet_model' in values) dropdowns.vae_unet?.updateDefaults?.(values.api_vae_unet_model);
    if ('api_model_file_diffusion_weight_dtype' in values) dropdowns.diffusion_model_weight_dtype?.updateDefaults?.(values.api_model_file_diffusion_weight_dtype);
    if ('api_model_file_text_encoder' in values) dropdowns.textencoder?.updateDefaults?.(values.api_model_file_text_encoder);
    if ('api_model_file_text_encoder_type' in values) dropdowns.textencoder_type?.updateDefaults?.(values.api_model_file_text_encoder_type);
    if ('api_model_file_text_encoder_device' in values) dropdowns.textencoder_device?.updateDefaults?.(values.api_model_file_text_encoder_device);
    if ('api_model_file_vpred' in values) dropdowns.vpred?.updateDefaults?.(values.api_model_file_vpred);
    if ('api_fast_enable' in values) globalThis.uiShell?.fastToggle?.render?.();
}

async function switchModelType(type) {
    if (!type || type === globalThis.globalSettings.api_model_type) return false;
    globalThis.dropdownList?.model_type?.updateDefaults?.(type);
    await callback_api_model_type(0, [type], { clearPrompts: true });
    return true;
}

async function writeSections(sections, source) {
    const persistence = globalThis.settingsPersistence;
    const names = Object.keys(sections);
    if (!persistence || names.length === 0) return;
    await persistence.runEditTransaction({ source, sections: names }, async () => {
        persistence.applySectionsData(sections, { mergeLayout: false });
        const SETTINGS = globalThis.globalSettings;
        if (sections.prompt) globalThis.artistList?.setSlots?.(SETTINGS.artist_slots);
        if (sections.generation && SETTINGS.api_model_type === 'Diffusion') globalThis.dropdownList?.model?.updateDefaults?.(SETTINGS.api_model_file_diffusion_select);
        // the slot rows are built a frame later: the undo step has to see them filled
        await nextFrame();
        await nextFrame();
    });
}

/**
 * Loads the checked `rows` of `recipe` into the editor. Returns what Undo needs:
 * { rows, before, typeChanged }.
 */
export async function loadRecipe(recipe, rows) {
    const SETTINGS = globalThis.globalSettings;
    const before = { ...currentEditor(), type: SETTINGS.api_model_type };
    let typeChanged = false;
    if (rows.includes('model')) typeChanged = await switchModelType(recipe.app?.api_model_type);
    // planned against the editor after a type switch: the rows left unchecked keep what the
    // type entered has, not what the type left had
    const plan = planRecipeLoad(recipe, currentEditor(), rows);
    applyAppKeys(plan.app);
    await writeSections(plan.sections, 'use-settings');
    if (plan.prose) pinProseParagraph(plan.prose);
    globalThis.uiShell?.pipeline?.refresh?.();
    return { rows, before, typeChanged };
}

/** Puts the editor back as it was before `result` (loadRecipe) was loaded. */
export async function undoRecipeLoad(result) {
    if (!result?.before) return;
    const { before } = result;
    if (result.typeChanged) await switchModelType(before.type);
    applyAppKeys(before.app);
    await writeSections(before.sections, 'use-settings-undo');
    globalThis.uiShell?.pipeline?.refresh?.();
}

let noticeTimer = null;

function showLoadedNotice(result, name) {
    document.querySelector('.use-settings-notice')?.remove();
    if (!result) return;
    const notice = element('div', 'use-settings-notice');
    notice.setAttribute('role', 'status');
    const count = result.rows.length;
    notice.append(element('span', 'use-settings-notice-text', text('use_settings_loaded', 'Loaded {0} sections from {1}').replace('{0}', String(count)).replace('{1}', name || 'the image')));
    const undo = element('button', 'use-settings-notice-undo', text('use_settings_undo', 'Undo'));
    undo.type = 'button';
    undo.addEventListener('click', async () => {
        notice.remove();
        await undoRecipeLoad(result);
    });
    notice.append(undo);
    document.body.append(notice);
    if (noticeTimer) clearTimeout(noticeTimer);
    noticeTimer = setTimeout(() => notice.remove(), 12000);
}

function fileName(file, seed) {
    const base = String(file ?? '').split(/[\\/]/).pop();
    return base || (seed ? `image_${seed}.png` : 'image.png');
}

/** The "Use settings…" button under the Info tab's recipe (viewerInfo.js). */
export function setupUseSettings() {
    addViewerInfoAction((actions, { entry, summary, records }) => {
        if (!actions || summary.state === 'none') return;
        const button = element('button', 'viewer-primary-button', text('viewer_use_settings', 'Use settings…'));
        button.type = 'button';
        button.addEventListener('click', () => openUseSettings({
            recipe: records.recipe,
            parameters: records.parameters,
            image: entry.image,
            name: fileName(records.path, entry.seed),
            trigger: button,
        }));
        actions.append(button);
    });
}
