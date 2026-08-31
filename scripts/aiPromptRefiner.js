export const PROMPT_MODE_EXPAND = 'Expand';
export const PROMPT_MODE_REFINE = 'Refine';

const MAX_PROMPT_LENGTH = 20_000;

export const LEGACY_REFINE_SYSTEM_PROMPT = `You are a prompt editor for WAI Illustrious SDXL.
Return exactly one JSON object and no markdown. The object must contain string fields "positive", "negative", and "changes". If the input contains "positive_right", also return a string field named "positive_right".

Edit the existing prompts according to the user's instruction. The instruction may be written in Japanese. Prompt output must use concise English Danbooru-style comma-separated tags.

Rules:
1. Preserve explicit user constraints, character identity tags, franchise qualifiers, LoRA tokens such as <lora:name:weight>, embeddings, and quality anchors unless the user explicitly requests their removal.
2. Preserve the requested subject count, composition, pose, clothing, setting, and camera direction unless the user explicitly requests a change.
3. Resolve obvious prompt contradictions and remove accidental duplicates without changing the intended image.
4. When the user asks to strengthen or weaken an existing element, weight the existing tag whenever possible instead of inventing a descriptive tag.
5. Do not change semantic meaning merely to add emphasis. For example, preserve "neutral expression" and use "detailed eyes" rather than adding "expressive eyes" unless the user asks for an expression change.
6. Map intensity conservatively: "slightly" or Japanese "少し" means 1.10 to strengthen and 0.90 to weaken; an unqualified request means 1.20 and 0.80; "strongly" means 1.30 and 0.70.
7. Use emphasis syntax (tag:1.20) sparingly. Add or change weights on at most four decisive visual tags. Keep weights between 0.70 and 1.50. Do not rewrite LoRA weights or character identity tags.
8. Reduce emphasis instead of deleting important existing tags. Use the negative prompt only for unwanted artifacts or explicitly excluded visual elements, not as a second way to suppress an element already down-weighted in the positive prompt.
9. Do not add unrequested subjects, identities, clothing, poses, expressions, body traits, settings, or story elements.
10. Keep "changes" to one short sentence describing the material edits.
11. Copy all protected tokens exactly, including punctuation and backslashes.`;

export const REFINE_SYSTEM_PROMPT = `You are a full prompt architect for WAI Illustrious SDXL.
Return exactly one JSON object and no markdown. The object must contain string fields "positive", "negative", and "changes". If the input contains "positive_right", also return a string field named "positive_right".

Refine always means full reconstruction. Read the user's instruction together with every existing prompt, apply the instruction, then rebuild the entire positive and negative prompts as a coherent prompt set. Return complete replacement prompts, never a patch, suffix, delta, or commentary. The instruction may be written in Japanese. Prompt output must use concise English Danbooru-style comma-separated tags.

Rules:
1. Preserve hard constraints and protected tokens unless the user explicitly changes them: character identity tags, franchise qualifiers, explicit subject count, LoRA tokens such as <lora:name:weight>, embeddings, quality anchors, and escaped tokens. Copy protected tokens exactly, including punctuation and backslashes.
2. Preserve the intended scene semantics, but freely rewrite, consolidate, and reorder ordinary tags. Do not retain the original wording or order merely because it already exists.
3. Audit every input tag. Remove duplicates, contradictions, obsolete tags, filler, and tags that no longer support the requested result. Replace verbose phrases with precise canonical visual tags when possible.
4. Reorder the complete positive prompt into this semantic sequence: quality and source, subject and identity, composition and camera, appearance, clothing and accessories, pose and action, setting, lighting, finish.
5. Apply the instruction across the whole prompt. Adjust related tags and weights together so the result is internally consistent instead of making one isolated insertion.
6. Add only visual tags directly implied by the instruction or necessary to render an explicit constraint consistently. Do not invent unrequested identities, subjects, clothing, poses, expressions, body traits, settings, or story elements.
7. Rebuild the negative prompt as a concise, relevant set of unwanted artifacts and explicit exclusions. Never place a desired or preserved positive concept in the negative prompt, even with a low weight. Remove irrelevant or contradictory negatives and do not duplicate down-weighted positive concepts there.
8. Map intensity exactly. For "slightly" or Japanese "少し", to strengthen you MUST use exactly 1.10 and to weaken you MUST use exactly 0.90. For an unqualified request, use exactly 1.20 and 0.80. For "strongly", use exactly 1.30 and 0.70.
9. Use emphasis syntax (tag:1.20) only on decisive visual concepts. Keep ordinary weights between 0.70 and 1.50. Do not rewrite LoRA weights or character identity tags.
10. Even when the instruction is narrow, return a fully audited, reorganized complete replacement for every supplied prompt field.
11. Before output, verify that preserved positive concepts are absent from the negative prompt and every changed weight matches the requested intensity.
12. Keep "changes" to one short sentence summarizing the reconstruction.`;

