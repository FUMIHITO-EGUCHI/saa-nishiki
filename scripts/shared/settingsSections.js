// Single source of truth for SAA settings: default values, the key → section map,
// normalization, and the on-disk envelope. Pure (no Electron, no fs); imported by
// scripts/main/settingsStore.js, scripts/main/globalSettings.js, the renderer and tests.
//
// Sections (see SAA-settings-split.md §3):
//   app        — settings modal + display / queue preferences. Autosaved, no presets.
//   prompt     — characters & views, prompt fields, weight plans, AI card.
//   generation — run bar, checkpoint, Hires fix, Refiner, Regional.
//   lora / adetailer / controlnet — pipeline slots.
import { REFINE_SYSTEM_PROMPT } from '../aiPromptRefiner.js';

export const SCHEMA_VERSION = 1;

export const MAX_CHARACTER_SLOTS = 6;

export const DEFAULT_SETTINGS = Object.freeze({
    version: '2.8.9',

    ws_service: false,
    ws_addr: '127.0.0.1',
    ws_port: 51028,

    setup_wizard: true,
    language: 'en-US',
    css_style: 'dark',
    rightToleft: true,

    model_path_comfyui: '',
    model_path_webui: '',
    image_save_path_comfyui: '%date',
    image_save_path_webui: '[date]',
    image_save_embed_character_name: false,

    webui_auth: 'user:pass',
    webui_auth_enable: 'OFF',

    model_filter: false,
    model_filter_keyword: 'waiIllustrious,waiNSFW,waiSHUFFLENOOB',
    model_filter_keyword_diffusion: '*',
    search_modelinsubfolder: true,

    thumb_select: 'waiIllustriousSDXL_v160',
    thumb_select_list: ['waiIllustriousSDXL_v160', 'waiANIMA_v10Base10', 'waiNSFWIllustrious_v120'],
    // Variable standard character slots (R4). character1-3 stay in the schema as the
    // migration source for pre-slot files and as read-only mirrors of slots 0-2.
    character_slots: [{ key: 'Random', weight: 1 }, { key: 'None', weight: 1 }, { key: 'None', weight: 1 }],
    character1: 'Random',
    character2: 'None',
    character3: 'None',
    tag_assist: true,
    wildcard_random: false,

    regional_condition: false,
    regional_swap: false,
    regional_overlap_ratio: 20,
    regional_image_ratio: 50,
    regional_str_left: 1,
    regional_str_right: 1,
    regional_option_left: 'default',
    regional_option_right: 'default',
    character_left: 'None',
    character_right: 'None',

    view_angle: 'None',
    view_camera: 'None',
    view_background: 'None',
    view_style: 'None',

    api_model_sampler: 'euler_ancestral',
    api_model_scheduler: 'normal',
    api_model_file_select: 'Default',
    api_model_file_vpred: 'Auto',
    api_model_type: 'Checkpoint',
    api_vae_unet_model: 'None',
    api_vae_sdxl_model: 'None',
    api_vae_sdxl_override: false,

    api_model_file_diffusion_select: 'None',
    api_model_file_diffusion_weight_dtype: 'default',
    api_model_file_text_encoder: 'None',
    api_model_file_text_encoder_type: 'stable_diffusion',
    api_model_file_text_encoder_device: 'default',

    random_seed: -1,
    cfg: 7,
    step: 30,
    width: 1024,
    height: 1360,
    batch: 3,
    api_image_landscape: false,
    scroll_to_last: false,
    keep_gallery: true,

    custom_prompt: '',
    api_prompt: 'masterpiece, best quality, amazing quality',
    api_prompt_right: ':d, selfie',
    api_neg_prompt: 'bad quality,worst quality,worst detail,sketch,censor',
    prompt_background: '',
    prompt_style: '',
    ai_prompt: '',
    prompt_ban: '',
    prompt_custom_fields: [],
    prompt_positive_order: [],
    prompt_negative_order: [],
    prompt_field_presets: {},
    prompt_field_collapsed: [],
    common_weight_plans: [],
    positive_weight_plans: [],
    positive_right_weight_plans: [],
    negative_weight_plans: [],
    exclude_weight_plans: [],
    background_weight_plans: [],
    style_weight_plans: [],
    common_batch: { enabled: false, count: 4 },
    positive_batch: { enabled: false, count: 4 },
    positive_right_batch: { enabled: false, count: 4 },
    negative_batch: { enabled: false, count: 4 },
    exclude_batch: { enabled: false, count: 4 },
    background_batch: { enabled: false, count: 4 },
    style_batch: { enabled: false, count: 4 },
    ptompt_textbox_autoresize: true,
    ptompt_textbox_fontsize: 14,
    ptompt_textbox_heights: [3, 3, 3, 3, 3, 3, 3, 3],

    remote_ai_base_url: 'https://api.groq.com/openai/v1/chat/completions',
    remote_ai_model: 'meta-llama/llama-4-maverick-17b-128e-instruct',
    remote_ai_api_key: '<Your API Key here>',
    remote_ai_timeout: 10,

    ai_interface: 'None',
    ai_local_addr: 'http://127.0.0.1:8080/chat/completions',
    ai_pod_addr: '',
    ai_pod_share_host: false,
    ai_pod_auth: '',
    ai_local_model_mode: 'Auto',
    ai_local_prompt_mode: 'Expand',
    ai_local_timeout: 120,
    ai_local_temp: 0.7,
    ai_local_n_predict: 768,
    ai_refine_system_prompt: REFINE_SYSTEM_PROMPT,
    ai_prompt_role: 1,
    ai_prompt_preview: true,

    api_interface: 'None',
    api_preview_refresh_time: 1,
    api_addr: '127.0.0.1:7860',
    api_pod_ssh_enable: false,
    api_pod_ssh_target: '',
    api_pod_ssh_key: '',
    api_pod_ssh_comfy_port: 8188,
    pod_image_save_dir: '',

    api_fast_enable: false,
    api_fast_lora: 'None',
    api_fast_lora_strength: 1,
    api_fast_steps: 8,
    api_fast_cfg: 1,
    api_fast_sampler: 'lcm',
    api_fast_scheduler: 'sgm_uniform',

    api_hf_enable: false,
    api_hf_scale: 1.5,
    api_hf_denoise: 0.4,
    api_hf_upscaler_selected: 'RealESRGAN_x4plus_anime_6B.pth',
    api_hf_colortransfer: 'Mean',
    api_hf_random_seed: false,
    api_hf_steps: 20,

    api_refiner_enable: false,
    api_refiner_add_noise: true,
    api_refiner_model: 'Default',
    api_refiner_model_vpred: 'Auto',
    api_refiner_ratio: 0.4,

    api_controlnet_enable: false,
    api_adetailer_enable: false,

    lora_slot: [],
    ad_slot: [],
    controlnet_slot: [],

    fav_characters: [],
    fav_tags: { positive: [], negative: [] },

    generate_auto_start: true,
    // 9 number inputs kept for on-disk compatibility: views angle 0 / camera 1
    // (2-3 were background / style, retired by the prompt-field migration; 4-6 were
    // characters 1-3, retired by the character_slots migration — all pinned to 1),
    // regional characters 7-8
    weights4dropdownlist: [1, 1, 1, 1, 1, 1, 1, 1, 1],

    // last preset name loaded per section ('' = none)
    preset_current: { prompt: '', generation: '', lora: '', adetailer: '', controlnet: '' },
});

