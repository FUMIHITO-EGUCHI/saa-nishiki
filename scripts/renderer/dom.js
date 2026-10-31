// The DOM helpers the renderer modules share: one element() instead of a copy in every file, and
// the icon-only button of the Design System (IconButton: .saa-icon-btn in theme.css).
import { iconElement } from '../shared/iconSet.js';

/** A new element with a class and a text; a null or undefined text leaves it empty. */
export function element(tag, className = '', content = null) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (content !== undefined && content !== null) node.textContent = String(content);
    return node;
}

const ICON_BUTTON_SIZES = { 24: '', 26: 'is-26', 28: 'is-28' };

/**
 * A button that shows one icon of the set and no text, so its name goes to aria-label and the
 * tooltip. size: 24 (rows and panels), 26 (the run bar), 28 (the LoRA rows); framed: a face and
 * an edge, as the viewer's tools.
 */
export function iconButton(icon, label, { className = '', size = 24, iconSize = 14, framed = false, onClick = null } = {}) {
    const classes = ['saa-icon-btn', ICON_BUTTON_SIZES[size] ?? '', framed ? 'is-framed' : '', className];
    const node = element('button', classes.filter(Boolean).join(' '));
    node.type = 'button';
    node.setAttribute('aria-label', label);
    node.title = label;
    node.append(iconElement(icon, iconSize));
    if (onClick) node.addEventListener('click', onClick);
    return node;
}
