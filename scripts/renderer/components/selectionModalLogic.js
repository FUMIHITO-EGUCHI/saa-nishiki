const WEIGHTED_TOKEN_PATTERN = /^\((.*):(-?(?:\d+\.?\d*|\.\d+))\)$/;

export function normalizeSearchText(value) {
    return String(value ?? '')
        .normalize('NFKC')
        .trim()
        .toLowerCase()
        .replace(/\s+/g, ' ');
}

export function normalizePromptToken(value) {
    let token = normalizeSearchText(value);
    let previousToken = '';
    while (token !== previousToken) {
        previousToken = token;
        const weightedMatch = WEIGHTED_TOKEN_PATTERN.exec(token);
        token = weightedMatch ? weightedMatch[1].trim() : token;
    }
    return normalizeSearchText(token.replaceAll('_', ' '));
}

export function normalizeSelectionKey(value) {
    return normalizePromptToken(value);
}

function optionSearchFields(option) {
    const label = typeof option?.label === 'function' ? option.label() : option?.label;
    return [
        option?.key,
        option?.value,
        label,
        option?.category,
        ...(Array.isArray(option?.attributes) ? option.attributes : []),
    ].map(normalizeSearchText).filter(Boolean);
}

export function filterSelectionOptions(options, filters = {}) {
    const queryTerms = normalizeSearchText(filters.query)
        .split(' ')
        .filter(Boolean);
    const category = normalizeSearchText(filters.category);
    const attribute = normalizeSearchText(filters.attribute);

    return (Array.isArray(options) ? options : []).filter(option => {
        const fields = optionSearchFields(option);
        if (queryTerms.some(term => !fields.some(field => field.includes(term)))) return false;
        if (category && normalizeSearchText(option.category) !== category) return false;
        if (attribute && !(Array.isArray(option.attributes)
            && option.attributes.some(item => normalizeSearchText(item) === attribute))) return false;
        return true;
    });
}

function optionKey(option) {
    return normalizeSelectionKey(option?.key ?? option?.value);
}

export function selectOption(selectedOptions, option, mode = 'multiple') {
    const selected = Array.isArray(selectedOptions) ? selectedOptions : [];
    const key = optionKey(option);
    if (!key) return selected.slice();

    if (mode === 'single') return [option];
    if (selected.some(item => optionKey(item) === key)) {
        return selected.filter(item => optionKey(item) !== key);
    }
    return [...selected, option];
}

export function removeSelectedOption(selectedOptions, key) {
    const normalizedKey = normalizeSelectionKey(key);
    return (Array.isArray(selectedOptions) ? selectedOptions : [])
        .filter(option => optionKey(option) !== normalizedKey);
}

export function limitSelectionOptions(options, limit = 200) {
    const safeLimit = Math.max(1, Number.parseInt(limit, 10) || 200);
    const items = Array.isArray(options) ? options.slice(0, safeLimit) : [];
    return {
        items,
        hasMore: Array.isArray(options) && options.length > safeLimit,
    };
}

function splitPromptTokens(value) {
    return String(value ?? '')
        .split(/[,\n]/)
        .map(token => token.trim())
        .filter(Boolean);
}

function snapCursorToTagBoundary(value, cursor) {
    const safeCursor = Math.max(0, Math.min(String(value).length, Number.parseInt(cursor, 10) || 0));
    const before = String(value).slice(0, safeCursor);
    const after = String(value).slice(safeCursor);
    const previousSeparator = Math.max(before.lastIndexOf(','), before.lastIndexOf('\n'));
    const nextComma = after.indexOf(',');
    const nextNewline = after.indexOf('\n');
    const nextSeparatorOffset = [nextComma, nextNewline]
        .filter(offset => offset >= 0)
        .sort((left, right) => left - right)[0];
    const tokenStart = previousSeparator + 1;
    const tokenEnd = nextSeparatorOffset === undefined
        ? String(value).length
        : safeCursor + nextSeparatorOffset;
    const tokenTextBeforeCursor = String(value).slice(tokenStart, safeCursor);
    const tokenTextAfterCursor = String(value).slice(safeCursor, tokenEnd);
    if (!tokenTextBeforeCursor.trim()) {
        return tokenStart + tokenTextAfterCursor.length - tokenTextAfterCursor.trimStart().length;
    }
    if (!tokenTextAfterCursor.trim()) return tokenEnd;
    return tokenEnd;
}

function hasSeparatorAtStart(value) {
    return /^[,\n]/.test(String(value).trimStart());
}

function hasSeparatorAtEnd(value) {
    return /[,\n]\s*$/.test(String(value));
}

export function insertTagsAtCursor(value, tags, start, end = start) {
    const originalValue = String(value ?? '');
    const selectedTags = (Array.isArray(tags) ? tags : [])
        .map(tag => String(tag ?? '').trim())
        .filter(Boolean);
    const existingTokens = new Set(splitPromptTokens(originalValue).map(normalizePromptToken));
    const seenTags = new Set();
    const uniqueTags = selectedTags.filter(tag => {
        const normalizedTag = normalizePromptToken(tag);
        if (!normalizedTag || existingTokens.has(normalizedTag) || seenTags.has(normalizedTag)) return false;
        seenTags.add(normalizedTag);
        return true;
    });
    if (uniqueTags.length === 0) return { value: originalValue, cursor: Math.max(0, Number.parseInt(start, 10) || 0) };

    const requestedStart = Math.max(0, Math.min(originalValue.length, Number.parseInt(start, 10) || 0));
    const requestedEnd = Math.max(requestedStart, Math.min(originalValue.length, Number.parseInt(end, 10) || requestedStart));
    const insertionStart = snapCursorToTagBoundary(originalValue, requestedStart);
    const insertionEnd = requestedEnd === requestedStart
        ? insertionStart
        : snapCursorToTagBoundary(originalValue, requestedEnd);
    const before = originalValue.slice(0, insertionStart);
    const after = originalValue.slice(insertionEnd);
    const inserted = uniqueTags.map(tag => normalizeSearchText(tag).replaceAll('_', ' ')).join(', ');
    const prefix = before && !hasSeparatorAtEnd(before) ? ', ' : '';
    const suffix = after && !hasSeparatorAtStart(after) ? ', ' : '';
    const nextValue = `${before}${prefix}${inserted}${suffix}${after}`;
    return {
        value: nextValue,
        cursor: before.length + prefix.length + inserted.length,
    };
}
