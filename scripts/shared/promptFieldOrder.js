// User-orderable prompt chain (pure, shared by renderer and tests).
//
// The positive prompt is assembled from ordered "units": the built-in blocks
// (common, views = angle+camera, background, style, ai, characters, positive)
// plus any user-defined custom fields; the negative prompt likewise starts from
// the built-in negative field. The stored order arrays list unit ids; anything
// missing is appended in default order so old settings and partial data stay
// valid, and unknown ids are dropped.

export const POSITIVE_BUILTIN_ORDER = Object.freeze(['common', 'views', 'background', 'style', 'ai', 'characters', 'positive']);
export const NEGATIVE_BUILTIN_ORDER = Object.freeze(['negative']);

// Fixed structural blocks that carry no user text of their own.
export const STRUCTURAL_UNITS = Object.freeze(new Set(['views', 'ai', 'characters']));

const CUSTOM_ID_PATTERN = /^cf_[a-z0-9]{1,32}$/;

export function makeCustomFieldId(random = Math.random) {
    return `cf_${random().toString(36).slice(2, 10)}`;
}

export function normalizeCustomFields(raw) {
    if (!Array.isArray(raw)) return [];
    const seen = new Set();
    const fields = [];
    for (const entry of raw) {
        if (!entry || typeof entry !== 'object') continue;
        const id = typeof entry.id === 'string' ? entry.id : '';
        if (!CUSTOM_ID_PATTERN.test(id) || seen.has(id)) continue;
        seen.add(id);
        fields.push({
            id,
            name: typeof entry.name === 'string' && entry.name.trim() !== '' ? entry.name.trim().slice(0, 40) : 'Custom',
            polarity: entry.polarity === 'negative' ? 'negative' : 'positive',
            text: typeof entry.text === 'string' ? entry.text : '',
        });
    }
    return fields;
}

export function normalizeOrder(rawOrder, polarity, customFields) {
    const builtins = polarity === 'negative' ? NEGATIVE_BUILTIN_ORDER : POSITIVE_BUILTIN_ORDER;
    const customs = normalizeCustomFields(customFields).filter(field => field.polarity === polarity).map(field => field.id);
    const valid = new Set([...builtins, ...customs]);
    const order = [];
    for (const id of Array.isArray(rawOrder) ? rawOrder : []) {
        if (valid.has(id) && !order.includes(id)) order.push(id);
    }
    // anything not mentioned keeps its default position: built-ins first, then customs
    for (const id of [...builtins, ...customs]) {
        if (!order.includes(id)) order.push(id);
    }
    return order;
}

/**
 * Field layout to apply when a prompt preset (or any partial prompt section)
 * is loaded. A preset that carries `prompt_custom_fields` is the authority on
 * the field set: its fields (names, texts, order) replace the current ones, so
 * fields it lacks disappear and fields it adds appear. A preset from before
 * custom fields existed (no key) leaves the current fields and order alone.
 * Per-field presets are a library, not content: they are unioned (current
 * wins) so switching presets never loses them.
 */
export function mergePromptFieldLayout(current = {}, incoming = {}) {
    const hasIncomingFields = Object.hasOwn(incoming ?? {}, 'prompt_custom_fields');
    const source = hasIncomingFields ? incoming : current;
    const fields = normalizeCustomFields(source?.prompt_custom_fields).map(field => ({ ...field }));
    const currentPresets = current?.prompt_field_presets && typeof current.prompt_field_presets === 'object' ? current.prompt_field_presets : {};
    const incomingPresets = incoming?.prompt_field_presets && typeof incoming.prompt_field_presets === 'object' ? incoming.prompt_field_presets : {};
    return {
        prompt_custom_fields: fields,
        prompt_positive_order: normalizeOrder(source?.prompt_positive_order, 'positive', fields),
        prompt_negative_order: normalizeOrder(source?.prompt_negative_order, 'negative', fields),
        prompt_field_presets: { ...incomingPresets, ...currentPresets },
    };
}

/**
 * Concatenate ordered units. `units` maps unit id to { text, colored? }; empty
 * or missing texts are skipped. Returns plain and BBCode-colored strings.
 */
export function joinOrderedUnits(order, units) {
    let prompt = '';
    let promptColored = '';
    for (const id of order) {
        const unit = units[id];
        if (!unit) continue;
        const text = typeof unit === 'string' ? unit : unit.text;
        if (!text) continue;
        prompt += text;
        promptColored += (typeof unit === 'object' && unit.colored) ? unit.colored : text;
    }
    return { prompt, promptColored };
}

/** Ensure a comma-space separator on a non-empty fragment. */
export function asFragment(text) {
    const trimmed = String(text ?? '').trim();
    if (trimmed === '') return '';
    return /[,\n]$/.test(trimmed) ? `${trimmed} ` : `${trimmed}, `;
}
