import { isStructuredRefineFormat } from '../../aiPromptRefiner.js';
import { DISABLED_TAG_MARKER, mapPromptTokens, splitPromptTokens, stripDisabledTags } from '../components/tagCapsuleLogic.js';
import { hasRefineEditorConflict } from './refineEditorState.js';

const FIELD_SPECS = Object.freeze([
    ['common', 'common', 'custom_prompt'],
    ['positive', 'positive', 'api_prompt'],
    ['positiveRight', 'positive_right', 'api_prompt_right'],
    ['negative', 'negative', 'api_neg_prompt'],
]);

// Schema 3 rewrites the Regional per-side negatives too. A schema 2 answer knows
// nothing about them, and outside Regional the fields are not part of the prompt, so
// both cases keep whatever the editor holds.
const SIDE_NEGATIVE_SPECS = Object.freeze([
    ['negativeLeft', 'negative_left', 'api_neg_prompt_left'],
    ['negativeRight', 'negative_right', 'api_neg_prompt_right'],
]);

const FIELD_LABELS = Object.freeze({
    common: 'Common',
    positive: 'Positive',
    positiveRight: 'Positive Right',
    negative: 'Negative',
    negativeLeft: 'Negative Left',
    negativeRight: 'Negative Right',
});

// Positive (right) is part of the prompt only while Regional is on, like the side
// negatives. A muted field was sent empty and is not Refine's to rewrite. A Regional field
// the answer left unanswered (null: a schema 2 answer, or one reused from a run outside
// Regional) keeps what the editor holds. Without `controls` (the pending summary) the
// fields are listed the same way an apply would write them.
function patchSpecs(candidate, controls, snapshot) {
    const muted = new Set(snapshot?.muted ?? []);
    const answered = candidateKey => typeof candidate?.editorFields?.[candidateKey] === 'string';
    const writable = controlKey => !controls || typeof controls[controlKey]?.setValue === 'function';
    const specs = snapshot?.mode !== 'regional'
        ? FIELD_SPECS.filter(([candidateKey]) => candidateKey !== 'positiveRight')
        : [
            ...FIELD_SPECS.filter(([candidateKey]) => candidateKey !== 'positiveRight' || answered('positiveRight')),
            ...SIDE_NEGATIVE_SPECS.filter(([candidateKey, controlKey]) => answered(candidateKey) && writable(controlKey)),
        ];
    return specs.filter(([candidateKey]) => !muted.has(candidateKey));
}

// Refine only saw the tags that reach the prompt. The field's switched-off "~tag" capsules
// stay in it, each back between the switched-on tags it sat between, so the chips keep
// their order. One that sat behind every switched-on tag stays behind them, wherever the
// model ended the field - an action sentence (rule 13) still ends it.
function keepDisabledTags(value, before) {
    // one tokenizer with the chips: a switched-off group ("~(red hair, blue eyes:1.2)")
    // is one tag, not the "~(red hair" half of one
    const tokens = splitPromptTokens(before);
    const switchedOn = tokens.filter(token => !token.startsWith(DISABLED_TAG_MARKER)).length;
    const pending = [];
    let seen = 0;
    for (const token of tokens) {
        if (token.startsWith(DISABLED_TAG_MARKER)) pending.push({ token, after: seen });
        else seen += 1;
    }
    const active = stripDisabledTags(value);
    if (pending.length === 0) return active;
    // `after` and the answer's tag index both count switched-on tags only
    const inside = pending.filter(entry => entry.after < switchedOn);
    const tail = pending.filter(entry => entry.after >= switchedOn).map(entry => entry.token);
    const text = mapPromptTokens(active, (token, index) => {
        const ahead = [];
        while (inside.length > 0 && inside[0].after <= index) ahead.push(inside.shift().token);
        return ahead.length > 0 ? `${ahead.join(', ')}, ${token}` : null;
    });
    // the model dropped tags the switched-off ones sat behind, or emptied the field
    return [text, ...inside.map(entry => entry.token), ...tail].filter(Boolean).join(', ');
}

function validatedPatch(candidate, specs, snapshot) {
    if (!isStructuredRefineFormat(candidate?.format) || candidate.validForEditorApply !== true || !candidate.editorFields) return null;
    const patch = {};
    for (const [candidateKey, controlKey] of specs) {
        const value = candidate.editorFields[candidateKey];
        if (typeof value !== 'string') return null;
        patch[controlKey] = keepDisabledTags(value, snapshot?.fields?.[candidateKey]);
    }
    return patch;
}

// The pending panel's text: the changes line, every field an apply would write - with the
// switched-off tags it keeps and without a "~" the model invented, exactly as the apply
// writes it, an emptied field included - and last the fields the apply leaves alone
// because they are switched off.
export function describeRefineCandidate(candidate, snapshot) {
    const fields = candidate?.editorFields ?? {};
    const written = patchSpecs(candidate, null, snapshot).map(([candidateKey]) =>
        `${FIELD_LABELS[candidateKey]}: ${keepDisabledTags(fields[candidateKey] ?? '', snapshot?.fields?.[candidateKey])}`);
    const locked = (snapshot?.muted ?? []).filter(key => FIELD_LABELS[key]).map(key => FIELD_LABELS[key]);
    return [
        candidate?.changes ? `Changes: ${candidate.changes}` : '',
        ...written,
        locked.length > 0 ? `Switched off, kept as they are: ${locked.join(', ')}` : '',
    ].filter(Boolean).join('\n');
}

function planCount(tagCapsuleFields, specs) {
    return specs.reduce((total, [, controlKey]) => total + (tagCapsuleFields?.get?.(controlKey)?.getPlans?.().length ?? 0), 0);
}

export function applyRefineEditorPatch({
    candidate,
    snapshot,
    currentSnapshot,
    controls = globalThis.prompt ?? {},
    settings = globalThis.globalSettings ?? {},
    tagCapsuleFields = globalThis.prompt?.tagCapsuleFields ?? null,
} = {}) {
    const specs = patchSpecs(candidate, controls, snapshot);
    const patch = validatedPatch(candidate, specs, snapshot);
    if (!patch) return { status: 'invalid', discardedPlans: 0 };
    if (hasRefineEditorConflict(snapshot, currentSnapshot)) return { status: 'conflict', discardedPlans: 0 };

    const previous = Object.fromEntries(specs.map(([, controlKey, settingsKey]) => [
        controlKey,
        String(controls[controlKey]?.getValue?.() ?? settings[settingsKey] ?? ''),
    ]));
    const beforePlans = planCount(tagCapsuleFields, specs);
    tagCapsuleFields?.beginBatchUpdate?.();
    try {
        for (const [, controlKey] of specs) {
            if (typeof controls[controlKey]?.setValue !== 'function') throw new Error(`Prompt control ${controlKey} is unavailable`);
        }
        for (const [, controlKey, settingsKey] of specs) settings[settingsKey] = patch[controlKey];
        for (const [, controlKey] of specs) controls[controlKey].setValue(patch[controlKey]);
    } catch (error) {
        for (const [, controlKey, settingsKey] of specs) {
            settings[settingsKey] = previous[controlKey];
            try { controls[controlKey]?.setValue?.(previous[controlKey]); } catch { /* best-effort DOM rollback */ }
        }
        return { status: 'error', discardedPlans: 0, error: error?.message ?? String(error) };
    } finally {
        tagCapsuleFields?.endBatchUpdate?.();
    }

    return {
        status: 'applied',
        discardedPlans: Math.max(0, beforePlans - planCount(tagCapsuleFields, specs)),
    };
}
