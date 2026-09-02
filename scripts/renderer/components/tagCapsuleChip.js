// One chip = name [+ weight] [+ ×]. Pure rendering; the field owns events and focus.
import { chipKind, describePlan, formatTagWeight, normalizeWeightPlan, weightWarning } from './tagCapsuleLogic.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

const ICON_PATHS = Object.freeze({
    increment: ['M3 12l10-8', 'M7 4h6v6'],
    decrement: ['M3 4l10 8', 'M7 12h6V6'],
    random: null,
    close: ['M4 4l8 8', 'M12 4l-8 8'],
    plus: ['M8 3v10', 'M3 8h10'],
    text: ['M2.5 4h11', 'M2.5 8h11', 'M2.5 12h7'],
    search: ['M10.5 10.5L14 14'],
    layers: ['M8 2.5l6 3-6 3-6-3 6-3z', 'M2 9.5l6 3 6-3'],
    chevronRight: ['M6 4l4 4-4 4'],
    chevronLeft: ['M10 4l-4 4 4 4'],
    chevronDown: ['M4 6l4 4 4-4'],
    minus: ['M3 8h10'],
    lock: ['M5.5 7V5a2.5 2.5 0 0 1 5 0v2'],
    star: ['M8 2.2l1.8 3.7 4.1.6-3 2.9.7 4.1L8 11.6l-3.6 1.9.7-4.1-3-2.9 4.1-.6L8 2.2z'],
});

export function createIcon(name, size = 14) {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('width', String(size));
    svg.setAttribute('height', String(size));
    svg.setAttribute('viewBox', '0 0 16 16');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '1.5');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true');
    svg.classList.add('tag-ui-icon', `tag-ui-icon-${name}`);

    const addPath = d => {
        const path = document.createElementNS(SVG_NS, 'path');
        path.setAttribute('d', d);
        svg.appendChild(path);
    };
    const addCircle = (cx, cy, r, filled = false) => {
        const circle = document.createElementNS(SVG_NS, 'circle');
        circle.setAttribute('cx', String(cx));
        circle.setAttribute('cy', String(cy));
        circle.setAttribute('r', String(r));
        if (filled) circle.setAttribute('fill', 'currentColor');
        svg.appendChild(circle);
    };
    const addRect = (x, y, w, h, rx) => {
        const rect = document.createElementNS(SVG_NS, 'rect');
        rect.setAttribute('x', String(x));
        rect.setAttribute('y', String(y));
        rect.setAttribute('width', String(w));
        rect.setAttribute('height', String(h));
        rect.setAttribute('rx', String(rx));
        svg.appendChild(rect);
    };

    switch (name) {
        case 'random':
            addRect(2.5, 2.5, 11, 11, 2);
            addCircle(5.5, 5.5, 0.9, true);
            addCircle(8, 8, 0.9, true);
            addCircle(10.5, 10.5, 0.9, true);
            break;
        case 'pill':
            addRect(1.5, 4.5, 13, 7, 3.5);
            addPath('M6 4.5v7');
            break;
        case 'search':
            addCircle(7, 7, 4.5);
            addPath('M10.5 10.5L14 14');
            break;
        case 'lock':
            addRect(3.5, 7, 9, 6.5, 1.5);
            addPath('M5.5 7V5a2.5 2.5 0 0 1 5 0v2');
            break;
        default:
            for (const d of ICON_PATHS[name] ?? []) addPath(d);
    }
    return svg;
}

export function modeIconName(mode) {
    if (mode === 'increment' || mode === 'decrement' || mode === 'random') return mode;
    return null;
}

export function chipSignature(capsule, options = {}) {
    const plan = normalizeWeightPlan(capsule.weightPlan);
    return [capsule.id, capsule.value, plan.mode, plan.min, plan.max, plan.step, plan.seed,
        options.excluded ? 1 : 0, options.favorite ? 1 : 0].join('|');
}

