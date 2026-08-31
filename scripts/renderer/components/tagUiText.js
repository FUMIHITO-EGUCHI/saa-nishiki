// English defaults for every tag-UI string. language.json (en-US / zh-CN) overrides
// these through the same keys; ja-JP inherits en-US by design (cachedFiles.js).

export const TAG_UI_DEFAULTS = Object.freeze({
    tag_ui_choose_tags: 'Choose tags',
    tag_ui_view: 'View',
    tag_ui_view_text: 'Text',
    tag_ui_view_capsules: 'Capsules',
    tag_ui_add_tag: 'Add tag',
    tag_ui_add_placeholder: 'tag, tag…',
    tag_ui_remove: 'Remove {0}',
    tag_ui_chips_label: '{0} tags',
    tag_ui_stats_tags: '{0} tags',
    tag_ui_stats_weighted: '{0} weighted',
    tag_ui_stats_variable: '{0} variable',
    tag_ui_batch_weights: 'Batch weights…',
    tag_ui_plans_discarded: '{0} plan(s) discarded',
    tag_ui_badge_variable: '{0} variable · image #1 values',
    tag_ui_excluded: 'Removed by Exclude',
    tag_ui_weight_for: 'Weight · {0}',
    tag_ui_tab_fixed: 'Fixed',
    tag_ui_tab_plan: 'Plan (batch)',
    tag_ui_weight: 'Weight',
    tag_ui_step: 'Step',
    tag_ui_presets: 'Presets',
    tag_ui_output: 'Output',
    tag_ui_weight_note: 'Warns below 0.50 or above 1.50. 1.00 is output without parentheses.',
    tag_ui_mode: 'Mode',
    tag_ui_mode_increment: 'Increment',
    tag_ui_mode_decrement: 'Decrement',
    tag_ui_mode_random: 'Random',
    tag_ui_min: 'Min',
    tag_ui_max: 'Max',
    tag_ui_seed: 'Seed',
    tag_ui_follow_seed: 'Follow generation seed',
    tag_ui_reproducible: 'Reproducible for the same generation seed',
    tag_ui_hint_fixed: '↑↓ ±step · Enter Apply',
    tag_ui_hint_plan: 'Enter Apply · Esc Close',
    tag_ui_cancel: 'Cancel',
    tag_ui_apply: 'Apply',
    tag_ui_apply_count: 'Apply ({0})',
    tag_ui_close: 'Close',
    tag_ui_decrease: 'Decrease',
    tag_ui_increase: 'Increase',
    tag_ui_batch_title: 'Batch weights — {0}',
    tag_ui_expand_per_image: 'Expand weights per image',
    tag_ui_batch_count: 'Batch count',
    tag_ui_generation_seed: 'Generation seed',
    tag_ui_seed_note: 'Image #n = seed + n − 1',
    tag_ui_seed_random: 'Random at generation',
    tag_ui_random: 'Random',
    tag_ui_variable_tags: 'Variable tags ({0})',
    tag_ui_edit_in_popover: 'Edit in capsule popover',
    tag_ui_comfy_note: '{0} × batch_size=1 → ComfyUI',
    tag_ui_preview: 'Preview',
    tag_ui_end_reached: '■ End reached at {0}',
    tag_ui_end_reached_title: 'End reached',
    tag_ui_random_badge: 'Random · seed {0}',
    tag_ui_final_prompt_col: 'Final prompt ({0})',
    tag_ui_images_summary: '{0} images · {1} variable tags',
    tag_ui_copy_row: 'C copy row prompt',
    tag_ui_copied: 'Copied',
    tag_ui_unapplied: 'Unapplied changes',
    tag_ui_no_changes: 'No changes',
    tag_ui_final_prompt: 'Final prompt',
    tag_ui_image_n: 'Image #{0} / {1}',
    tag_ui_prev_image: 'Previous image',
    tag_ui_next_image: 'Next image',
    tag_ui_readonly_note: 'Read-only · weight 1.00 omitted',
    tag_ui_expand_to_review: 'Image #1 · expand to review',
    tag_ui_fp_positive: 'Positive',
    tag_ui_fp_positive_right: 'Positive (right)',
    tag_ui_fp_negative: 'Negative',
    tag_ui_fp_empty: '(empty)',
    tag_ui_modal_note: 'Weights and batch are not set here',
    tag_ui_modal_hint: '↑↓ move · Space select · Enter apply',
});

export function formatText(template, args = []) {
    return String(template ?? '').replaceAll(/\{(\d+)\}/g, (match, index) => {
        const value = args[Number(index)];
        return value === undefined || value === null ? match : String(value);
    });
}

function currentLanguageTable() {
    try {
        const languages = globalThis.cachedFiles?.language;
        const code = globalThis.globalSettings?.language;
        return languages && code ? languages[code] : null;
    } catch {
        return null;
    }
}

// Resolves a key through the active language table, falling back to the English default.
export function createTextResolver(getLanguage = currentLanguageTable) {
    return (key, ...args) => {
        const table = typeof getLanguage === 'function' ? getLanguage() : null;
        const template = table?.[key] ?? TAG_UI_DEFAULTS[key] ?? key;
        return formatText(template, args);
    };
}

export const tagText = createTextResolver();
