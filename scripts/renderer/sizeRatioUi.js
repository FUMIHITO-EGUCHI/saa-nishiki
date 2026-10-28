// The run bar's Size: the ratio chip (turn | pick), the chain between the width and
// height boxes and the ratio tiles (scripts/shared/sizeRatio.js).
// The orientation is the size itself: turning swaps the two boxes. The old Landscape
// switch (api_image_landscape, which swapped them only at generation) is folded into
// the boxes when something switches it on and is kept off.
// Stored: api_image_ratio (the ratio last picked, '' = none yet) and
// api_image_ratio_linked (false = Free: the boxes move on their own).

import { RATIOS, followSize, nearestRatio, ratioById, settleRatio, sizeAtArea } from '../shared/sizeRatio.js';

const CAT = '[sizeRatio]';

const CHAIN = {
    linked: '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><path d="M6.8 9.2l2.4-2.4"/><path d="M7.4 4.6l1-1a2.6 2.6 0 013.7 3.7l-1 1"/><path d="M8.6 11.4l-1 1a2.6 2.6 0 01-3.7-3.7l1-1"/></svg>',
    broken: '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><path d="M8.2 4l1-1a2.6 2.6 0 013.7 3.7l-1 1"/><path d="M7.8 12l-1 1a2.6 2.6 0 01-3.7-3.7l1-1"/><path d="M5.6 2.6v1.6M2.6 5.6h1.6M10.4 13.4v-1.6M13.4 10.4h-1.6"/></svg>',
};
const CHEVRON = '<svg viewBox="0 0 16 16" width="10" height="10" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M4 6l4 4 4-4"/></svg>';

function lang() {
    return globalThis.cachedFiles?.language?.[globalThis.globalSettings?.language] ?? {};
}

function uiText(key, fallback) {
    const value = lang()[key];
    return typeof value === 'string' && value ? value : fallback;
}

const sizeBox = axis => globalThis.generate?.[axis];
const readSize = () => ({ width: Number(sizeBox('width')?.getValue?.()), height: Number(sizeBox('height')?.getValue?.()) });
const rangeOf = () => sizeBox('width')?.getRange?.();

function writeSize({ width, height }) {
    sizeBox('width')?.setValue?.(width);
    sizeBox('height')?.setValue?.(height);
}

// the orientation a square size hands to the ratio picked next
let landscape = false;

function turnSize() {
    const { width, height } = readSize();
    if (!Number.isFinite(width) || !Number.isFinite(height)) return;
    landscape = width === height ? !landscape : height > width;
    if (width !== height) writeSize({ width: height, height: width });
}

// generate.landscape for the code that still asks (generation, recipes, language.js):
// never on; switching it on turns the boxes instead.
export function createLandscapeShim() {
    return {
        getValue: () => false,
        setValue: value => {
            if (value === true) turnSize();
            const settings = globalThis.globalSettings;
            if (settings?.api_image_landscape) settings.api_image_landscape = false;
        },
        setTitle: () => {},
    };
}

const ratioLabel = ratio => (ratio.labelKey ? uiText(ratio.labelKey, ratio.label) : ratio.label);

// a rectangle of the ratio, its long side `max` px
function shapeSize(long, turned, max) {
    const short = Math.max(2, Math.round(max / long));
    return turned ? { width: max, height: short } : { width: short, height: max };
}

// through the CSSOM: the page's CSP refuses style attributes in markup
function sizeShape(element, { width, height }) {
    element.style.width = `${width}px`;
    element.style.height = `${height}px`;
}