export function createChip(capsule, options = {}) {
    const { text, excluded = false, favorite = false } = options;
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'tag-capsule-chip';
    chip.tabIndex = -1;
    chip.draggable = true;

    const fav = document.createElement('span');
    fav.className = 'tag-capsule-chip-fav';
    fav.setAttribute('aria-hidden', 'true');
    fav.appendChild(createIcon('star', 11));
    chip.appendChild(fav);

    const name = document.createElement('span');
    name.className = 'tag-capsule-chip-name';
    chip.appendChild(name);

    const weight = document.createElement('span');
    weight.className = 'tag-capsule-chip-weight';
    chip.appendChild(weight);

    const remove = document.createElement('span');
    remove.className = 'tag-capsule-chip-remove';
    remove.setAttribute('aria-hidden', 'true');
    remove.appendChild(createIcon('close', 12));
    chip.appendChild(remove);

    updateChip(chip, capsule, { text, excluded, favorite });
    return chip;
}

export function updateChip(chip, capsule, options = {}) {
    const { text, excluded = false, favorite = false } = options;
    const plan = normalizeWeightPlan(capsule.weightPlan);
    const kind = chipKind(plan);
    const description = describePlan(plan);
    const modeIcon = modeIconName(plan.mode);

    chip.dataset.capsuleId = capsule.id;
    chip.dataset.signature = chipSignature(capsule, { excluded, favorite });
    chip.classList.toggle('is-up', kind === 'up');
    chip.classList.toggle('is-down', kind === 'down');
    chip.classList.toggle('is-plan', kind === 'plan');
    chip.classList.toggle('is-warn', weightWarning(plan));
    chip.classList.toggle('is-excluded', excluded);
    chip.classList.toggle('is-fav', favorite);
    const favMark = chip.querySelector('.tag-capsule-chip-fav');
    if (favMark) favMark.hidden = !favorite;

    const name = chip.querySelector('.tag-capsule-chip-name');
    name.textContent = capsule.value;
    name.title = capsule.value;

    const weight = chip.querySelector('.tag-capsule-chip-weight');
    weight.replaceChildren();
    if (description) {
        if (modeIcon) weight.appendChild(createIcon(modeIcon, 12));
        weight.appendChild(document.createTextNode(description));
    }
    weight.hidden = !description;

    const labelParts = [capsule.value];
    if (kind === 'plan') {
        labelParts.push(`${plan.mode} ${formatTagWeight(plan.min)} to ${formatTagWeight(plan.max)} step ${formatTagWeight(plan.step)}`);
    } else if (description) {
        labelParts.push(`weight ${formatTagWeight(plan.min)}`);
    }
    if (excluded && typeof text === 'function') labelParts.push(text('tag_ui_excluded'));
    chip.setAttribute('aria-label', labelParts.join(', '));
    chip.title = excluded && typeof text === 'function' ? `${capsule.value} — ${text('tag_ui_excluded')}` : capsule.value;
    return chip;
}

// Keyed diff: reuses chip elements by capsule id, re-renders only changed ones,
// and keeps `trailing` (the add-tag slot) as the last child.
export function renderChips(container, capsules, options = {}) {
    const { text, excludedSet = new Set(), trailing = null, isFavorite = null } = options;
    const existing = new Map();
    for (const child of container.querySelectorAll(':scope > .tag-capsule-chip')) {
        existing.set(child.dataset.capsuleId, child);
    }

    const ordered = [];
    for (const capsule of capsules) {
        const excluded = excludedSet.has(String(capsule.value ?? '').trim().replaceAll(/\s+/g, ' ').toLocaleLowerCase());
        const favorite = typeof isFavorite === 'function' && isFavorite(capsule.value);
        let chip = existing.get(capsule.id);
        if (chip) {
            existing.delete(capsule.id);
            if (chip.dataset.signature !== chipSignature(capsule, { excluded, favorite })) updateChip(chip, capsule, { text, excluded, favorite });
        } else {
            chip = createChip(capsule, { text, excluded, favorite });
        }
        ordered.push(chip);
    }
    for (const stale of existing.values()) stale.remove();

    let cursor = container.firstElementChild;
    for (const chip of ordered) {
        if (cursor === chip) {
            cursor = cursor.nextElementSibling;
            continue;
        }
        container.insertBefore(chip, cursor);
    }
    if (trailing) container.appendChild(trailing);
    return ordered;
}
