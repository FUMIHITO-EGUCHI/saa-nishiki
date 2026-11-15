// The lock buttons (promptLocks.js): one on a prompt row that has a random source (beside its
// ⋯), one on a Random character slot (after its weight), one on the AI card while the AI
// prompt is on; and what each drew last, after the row's "+ Tag" and after the slot's name.
// A locked one shows what it holds; an unlocked one what it drew last, dimmed.

import { iconElement } from '../shared/iconSet.js';
import { hasRandomSource } from '../shared/promptLocks.js';
import { deriveAiMode } from './components/aiModeLogic.js';
import { LOCKS_CHANGED_EVENT, aiState, characterState, fieldState, toggleAiLock, toggleCharacterLock, toggleFieldLock } from './promptLocks.js';

const LIST_ROWS = new Set(['background', 'style']);

function text(key, fallback) {
    const value = globalThis.cachedFiles?.language?.[globalThis.globalSettings?.language]?.[key];
    return typeof value === 'string' && value !== '' ? value : fallback;
}

function paintButton(button, locked, label) {
    button.setAttribute('aria-pressed', String(locked));
    button.replaceChildren(iconElement(locked ? 'lock' : 'unlock', 14));
    button.title = locked ? text('ui_lock_on', 'Locked: keeps what it drew. Click to draw anew') : text('ui_lock_off', 'Lock what it drew');
    button.setAttribute('aria-label', `${button.title} · ${label}`);
}

function lockButton(className, onClick) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `saa-icon-btn is-26 prompt-lock ${className}`;
    button.hidden = true;
    button.addEventListener('click', event => { event.stopPropagation(); onClick(); });
    return button;
}

// ---------------------------------------------------------------- prompt rows

/** A row's lock (before `before`, the ⋯) and its drawn-value pill; painted by paintRowLock. */
export function attachRowLock(container, id, tools, before) {
    if (!container || container.__promptLock) return;
    const button = lockButton('prompt-row-lock', () => toggleFieldLock(container.__promptLock.id));
    tools.insertBefore(button, before ?? null);
    const pill = document.createElement('span');
    pill.className = 'prompt-lock-drawn';
    pill.hidden = true;
    container.__promptLock = { id, button, pill };
    // the pill moves with the row's view (chips / text)
    container.querySelector('.tag-view-toggle')?.addEventListener('click', () => queueMicrotask(() => globalThis.prompt?.fieldManager?.paintLocks?.()));
}

/** `text` is the row's text, `label` its name, `positive` whether it goes into the prompt. */
export function paintRowLock(container, { text: rowText = '', label = '', positive = true } = {}) {
    const lock = container?.__promptLock;
    if (!lock) return;
    const state = fieldState(lock.id);
    const drawing = hasRandomSource(rowText, { list: LIST_ROWS.has(lock.id) });
    // a locked row keeps its button (to unlock it) even with its sources gone
    const show = positive && (state.locked || drawing);
    lock.button.hidden = !show;
    if (show) paintButton(lock.button, state.locked, label);
    // the pill sits after "+ Tag" (the add slot stays put while the chips re-render), or in
    // the text view's corner
    const view = container.querySelector('.tag-capsule-view');
    const chips = Boolean(view && !view.hidden);
    const host = chips ? container.querySelector('.tag-capsule-add-slot') : container.querySelector('.myTextbox-container-relative');
    if (host && lock.pill.parentElement !== host) host.appendChild(lock.pill);
    lock.pill.classList.toggle('is-corner', !chips);
    const values = show && drawing ? state.values : [];
    lock.pill.hidden = values.length === 0;
    lock.pill.classList.toggle('is-held', state.locked);
    lock.pill.textContent = values.length ? `→ ${values.join(', ')}` : '';
    lock.pill.title = values.join(', ');
}

// ---------------------------------------------------------------- character slots

/**
 * The lock a character slot list (characterSelectionModal.js) gives each Random slot:
 * `nameOf(key)` is what the slot list calls a character.
 */
export function characterLocks() {
    return {
        state: index => characterState(index),
        toggle: index => toggleCharacterLock(index),
        paintButton,
        prune: count => globalThis.promptLocks?.pruneCharacters?.(count),
    };
}

// ---------------------------------------------------------------- the AI card

function setupAiLock() {
    const head = document.querySelector('#ai-card .ai-card-head');
    const role = head?.querySelector('.ai-role');
    if (!head || !role) return null;
    const button = lockButton('ai-lock', () => toggleAiLock());
    role.after(button);
    const paint = () => {
        const settings = globalThis.globalSettings ?? {};
        const role = Number(globalThis.ai?.ai_select?.getValue?.() ?? settings.ai_prompt_role ?? 0);
        const state = aiState();
        // the AI answers only with a mode (Expand / Refine) and a role
        const show = deriveAiMode(settings) !== 'off' && role !== 0;
        button.hidden = !show;
        if (!show) return;
        paintButton(button, state.locked, text('ui_ai_title', 'AI prompt'));
        if (state.text) button.title = `${button.title}\n${state.text}`;
    };
    // the mode and role buttons repaint it as they change
    head.addEventListener('click', () => requestAnimationFrame(paint));
    return paint;
}

export function setupPromptLocksUi() {
    const paintAi = setupAiLock();
    const repaint = () => {
        paintAi?.();
        globalThis.prompt?.fieldManager?.paintLocks?.();
        globalThis.characterList?.paintLocks?.();
    };
    document.addEventListener(LOCKS_CHANGED_EVENT, repaint);
    repaint();
    return { repaint };
}