export function setupSizeRatio() {
    const chip = document.getElementById('run-ratio');
    const turnButton = document.getElementById('run-ratio-turn');
    const pickButton = document.getElementById('run-ratio-pick');
    const chain = document.getElementById('run-ratio-chain');
    const popover = document.getElementById('run-ratio-popover');
    if (!chip || !turnButton || !pickButton || !chain || !popover) return null;

    const shape = turnButton.querySelector('.run-ratio-shape');
    const label = pickButton.querySelector('.run-ratio-label');
    pickButton.querySelector('.run-ratio-chevron').innerHTML = CHEVRON;

    const settings = () => globalThis.globalSettings ?? {};
    const stored = () => ({ ratioId: settings().api_image_ratio ?? '', linked: settings().api_image_ratio_linked !== false });
    const linkedRatio = () => {
        const { ratioId, linked } = stored();
        return linked ? ratioById(ratioId) : null;
    };
    const store = next => {
        const now = stored();
        if (now.ratioId !== next.ratioId) settings().api_image_ratio = next.ratioId;
        if (now.linked !== next.linked) settings().api_image_ratio_linked = next.linked;
    };

    // one undo step for what one click changes (the boxes and the choice together)
    const edit = mutation => {
        const history = globalThis.editHistory;
        const token = history?.beginTransaction?.({ source: 'size-ratio', sections: ['generation'] });
        try {
            mutation();
        } finally {
            if (token) history.commitTransaction(token);
        }
        render();
    };

    const sizeInputs = ['width', 'height'].map(axis => document.querySelector(`.generate-${axis} input[type="number"]`));
    const isTyping = () => sizeInputs.includes(document.activeElement);

    // the run bar refreshes often (queue, progress): markup is only assigned when it changes,
    // so a refresh does not rebuild a tile under the pointer
    const rendered = new Map();
    const setMarkup = (element, markup) => {
        if (rendered.get(element) === markup) return false;
        rendered.set(element, markup);
        element.innerHTML = markup;
        return true;
    };

    let open = false;
    const setOpen = next => {
        open = next;
        popover.hidden = !open;
        pickButton.setAttribute('aria-expanded', String(open));
        chip.classList.toggle('is-open', open);
        if (open) renderTiles();
    };

    function renderTiles() {
        const size = readSize();
        const range = rangeOf();
        const picked = linkedRatio();
        const area = size.width * size.height;
        const tile = ({ index, selected, shape: { width, height }, free, text, px }) => `
            <button type="button" class="run-ratio-tile" data-index="${index}" aria-pressed="${selected}">
                <span class="run-ratio-tile-frame"><span class="run-ratio-shape${free ? ' is-free' : ''}" data-width="${width}" data-height="${height}"></span></span>
                <span class="run-ratio-tile-label">${text}</span>
                <span class="run-ratio-tile-px">${px}</span>
            </button>`;
        const tiles = RATIOS.map((ratio, index) => {
            const next = sizeAtArea(ratio, area, landscape, range);
            return tile({ index, selected: picked?.id === ratio.id, shape: shapeSize(ratio.long, landscape, 40), text: ratioLabel(ratio), px: `${next.width}×${next.height}` });
        });
        const long = Math.max(size.width, size.height) / Math.min(size.width, size.height);
        tiles.push(tile({ index: RATIOS.length, selected: !picked, shape: shapeSize(long, size.width > size.height, 40), free: true, text: uiText('ui_ratio_free', 'Free'), px: `${size.width}×${size.height}` }));
        if (!setMarkup(popover, `<div class="run-ratio-tiles">${tiles.join('')}</div>`)) return;
        for (const element of popover.querySelectorAll('.run-ratio-shape')) {
            sizeShape(element, { width: Number(element.dataset.width), height: Number(element.dataset.height) });
        }
    }
    popover.addEventListener('click', event => {
        const button = event.target.closest('.run-ratio-tile');
        if (!button) return;
        const ratio = RATIOS[Number(button.dataset.index)];
        if (ratio) pick(ratio); else unlink();
        setOpen(false);
        pickButton.focus();
    });

    function render() {
        const size = readSize();
        if (!Number.isFinite(size.width) || !Number.isFinite(size.height)) return;
        const picked = linkedRatio();
        const long = picked ? picked.long : Math.max(size.width, size.height) / Math.min(size.width, size.height);
        sizeShape(shape, shapeSize(long, size.width > size.height, 14));
        shape.classList.toggle('is-free', !picked);
        label.textContent = picked ? ratioLabel(picked) : uiText('ui_ratio_free', 'Free');
        turnButton.setAttribute('aria-label', size.width > size.height || (size.width === size.height && landscape)
            ? uiText('ui_ratio_turn_portrait', 'Turn to portrait') : uiText('ui_ratio_turn_landscape', 'Turn to landscape'));
        pickButton.setAttribute('aria-label', uiText('ui_ratio_pick', 'Aspect ratio'));
        const linked = stored().linked;
        setMarkup(chain, linked ? CHAIN.linked : CHAIN.broken);
        chain.classList.toggle('is-linked', linked);
        chain.setAttribute('aria-pressed', String(linked));
        chain.setAttribute('aria-label', uiText('ui_ratio_keep', 'Keep the ratio'));
        if (open) renderTiles();
    }

    // a ratio picked keeps the pixels the size has now
    function pick(ratio) {
        edit(() => {
            const size = readSize();
            writeSize(sizeAtArea(ratio, size.width * size.height, landscape, rangeOf()));
            store({ ratioId: ratio.id, linked: true });
        });
    }

    function unlink() {
        edit(() => store({ ratioId: stored().ratioId, linked: false }));
    }

    // linked again: the height follows the width at the last ratio (or the nearest one)
    function relink() {
        edit(() => {
            const size = readSize();
            const ratio = ratioById(stored().ratioId) ?? nearestRatio(size.width, size.height);
            writeSize(followSize(ratio, landscape, 'width', size.width, rangeOf()));
            store({ ratioId: ratio.id, linked: true });
        });
    }

    // The size moved by something other than this picker (a recipe, the model type's own
    // size, a clamp, undo): show the ratio it fits. What this writes is a consequence of
    // that change, not an edit of its own, so it stays out of the history.
    let settleTimer = null;
    function settle() {
        clearTimeout(settleTimer);
        settleTimer = null;
        const size = readSize();
        if (!Number.isFinite(size.width) || !Number.isFinite(size.height)) return;
        if (size.width !== size.height) landscape = size.width > size.height;
        if (!isTyping()) {
            const now = stored();
            const next = settleRatio({ ...size, ...now });
            if (next.ratioId !== now.ratioId || next.linked !== now.linked) {
                const history = globalThis.editHistory;
                if (history?.suspendRecording && !history.isRecordingSuspended?.()) {
                    history.suspendRecording(() => store(next)).catch(error => console.error(CAT, 'settle:', error));
                } else {
                    store(next);
                }
            }
        }
        render();
    }
    const settleSoon = () => { if (!settleTimer) settleTimer = setTimeout(settle, 0); };

    // Typing one box moves the other along the ratio. While typing only the other box
    // follows; leaving the box (change) settles both, the typed one pulled back when the
    // other hit the range.
    ['width', 'height'].forEach((axis, index) => {
        const input = sizeInputs[index];
        const container = input?.closest(`.generate-${axis}`);
        if (!input || !container) return;
        let token = null;
        const begin = () => {
            const history = globalThis.editHistory;
            if (token || !history?.beginTransaction) return;
            token = history.beginTransaction({ source: 'size-ratio', sections: ['generation'], mergeKey: `size-ratio:${axis}` });
            setTimeout(() => { if (token) history.commitTransaction(token); token = null; }, 0);
        };
        container.addEventListener('input', begin, true);
        container.addEventListener('change', begin, true);
        const follow = done => {
            const ratio = linkedRatio();
            if (!ratio) return;
            const range = rangeOf();
            const typed = done ? sizeBox(axis).getValue() : Number.parseFloat(input.value);
            if (!Number.isFinite(typed) || (!done && range && (typed < range.min || typed > range.max))) return;
            const next = followSize(ratio, landscape, axis, typed, range);
            const other = axis === 'width' ? 'height' : 'width';
            if (done) writeSize(next); else sizeBox(other)?.setValue?.(next[other]);
        };
        input.addEventListener('input', () => follow(false));
        input.addEventListener('change', () => { follow(true); settleSoon(); });
        input.addEventListener('blur', settleSoon);
    });

    turnButton.addEventListener('click', () => edit(turnSize));
    chain.addEventListener('click', () => (stored().linked ? unlink() : relink()));
    pickButton.addEventListener('click', event => {
        event.stopPropagation();
        setOpen(!open);
    });
    document.addEventListener('click', event => {
        if (open && !event.target.closest('#run-ratio-popover, #run-ratio-pick')) setOpen(false);
    });
    document.addEventListener('keydown', event => {
        if (open && event.key === 'Escape') {
            setOpen(false);
            pickButton.focus();
        }
    });

    const api = { render, settle, settleSoon };
    globalThis.sizeRatio = api;
    settle();
    return api;
}
