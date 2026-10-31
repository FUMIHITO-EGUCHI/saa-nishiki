// The app's one icon set (the Design System's IconSet): a 16-unit box, 1.5 strokes with
// round caps and joins, no fill, ink = currentColor, so an icon takes the colour of the text
// around it. Every icon the UI draws comes from here: as an element (iconElement), as markup
// for a template string (iconMarkup), or as a file in scripts/svg (iconFile, written by
// scripts/buildIconFiles.mjs for the <img> and mask uses the upstream layout still has).
// A missing shape is drawn to the same rules and added here.

const path = (...ds) => ds.map(d => ['path', { d }]);
const circle = (cx, cy, r) => ['circle', { cx, cy, r }];
const rect = (x, y, width, height, rx) => ['rect', { x, y, width, height, rx }];
// the only filled marks: small dots (info, dice, grip)
const dot = (cx, cy, r = 0.9) => ['circle', { cx, cy, r, fill: 'currentColor', stroke: 'none' }];

export const ICON_SHAPES = Object.freeze({
    'chevron-down': path('M4 6l4 4 4-4'),
    'chevron-left': path('M10 4l-4 4 4 4'),
    'chevron-right': path('M6 4l4 4-4 4'),
    'arrow-left': path('M13 8H3', 'M7 4L3 8l4 4'),
    'arrow-right': path('M3 8h10', 'M9 4l4 4-4 4'),
    plus: path('M8 3v10', 'M3 8h10'),
    minus: path('M3 8h10'),
    close: path('M4 4l8 8', 'M12 4l-8 8'),
    check: path('M3 8.4l3.2 3.2L13 4.6'),
    search: [circle(7, 7, 4.5), ...path('M10.5 10.5L14 14')],
    pencil: path('M10.5 2.5l3 3-8 8h-3v-3z', 'M9 4l3 3'),
    trash: path('M2.5 4.5h11', 'M6 4.5V3h4v1.5', 'M4 4.5l.7 8.6a1 1 0 0 0 1 .9h4.6a1 1 0 0 0 1-.9l.7-8.6', 'M6.7 7v4.5', 'M9.3 7v4.5'),
    save: path('M3 2.5h7.8l2.7 2.7v7.8a.5.5 0 0 1-.5.5H3a.5.5 0 0 1-.5-.5V3a.5.5 0 0 1 .5-.5z', 'M5 2.5v3h5v-3', 'M5 13.5v-4h6v4'),
    refresh: path('M13 6.5A5 5 0 0 0 3.5 5.2', 'M3.2 2.5v2.9h2.9', 'M3 9.5a5 5 0 0 0 9.5 1.3', 'M12.8 13.5v-2.9H9.9'),
    reset: path('M3 8a5 5 0 1 0 1.5-3.5', 'M4.5 1.8v2.9h2.9'),
    undo: path('M6 5L3 8l3 3', 'M3 8h6a4 4 0 0 1 4 4'),
    redo: path('M10 5l3 3-3 3', 'M13 8H7a4 4 0 0 0-4 4'),
    swap: path('M2.5 5.5h10', 'M10 3l2.5 2.5L10 8', 'M13.5 10.5h-10', 'M6 8l-2.5 2.5L6 13'),
    'put-in': path('M9.3 3.3h4v9.4h-4', 'M2 8h8', 'M6.7 4.7L10 8l-3.3 3.3'),
    expand: path('M9.3 2H14v4.7', 'M6.7 14H2V9.3', 'M14 2L9.3 6.7', 'M2 14l4.7-4.7'),
    grid: [rect(2.5, 2.5, 4.5, 4.5, 1), rect(9, 2.5, 4.5, 4.5, 1), rect(2.5, 9, 4.5, 4.5, 1), rect(9, 9, 4.5, 4.5, 1)],
    sliders: [...path('M2.5 4.5H4', 'M7 4.5h6.5', 'M2.5 8H9', 'M12 8h1.5', 'M2.5 11.5h3', 'M8.5 11.5h5'), circle(5.5, 4.5, 1.5), circle(10.5, 8, 1.5), circle(7, 11.5, 1.5)],
    bookmark: path('M4.5 2.5h7v11L8 11l-3.5 2.5z'),
    clipboard: [rect(3.5, 3, 9, 11, 1.5), rect(6, 1.8, 4, 2.4, 0.8), ...path('M6 8h4', 'M6 10.5h4')],
    'file-upload': path('M9 2.5H4.5a1 1 0 0 0-1 1v9a1 1 0 0 0 1 1h7a1 1 0 0 0 1-1V6z', 'M9 2.5V6h3.5', 'M8 12V8.2', 'M6.3 9.8L8 8.1l1.7 1.7'),
    'image-upload': path('M13.5 9v3.5a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1H7', 'M2.5 11l3-3 2.5 2.5 1.5-1.5 4 3.5', 'M11.5 7V2.5', 'M9.7 4.3l1.8-1.8 1.8 1.8'),
    image: path('M2.5 3.5h11v9h-11z', 'M2.5 11.5l3.5-3.5 2.5 2.5 2-2 3 3'),
    layers: path('M8 2.5l6 3-6 3-6-3z', 'M2 8.5l6 3 6-3', 'M2 11l6 3 6-3'),
    lock: [rect(3.5, 7, 9, 6.5, 1.5), ...path('M5.5 7V5a2.5 2.5 0 0 1 5 0v2')],
    dice: [rect(2.5, 2.5, 11, 11, 2), dot(6, 6), dot(10, 10), dot(10, 6), dot(6, 10)],
    link: path('M6.8 9.2l2.4-2.4', 'M7.4 4.6l1-1a2.6 2.6 0 0 1 3.7 3.7l-1 1', 'M8.6 11.4l-1 1a2.6 2.6 0 0 1-3.7-3.7l1-1'),
    unlink: path('M8.2 4l1-1a2.6 2.6 0 0 1 3.7 3.7l-1 1', 'M7.8 12l-1 1a2.6 2.6 0 0 1-3.7-3.7l1-1', 'M5.6 2.6v1.6M2.6 5.6h1.6M10.4 13.4v-1.6M13.4 10.4h-1.6'),
    info: [circle(8, 8, 6.5), ...path('M8 7.3v3.9'), dot(8, 5.1, 0.7)],
    star: path('M8 2.2l1.8 3.7 4.1.6-3 2.9.7 4.1L8 11.6l-3.6 1.9.7-4.1-3-2.9 4.1-.6L8 2.2z'),
    spark: path('M8 2.5v11', 'M2.5 8h11', 'M4.1 4.1l7.8 7.8', 'M11.9 4.1l-7.8 7.8'),
    text: path('M2.5 4h11', 'M2.5 8h11', 'M2.5 12h7'),
    pill: [rect(1.5, 4.5, 13, 7, 3.5), ...path('M6 4.5v7')],
    increment: path('M3 12l10-8', 'M7 4h6v6'),
    decrement: path('M3 4l10 8', 'M7 12h6V6'),
    moon: path('M13.5 9.2A5.8 5.8 0 1 1 6.8 2.5a4.5 4.5 0 0 0 6.7 6.7z'),
    sun: [circle(8, 8, 2.8), ...path('M8 1.5V3', 'M8 13v1.5', 'M1.5 8H3', 'M13 8h1.5', 'M3.4 3.4l1.1 1.1', 'M11.5 11.5l1.1 1.1', 'M3.4 12.6l1.1-1.1', 'M11.5 4.5l1.1-1.1')],
    brush: path('M13.5 2.5c-2.2 1.2-4.2 2.9-5.6 4.8l.8.8c1.9-1.4 3.6-3.4 4.8-5.6z', 'M7.1 8.3c-1.4-.2-2.5.7-2.6 2-.1 1.1-.6 1.8-1.9 2.2 1.9.8 4.1.3 4.9-1 .5-.8.4-1.7-.4-3.2z'),
    portrait: [rect(2.5, 2.5, 11, 11, 2), circle(8, 6.8, 2.2), ...path('M4.8 13.5c.5-1.9 1.7-2.9 3.2-2.9s2.7 1 3.2 2.9')],
    pose: [circle(8, 3.2, 1.4), ...path('M8 4.8v4.4', 'M4.5 5.5L8 7l3.5-2', 'M8 9.2l-2.5 4.3', 'M8 9.2l2.8 4.3')],
    grip: [dot(6, 4), dot(10, 4), dot(6, 8), dot(10, 8), dot(6, 12), dot(10, 12)],
});

