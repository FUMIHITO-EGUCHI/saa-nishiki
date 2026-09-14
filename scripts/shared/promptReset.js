// What "clear the Prompts" means as a settings patch (pure, shared by the
// renderer and tests). Switching the model type (Checkpoint ↔ Diffusion) empties
// the Scene: every prompt text, the View row and the per-image weight plans.
// The row structure stays - custom fields keep their names, sides, polarity,
// batch and mute state - so the user starts the other model with the same layout.

import { normalizeCustomFields } from './promptFieldOrder.js';

export const PROMPT_TEXT_KEYS = Object.freeze([
    'custom_prompt', 'api_prompt', 'api_prompt_right',
    'api_neg_prompt', 'api_neg_prompt_left', 'api_neg_prompt_right',
    'prompt_background', 'prompt_style', 'prompt_ban',
]);

export const PROMPT_PLAN_KEYS = Object.freeze([
    'common_weight_plans', 'positive_weight_plans', 'positive_right_weight_plans',
    'negative_weight_plans', 'negative_left_weight_plans', 'negative_right_weight_plans',
    'background_weight_plans', 'style_weight_plans', 'exclude_weight_plans',
]);

export function clearedPromptPatch(settings = {}) {
    const patch = {};
    for (const key of PROMPT_TEXT_KEYS) patch[key] = '';
    for (const key of PROMPT_PLAN_KEYS) patch[key] = [];
    patch.view_angle = 'None';
    patch.view_camera = 'None';
    patch.prompt_custom_fields = normalizeCustomFields(settings.prompt_custom_fields).map(field => {
        const cleared = { ...field, text: '' };
        delete cleared.weight_plans; // plans name chips that are gone
        return cleared;
    });
    return patch;
}
