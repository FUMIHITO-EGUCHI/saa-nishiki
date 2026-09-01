import { createIcon } from './components/tagCapsuleChip.js';

const PROMPT_KEYS = Object.freeze(['common', 'positive', 'positive_right', 'negative', 'ai', 'exclude']);

export function historyShortcut(event = {}) {
    if (event.isComposing || event.keyCode === 229 || event.altKey) return null;
    if (!event.ctrlKey && !event.metaKey) return null;
    const key = String(event.key ?? '').toLowerCase();
    if (key === 'z') return event.shiftKey ? 'redo' : 'undo';
    if (key === 'y' && !event.shiftKey) return 'redo';
    return null;
}

export function classifyHistoryInput(inputType = '', composing = false) {
    const type = String(inputType);
    if (type === 'historyUndo' || type === 'historyRedo') return 'history';
    if (composing || type.includes('Composition')) return 'composition';
    if (type === 'insertFromPaste') return 'paste';
    if (type === 'insertFromDrop') return 'drop';
    if (type.startsWith('delete')) return 'delete';
    if (type.startsWith('insert')) return 'typing';
    return type || 'edit';
}

function language() {
    return globalThis.cachedFiles?.language?.[globalThis.globalSettings?.language] ?? {};
}

function text(key, fallback) {
    const value = language()[key];
    return typeof value === 'string' && value ? value : fallback;
}

function promptControl(key) {
    return globalThis.prompt?.[key] ?? null;
}

function promptKeyForTextbox(target) {
    for (const key of PROMPT_KEYS) {
        if (promptControl(key)?.getElement?.() === target) return key;
    }
    return null;
}

function capsuleFieldForElement(target) {
    const fields = globalThis.prompt?.tagCapsuleFields?.fields;
    if (!fields || !target) return null;
    for (const [key, field] of fields) {
        if (field.element?.contains?.(target) || field.header?.contains?.(target)) return { key, field };
    }
    return null;
}

function isNativeEditor(target) {
    return Boolean(target?.closest?.('input, textarea, [contenteditable="true"]'));
}

function createFocusAdapter() {
    return {
        capture() {
            const active = document.activeElement;
            const textKey = promptKeyForTextbox(active);
            if (textKey) {
                return {
                    kind: 'text',
                    field: textKey,
                    start: active.selectionStart ?? 0,
                    end: active.selectionEnd ?? 0,
                    direction: active.selectionDirection ?? 'none',
                };
            }
            const capsule = capsuleFieldForElement(active);
            if (!capsule) return null;
            const chip = active.closest?.('.tag-capsule-chip');
            const chips = capsule.field.element?.querySelectorAll?.('.tag-capsule-chip') ?? [];
            return {
                kind: 'capsule',
                field: capsule.key,
                capsuleId: chip?.dataset?.capsuleId ?? '',
                index: chip ? [...chips].indexOf(chip) : 0,
            };
        },
        restore(focus) {
            if (!focus?.field) return;
            const field = globalThis.prompt?.tagCapsuleFields?.get?.(focus.field);
            const textbox = promptControl(focus.field)?.getElement?.();
            if (field?.getMode?.() === 'capsule') {
                field.focusFromHistory?.(focus.capsuleId, focus.index);
                return;
            }
            if (!textbox) return;
            textbox.focus();
            const length = textbox.value?.length ?? 0;
            const start = Math.max(0, Math.min(length, Number(focus.start) || 0));
            const end = Math.max(start, Math.min(length, Number(focus.end) || start));
            textbox.setSelectionRange?.(start, end, focus.direction ?? 'none');
        },
    };
}

export function setupEditHistoryUi() {
    const history = globalThis.editHistory;
    const undoButton = document.getElementById('edit-history-undo');
    const redoButton = document.getElementById('edit-history-redo');
    const status = document.getElementById('edit-history-status');
    if (!history || !undoButton || !redoButton || !status) return null;

    undoButton.replaceChildren(createIcon('undo', 16));
    redoButton.replaceChildren(createIcon('redo', 16));
    globalThis.editHistoryFocus = createFocusAdapter();
    const composing = new WeakSet();

    function updateButtons(next = history.status()) {
        undoButton.disabled = !next.canUndo;
        redoButton.disabled = !next.canRedo;
    }

    function updateLanguage() {
        const undo = text('ui_history_undo', 'Undo');
        const redo = text('ui_history_redo', 'Redo');
        undoButton.title = `${undo} (Ctrl+Z)`;
        redoButton.title = `${redo} (Ctrl+Y / Ctrl+Shift+Z)`;
        undoButton.setAttribute('aria-label', undoButton.title);
        redoButton.setAttribute('aria-label', redoButton.title);
    }

    async function travel(action) {
        const changed = await history[action]();
        if (changed) status.textContent = action === 'undo'
            ? text('ui_history_undone', 'Undo complete')
            : text('ui_history_redone', 'Redo complete');
        updateButtons();
        return changed;
    }

    for (const button of [undoButton, redoButton]) {
        button.addEventListener('pointerdown', event => event.preventDefault());
    }
    undoButton.addEventListener('click', () => { void travel('undo'); });
    redoButton.addEventListener('click', () => { void travel('redo'); });

    document.addEventListener('compositionstart', event => {
        if (promptKeyForTextbox(event.target)) composing.add(event.target);
    }, true);
    document.addEventListener('compositionend', event => {
        if (!promptKeyForTextbox(event.target)) return;
        setTimeout(() => composing.delete(event.target), 0);
    }, true);

    document.addEventListener('beforeinput', event => {
        const key = promptKeyForTextbox(event.target);
        if (!key) return;
        if (event.inputType === 'historyUndo' || event.inputType === 'historyRedo') {
            event.preventDefault();
            void travel(event.inputType === 'historyUndo' ? 'undo' : 'redo');
            return;
        }
        const category = classifyHistoryInput(event.inputType, event.isComposing || composing.has(event.target));
        history.runTransaction({
            source: 'input',
            sections: ['prompt'],
            mergeKey: `prompt:${key}:${category}`,
        }, () => {}).catch(error => console.error('[EditHistory] input capture failed', error));
    }, true);

    document.addEventListener('keydown', event => {
        const action = historyShortcut(event);
        if (!action) return;
        const managedTextbox = Boolean(promptKeyForTextbox(event.target));
        if (isNativeEditor(event.target) && !managedTextbox) return;
        event.preventDefault();
        void travel(action);
    }, true);

    document.addEventListener('saa-edit-history-changed', event => updateButtons(event.detail));
    updateButtons();
    updateLanguage();

    const api = { undo: () => travel('undo'), redo: () => travel('redo'), updateLanguage, updateButtons };
    globalThis.editHistoryUi = api;
    return api;
}
