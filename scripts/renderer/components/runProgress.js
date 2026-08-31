// Progress / error rows of the run bar.
// The generation code keeps driving the legacy #cg-loading-overlay (created by
// mainGallery.showLoading) and globalThis.generate.loadingMessage; this module mirrors
// that state into the run bar so the floating overlay can stay hidden via CSS.
// Pure helpers (parseLoadingMessage, formatElapsed) are exported for tests.

const TICK_MS = 250;

// "abc123\n[2/4] <6/22>" → { label: '[2/4]', step: 6, total: 22, extra: 'abc123' }
export function parseLoadingMessage(message) {
    const raw = String(message ?? '').trim();
    if (!raw) return { label: '', step: null, total: null, extra: '' };
    const progress = /<\s*(\d+)\s*\/\s*(\d+)\s*>/.exec(raw);
    const withoutProgress = raw.replace(/<\s*\d+\s*\/\s*\d+\s*>/, '').trim();
    const lines = withoutProgress.split('\n').map(line => line.trim()).filter(Boolean);
    const label = lines.length ? lines[lines.length - 1] : '';
    const extra = lines.slice(0, -1).join(' · ');
    return {
        label,
        step: progress ? Number(progress[1]) : null,
        total: progress ? Number(progress[2]) : null,
        extra,
    };
}

export function formatElapsed(ms) {
    const seconds = Math.max(0, Math.floor(ms / 1000));
    if (seconds < 60) return `${seconds} s`;
    const minutes = Math.floor(seconds / 60);
    return `${minutes} m ${String(seconds % 60).padStart(2, '0')} s`;
}

export function setupRunProgress({ root, text = {} } = {}) {
    if (!root) return null;
    root.innerHTML = `
        <div class="run-progress-row" hidden>
            <span class="run-progress-title"></span>
            <span class="run-progress-timer mono"></span>
            <span class="run-progress-bar" role="progressbar" aria-valuemin="0" aria-valuemax="100"><i></i></span>
            <span class="run-progress-actions"></span>
        </div>
        <div class="run-error-row" hidden>
            <span class="run-error-pill"><i></i><span class="run-error-text"></span></span>
            <span class="run-error-hint"></span>
            <button type="button" class="run-error-details"></button>
        </div>
    `;
    const progressRow = root.querySelector('.run-progress-row');
    const title = root.querySelector('.run-progress-title');
    const timer = root.querySelector('.run-progress-timer');
    const bar = root.querySelector('.run-progress-bar');
    const barFill = bar.querySelector('i');
    const actions = root.querySelector('.run-progress-actions');
    const errorRow = root.querySelector('.run-error-row');
    const errorText = root.querySelector('.run-error-text');
    const errorHint = root.querySelector('.run-error-hint');
    const errorButton = root.querySelector('.run-error-details');

    let startTime = 0;
    let tickHandle = null;
    let lastStep = null;
    let lastTotal = null;

    function tick() {
        const parsed = parseLoadingMessage(globalThis.generate?.loadingMessage);
        title.textContent = parsed.label || (text.generating ?? 'Generating…');
        title.title = parsed.extra;
        timer.textContent = formatElapsed(Date.now() - startTime);
        const step = parsed.step ?? lastStep;
        const total = parsed.total ?? lastTotal;
        if (Number.isFinite(step) && Number.isFinite(total) && total > 0) {
            lastStep = step;
            lastTotal = total;
            const percent = Math.max(0, Math.min(100, Math.round((step / total) * 100)));
            barFill.style.width = `${percent}%`;
            bar.setAttribute('aria-valuenow', String(percent));
            bar.classList.remove('is-indeterminate');
        } else {
            barFill.style.width = '';
            bar.removeAttribute('aria-valuenow');
            bar.classList.add('is-indeterminate');
        }
    }

    function start() {
        if (tickHandle) return;
        startTime = Date.now();
        lastStep = null;
        lastTotal = null;
        progressRow.hidden = false;
        root.classList.add('is-running');
        tick();
        tickHandle = setInterval(tick, TICK_MS);
    }

    function stop() {
        if (tickHandle) clearInterval(tickHandle);
        tickHandle = null;
        progressRow.hidden = true;
        root.classList.remove('is-running');
    }

    function showError(message) {
        errorText.textContent = message || (text.errorTitle ?? 'Backend error');
        errorHint.textContent = text.errorHint ?? 'Queue paused · press Create Image to retry';
        errorButton.textContent = text.details ?? 'Details';
        errorRow.hidden = false;
        root.classList.add('is-error');
    }

    function hideError() {
        errorRow.hidden = true;
        root.classList.remove('is-error');
    }

    errorButton.addEventListener('click', () => {
        const overlay = document.getElementById('cg-error-overlay');
        if (overlay) overlay.classList.toggle('is-revealed');
    });

    const sync = () => {
        const loading = document.getElementById('cg-loading-overlay');
        if (loading && !tickHandle) start();
        if (!loading && tickHandle) stop();
        const error = document.getElementById('cg-error-overlay');
        if (error) {
            const pre = error.querySelector('pre');
            const firstLine = (pre?.textContent ?? '').split('\n').map(line => line.trim()).find(Boolean) ?? '';
            showError(firstLine.slice(0, 120));
        } else if (!errorRow.hidden) {
            hideError();
        }
    };
    const observer = new MutationObserver(sync);
    observer.observe(document.body, { childList: true });
    sync();

    return {
        element: root,
        actions,
        isRunning: () => Boolean(tickHandle),
        refresh: sync,
        updateLanguage(nextText = {}) {
            Object.assign(text, nextText);
            if (!errorRow.hidden) {
                errorHint.textContent = text.errorHint ?? errorHint.textContent;
                errorButton.textContent = text.details ?? errorButton.textContent;
            }
        },
        destroy() {
            observer.disconnect();
            stop();
        },
    };
}
