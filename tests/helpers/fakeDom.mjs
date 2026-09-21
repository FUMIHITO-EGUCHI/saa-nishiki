// A small in-memory DOM for renderer component tests (node has no DOM). It covers what the
// components under test touch:
//   - elements with classes / attributes / children / listeners, and a `dataset` that is a
//     live view of the data-* attributes, as a browser's is - markup parsed into the tree
//     is read back through `dataset`, and writing `dataset.foo` is what makes `[data-foo]`
//     match;
//   - a CSS selector subset: tag, #id, .class, [attribute] with = ^= $= *= ~= |=,
//     :not() / :is() / :where() / :scope / :disabled / :enabled / :checked /
//     :first-child / :last-child, with descendant and child combinators. A pseudo-class
//     nobody implemented throws rather than quietly matching nothing;
//   - event propagation with a capture phase, `once` listeners, stopPropagation, and a
//     `target` filled in by the dispatcher;
//   - `textContent` computed from the descendants the way a node does, and written by
//     replacing the children with one text node, so a `<pre>` given text it must not
//     interpret holds a text node and no elements;
//   - the two child lists a browser keeps apart: `childNodes` is every node, `children`
//     only the elements, and a document fragment inserted into either empties into its
//     new parent instead of becoming a node of the tree;
//   - a `value` that is a DOMString on the text controls: a number written into one reads
//     back as the text of that number;
//   - an innerHTML parser that nests (an opening tag encloses what follows it until its
//     closing tag; void and self-closed tags do not), decodes entities, and reflects
//     class / hidden / data-* / the input attributes onto the element;
//   - layout boxes: a box is what setLayoutBox gave the element and zero otherwise, and
//     the offset / client / scroll properties derive from it. What is faithful is
//     *whether* there is one - an element outside the page, or with a hidden ancestor,
//     has no client rects at all, which is how a focus trap tells the rows it may move to
//     from the ones it may not;
//   - range inputs that sanitize their value to min / max / step the way Chromium does -
//     reading `value` after a narrower `max` is set gives the clamped value.
//
// What it does not model: CSS cascade, inheritance or computed style (style.setProperty
// stores custom properties and nothing resolves them), real layout (nothing measures, so
// the offset / client / scroll properties are whatever a test declares - and unlike a
// browser's they are writable, because there is no engine to derive them from), shadow
// DOM, mutation observers, selection, the `+` / `~` sibling combinators, and innerHTML
// serialization fidelity (the getter emits tags and text, not attributes - enough for the
// `if (!element.innerHTML)` emptiness checks the components make and for `innerHTML +=`).
// The parser drops a run of text that is only whitespace, which a browser would keep, so
// markup indented in a template literal does not turn into textContent nobody wrote. Only
// `id`, `tabindex` and `disabled` reflect between property and attribute; `className`,
// `hidden` and `checked` are plain properties, so setAttribute('class', ...) does not
// reach classList.

class FakeClassList {
    constructor(element) {
        this.element = element;
    }