export function resolveRefineSystemPrompt(savedPrompt) {
    if (typeof savedPrompt !== 'string' || savedPrompt.trim() === '') {
        return REFINE_SYSTEM_PROMPT;
    }
    if (savedPrompt.trim() === LEGACY_REFINE_SYSTEM_PROMPT.trim()) {
        return REFINE_SYSTEM_PROMPT;
    }
    return savedPrompt;
}

export function normalizePromptMode(mode) {
    return String(mode ?? '').trim().toLowerCase() === 'refine'
        ? PROMPT_MODE_REFINE
        : PROMPT_MODE_EXPAND;
}

function requireString(value, name) {
    if (typeof value !== 'string') {
        throw new TypeError(`${name} must be a string`);
    }
    return value;
}

export function buildRefineUserContent({
    instruction = '',
    positive = '',
    negative = '',
    positiveRight = '',
} = {}) {
    const payload = {
        instruction: requireString(instruction, 'instruction'),
        positive: requireString(positive, 'positive'),
        negative: requireString(negative, 'negative'),
    };

    const regionalPrompt = requireString(positiveRight, 'positiveRight');
    if (regionalPrompt.trim() !== '') {
        payload.positive_right = regionalPrompt;
    }

    return JSON.stringify(payload);
}

function fallbackResult(original, error) {
    return {
        ok: false,
        positive: original.positive,
        positiveRight: original.positiveRight,
        negative: original.negative,
        changes: '',
        error,
    };
}

function stripJsonFence(content) {
    const trimmed = content.trim();
    const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
    return fenced ? fenced[1].trim() : trimmed;
}

function findLoRATokens(prompt) {
    return prompt.match(/<lora:[^>\r\n]+>/gi) ?? [];
}

function preserveLoRATokens(refinedPrompt, originalPrompt) {
    const missing = findLoRATokens(originalPrompt).filter((token) => !refinedPrompt.includes(token));
    if (missing.length === 0) return refinedPrompt;
    return [refinedPrompt.replace(/,\s*$/, ''), ...missing].filter(Boolean).join(', ');
}

export function removeAiPromptMarker(prompt, marker) {
    const safePrompt = requireString(prompt, 'prompt');
    const safeMarker = requireString(marker, 'marker');
    if (safeMarker === '') throw new Error('marker must not be empty');

    return safePrompt
        .replaceAll(safeMarker, '')
        .replace(/,\s*,+\s*/g, ', ')
        .replace(/^\s*,\s*|\s*,\s*$/g, '')
        .trim();
}

function replaceInfoSection(info, startLabel, endLabel, value) {
    const startToken = `${startLabel}\n`;
    const startIndex = info.indexOf(startToken);
    if (startIndex < 0) return info;

    const contentStart = startIndex + startToken.length;
    const endToken = endLabel === 'Layout:' ? '\n\nLayout:' : `\n${endLabel}\n`;
    const endIndex = info.indexOf(endToken, contentStart);
    if (endIndex < 0) return info;

    return `${info.slice(0, contentStart)}${value}${info.slice(endIndex)}`;
}

