// A small in-memory DOM for renderer component tests (node has no DOM). It covers what the
// components under test touch: elements with classes / attributes / children / listeners,
// class and id selectors with descendant combinators, a flat innerHTML parser, and range
// inputs that sanitize their value to min / max / step the way Chromium does - reading
// `value` after a narrower `max` is set gives the clamped value.

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

function parseCompound(text) {
    const compound = { tag: null, id: null, classes: [] };
    for (const part of text.match(/[.#]?[^.#]+/g) ?? []) {
        if (part.startsWith('.')) compound.classes.push(part.slice(1));
        else if (part.startsWith('#')) compound.id = part.slice(1);
        else compound.tag = part.toUpperCase();
    }
    return compound;
}

function matchesCompound(element, compound) {
    if (!element || element.nodeType !== 1) return false;
    if (compound.tag && element.tagName !== compound.tag) return false;
    if (compound.id && element.id !== compound.id) return false;
    return compound.classes.every(name => element.classList.contains(name));
}

function matchesSelector(element, selector) {
    return selector.split(',').some(alternative => {
        const compounds = alternative.trim().split(/\s+/).filter(Boolean).map(parseCompound);
        if (compounds.length === 0 || !matchesCompound(element, compounds.at(-1))) return false;
        let ancestor = element.parentElement;
        for (let index = compounds.length - 2; index >= 0; index--) {
            while (ancestor && !matchesCompound(ancestor, compounds[index])) ancestor = ancestor.parentElement;
            if (!ancestor) return false;
            ancestor = ancestor.parentElement;
        }
        return true;
    });
}

export class FakeElement {
    constructor(ownerDocument, tagName) {
        this.ownerDocument = ownerDocument;
        this.nodeType = tagName === '#text' ? 3 : 1;
        this.tagName = String(tagName).toUpperCase();
        this.id = '';
        this.className = '';
        this.textContent = '';
        this.title = '';
        this.hidden = false;
        this.disabled = false;
        this.checked = false;
        this.style = {};
        this.dataset = {};
        this.children = [];
        this.parentElement = null;
        this.attributes = new Map();
        this.listeners = new Map();
        this.classList = new FakeClassList(this);
    }

    get options() { return this.children.filter(child => child.tagName === 'OPTION'); }
    get firstChild() { return this.children[0] ?? null; }
    get childNodes() { return this.children; }
    get nextSibling() {
        const siblings = this.parentElement?.children ?? [];
        return siblings[siblings.indexOf(this) + 1] ?? null;
    }

    #node(value) {
        if (value instanceof FakeElement) return value;
        const text = new FakeElement(this.ownerDocument, '#text');
        text.textContent = String(value);
        return text;
    }

    appendChild(child) {
        child.remove();
        child.parentElement = this;
        this.children.push(child);
        return child;
    }

    append(...nodes) { for (const node of nodes) this.appendChild(this.#node(node)); }

    prepend(...nodes) {
        for (const node of nodes.map(value => this.#node(value)).reverse()) {
            node.remove();
            node.parentElement = this;
            this.children.unshift(node);
        }
    }

    insertBefore(node, reference) {
        node.remove();
        const index = reference ? this.children.indexOf(reference) : -1;
        node.parentElement = this;
        if (index < 0) this.children.push(node); else this.children.splice(index, 0, node);
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
        for (const child of this.children) child.parentElement = null;
        this.children = [];
        this.append(...nodes);
    }

    remove() {
        const parent = this.parentElement;
        if (!parent) return;
        parent.children = parent.children.filter(child => child !== this);
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

    addEventListener(type, listener) {
        if (!this.listeners.has(type)) this.listeners.set(type, []);
        this.listeners.get(type).push(listener);
    }

    removeEventListener(type, listener) {
        this.listeners.set(type, (this.listeners.get(type) ?? []).filter(entry => entry !== listener));
    }

    dispatchEvent(event) {
        for (let target = this; target; target = event.bubbles ? target.parentElement : null) {
            for (const listener of [...(target.listeners.get(event.type) ?? [])]) {
                listener.call(target, event);
            }
        }
        return true;
    }

    matches(selector) { return matchesSelector(this, selector); }

    closest(selector) {
        for (let current = this; current; current = current.parentElement) if (current.matches(selector)) return current;
        return null;
    }

    querySelectorAll(selector) {
        const found = [];
        const walk = element => {
            for (const child of element.children) {
                if (child.nodeType === 1 && child.matches(selector)) found.push(child);
                walk(child);
            }
        };
        walk(this);
        return found;
    }

    querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }

    focus() { this.ownerDocument.activeElement = this; }
    blur() { if (this.ownerDocument.activeElement === this) this.ownerDocument.activeElement = null; }
    click() { this.dispatchEvent({ type: 'click', bubbles: true, preventDefault() {}, stopPropagation() {} }); }
    getBoundingClientRect() { return { top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }; }
    getClientRects() { return []; }
    scrollIntoView() {}

    // Flat parser: every opening tag becomes a child of this element (the tests look
    // controls up by class, so the nesting of the markup does not matter).
    set innerHTML(html) {
        this.replaceChildren();
        for (const [, tag, rest] of String(html).matchAll(/<([a-zA-Z][\w-]*)([^>]*)>/g)) {
            const element = this.ownerDocument.createElement(tag);
            for (const [, name, doubleQuoted, singleQuoted, bare] of rest.matchAll(/([\w-]+)(?:=(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) {
                const value = doubleQuoted ?? singleQuoted ?? bare ?? '';
                if (name === 'class') element.className = value;
                else if (name === 'hidden') element.hidden = true;
                else if (['type', 'min', 'max', 'step', 'value', 'title', 'id'].includes(name)) element[name] = value;
                else element.setAttribute(name, value);
            }
            this.appendChild(element);
        }
    }
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

export function createFakeDocument() {
    const listeners = new Map();
    const document = {
        activeElement: null,
        createElement: tag => (String(tag).toLowerCase() === 'input' ? new FakeInput(document) : new FakeElement(document, tag)),
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
        addEventListener: (type, listener) => {
            if (!listeners.has(type)) listeners.set(type, []);
            listeners.get(type).push(listener);
        },
        removeEventListener: (type, listener) => {
            listeners.set(type, (listeners.get(type) ?? []).filter(entry => entry !== listener));
        },
        dispatchEvent: event => {
            for (const listener of [...(listeners.get(event.type) ?? [])]) listener(event);
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
