// Pure mapping between the AI card (Off | Expand | Refine + role) and the settings keys
// that already exist: ai_interface (None/Remote/Local), ai_local_prompt_mode (Expand/Refine),
// ai_prompt_role (0 None, 1 Once, 2 Every, 3 Last). No new settings keys.

export const AI_MODES = ['off', 'expand', 'refine'];
export const AI_ROLES = ['once', 'every', 'last']; // role index 1..3 in ai_prompt_role

export function deriveAiMode(settings = {}) {
    if (!settings.ai_interface || settings.ai_interface === 'None') return 'off';
    return settings.ai_local_prompt_mode === 'Refine' ? 'refine' : 'expand';
}

// Returns the settings patch for switching the segment. `lastInterface` remembers Remote/Local
// while the card is Off so switching back restores the same backend (default Local).
export function applyAiMode(mode, settings = {}, lastInterface = 'Local') {
    if (!AI_MODES.includes(mode)) throw new Error(`unknown AI mode: ${mode}`);
    if (mode === 'off') {
        return { ai_interface: 'None' };
    }
    const backend = settings.ai_interface && settings.ai_interface !== 'None' ? settings.ai_interface : (lastInterface === 'Remote' ? 'Remote' : 'Local');
    const patch = { ai_interface: backend, ai_local_prompt_mode: mode === 'refine' ? 'Refine' : 'Expand' };
    const role = Number(settings.ai_prompt_role);
    if (!Number.isFinite(role) || role < 1 || role > 3) patch.ai_prompt_role = 1; // None → Once when the AI is turned on
    return patch;
}

export function deriveAiRole(settings = {}) {
    const role = Number(settings.ai_prompt_role);
    if (role >= 1 && role <= 3) return AI_ROLES[role - 1];
    return 'once';
}

export function applyAiRole(role) {
    const index = AI_ROLES.indexOf(role);
    if (index < 0) throw new Error(`unknown AI role: ${role}`);
    return { ai_prompt_role: index + 1 };
}

// "Local · Small · last run 96 s" — the status text on the card header.
export function describeAiStatus(settings = {}, { lastRunSeconds = null, text = {} } = {}) {
    const mode = deriveAiMode(settings);
    if (mode === 'off') return text.off ?? 'Off';
    const parts = [];
    parts.push(settings.ai_interface === 'Remote' ? (text.remote ?? 'Remote') : (text.local ?? 'Local'));
    if (settings.ai_interface === 'Remote') {
        if (settings.remote_ai_model) parts.push(String(settings.remote_ai_model).split('/').pop());
    } else if (settings.ai_local_model_mode) {
        parts.push(String(settings.ai_local_model_mode));
    }
    if (Number.isFinite(lastRunSeconds) && lastRunSeconds >= 0) parts.push(`${text.lastRun ?? 'last run'} ${Math.round(lastRunSeconds)} s`);
    return parts.join(' · ');
}