export function renderAiPromptInfo({
    info = '',
    mode = PROMPT_MODE_EXPAND,
    marker,
    preview = '',
    positive = '',
    positiveRight = '',
    negative = '',
    regional = false,
} = {}) {
    const safeInfo = requireString(info, 'info');
    const safeMarker = requireString(marker, 'marker');
    if (safeMarker === '') throw new Error('marker must not be empty');

    if (normalizePromptMode(mode) === PROMPT_MODE_EXPAND) {
        return safeInfo.replaceAll(safeMarker, requireString(preview, 'preview'));
    }

    let rendered = safeInfo;
    if (regional) {
        rendered = replaceInfoSection(
            rendered,
            'Positive Left:',
            'Positive Right:',
            requireString(positive, 'positive'),
        );
        rendered = replaceInfoSection(
            rendered,
            'Positive Right:',
            'Negative:',
            requireString(positiveRight, 'positiveRight'),
        );
    } else {
        rendered = replaceInfoSection(
            rendered,
            'Positive:',
            'Negative:',
            requireString(positive, 'positive'),
        );
    }
    rendered = replaceInfoSection(
        rendered,
        'Negative:',
        'Layout:',
        requireString(negative, 'negative'),
    );

    return rendered.replaceAll(safeMarker, '');
}

function validatePrompt(value, name, { allowEmpty = false } = {}) {
    if (typeof value !== 'string') {
        throw new TypeError(`${name} must be a string`);
    }
    const trimmed = value.trim();
    if (!allowEmpty && trimmed === '') {
        throw new Error(`${name} must not be empty`);
    }
    if (trimmed.length > MAX_PROMPT_LENGTH) {
        throw new Error(`${name} is too long`);
    }
    return trimmed;
}

export function parseRefineResponse(content, originalPrompts = {}) {
    const original = {
        positive: typeof originalPrompts.positive === 'string' ? originalPrompts.positive : '',
        positiveRight: typeof originalPrompts.positiveRight === 'string' ? originalPrompts.positiveRight : '',
        negative: typeof originalPrompts.negative === 'string' ? originalPrompts.negative : '',
    };

    if (typeof content !== 'string') {
        return fallbackResult(original, 'Refine response was not a string');
    }

    let parsed;
    try {
        parsed = JSON.parse(stripJsonFence(content));
    } catch {
        return fallbackResult(original, 'Refine response was not valid JSON');
    }

    if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') {
        return fallbackResult(original, 'Refine response JSON was not an object');
    }

    try {
        const positive = preserveLoRATokens(
            validatePrompt(parsed.positive, 'positive'),
            original.positive,
        );
        const negative = validatePrompt(parsed.negative, 'negative', { allowEmpty: true });
        const positiveRight = original.positiveRight.trim() === ''
            ? ''
            : preserveLoRATokens(
                validatePrompt(parsed.positive_right, 'positive_right'),
                original.positiveRight,
            );
        const changes = typeof parsed.changes === 'string' ? parsed.changes.trim() : '';

        return {
            ok: true,
            positive,
            positiveRight,
            negative,
            changes,
            error: '',
        };
    } catch (error) {
        return fallbackResult(original, error.message);
    }
}

export function applyAiPromptResult({
    mode = PROMPT_MODE_EXPAND,
    content = '',
    marker,
    positive = '',
    positiveRight = '',
    negative = '',
} = {}) {
    const safeMarker = requireString(marker, 'marker');
    if (safeMarker === '') throw new Error('marker must not be empty');

    const safeContent = requireString(content, 'content').trim();
    const original = {
        positive: removeAiPromptMarker(positive, safeMarker),
        positiveRight: removeAiPromptMarker(positiveRight, safeMarker),
        negative: requireString(negative, 'negative'),
    };

    if (normalizePromptMode(mode) === PROMPT_MODE_REFINE) {
        const parsed = parseRefineResponse(safeContent, original);
        return {
            ...parsed,
            preview: parsed.ok ? (parsed.changes || parsed.positive) : '',
        };
    }

    return {
        ok: safeContent !== '',
        positive: requireString(positive, 'positive').replaceAll(safeMarker, safeContent),
        positiveRight: requireString(positiveRight, 'positiveRight').replaceAll(safeMarker, safeContent),
        negative: original.negative,
        changes: '',
        preview: safeContent,
        error: safeContent === '' ? 'AI prompt was empty' : '',
    };
}