export const ICON_NAMES = Object.freeze(Object.keys(ICON_SHAPES));

const SVG_NS = 'http://www.w3.org/2000/svg';
const ROOT = { viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.5', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' };

function shapeOf(name) {
    const shape = ICON_SHAPES[name];
    if (!shape) throw new Error(`no icon named "${name}"`);
    return shape;
}

const attributes = values => Object.entries(values).map(([key, value]) => ` ${key}="${value}"`).join('');

/** `<svg>` markup for a template string. */
export function iconMarkup(name, size = 16, { className = '' } = {}) {
    const inner = shapeOf(name).map(([tag, values]) => `<${tag}${attributes(values)}/>`).join('');
    return `<svg${className ? ` class="${className}"` : ''}${attributes({ width: size, height: size, ...ROOT })}>${inner}</svg>`;
}

/** An `<svg>` element; `name` null gives an empty one of the same size. */
export function iconElement(name, size = 16, { className = '' } = {}) {
    const svg = document.createElementNS(SVG_NS, 'svg');
    for (const [key, value] of Object.entries({ width: size, height: size, ...ROOT })) svg.setAttribute(key, String(value));
    if (className) svg.classList.add(...className.split(/\s+/).filter(Boolean));
    for (const [tag, values] of name === null ? [] : shapeOf(name)) {
        const child = document.createElementNS(SVG_NS, tag);
        for (const [key, value] of Object.entries(values)) child.setAttribute(key, String(value));
        svg.appendChild(child);
    }
    return svg;
}

/** A standalone SVG file in black ink, for an <img> a CSS filter tints or a CSS mask. */
export function iconFile(name) {
    return `${iconMarkup(name, 16).replace('<svg', `<svg xmlns="${SVG_NS}"`).replaceAll('currentColor', '#000000').replace(' aria-hidden="true"', '')}\n`;
}
