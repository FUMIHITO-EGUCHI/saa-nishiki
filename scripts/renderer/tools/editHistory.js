// Session-only undo/redo core. Callers provide section capture/restore so this
// module stays independent from the DOM and settings persistence.

function clone(value) {
    return value === undefined ? undefined : structuredClone(value);
}

function same(left, right) {
    return JSON.stringify(left) === JSON.stringify(right);
}

function entryBytes(entry) {
    try {
        return new TextEncoder().encode(JSON.stringify(entry)).byteLength;
    } catch {
        return Number.POSITIVE_INFINITY;
    }
}

function normalizedSections(sections) {
    return [...new Set((Array.isArray(sections) ? sections : [sections]).filter(section => typeof section === 'string' && section))].sort();
}

export function createEditHistory({
    capture,
    restore,
    captureFocus = () => null,
    restoreFocus = () => {},
    maxEntries = 100,
    maxBytes = 5 * 1024 * 1024,
    mergeWindowMs = 750,
    now = () => Date.now(),
    onChange = null,
} = {}) {
    if (typeof capture !== 'function' || typeof restore !== 'function') {
        throw new Error('createEditHistory: capture and restore are required');
    }

    const undoStack = [];
    const redoStack = [];
    let undoBytes = 0;
    let active = null;
    let suspended = 0;

    function status() {
        return {
            canUndo: undoStack.length > 0,
            canRedo: redoStack.length > 0,
            undoCount: undoStack.length,
            redoCount: redoStack.length,
        };
    }

    function emit() {
        onChange?.(status());
    }

    function captureSections(sections) {
        const snapshots = {};
        for (const section of sections) snapshots[section] = clone(capture(section));
        return snapshots;
    }

    function addSections(transaction, sections) {
        for (const section of sections) {
            if (transaction.sections.has(section)) continue;
            transaction.sections.add(section);
            transaction.before[section] = clone(capture(section));
        }
    }

    function trim() {
        const countLimit = Math.max(0, Number(maxEntries) || 0);
        const byteLimit = Math.max(0, Number(maxBytes) || 0);
        while (undoStack.length > countLimit || (undoBytes > byteLimit && undoStack.length > 0)) {
            const removed = undoStack.shift();
            undoBytes -= removed.bytes;
        }
    }

    function push(entry) {
        entry.bytes = entryBytes(entry);
        if (!Number.isFinite(entry.bytes) || entry.bytes > maxBytes || maxEntries <= 0) {
            redoStack.length = 0;
            emit();
            return false;
        }

        const previous = undoStack.at(-1);
        const mergeable = Boolean(entry.mergeKey)
            && previous?.mergeKey === entry.mergeKey
            && previous.source === entry.source
            && entry.timestamp - previous.timestamp <= mergeWindowMs
            && same(previous.sections, entry.sections)
            && same(previous.focusAfter, entry.focusBefore);
        if (mergeable) {
            undoBytes -= previous.bytes;
            previous.after = entry.after;
            previous.focusAfter = entry.focusAfter;
            previous.timestamp = entry.timestamp;
            previous.bytes = entryBytes(previous);
            undoBytes += previous.bytes;
        } else {
            undoStack.push(entry);
            undoBytes += entry.bytes;
        }
        redoStack.length = 0;
        trim();
        emit();
        return true;
    }

    function finish(transaction) {
        const sections = [...transaction.sections].sort();
        const after = captureSections(sections);
        if (same(transaction.before, after)) return false;
        return push({
            source: transaction.source,
            mergeKey: transaction.mergeKey,
            sections,
            before: transaction.before,
            after,
            focusBefore: transaction.focusBefore,
            focusAfter: clone(captureFocus()),
            timestamp: now(),
        });
    }

    function beginTransaction(options = {}) {
        if (suspended > 0) return null;
        const sections = normalizedSections(options.sections);
        if (sections.length === 0) return null;

        if (active) {
            addSections(active, sections);
            return { transaction: active, owner: false };
        }

        const transaction = {
            source: String(options.source ?? 'edit'),
            mergeKey: options.mergeKey ? String(options.mergeKey) : '',
            sections: new Set(),
            before: {},
            focusBefore: clone(captureFocus()),
        };
        active = transaction;
        addSections(transaction, sections);
        return { transaction, owner: true };
    }

    function commitTransaction(token) {
        if (!token?.owner) return false;
        if (active !== token.transaction) return false;
        active = null;
        return finish(token.transaction);
    }

    async function runTransaction(options = {}, mutation = () => {}) {
        if (typeof mutation !== 'function') throw new TypeError('runTransaction: mutation must be a function');
        if (suspended > 0) return mutation();

        const sections = normalizedSections(options.sections);
        if (sections.length === 0) return mutation();
        if (active) {
            addSections(active, sections);
            return mutation();
        }

        const token = beginTransaction(options);
        try {
            return await mutation();
        } finally {
            commitTransaction(token);
        }
    }

    async function suspendRecording(mutation) {
        if (typeof mutation !== 'function') throw new TypeError('suspendRecording: mutation must be a function');
        suspended += 1;
        try {
            return await mutation();
        } finally {
            suspended -= 1;
        }
    }

    async function travel(from, to, key) {
        if (active || from.length === 0) return false;
        const entry = from.pop();
        if (key === 'undo') undoBytes -= entry.bytes;
        try {
            await suspendRecording(() => restore(clone(entry[key === 'undo' ? 'before' : 'after']), {
                source: key,
                sections: [...entry.sections],
            }));
            await restoreFocus(clone(entry[key === 'undo' ? 'focusBefore' : 'focusAfter']));
            to.push(entry);
            if (key === 'redo') undoBytes += entry.bytes;
            emit();
            return true;
        } catch (error) {
            from.push(entry);
            if (key === 'undo') undoBytes += entry.bytes;
            throw error;
        }
    }

    return {
        beginTransaction,
        commitTransaction,
        runTransaction,
        suspendRecording,
        undo: () => travel(undoStack, redoStack, 'undo'),
        redo: () => travel(redoStack, undoStack, 'redo'),
        canUndo: () => undoStack.length > 0,
        canRedo: () => redoStack.length > 0,
        undoCount: () => undoStack.length,
        redoCount: () => redoStack.length,
        status,
        isRecordingSuspended: () => suspended > 0,
        isTransactionActive: () => Boolean(active),
        clear() {
            undoStack.length = 0;
            redoStack.length = 0;
            undoBytes = 0;
            emit();
        },
    };
}
