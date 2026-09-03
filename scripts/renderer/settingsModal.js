const CAT = '[SettingsModal]';

const FOCUSABLE_SELECTOR = [
    'button:not([disabled])',
    '[href]',
    'input:not([disabled])',
    'select:not([disabled])',
    'textarea:not([disabled])',
    '[tabindex]:not([tabindex="-1"])'
].join(',');

export function setupSettingsModal() {
    const toggle = document.getElementById('settings-modal-toggle');
    const modal = document.getElementById('settings-modal');
    const dialog = document.getElementById('settings-modal-dialog');
    const closeButton = document.getElementById('settings-modal-close');

    if (!toggle || !modal || !dialog || !closeButton) {
        console.error(CAT, 'Settings modal elements not found');
        return null;
    }

    let lastFocusedElement = null;
    let activePageId = 'general';

    const pageButtons = [...modal.querySelectorAll('.settings-modal-nav-item[data-settings-page]')];
    const pages = [...modal.querySelectorAll('.settings-modal-page[data-settings-page-content]')];

    function setPage(pageId) {
        const targetPage = pages.find(page => page.dataset.settingsPageContent === pageId);
        if (!targetPage) {
            return false;
        }

        activePageId = pageId;
        for (const page of pages) {
            page.hidden = page !== targetPage;
        }
        for (const button of pageButtons) {
            const isActive = button.dataset.settingsPage === pageId;
            button.classList.toggle('is-active', isActive);
            button.setAttribute('aria-selected', String(isActive));
            button.tabIndex = isActive ? 0 : -1;
        }
        return true;
    }

    pageButtons.forEach((button, index) => {
        button.addEventListener('click', () => setPage(button.dataset.settingsPage));
        button.addEventListener('keydown', event => {
            if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') {
                return;
            }
            event.preventDefault();
            const offset = event.key === 'ArrowDown' ? 1 : -1;
            const nextIndex = (index + offset + pageButtons.length) % pageButtons.length;
            const nextButton = pageButtons[nextIndex];
            setPage(nextButton.dataset.settingsPage);
            nextButton.focus();
        });
    });
    setPage(activePageId);

    // Conditional blocks: [data-when-api="ComfyUI|WebUI"], [data-when-model-type="Diffusion"], [data-when-ai="Local|Remote|Pod"]
    function applyConditions() {
        const settings = globalThis.globalSettings ?? {};
        const rules = { api: settings.api_interface, 'model-type': settings.api_model_type, ai: settings.ai_interface };
        for (const [attribute, value] of Object.entries(rules)) {
            for (const element of modal.querySelectorAll(`[data-when-${attribute}]`)) {
                const wanted = String(element.getAttribute(`data-when-${attribute}`) ?? '').split('|');
                element.hidden = !wanted.includes(String(value));
            }
        }
    }
    let conditionsFrame = 0;
    const scheduleConditions = () => {
        cancelAnimationFrame(conditionsFrame);
        conditionsFrame = requestAnimationFrame(applyConditions);
    };
    modal.addEventListener('change', scheduleConditions);
    modal.addEventListener('click', scheduleConditions);
    modal.addEventListener('input', scheduleConditions);

    const focusableElements = () => [...dialog.querySelectorAll(FOCUSABLE_SELECTOR)]
        .filter(element => element.getClientRects().length > 0);

    const onKeyDown = event => {
        if (event.key === 'Escape') {
            event.preventDefault();
            setOpen(false);
            return;
        }

        if (event.key !== 'Tab') {
            return;
        }

        const elements = focusableElements();
        if (elements.length === 0) {
            event.preventDefault();
            dialog.focus();
            return;
        }

        const first = elements[0];
        const last = elements[elements.length - 1];
        if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first.focus();
        }
    };

    function setOpen(isOpen) {
        modal.hidden = !isOpen;
        modal.setAttribute('aria-hidden', String(!isOpen));
        toggle.setAttribute('aria-expanded', String(isOpen));

        if (isOpen) {
            applyConditions();
            const activeElement = document.activeElement;
            lastFocusedElement = activeElement && activeElement !== document.body && !modal.contains(activeElement)
                ? activeElement
                : toggle;
            document.addEventListener('keydown', onKeyDown);
            dialog.focus();
        } else {
            document.removeEventListener('keydown', onKeyDown);
            if (lastFocusedElement && typeof lastFocusedElement.focus === 'function') {
                lastFocusedElement.focus();
            } else {
                toggle.focus();
            }
            lastFocusedElement = null;
        }
    }

    toggle.addEventListener('click', () => setOpen(true));
    closeButton.addEventListener('click', () => setOpen(false));
    modal.querySelector('[data-settings-modal-close]')?.addEventListener('click', () => setOpen(false));

    return {
        toggle,
        open: () => setOpen(true),
        close: () => setOpen(false),
        isOpen: () => !modal.hidden,
        setPage,
        getPage: () => activePageId,
        applyConditions
    };
}