export const SECTION_KEYS = Object.freeze({
    app: Object.freeze([
        'version', 'setup_wizard', 'ws_service', 'ws_addr', 'ws_port',
        'language', 'css_style', 'rightToleft', 'ptompt_textbox_autoresize', 'ptompt_textbox_fontsize', 'ptompt_textbox_heights',
        'api_interface', 'api_addr', 'api_preview_refresh_time', 'search_modelinsubfolder',
        'api_pod_ssh_enable', 'api_pod_ssh_target', 'api_pod_ssh_key', 'api_pod_ssh_comfy_port', 'pod_image_save_dir',
        'api_fast_enable', 'api_fast_lora', 'api_fast_lora_strength', 'api_fast_steps', 'api_fast_cfg', 'api_fast_sampler', 'api_fast_scheduler',
        'model_filter', 'model_filter_keyword', 'model_filter_keyword_diffusion',
        'model_path_comfyui', 'model_path_webui', 'image_save_path_comfyui', 'image_save_path_webui', 'image_save_embed_character_name',
        'webui_auth', 'webui_auth_enable',
        'api_model_type', 'api_model_file_vpred', 'thumb_select', 'thumb_select_list',
        'api_vae_sdxl_model', 'api_vae_sdxl_override', 'api_vae_unet_model', 'api_model_file_diffusion_weight_dtype',
        'api_model_file_text_encoder', 'api_model_file_text_encoder_type', 'api_model_file_text_encoder_device',
        'ai_local_addr', 'ai_local_model_mode', 'ai_local_timeout', 'ai_local_temp', 'ai_local_n_predict', 'ai_refine_system_prompt',
        'ai_pod_addr', 'ai_pod_share_host', 'ai_pod_auth',
        'remote_ai_base_url', 'remote_ai_model', 'remote_ai_api_key', 'remote_ai_timeout',
        'tag_assist', 'wildcard_random',
        'keep_gallery', 'scroll_to_last', 'generate_auto_start',
        'fav_characters',
        'fav_tags',
        'preset_current',
    ]),
    prompt: Object.freeze([
        'character_slots', 'character1', 'character2', 'character3', 'character_left', 'character_right',
        'view_angle', 'view_camera', 'view_background', 'view_style', 'weights4dropdownlist',
        'custom_prompt', 'api_prompt', 'api_prompt_right', 'api_neg_prompt', 'prompt_background', 'prompt_style', 'ai_prompt', 'prompt_ban',
        'prompt_custom_fields', 'prompt_positive_order', 'prompt_negative_order', 'prompt_field_presets', 'prompt_field_collapsed',
        'common_weight_plans', 'positive_weight_plans', 'positive_right_weight_plans', 'negative_weight_plans', 'exclude_weight_plans',
        'background_weight_plans', 'style_weight_plans',
        'common_batch', 'positive_batch', 'positive_right_batch', 'negative_batch', 'exclude_batch',
        'background_batch', 'style_batch',
        'ai_interface', 'ai_local_prompt_mode', 'ai_prompt_role', 'ai_prompt_preview',
    ]),
    generation: Object.freeze([
        'random_seed', 'cfg', 'step', 'width', 'height', 'batch', 'api_image_landscape', 'api_model_sampler', 'api_model_scheduler',
        'api_model_file_select', 'api_model_file_diffusion_select',
        'api_hf_enable', 'api_hf_scale', 'api_hf_denoise', 'api_hf_upscaler_selected', 'api_hf_colortransfer', 'api_hf_random_seed', 'api_hf_steps',
        'api_refiner_enable', 'api_refiner_add_noise', 'api_refiner_model', 'api_refiner_model_vpred', 'api_refiner_ratio',
        'regional_condition', 'regional_swap', 'regional_overlap_ratio', 'regional_image_ratio',
        'regional_str_left', 'regional_str_right', 'regional_option_left', 'regional_option_right',
    ]),
    lora: Object.freeze(['lora_slot']),
    adetailer: Object.freeze(['api_adetailer_enable', 'ad_slot']),
    controlnet: Object.freeze(['api_controlnet_enable', 'controlnet_slot']),
});

