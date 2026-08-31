// FP: read-only "Final prompt" disclosure at the end of the prompt panel.
// Shows expandAll()[n] — the exact strings the field set hands to generate.js.
import { createIcon } from './tagCapsuleChip.js';
import { tagText } from './tagUiText.js';

const WEIGHTED_TOKEN = /\(([^()]*?):(-?\d+(?:\.\d+)?)\)/g;

function el(tag, className, text = '') {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text) node.textContent = text;
    return node;
}

// Highlights (tag:weight) tokens using text nodes and spans only.
export function renderWeightedText(target, value) {
    target.replaceChildren();
    const source = String(value ?? '');
    let last = 0;
    for (const match of source.matchAll(WEIGHTED_TOKEN)) {
        const start = match.index;
        if (start > last) target.appendChild(document.createTextNode(source.slice(last, start)));
        const weight = Number(match[2]);
        const span = el('span', weight > 1 ? 'final-prompt-up' : 'final-prompt-down', match[0]);
        target.appendChild(span);
        last = start + match[0].length;
    }
    if (last < source.length) target.appendChild(document.createTextNode(source.slice(last)));
}

export function setupFinalPromptDisclosure({ container, getExpansion, text = tagText, showRight = () => false } = {}) {
    if (!container) return null;

    const root = el('section', 'final-prompt-disclosure');
    const head = el('div', 'final-prompt-head');
    const toggle = el('button', 'final-prompt-toggle');
    toggle.type = 'button';
    toggle.setAttribute('aria-expanded', 'false');
    const chevron = createIcon('chevronRight', 14);
    const toggleText = el('span', 'final-prompt-toggle-text');
    toggle.append(chevron, toggleText);

    const pager = el('div', 'final-prompt-pager');
    const prevButton = el('button', 'tag-weight-stepbtn final-prompt-pager-button');
    prevButton.type = 'button';
    prevButton.appendChild(createIcon('chevronLeft', 12));
    const pagerText = el('span', 'final-prompt-pager-text');
    const nextButton = el('button', 'tag-weight-stepbtn final-prompt-pager-button');
    nextButton.type = 'button';
    nextButton.appendChild(createIcon('chevronRight', 12));
    pager.append(prevButton, pagerText, nextButton);

    const note = el('span', 'final-prompt-note');
    head.append(toggle, pager, note);
    root.appendChild(head);

    const panel = el('div', 'final-prompt-panel');
    panel.id = 'final-prompt-panel';
    panel.hidden = true;
    toggle.setAttribute('aria-controls', panel.id);
    root.appendChild(panel);
    container.appendChild(root);

    let open = false;
    let imageIndex = 0;
    let scheduled = false;
    let chevronNode = chevron;

    function block(label, value) {
        const wrapper = el('div', 'final-prompt-block');
        wrapper.appendChild(el('span', 'final-prompt-block-label', label));
        const out = el('output', 'final-prompt-output');
        if (value) renderWeightedText(out, value);
        else out.textContent = text('tag_ui_fp_empty');
        wrapper.appendChild(out);
        return wrapper;
    }

    function render() {
        toggleText.textContent = text('tag_ui_final_prompt');
        prevButton.setAttribute('aria-label', text('tag_ui_prev_image'));
        nextButton.setAttribute('aria-label', text('tag_ui_next_image'));
        const expansion = typeof getExpansion === 'function' ? getExpansion() : null;
        const rows = expansion?.rows ?? [];
        const count = Math.max(1, rows.length);
        imageIndex = Math.min(imageIndex, count - 1);
        const showPager = open && count > 1;
        pager.hidden = !showPager;
        pagerText.textContent = text('tag_ui_image_n', imageIndex + 1, count);
        prevButton.disabled = imageIndex <= 0;
        nextButton.disabled = imageIndex >= count - 1;
        note.textContent = open ? text('tag_ui_readonly_note') : text('tag_ui_expand_to_review');
        const nextChevron = open ? createIcon('chevronDown', 14) : createIcon('chevronRight', 14);
        chevronNode.replaceWith(nextChevron);
        chevronNode = nextChevron;

        panel.hidden = !open;
        if (!open) return;
        const row = rows[imageIndex];
        panel.replaceChildren();
        panel.appendChild(block(text('tag_ui_fp_positive'), row?.positive ?? ''));
        if (showRight()) panel.appendChild(block(text('tag_ui_fp_positive_right'), row?.positiveRight ?? ''));
        panel.appendChild(block(text('tag_ui_fp_negative'), row?.negative ?? ''));
    }

    function refresh() {
        if (scheduled) return;
        scheduled = true;
        requestAnimationFrame(() => {
            scheduled = false;
            render();
        });
    }

    toggle.addEventListener('click', () => {
        open = !open;
        toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
        render();
    });
    prevButton.addEventListener('click', () => { imageIndex = Math.max(0, imageIndex - 1); render(); });
    nextButton.addEventListener('click', () => { imageIndex += 1; render(); });
    head.addEventListener('keydown', event => {
        if (!open) return;
        if (event.key === 'ArrowLeft' && !prevButton.disabled) { event.preventDefault(); imageIndex -= 1; render(); }
        if (event.key === 'ArrowRight' && !nextButton.disabled) { event.preventDefault(); imageIndex += 1; render(); }
    });

    render();

    return {
        element: root,
        refresh,
        render,
        isOpen: () => open,
        setImageIndex: index => { imageIndex = Math.max(0, Math.floor(index)); render(); },
        updateLanguage: render,
    };
}
