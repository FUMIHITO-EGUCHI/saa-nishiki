// One chip = name [+ weight] [+ ×]. Pure rendering; the field owns events and focus.
import { chipKind, describePlan, formatTagWeight, normalizeWeightPlan, weightWarning } from './tagCapsuleLogic.js';
import { PART_PREFIX, isPartToken, partNameOf } from '../../shared/parts.js';
import { heatLabel, heatTier } from '../../shared/tagHeat.js';
import { ICON_SHAPES, iconElement, iconMarkup } from '../../shared/iconSet.js';

// the chip and popover names of the icons, where they differ from the icon set's
const ICON_SHAPE_OF = Object.freeze({
    random: 'dice', chevronDown: 'chevron-down', chevronLeft: 'chevron-left', chevronRight: 'chevron-right', arrowRight: 'arrow-right',
});

export function createIcon(name, size = 14) {
    const shape = ICON_SHAPE_OF[name] ?? name;
    // a name with no icon (the "fixed" weight mode) keeps its place as an empty box
    return iconElement(ICON_SHAPES[shape] ? shape : null, size, { className: `tag-ui-icon tag-ui-icon-${name}` });
}

export function modeIconName(mode) {
    if (mode === 'increment' || mode === 'decrement' || mode === 'random') return mode;
    return null;
}

export function chipSignature(capsule, options = {}) {
    const plan = normalizeWeightPlan(capsule.weightPlan);
    const part = options.part ? `${options.part.exists ? 1 : 0}:${options.part.count}` : '';
    const lora = options.lora ? `${options.lora.suggest ?? 0}:${options.lora.from ? 1 : 0}` : '';
    return [capsule.id, capsule.value, plan.mode, plan.min, plan.max, plan.step, plan.seed,
        options.excluded ? 1 : 0, options.favorite ? 1 : 0, capsule.disabled ? 1 : 0, options.status ?? '', part,
        options.heat ?? '', lora].join('|');
}

const LINK_ICON = iconMarkup('link', 11);

// The LoRA marks of a chip (loraUi.js chipInfo): the badge counting the LoRAs suggested
// for the tag, which opens their popover, and the link mark on a trigger word that came
// in with a LoRA of the slots.
function paintLoraMarks(chip, lora) {
    const from = Boolean(lora?.from);
    const suggest = Number(lora?.suggest) || 0;
    chip.classList.toggle('is-from-lora', from);
    let mark = chip.querySelector('.tag-capsule-chip-from-lora');
    if (from && !mark) {
        mark = document.createElement('span');
        mark.className = 'tag-capsule-chip-from-lora';
        mark.innerHTML = LINK_ICON;
        chip.insertBefore(mark, chip.querySelector('.tag-capsule-chip-name'));
    } else if (!from) {
        mark?.remove();
    }
    let badge = chip.querySelector('.tag-capsule-chip-lora');
    if (suggest > 0) {
        if (!badge) {
            badge = document.createElement('span');
            badge.className = 'tag-capsule-chip-lora';
            badge.setAttribute('role', 'button');
            chip.appendChild(badge);
        }
        badge.textContent = `LoRA ${suggest}`;
        badge.setAttribute('aria-label', `LoRAs that know ${chip.querySelector('.tag-capsule-chip-name')?.title ?? ''}`);
    } else {
        badge?.remove();
    }
}

export function createChip(capsule, options = {}) {
    const { text, excluded = false, favorite = false, status = '', part = null, heat = null, lora = null } = options;
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'tag-capsule-chip';
    chip.tabIndex = -1;
    chip.draggable = true;
    // the field only repaints selection state while something is (or was) selected
    chip.setAttribute('aria-selected', 'false');

    // one-touch enable/disable dot; the field toggles `disabled` when it is clicked
    const toggle = document.createElement('span');
    toggle.className = 'tag-capsule-chip-toggle';
    toggle.setAttribute('aria-hidden', 'true');
    chip.appendChild(toggle);

    // a favorite is told by the segment (★ on amber); no separate star before the name

    const name = document.createElement('span');
    name.className = 'tag-capsule-chip-name';
    chip.appendChild(name);

    const weight = document.createElement('span');
    weight.className = 'tag-capsule-chip-weight';
    chip.appendChild(weight);
    // no × on the chip: a tag is removed from the context menu or with Delete

    updateChip(chip, capsule, { text, excluded, favorite, status, part, heat, lora });
    return chip;
}