    #names() {
        return String(this.element.className ?? '').split(/\s+/).filter(Boolean);
    }

    #write(names) {
        this.element.className = [...new Set(names)].join(' ');
    }

    add(...names) { this.#write([...this.#names(), ...names]); }
    remove(...names) { this.#write(this.#names().filter(name => !names.includes(name))); }
    contains(name) { return this.#names().includes(name); }
    toggle(name, force) {
        const on = force === undefined ? !this.contains(name) : Boolean(force);
        if (on) this.add(name); else this.remove(name);
        return on;
    }
}

// ---------------------------------------------------------------- selectors
// One compound part: a tag, #id, .class, an [attribute] test or a :pseudo-class
// (with an optional parenthesised argument).
const COMPOUND_PART = /^(?:(\*|[a-zA-Z][\w-]*)|#([\w-]+)|\.([\w-]+)|\[\s*([\w-]+)\s*(?:([~^*$|]?=)\s*(?:"([^"]*)"|'([^']*)'|([^\]\s]+)))?\s*\]|:([\w-]+)(?:\(([^)]*)\))?)/;

// Splits a selector list at its top-level commas: the ones inside :not(...) or an
// attribute value belong to that part.
function splitSelectorList(selector) {
    const parts = [];
    let depth = 0;
    let quote = '';
    let current = '';
    for (const char of String(selector)) {
        if (quote) {
            if (char === quote) quote = '';
            current += char;
            continue;
        }
        if (char === '"' || char === "'") { quote = char; current += char; continue; }
        if (char === '(' || char === '[') depth += 1;
        if (char === ')' || char === ']') depth -= 1;
        if (char === ',' && depth === 0) { parts.push(current); current = ''; continue; }
        current += char;
    }
    parts.push(current);
    return parts.map(part => part.trim()).filter(Boolean);
}

function parseComplex(selector) {
    const parts = [];
    let rest = selector.trim();
    let combinator = null;
    while (rest) {
        const compound = { tag: null, id: null, classes: [], attributes: [], pseudos: [] };
        let matched = false;
        let match;
        while ((match = COMPOUND_PART.exec(rest))) {
            matched = true;
            if (match[1]) compound.tag = match[1];
            else if (match[2]) compound.id = match[2];
            else if (match[3]) compound.classes.push(match[3]);
            else if (match[4]) {
                compound.attributes.push({
                    name: match[4],
                    operator: match[5] ?? null,
                    value: match[6] ?? match[7] ?? match[8] ?? null,
                });
            } else compound.pseudos.push({ name: match[9], argument: match[10] ?? null });
            rest = rest.slice(match[0].length);
        }
        if (!matched) throw new Error(`fake DOM: unsupported selector "${selector}"`);
        parts.push({ compound, combinator });
        const gap = /^\s*(>)?\s*/.exec(rest);
        rest = rest.slice(gap[0].length);
        combinator = gap[1] ? '>' : ' ';
    }
    return parts;
}

const selectorCache = new Map();

function parseSelector(selector) {
    const key = String(selector);
    if (!selectorCache.has(key)) selectorCache.set(key, splitSelectorList(key).map(parseComplex));
    return selectorCache.get(key);
}

function attributeMatches(element, { name, operator, value }) {
    const actual = element.getAttribute(name);
    if (actual === null) return false;
    if (!operator) return true;
    if (operator === '=') return actual === value;
    if (operator === '^=') return actual.startsWith(value);
    if (operator === '$=') return actual.endsWith(value);
    if (operator === '*=') return actual.includes(value);
    if (operator === '~=') return actual.split(/\s+/).includes(value);
    if (operator === '|=') return actual === value || actual.startsWith(`${value}-`);
    return false;
}

function pseudoMatches(element, { name, argument }, scope) {
    switch (name) {
        case 'not': return !splitSelectorList(argument ?? '').some(part => matchesSelector(element, part, scope));
        case 'is':
        case 'where': return splitSelectorList(argument ?? '').some(part => matchesSelector(element, part, scope));
        case 'scope': return element === scope;
        case 'disabled': return element.disabled === true;
        case 'enabled': return element.disabled !== true;
        case 'checked': return element.checked === true;
        case 'first-child': return (element.parentElement?.children ?? [])[0] === element;
        case 'last-child': return (element.parentElement?.children ?? []).at(-1) === element;
        // A pseudo-class nobody implemented here would quietly match the wrong rows; say so
        // instead, so whoever needs it adds it.
        default: throw new Error(`fake DOM: unsupported pseudo-class ":${name}"`);
    }
}

function matchesCompound(element, compound, scope) {
    if (!element || element.nodeType !== 1) return false;
    if (compound.tag && compound.tag !== '*' && element.tagName !== compound.tag.toUpperCase()) return false;
    if (compound.id && element.id !== compound.id) return false;
    if (!compound.classes.every(name => element.classList.contains(name))) return false;
    if (!compound.attributes.every(attribute => attributeMatches(element, attribute))) return false;
    return compound.pseudos.every(pseudo => pseudoMatches(element, pseudo, scope));
}

function matchesComplex(element, parts, scope) {
    if (!matchesCompound(element, parts.at(-1).compound, scope)) return false;
    let current = element;
    for (let index = parts.length - 1; index > 0; index--) {
        const { compound } = parts[index - 1];
        if (parts[index].combinator === '>') {
            current = current.parentElement;
            if (!matchesCompound(current, compound, scope)) return false;
            continue;
        }
        let ancestor = current.parentElement;
        while (ancestor && !matchesCompound(ancestor, compound, scope)) ancestor = ancestor.parentElement;
        if (!ancestor) return false;
        current = ancestor;
    }
    return true;
}

function matchesSelector(element, selector, scope = null) {
    return parseSelector(selector).some(complex => matchesComplex(element, complex, scope));
}

// ---------------------------------------------------------------- style and dataset
// style.foo = '...' is a plain property here; custom properties go through the same three
// methods a CSSStyleDeclaration offers. Nothing resolves them - there is no cascade.
function createStyle() {
    const custom = new Map();
    const style = {};
    Object.defineProperties(style, {
        setProperty: { value: (name, value) => { custom.set(name, String(value)); } },
        getPropertyValue: { value: name => custom.get(name) ?? '' },
        removeProperty: { value: name => { const value = custom.get(name) ?? ''; custom.delete(name); return value; } },
    });
    return style;
}

// dataset is a live view of the data-* attributes, as it is in a browser: writing
// `dataset.fieldKey` is what makes `[data-field-key]` match, and a data-* attribute the
// innerHTML parser set is read back as `dataset.fieldKey` without anything syncing them.
const DATA_PREFIX = 'data-';
const toAttributeName = property => DATA_PREFIX + String(property).replaceAll(/[A-Z]/g, char => `-${char.toLowerCase()}`);
const toDatasetName = attribute => attribute.slice(DATA_PREFIX.length).replaceAll(/-([a-z])/g, (whole, char) => char.toUpperCase());

function createDataset(element) {
    return new Proxy({}, {
        get: (target, property) => (typeof property === 'string' ? element.getAttribute(toAttributeName(property)) ?? undefined : undefined),
        set: (target, property, value) => { element.setAttribute(toAttributeName(property), value); return true; },
        has: (target, property) => typeof property === 'string' && element.hasAttribute(toAttributeName(property)),
        deleteProperty: (target, property) => { element.removeAttribute(toAttributeName(property)); return true; },
        ownKeys: () => [...element.attributes.keys()].filter(name => name.startsWith(DATA_PREFIX)).map(toDatasetName),
        getOwnPropertyDescriptor: (target, property) => (typeof property === 'string' && element.hasAttribute(toAttributeName(property))
            ? { value: element.getAttribute(toAttributeName(property)), writable: true, enumerable: true, configurable: true }
            : undefined),
    });
}

// ---------------------------------------------------------------- events
// The dispatcher fills in `target`, which a real Event (node has Event / CustomEvent)
// only exposes through a getter - an own property has to shadow it. A plain object
// literal, the usual stand-in for an event in these tests, keeps the target it was given.
export function setEventTarget(event, node) {
    if (event.target !== undefined && event.target !== null) return;
    try {
        Object.defineProperty(event, 'target', { value: node, configurable: true, writable: true, enumerable: true });
    } catch { /* an event that will not take one keeps whatever it reports */ }
}

// The DOM event path: capture from the root down to the target, the target itself, then
// the bubble phase back up when the event bubbles. stopPropagation ends it where it is.
function dispatchOnPath(node, event) {
    const path = [];
    for (let current = node; current; current = current.parentElement) path.push(current);
    const ownerDocument = node.ownerDocument ?? node;
    if (ownerDocument !== node && path.at(-1) === ownerDocument.documentElement) path.push(ownerDocument);

    setEventTarget(event, node);
    let stopped = false;
    const ownStop = Object.getOwnPropertyDescriptor(event, 'stopPropagation');
    const originalStop = event.stopPropagation;
    Object.defineProperty(event, 'stopPropagation', {
        configurable: true,
        writable: true,
        enumerable: Boolean(ownStop?.enumerable),
        value: function stopPropagation(...args) {
            stopped = true;
            return originalStop?.apply(this, args);
        },
    });

    const call = (target, phase) => {
        for (const entry of [...(target.__listeners?.get(event.type) ?? [])]) {
            if (phase === 'capture' && !entry.capture) continue;
            if (phase === 'bubble' && entry.capture) continue;
            if (entry.once) target.removeEventListener(event.type, entry.listener, entry.options);
            entry.listener.call(target, event);
            if (stopped) return true;
        }
        return false;
    };

    try {
        for (const target of [...path].reverse()) {
            if (target === node) break;
            if (call(target, 'capture')) return true;
        }
        if (call(node, 'target')) return true;
        if (event.bubbles) {
            for (const target of path.slice(1)) {
                if (call(target, 'bubble')) return true;
            }
        }
    } finally {
        if (ownStop) Object.defineProperty(event, 'stopPropagation', ownStop);
        else delete event.stopPropagation;
    }
    return true;
}

function addListener(target, type, listener, options) {
    if (typeof listener !== 'function') return;
    const capture = options === true || Boolean(options?.capture);
    const once = Boolean(options?.once);
    if (!target.__listeners.has(type)) target.__listeners.set(type, []);
    const entries = target.__listeners.get(type);
    if (entries.some(entry => entry.listener === listener && entry.capture === capture)) return;
    entries.push({ listener, capture, once, options });
}

function removeListener(target, type, listener, options) {
    const capture = options === true || Boolean(options?.capture);
    target.__listeners.set(type, (target.__listeners.get(type) ?? [])
        .filter(entry => !(entry.listener === listener && entry.capture === capture)));
}

// ---------------------------------------------------------------- markup
const VOID_TAGS = new Set(['AREA', 'BASE', 'BR', 'COL', 'EMBED', 'HR', 'IMG', 'INPUT', 'LINK', 'META', 'PARAM', 'SOURCE', 'TRACK', 'WBR']);

const ENTITIES = { lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', amp: '&' };

function decodeEntities(text) {
    return String(text).replaceAll(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body) => {
        if (body.startsWith('#')) {
            const code = body[1] === 'x' || body[1] === 'X' ? Number.parseInt(body.slice(2), 16) : Number.parseInt(body.slice(1), 10);
            return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
        }
        return ENTITIES[body.toLowerCase()] ?? whole;
    });
}

// Attributes the parser writes as properties rather than plain attributes, because that is
// where the element keeps them (an input sanitizes through its setters, for one).
const PARSED_PROPERTIES = new Set(['type', 'min', 'max', 'step', 'value', 'title', 'id']);

// ---------------------------------------------------------------- elements
// Elements that take the focus without a tabindex of their own.
const NATURALLY_FOCUSABLE = new Set(['A', 'BUTTON', 'INPUT', 'SELECT', 'TEXTAREA']);

// `value` on a text control is a DOMString: a number written into one reads back as the
// text of that number, which is what the components then pass on.
const TEXT_CONTROLS = new Set(['INPUT', 'TEXTAREA']);

// The layout properties, and what each one reads off the box when no test has written it.
const LAYOUT_PROPERTIES = {
    offsetWidth: box => box.width,
    offsetHeight: box => box.height,
    offsetLeft: box => box.left,
    offsetTop: box => box.top,
    clientWidth: box => box.width,
    clientHeight: box => box.height,
    scrollWidth: box => box.width,
    scrollHeight: box => box.height,
};

export class FakeElement {
    #text = '';
    #box = null;
    #layout = new Map();
    #valueText;

    constructor(ownerDocument, tagName) {
        this.ownerDocument = ownerDocument;
        this.nodeType = tagName === '#text' ? 3 : (tagName === '#fragment' ? 11 : 1);
        this.tagName = String(tagName).toUpperCase();
        this.id = '';
        this.className = '';
        this.title = '';
        this.hidden = false;
        this.checked = false;
        this.style = createStyle();
        this.childNodes = [];
        this.parentElement = null;
        this.attributes = new Map();
        this.__listeners = new Map();
        this.classList = new FakeClassList(this);
        this.dataset = createDataset(this);
    }

    // `listeners` was the public store before capture / once were supported; it still
    // reads as "type -> the functions registered for it".
    get listeners() {
        return new Map([...this.__listeners].map(([type, entries]) => [type, entries.map(entry => entry.listener)]));
    }

    get value() { return this.#valueText; }
    set value(next) { this.#valueText = TEXT_CONTROLS.has(this.tagName) ? String(next) : next; }

    // `children` is the element children, as a browser's HTMLCollection is; the text
    // nodes are in `childNodes` with them.
    get children() { return this.childNodes.filter(node => node.nodeType === 1); }
    get childElementCount() { return this.children.length; }
    get options() { return this.children.filter(child => child.tagName === 'OPTION'); }
    get firstChild() { return this.childNodes[0] ?? null; }
    get lastChild() { return this.childNodes.at(-1) ?? null; }
    get firstElementChild() { return this.children[0] ?? null; }
    get lastElementChild() { return this.children.at(-1) ?? null; }
    get nextSibling() {
        const siblings = this.parentElement?.childNodes ?? [];
        return siblings[siblings.indexOf(this) + 1] ?? null;
    }

    get nextElementSibling() {
        const siblings = this.parentElement?.children ?? [];
        return siblings[siblings.indexOf(this) + 1] ?? null;
    }

    get previousElementSibling() {
        const siblings = this.parentElement?.children ?? [];
        const index = siblings.indexOf(this);
        return index > 0 ? siblings[index - 1] : null;
    }

    // In the page when the document holds it (what `isConnected` means in the browser).
    get isConnected() {
        const root = this.ownerDocument?.documentElement;
        for (let current = this; current; current = current.parentElement) if (current === root) return true;
        return false;
    }

    // What a node's text is: its own for a text node, its descendants' joined for an
    // element. Writing it replaces the children with a single text node.
    get textContent() {
        if (this.nodeType === 3) return this.#text;
        return this.childNodes.map(child => child.textContent).join('');
    }

    set textContent(value) {
        const text = value === null || value === undefined ? '' : String(value);
        if (this.nodeType === 3) { this.#text = text; return; }
        for (const child of this.childNodes) child.parentElement = null;
        this.childNodes = [];
        if (text) this.appendChild(this.ownerDocument.createTextNode(text));
    }

    // tabIndex and disabled reflect their attributes, so [tabindex] / [disabled] and
    // :disabled see what the property set (and the other way round).
    get tabIndex() {
        const parsed = Number.parseInt(this.getAttribute('tabindex'), 10);
        if (Number.isFinite(parsed)) return parsed;
        return NATURALLY_FOCUSABLE.has(this.tagName) ? 0 : -1;
    }

    set tabIndex(value) {
        const parsed = Number.parseInt(value, 10);
        this.setAttribute('tabindex', String(Number.isFinite(parsed) ? parsed : 0));
    }

    get disabled() { return this.hasAttribute('disabled'); }

    set disabled(value) { this.toggleAttribute('disabled', Boolean(value)); }

    #node(value) {
        if (value instanceof FakeElement) return value;
        return this.ownerDocument.createTextNode(value);
    }

    // Inserting a document fragment inserts its children and leaves the fragment empty,
    // as it does in a browser - the fragment itself never becomes a node of the tree.
    #expand(node) {
        if (node.nodeType !== 11) return [node];
        const moved = [...node.childNodes];
        for (const child of moved) child.parentElement = null;
        node.childNodes = [];
        return moved;
    }

    appendChild(child) {
        for (const node of this.#expand(child)) {
            node.remove();
            node.parentElement = this;
            this.childNodes.push(node);
        }
        return child;
    }

    append(...nodes) { for (const node of nodes) this.appendChild(this.#node(node)); }

    prepend(...nodes) {
        for (const node of nodes.flatMap(value => this.#expand(this.#node(value))).reverse()) {
            node.remove();
            node.parentElement = this;
            this.childNodes.unshift(node);
        }
    }

    insertBefore(node, reference) {
        for (const child of this.#expand(node)) {
            child.remove();
            const index = reference ? this.childNodes.indexOf(reference) : -1;
            child.parentElement = this;
            if (index < 0) this.childNodes.push(child); else this.childNodes.splice(index, 0, child);
        }
        return node;
    }

    insertAdjacentElement(position, node) {
        const parent = this.parentElement;
        if (position === 'afterend' && parent) return parent.insertBefore(node, this.nextSibling);
        if (position === 'beforebegin' && parent) return parent.insertBefore(node, this);
        if (position === 'afterbegin') { this.prepend(node); return node; }
        return this.appendChild(node);
    }

    replaceChildren(...nodes) {
        for (const child of this.childNodes) child.parentElement = null;
        this.childNodes = [];
        // an emptied box has nothing to scroll: a browser clamps its scrollTop to 0 and
        // does not bring it back when children are appended again
        if ('scrollTop' in this) this.scrollTop = 0;
        this.append(...nodes);
    }

    remove() {
        const parent = this.parentElement;
        if (!parent) return;
        parent.childNodes = parent.childNodes.filter(child => child !== this);
        this.parentElement = null;
    }

    contains(node) {
        for (let current = node; current; current = current.parentElement) if (current === this) return true;
        return false;
    }

    setAttribute(name, value) { this.attributes.set(name, String(value)); if (name === 'id') this.id = String(value); }
    getAttribute(name) { return this.attributes.has(name) ? this.attributes.get(name) : null; }
    hasAttribute(name) { return this.attributes.has(name); }
    removeAttribute(name) { this.attributes.delete(name); }
    toggleAttribute(name, force) {
        const on = force === undefined ? !this.hasAttribute(name) : Boolean(force);
        if (on) this.setAttribute(name, ''); else this.removeAttribute(name);
        return on;
    }

    addEventListener(type, listener, options) { addListener(this, type, listener, options); }

    removeEventListener(type, listener, options) { removeListener(this, type, listener, options); }

    dispatchEvent(event) { return dispatchOnPath(this, event); }

    matches(selector) { return matchesSelector(this, selector, this); }

    closest(selector) {
        for (let current = this; current; current = current.parentElement) {
            if (current.nodeType === 1 && matchesSelector(current, selector, this)) return current;
        }
        return null;
    }

    querySelectorAll(selector) {
        const found = [];
        const walk = element => {
            for (const child of element.childNodes) {
                if (child.nodeType === 1 && matchesSelector(child, selector, this)) found.push(child);
                walk(child);
            }
        };
        walk(this);
        return found;
    }

    querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }

    focus() { this.ownerDocument.activeElement = this; }
    blur() { if (this.ownerDocument.activeElement === this) this.ownerDocument.activeElement = null; }
    select() {}
    click() { this.dispatchEvent({ type: 'click', bubbles: true, preventDefault() {}, stopPropagation() {} }); }
    scrollIntoView() {}

    // ---- layout. There is no layout engine here: a box is what setLayoutBox gave the
    // element, zero-sized otherwise. What is faithful is *whether* there is one - an
    // element outside the page, or with a hidden ancestor, has no box at all, which is
    // how a focus trap tells the rows it may move to from the ones it may not.
    get __rendered() {
        if (!this.isConnected) return false;
        for (let current = this; current && current.nodeType === 1; current = current.parentElement) {
            if (current.hidden === true || current.style?.display === 'none') return false;
        }
        return true;
    }

    setLayoutBox(box = {}) {
        this.#box = { top: 0, left: 0, width: 0, height: 0, ...box };
        // the box is the newer word on the element's size: drop the values written directly
        for (const name of Object.keys(LAYOUT_PROPERTIES)) this.#layout.delete(name);
    }

    getBoundingClientRect() {
        if (!this.__rendered) return { top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0 };
        const { top, left, width, height } = this.#box ?? { top: 0, left: 0, width: 0, height: 0 };
        return { top, left, right: left + width, bottom: top + height, width, height, x: left, y: top };
    }

    getClientRects() { return this.__rendered ? [this.getBoundingClientRect()] : []; }

    // The offset / client / scroll sizes derive from the box, but stay writable: a browser
    // computes them and refuses the assignment, and with no engine here a test declaring
    // one directly is the only way to say how big something came out.
    __layoutValue(name) {
        if (this.#layout.has(name)) return this.#layout.get(name);
        return LAYOUT_PROPERTIES[name](this.getBoundingClientRect());
    }

    __setLayoutValue(name, value) { this.#layout.set(name, value); }

    // Rough serialization - enough for the `if (!element.innerHTML)` emptiness checks the
    // components make and for `innerHTML +=`, not a faithful round-trip of the markup.
    get innerHTML() {
        return this.childNodes.map(node => {
            if (node.nodeType === 3) return node.textContent;
            const tag = node.tagName.toLowerCase();
            return `<${tag}>${node.innerHTML}</${tag}>`;
        }).join('');
    }

    // Parser: an opening tag becomes a child of the tag that encloses it and a closing tag
    // pops back out, so a control is found under the parent its markup gives it. Text
    // between tags is entity-decoded into a text node of the enclosing element; a run that
    // is only whitespace is dropped, so markup indented in a template literal does not
    // turn into textContent nobody wrote.
    set innerHTML(html) {
        this.replaceChildren();
        const source = String(html);
        const stack = [this];
        let index = 0;
        const flush = upto => {
            const text = decodeEntities(source.slice(index, upto));
            if (text.trim()) stack.at(-1).appendChild(this.ownerDocument.createTextNode(text));
        };
        for (const match of source.matchAll(/<(\/?)([a-zA-Z][\w-]*)([^>]*)>/g)) {
            const [tag, closing, name, rest] = match;
            flush(match.index);
            index = match.index + tag.length;
            if (closing) {
                const open = stack.findLastIndex(node => node.tagName === name.toUpperCase());
                if (open > 0) stack.length = open;
                continue;
            }
            const element = this.ownerDocument.createElement(name);
            for (const [, attribute, doubleQuoted, singleQuoted, bare] of rest.matchAll(/([\w-]+)(?:=(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) {
                const value = decodeEntities(doubleQuoted ?? singleQuoted ?? bare ?? '');
                if (attribute === 'class') element.className = value;
                else if (attribute === 'hidden') element.hidden = true;
                else if (PARSED_PROPERTIES.has(attribute)) element[attribute] = value;
                else element.setAttribute(attribute, value);
            }
            stack.at(-1).appendChild(element);
            if (!rest.trimEnd().endsWith('/') && !VOID_TAGS.has(element.tagName)) stack.push(element);
        }
        flush(source.length);
    }
}

for (const name of Object.keys(LAYOUT_PROPERTIES)) {
    Object.defineProperty(FakeElement.prototype, name, {
        configurable: true,
        enumerable: false,
        get() { return this.__layoutValue(name); },
        set(value) { this.__setLayoutValue(name, value); },
    });
}

// A range input the way Chromium keeps one: the value is sanitized in place whenever it,
// or one of min / max / step, is written, and the sanitized value is what the element then
// holds. Widening the range again therefore does not bring back the value it had before a
// narrower one clamped it - reading `value` is not a fresh derivation from what was set.
export class FakeInput extends FakeElement {
    #type = 'text';
    #min = '';
    #max = '';
    #step = '';
    #value = '';

    constructor(ownerDocument, tagName = 'input') {
        super(ownerDocument, tagName);
    }

    get type() { return this.#type; }
    set type(next) { this.#type = String(next); this.#sanitize(); }

    get min() { return this.#min; }
    set min(next) { this.#min = String(next); this.#sanitize(); }

    get max() { return this.#max; }
    set max(next) { this.#max = String(next); this.#sanitize(); }

    get step() { return this.#step; }
    set step(next) { this.#step = String(next); this.#sanitize(); }

    get value() { return this.#value; }
    set value(next) { this.#value = String(next); this.#sanitize(); }

    #sanitize() {
        if (this.#type !== 'range') return;
        const min = Number.isFinite(Number.parseFloat(this.#min)) ? Number.parseFloat(this.#min) : 0;
        const ceiling = Number.isFinite(Number.parseFloat(this.#max)) ? Number.parseFloat(this.#max) : 100;
        // a maximum below the minimum counts as the minimum (HTML: "if max < min, max is min")
        const max = ceiling < min ? min : ceiling;
        const step = Number.parseFloat(this.#step) > 0 ? Number.parseFloat(this.#step) : 1;
        let value = Number.parseFloat(this.#value);
        if (!Number.isFinite(value)) value = min + (max - min) / 2;
        value = Math.min(max, Math.max(min, value));
        value = min + Math.round((value - min) / step) * step;
        if (value > max) value -= step;
        this.#value = String(Number(value.toFixed(10)));
    }
}

// CSS.escape, as the modal's aria-activedescendant lookup uses it.
export const FakeCSS = {
    escape(value) {
        return String(value).replaceAll(/[^\w-]/g, char => `\\${char}`).replace(/^(-?\d)/, '\\3$1 ');
    },
};

export function createFakeDocument() {
    const documentListeners = new Map();
    const document = {
        activeElement: null,
        __listeners: documentListeners,
        createElement: tag => {
            const name = String(tag).toLowerCase();
            const element = name === 'input' ? new FakeInput(document) : new FakeElement(document, tag);
            if (['select', 'option', 'textarea'].includes(name)) element.value = '';
            return element;
        },
        createElementNS: (namespace, tag) => new FakeElement(document, tag),
        createTextNode: text => {
            const node = new FakeElement(document, '#text');
            node.textContent = String(text);
            return node;
        },
        createDocumentFragment: () => new FakeElement(document, '#fragment'),
        getElementById: id => document.documentElement.querySelectorAll(`#${id}`)[0] ?? null,
        querySelector: selector => document.documentElement.querySelector(selector),
        querySelectorAll: selector => document.documentElement.querySelectorAll(selector),
        contains: node => document.documentElement.contains(node),
        addEventListener: (type, listener, options) => addListener(document, type, listener, options),
        removeEventListener: (type, listener, options) => removeListener(document, type, listener, options),
        dispatchEvent: event => {
            setEventTarget(event, document);
            for (const entry of [...(documentListeners.get(event.type) ?? [])]) {
                if (entry.once) removeListener(document, event.type, entry.listener, entry.options);
                entry.listener.call(document, event);
            }
            return true;
        },
    };
    document.documentElement = new FakeElement(document, 'html');
    document.body = document.documentElement.appendChild(new FakeElement(document, 'body'));
    return document;
}

// Runs `body` with a fake document (plus the few window globals the components read)
// installed on globalThis, restoring whatever was there afterwards.
export async function withFakeDom(body, extraGlobals = {}) {
    const document = createFakeDocument();
    const globals = {
        document,
        CSS: FakeCSS,
        requestAnimationFrame: callback => setTimeout(callback, 0),
        cancelAnimationFrame: handle => clearTimeout(handle),
        innerWidth: 1280,
        innerHeight: 800,
        ...extraGlobals,
    };
    const saved = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
    for (const [key, value] of Object.entries(globals)) {
        Object.defineProperty(globalThis, key, { value, configurable: true, writable: true, enumerable: true });
    }
    try {
        return await body(document);
    } finally {
        for (const [key, descriptor] of saved) {
            if (descriptor) Object.defineProperty(globalThis, key, descriptor);
            else delete globalThis[key];
        }
    }
}