export const SECTIONS = Object.freeze(Object.keys(SECTION_KEYS));
export const PRESET_SECTIONS = Object.freeze(SECTIONS.filter(section => section !== 'app'));
export const STATE_SECTIONS = PRESET_SECTIONS;

// Keys the renderer used to write under a different name than the defaults. Read-only compatibility.
export const KEY_ALIASES = Object.freeze({
    diffusion_model_weight_dtype: 'api_model_file_diffusion_weight_dtype',
    remote_ai_webui_auth: 'webui_auth',
    remote_ai_webui_auth_enable: 'webui_auth_enable',
});

const KEY_TO_SECTION = new Map();
for (const [section, keys] of Object.entries(SECTION_KEYS)) {
    for (const key of keys) KEY_TO_SECTION.set(key, section);
}

export function sectionOf(key) {
    const resolved = KEY_ALIASES[key] ?? key;
    return KEY_TO_SECTION.get(resolved) ?? null;
}

export function isSection(section) {
    return typeof section === 'string' && Object.hasOwn(SECTION_KEYS, section);
}

export function isPresetSection(section) {
    return PRESET_SECTIONS.includes(section);
}

export function clone(value) {
    return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function sameType(defaultValue, value) {
    if (Array.isArray(defaultValue)) return Array.isArray(value);
    if (defaultValue !== null && typeof defaultValue === 'object') return value !== null && typeof value === 'object' && !Array.isArray(value);
    return typeof value === typeof defaultValue;
}

function coerce(key, value, defaultValue) {
    if (typeof defaultValue === 'number') {
        if (typeof value === 'number') return Number.isFinite(value) ? value : defaultValue;
        if (typeof value === 'string' && value.trim() !== '') {
            const parsed = Number(value);
            return Number.isFinite(parsed) ? parsed : defaultValue;
        }
        return defaultValue;
    }
    if (typeof defaultValue === 'boolean') {
        if (typeof value === 'boolean') return value;
        if (value === 'true' || value === 1) return true;
        if (value === 'false' || value === 0) return false;
        return defaultValue;
    }
    if (typeof defaultValue === 'string') {
        return typeof value === 'string' ? value : (typeof value === 'number' ? String(value) : defaultValue);
    }
    if (key === 'character_slots') {
        if (!Array.isArray(value)) return clone(defaultValue);
        const slots = value
            .filter(slot => slot && typeof slot === 'object' && typeof slot.key === 'string' && slot.key.trim() !== '')
            .slice(0, MAX_CHARACTER_SLOTS)
            .map(slot => {
                const weight = Number.parseFloat(slot.weight);
                return { key: slot.key, weight: Number.isFinite(weight) ? weight : 1 };
            });
        return slots.length ? slots : clone(defaultValue);
    }
    if (key === 'weights4dropdownlist') {
        if (!Array.isArray(value)) return clone(defaultValue);
        const numbers = defaultValue.map((fallback, index) => {
            const parsed = Number.parseFloat(value[index]);
            return Number.isFinite(parsed) ? parsed : fallback;
        });
        return numbers;
    }
    if (key === 'preset_current') {
        const result = clone(defaultValue);
        if (value && typeof value === 'object') {
            for (const section of Object.keys(result)) {
                if (typeof value[section] === 'string') result[section] = value[section];
            }
        }
        return result;
    }
    if (key.endsWith('_batch') && defaultValue && typeof defaultValue === 'object') {
        const result = clone(defaultValue);
        if (value && typeof value === 'object') {
            if (typeof value.enabled === 'boolean') result.enabled = value.enabled;
            const count = Number(value.count);
            if (Number.isInteger(count) && count >= 1) result.count = count;
        }
        return result;
    }
    return sameType(defaultValue, value) ? clone(value) : clone(defaultValue);
}

// The Background / Style dropdown columns became prompt fields. A selection stored by an
// older version (state file or preset) is converted into prompt text once, then cleared,
// so re-normalizing already-migrated data is a no-op. 'Random' stays the literal keyword
// `random`, which the generator still resolves against the view-tag list per seed.
function migrateViewPrompts(result) {
    const moves = [['view_background', 'prompt_background', 2], ['view_style', 'prompt_style', 3]];
    for (const [fromKey, toKey, weightIndex] of moves) {
        const value = String(result[fromKey] ?? '').trim();
        result[fromKey] = 'None';
        if (value === '' || value.toLowerCase() === 'none') continue;
        let tag;
        if (value.toLowerCase() === 'random') {
            tag = 'random';
        } else {
            tag = value.toLowerCase().replaceAll('\\', '\\\\').replaceAll('(', '\\(').replaceAll(')', '\\)');
            const weight = Number(result.weights4dropdownlist?.[weightIndex]);
            if (Number.isFinite(weight) && weight !== 1) tag = `(${tag}:${weight})`;
        }
        const existing = String(result[toKey] ?? '').trim();
        result[toKey] = existing ? `${existing.replace(/,$/, '')}, ${tag}` : tag;
    }
    if (Array.isArray(result.weights4dropdownlist)) {
        result.weights4dropdownlist[2] = 1;
        result.weights4dropdownlist[3] = 1;
    }
    return result;
}

// Pre-R4 data has no character_slots: build them from character1-3 and their
// weights4dropdownlist[4..6] weights. Afterwards character1-3 mirror slots 0-2
// (read-only compatibility) and the retired weight slots are pinned to 1.
function migrateCharacterSlots(result, source) {
    if (!Object.hasOwn(source ?? {}, 'character_slots')) {
        const weights = result.weights4dropdownlist ?? [];
        result.character_slots = [result.character1, result.character2, result.character3].map((key, index) => {
            const weight = Number.parseFloat(weights[4 + index]);
            return {
                key: typeof key === 'string' && key.trim() ? key : 'None',
                weight: Number.isFinite(weight) ? weight : 1,
            };
        });
    }
    result.character1 = result.character_slots[0]?.key ?? 'None';
    result.character2 = result.character_slots[1]?.key ?? 'None';
    result.character3 = result.character_slots[2]?.key ?? 'None';
    if (Array.isArray(result.weights4dropdownlist)) {
        result.weights4dropdownlist[4] = 1;
        result.weights4dropdownlist[5] = 1;
        result.weights4dropdownlist[6] = 1;
    }
    return result;
}

/**
 * Return a complete, typed object for `section`: every section key present, aliases resolved,
 * foreign / unknown keys dropped (reported through `warn`).
 */
export function normalizeSection(section, data, { warn = null } = {}) {
    if (!isSection(section)) throw new Error(`Unknown settings section: ${section}`);
    const keys = SECTION_KEYS[section];
    const source = data && typeof data === 'object' ? data : {};
    const result = {};
    for (const key of keys) result[key] = clone(DEFAULT_SETTINGS[key]);
    for (const [rawKey, value] of Object.entries(source)) {
        const key = KEY_ALIASES[rawKey] ?? rawKey;
        if (!keys.includes(key)) {
            warn?.(`[${section}] ignoring key "${rawKey}"`);
            continue;
        }
        result[key] = coerce(key, value, DEFAULT_SETTINGS[key]);
    }
    if (section === 'prompt') {
        migrateViewPrompts(result);
        migrateCharacterSlots(result, source);
    }
    return result;
}

/** Pick the keys of `section` out of a flat settings object (normalized). */
export function pickSection(flat, section, options) {
    const keys = SECTION_KEYS[section];
    if (!keys) throw new Error(`Unknown settings section: ${section}`);
    const subset = {};
    if (flat && typeof flat === 'object') {
        for (const key of keys) if (Object.hasOwn(flat, key)) subset[key] = flat[key];
    }
    return normalizeSection(section, subset, options);
}

/** Split a flat object into { app, state: { prompt, generation, lora, adetailer, controlnet } }. */
export function splitFlat(flat, options) {
    const state = {};
    for (const section of STATE_SECTIONS) state[section] = pickSection(flat, section, options);
    return { app: pickSection(flat, 'app', options), state };
}

/** Merge app + state sections back into the flat object the renderer works with. */
export function mergeSections(app, state) {
    const flat = {};
    Object.assign(flat, normalizeSection('app', app));
    for (const section of STATE_SECTIONS) Object.assign(flat, normalizeSection(section, state?.[section]));
    return flat;
}

export function makeEnvelope(section, data, { saaVersion = DEFAULT_SETTINGS.version, now = () => new Date() } = {}) {
    const stamp = now();
    return {
        schema: SCHEMA_VERSION,
        section,
        saa_version: saaVersion,
        saved_at: stamp instanceof Date ? stamp.toISOString() : String(stamp),
        data,
    };
}

/** Return the `data` of an envelope for `section`, or null when the file is not one. */
export function readEnvelope(section, envelope, { warn = null } = {}) {
    if (!envelope || typeof envelope !== 'object') return null;
    if (envelope.section !== section) {
        warn?.(`expected section "${section}", file says "${envelope.section}"`);
        return null;
    }
    if (typeof envelope.schema !== 'number' || envelope.schema > SCHEMA_VERSION) {
        warn?.(`unsupported schema ${envelope.schema} (max ${SCHEMA_VERSION})`);
        return null;
    }
    return envelope.data && typeof envelope.data === 'object' ? envelope.data : null;
}

/** File-name safe preset name, or null when nothing usable remains. */
export function sanitizePresetName(name) {
    if (typeof name !== 'string') return null;
    let result = name.replaceAll(/[/\\:*?"<>|]/g, ' ').replaceAll(/[\u0000-\u001f\u007f]/g, '').replaceAll(/\s+/g, ' ').trim();
    result = result.replace(/^\.+/, '').replace(/\.json$/i, '').trim();
    if (!result) return null;
    return result.slice(0, 64);
}