export function updateChip(chip, capsule, options = {}) {
    const { text, excluded = false, favorite = false, status = '', part = null, heat = null, lora = null } = options;
    const plan = normalizeWeightPlan(capsule.weightPlan);
    const kind = chipKind(plan);
    const description = describePlan(plan);
    const modeIcon = modeIconName(plan.mode);

    chip.dataset.capsuleId = capsule.id;
    chip.dataset.signature = chipSignature(capsule, { excluded, favorite, status, part, heat, lora });
    // a "parts:<name>" token: the gold prefix, the name, and the member count at the right
    chip.classList.toggle('is-part', Boolean(part));
    chip.classList.toggle('is-part-missing', Boolean(part) && !part.exists);
    // dictionary marks (tagDictionaryStatus.js): a value no tag matches, or a sentence
    chip.classList.toggle('is-unknown', !part && status === 'unknown');
    chip.classList.toggle('is-sentence', !part && status === 'sentence');
    // the heat tier (shared/tagHeat.js): a tag the models have barely seen, or seen little of
    const tier = part ? null : heatTier(heat);
    chip.classList.toggle('is-heat-weak', tier === 'weak');
    chip.classList.toggle('is-heat-thin', tier === 'thin');
    chip.classList.toggle('is-up', kind === 'up');
    chip.classList.toggle('is-down', kind === 'down');
    chip.classList.toggle('is-plan', kind === 'plan');
    chip.classList.toggle('is-warn', weightWarning(plan));
    chip.classList.toggle('is-excluded', excluded);
    chip.classList.toggle('is-fav', favorite);
    chip.classList.toggle('is-disabled', capsule.disabled === true);
    chip.setAttribute('aria-pressed', capsule.disabled === true ? 'false' : 'true');
    const toggleMark = chip.querySelector('.tag-capsule-chip-toggle');
    if (toggleMark && typeof text === 'function') toggleMark.title = text(capsule.disabled ? 'tag_ui_enable_tag' : 'tag_ui_disable_tag');
    // the segment's icon says the state: ✓ in the prompt, − left out, ★ a favorite, × excluded
    const stateIcon = capsule.disabled === true ? 'minus' : excluded ? 'close' : favorite ? 'star' : 'check';
    if (toggleMark && toggleMark.dataset.icon !== stateIcon) {
        const icon = createIcon(stateIcon, 10);
        if (stateIcon === 'star') icon.setAttribute('fill', 'currentColor');
        toggleMark.replaceChildren(icon);
        toggleMark.dataset.icon = stateIcon;
    }
    const favMark = chip.querySelector('.tag-capsule-chip-fav');
    if (favMark) favMark.hidden = !favorite;

    const name = chip.querySelector('.tag-capsule-chip-name');
    if (part) {
        const prefix = document.createElement('span');
        prefix.className = 'tag-capsule-chip-prefix';
        prefix.textContent = PART_PREFIX;
        name.replaceChildren(prefix, document.createTextNode(partNameOf(capsule.value) ?? capsule.value));
    } else {
        name.textContent = capsule.value;
    }
    name.title = capsule.value;

    const weight = chip.querySelector('.tag-capsule-chip-weight');
    weight.replaceChildren();
    if (description) {
        if (modeIcon) weight.appendChild(createIcon(modeIcon, 12));
        // the segment shows the number alone; the token's ":" is for the prompt text
        weight.appendChild(document.createTextNode(description.replace(/^:/, '')));
    } else if (part?.exists) {
        // a part at weight 1: the right segment counts its tags instead
        weight.appendChild(document.createTextNode(String(part.count)));
    }
    weight.hidden = !description && !part?.exists;

    const labelParts = [capsule.value];
    if (kind === 'plan') {
        labelParts.push(`${plan.mode} ${formatTagWeight(plan.min)} to ${formatTagWeight(plan.max)} step ${formatTagWeight(plan.step)}`);
    } else if (description) {
        labelParts.push(`weight ${formatTagWeight(plan.min)}`);
    }
    if (excluded && typeof text === 'function') labelParts.push(text('tag_ui_excluded'));
    if (capsule.disabled && typeof text === 'function') labelParts.push(text('tag_ui_disabled'));
    // the tooltip: the value, the exclusion, then the tier wording with the exact count
    const titleParts = [capsule.value];
    if (excluded && typeof text === 'function') titleParts.push(text('tag_ui_excluded'));
    const heatText = tier ? heatLabel(text, heat) : '';
    if (heatText) {
        labelParts.push(heatText);
        titleParts.push(heatText);
    }
    chip.setAttribute('aria-label', labelParts.join(', '));
    chip.title = titleParts.join(' — ');
    paintLoraMarks(chip, part ? null : lora);
    return chip;
}

// Keyed diff: reuses chip elements by capsule id, re-renders only changed ones,
// and keeps `trailing` (the add-tag slot) as the last child.
export function renderChips(container, capsules, options = {}) {
    const { text, excludedSet = new Set(), trailing = null, isFavorite = null, tagStatus = null, tagHeat = null, partInfo = null, loraInfo = null } = options;
    const existing = new Map();
    for (const child of container.querySelectorAll(':scope > .tag-capsule-chip')) {
        existing.set(child.dataset.capsuleId, child);
    }

    const ordered = [];
    for (const capsule of capsules) {
        const excluded = excludedSet.has(String(capsule.value ?? '').trim().replaceAll(/\s+/g, ' ').toLocaleLowerCase());
        const favorite = typeof isFavorite === 'function' && isFavorite(capsule.value);
        // a part token is neither looked up in the dictionary nor a favorite candidate
        const part = typeof partInfo === 'function' && isPartToken(capsule.value) ? partInfo(capsule.value) : null;
        const status = !part && typeof tagStatus === 'function' ? tagStatus(capsule.value) : '';
        const heat = !part && status === 'known' && typeof tagHeat === 'function' ? tagHeat(capsule.value) : null;
        const lora = !part && typeof loraInfo === 'function' ? loraInfo(capsule.value) : null;
        let chip = existing.get(capsule.id);
        if (chip) {
            existing.delete(capsule.id);
            if (chip.dataset.signature !== chipSignature(capsule, { excluded, favorite, status, part, heat, lora })) updateChip(chip, capsule, { text, excluded, favorite, status, part, heat, lora });
        } else {
            chip = createChip(capsule, { text, excluded, favorite, status, part, heat, lora });
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
