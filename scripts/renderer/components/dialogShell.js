// Shared modal skeleton (backdrop, focus trap, Esc, lastTrigger restore) reused by
// batchWeightDialog.js. Mirrors selectionModal.js so both dialogs look and behave alike.

const FOCUSABLE_SELECTOR = [
    'button:not([disabled])',
    'input:not([disabled])',
    'select:not([disabled])',
    'textarea:not([disabled])',
    '[tabindex]:not([tabindex="-1"])',
].join(',');

let shellSequence = 0;

function createElement(tagName, className, text = '') {
    const element = document.createElement(tagName);
    if (className) element.className = className;
    if (text) element.textContent = text;
    return element;
}

export function createDialogShell({ className = '', onClose = null } = {}) {
    const id = `dialog-shell-${++shellSequence}`;
    const overlay = createElement('div', `selection-modal ${className}`.trim());
    overlay.hidden = true;
    overlay.setAttribute('aria-hidden', 'true');

    const dialog = createElement('div', 'selection-modal-dialog');
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-labelledby', `${id}-title`);
    dialog.tabIndex = -1;

    const header = createElement('header', 'selection-modal-header');
    const heading = createElement('h2', 'selection-modal-title');
    heading.id = `${id}-title`;
    header.appendChild(heading);
    const closeButton = createElement('button', 'selection-modal-close', '×');
    closeButton.type = 'button';
    closeButton.setAttribute('aria-label', 'Close');
    header.appendChild(closeButton);
    dialog.appendChild(header);

    const body = createElement('div', 'dialog-shell-body');
    dialog.appendChild(body);

    const footer = createElement('footer', 'selection-modal-footer');
    dialog.appendChild(footer);

    overlay.appendChild(createElement('div', 'selection-modal-backdrop'));
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);

    let lastTrigger = null;
    let fallbackFocus = null;
    let closeHandler = onClose;

    function isOpen() {
        return !overlay.hidden;
    }

    function restoreFocus() {
        const target = lastTrigger?.isConnected ? lastTrigger : fallbackFocus;
        if (target && typeof target.focus === 'function') {
            target.focus();
        }
        lastTrigger = null;
        fallbackFocus = null;
    }

    function onKeyDown(event) {
        if (event.key === 'Escape') {
            if (event.isComposing || event.keyCode === 229) return;
            event.preventDefault();
            close({ apply: false });
            return;
        }
        if (event.key === 'Tab') {
            const focusable = [...dialog.querySelectorAll(FOCUSABLE_SELECTOR)]
                .filter(element => element.getClientRects().length > 0);
            if (focusable.length === 0) {
                event.preventDefault();
                dialog.focus();
                return;
            }
            const first = focusable[0];
            const last = focusable.at(-1);
            if (event.shiftKey && document.activeElement === first) {
                event.preventDefault();
                last.focus();
            } else if (!event.shiftKey && document.activeElement === last) {
                event.preventDefault();
                first.focus();
            }
        }
    }

    function close({ apply = false } = {}) {
        if (!isOpen()) return;
        overlay.hidden = true;
        overlay.setAttribute('aria-hidden', 'true');
        document.removeEventListener('keydown', onKeyDown);
        if (typeof closeHandler === 'function') closeHandler({ apply });
        restoreFocus();
    }

    function open({ trigger = null, fallback = null, title = '', initialFocus = null } = {}) {
        lastTrigger = trigger;
        fallbackFocus = fallback;
        heading.textContent = title;
        overlay.hidden = false;
        overlay.setAttribute('aria-hidden', 'false');
        document.addEventListener('keydown', onKeyDown);
        requestAnimationFrame(() => {
            const target = typeof initialFocus === 'function' ? initialFocus() : initialFocus;
            (target ?? dialog).focus?.();
        });
    }

    closeButton.addEventListener('click', () => close({ apply: false }));

    return {
        overlay,
        dialog,
        heading,
        body,
        footer,
        closeButton,
        open,
        close,
        isOpen,
        setCloseHandler: handler => { closeHandler = handler; },
        destroy: () => {
            close({ apply: false });
            overlay.remove();
        },
    };
}
