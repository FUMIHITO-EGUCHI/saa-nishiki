// The Scene (promptFieldManager.js) with the real capsule field set, driven through a
// small in-memory DOM: a muted row leaves generation, the Final prompt preview and the
// batch plan; Swap moves texts, weight plans and mute together; a programmatic reload
// keeps the stored plans; drags and Move up / down change only what the Scene shows.
import test from 'node:test';
import assert from 'node:assert/strict';

import { setupTextbox } from '../scripts/renderer/components/myTextbox.js';
import { setupTagCapsuleFields } from '../scripts/renderer/components/tagCapsuleField.js';
import { setupPromptFieldManager } from '../scripts/renderer/components/promptFieldManager.js';
import { readPromptValue } from '../scripts/renderer/tools/promptBatchExpansion.js';
import { getCustomFieldTexts, getViewTags } from '../scripts/renderer/generate.js';
import { getNegativePrompts } from '../scripts/renderer/generate_regional.js';

// ------------------------------------------------------------------ in-memory DOM

const VOID_TAGS = new Set(['input', 'br', 'img', 'hr', 'meta', 'link']);

function toAttributeName(prop) {
    return `data-${prop.replaceAll(/[A-Z]/g, char => `-${char.toLowerCase()}`)}`;
}

function splitSelectorList(selector) {
    const parts = [];
    let depth = 0;
    let quote = '';
    let current = '';
    for (const char of selector) {
        if (quote) { if (char === quote) quote = ''; current += char; continue; }
        if (char === '"' || char === "'") { quote = char; current += char; continue; }
        if (char === '[') depth += 1;
        if (char === ']') depth -= 1;
        if (char === ',' && depth === 0) { parts.push(current.trim()); current = ''; continue; }
        current += char;
    }
    if (current.trim()) parts.push(current.trim());
    return parts;
}

const COMPOUND_PART = /^(?:(\*|[a-zA-Z][\w-]*)|#([\w-]+)|\.([\w-]+)|\[\s*([\w-]+)\s*(?:([\^*$]?=)\s*(?:"([^"]*)"|'([^']*)'|([^\]\s]+)))?\s*\]|(:scope))/;

function parseComplex(selector) {
    const parts = [];
    let rest = selector.trim();
    let combinator = null;
    while (rest) {
        const compound = { tag: null, id: null, classes: [], attrs: [], scope: false };
        let matched = false;
        let match;
        while ((match = COMPOUND_PART.exec(rest))) {
            matched = true;
            if (match[1]) compound.tag = match[1];
            else if (match[2]) compound.id = match[2];
            else if (match[3]) compound.classes.push(match[3]);
            else if (match[4]) compound.attrs.push({ name: match[4], op: match[5] ?? null, value: match[6] ?? match[7] ?? match[8] ?? null });
            else if (match[9]) compound.scope = true;
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

function matchesCompound(element, compound, scope) {
    if (!(element instanceof FakeElement)) return false;
    if (compound.scope && element !== scope) return false;
    if (compound.tag && compound.tag !== '*' && element.tagName !== compound.tag.toUpperCase()) return false;
    if (compound.id && element.getAttribute('id') !== compound.id) return false;
    for (const name of compound.classes) if (!element.classList.contains(name)) return false;
    for (const { name, op, value } of compound.attrs) {
        const actual = element.getAttribute(name);
        if (actual === null) return false;
        if (op === '=' && actual !== value) return false;
        if (op === '^=' && !actual.startsWith(value)) return false;
        if (op === '*=' && !actual.includes(value)) return false;
        if (op === '$=' && !actual.endsWith(value)) return false;
    }
    return true;
}

function matchesParts(element, parts, index, scope) {
    if (!matchesCompound(element, parts[index].compound, scope)) return false;
    if (index === 0) return true;
    if (parts[index].combinator === '>') {
        return element.parentElement ? matchesParts(element.parentElement, parts, index - 1, scope) : false;
    }
    for (let ancestor = element.parentElement; ancestor; ancestor = ancestor.parentElement) {
        if (matchesParts(ancestor, parts, index - 1, scope)) return true;
    }
    return false;
}

function matchesSelector(element, selector, scope) {
    return splitSelectorList(selector).some(one => {
        const parts = parseComplex(one);
        return matchesParts(element, parts, parts.length - 1, scope);
    });
}

class FakeNode {
    constructor(ownerDocument) {
        this.ownerDocument = ownerDocument;
        this.parentNode = null;
        this.childNodes = [];
        this.listeners = new Map();
    }
    get parentElement() { return this.parentNode instanceof FakeElement ? this.parentNode : null; }
    get firstChild() { return this.childNodes[0] ?? null; }
    get lastChild() { return this.childNodes.at(-1) ?? null; }
    get nextSibling() {
        const siblings = this.parentNode?.childNodes;
        return siblings ? siblings[siblings.indexOf(this) + 1] ?? null : null;
    }
    get previousSibling() {
        const siblings = this.parentNode?.childNodes;
        return siblings ? siblings[siblings.indexOf(this) - 1] ?? null : null;
    }
    get textContent() { return this.childNodes.map(node => node.textContent).join(''); }
    set textContent(value) {
        this.replaceChildren();
        if (value !== null && value !== undefined && String(value) !== '') this.appendChild(this.ownerDocument.createTextNode(String(value)));
    }
    toNode(value) { return typeof value === 'string' ? this.ownerDocument.createTextNode(value) : value; }
    contains(node) {
        for (let current = node; current; current = current.parentNode) if (current === this) return true;
        return false;
    }
    insertBefore(node, reference) {
        if (node === reference) return node;
        node.remove();
        if (reference) {
            const index = this.childNodes.indexOf(reference);
            if (index < 0) throw new Error('fake DOM: reference is not a child');
            this.childNodes.splice(index, 0, node);
        } else {
            this.childNodes.push(node);
        }
        node.parentNode = this;
        return node;
    }
    appendChild(node) { return this.insertBefore(node, null); }
    removeChild(node) {
        const index = this.childNodes.indexOf(node);
        if (index < 0) throw new Error('fake DOM: not a child');
        this.childNodes.splice(index, 1);
        node.parentNode = null;
        return node;
    }
    remove() { this.parentNode?.removeChild(this); }
    append(...nodes) { for (const node of nodes) this.appendChild(this.toNode(node)); }
    prepend(...nodes) {
        const first = this.firstChild;
        for (const node of nodes) this.insertBefore(this.toNode(node), first);
    }
    replaceChildren(...nodes) {
        for (const child of [...this.childNodes]) this.removeChild(child);
        this.append(...nodes);
    }
    replaceWith(...nodes) {
        const parent = this.parentNode;
        if (!parent) return;
        for (const node of nodes) parent.insertBefore(this.toNode(node), this);
        this.remove();
    }
    addEventListener(type, listener, options) {
        const capture = options === true || options?.capture === true;
        const list = this.listeners.get(type) ?? [];
        if (!list.some(entry => entry.listener === listener && entry.capture === capture)) list.push({ listener, capture });
        this.listeners.set(type, list);
    }
    removeEventListener(type, listener, options) {
        const capture = options === true || options?.capture === true;
        const list = this.listeners.get(type) ?? [];
        this.listeners.set(type, list.filter(entry => !(entry.listener === listener && entry.capture === capture)));
    }
    dispatchEvent(event) {
        Object.defineProperty(event, 'target', { value: this, configurable: true });
        const path = [];
        for (let node = this.parentNode; node; node = node.parentNode) path.push(node);
        const invoke = (node, phase) => {
            for (const entry of [...(node.listeners.get(event.type) ?? [])]) {
                if (phase === 'capture' && !entry.capture) continue;
                if (phase === 'bubble' && entry.capture) continue;
                Object.defineProperty(event, 'currentTarget', { value: node, configurable: true });
                entry.listener.call(node, event);
            }
        };
        for (const node of [...path].reverse()) {
            invoke(node, 'capture');
            if (event.cancelBubble) return !event.defaultPrevented;
        }
        invoke(this, 'target');
        if (event.bubbles) {
            for (const node of path) {
                if (event.cancelBubble) break;
                invoke(node, 'bubble');
            }
        }
        return !event.defaultPrevented;
    }
}

class FakeText extends FakeNode {
    constructor(ownerDocument, data) {
        super(ownerDocument);
        this.nodeType = 3;
        this.data = String(data);
    }
    get textContent() { return this.data; }
    set textContent(value) { this.data = String(value); }
}

class FakeElement extends FakeNode {
    constructor(ownerDocument, tagName) {
        super(ownerDocument);
        this.nodeType = 1;
        this.tagName = tagName.toUpperCase();
        this.attributes = new Map();
        this.style = {};
        this.hidden = false;
        this.value = '';
        this.tabIndex = -1;
        this.draggable = false;
        this.disabled = false;
        const element = this;
        this.dataset = new Proxy({}, {
            get: (_, prop) => (typeof prop === 'string' ? element.getAttribute(toAttributeName(prop)) ?? undefined : undefined),
            set: (_, prop, value) => { element.setAttribute(toAttributeName(prop), value); return true; },
            deleteProperty: (_, prop) => { element.removeAttribute(toAttributeName(prop)); return true; },
            has: (_, prop) => element.hasAttribute(toAttributeName(prop)),
        });
        const read = () => (element.getAttribute('class') ?? '').split(/\s+/).filter(Boolean);
        const write = names => element.setAttribute('class', names.join(' '));
        this.classList = {
            add: (...names) => write([...new Set([...read(), ...names])]),
            remove: (...names) => write(read().filter(name => !names.includes(name))),
            contains: name => read().includes(name),
            toggle: (name, force) => {
                const want = force === undefined ? !read().includes(name) : Boolean(force);
                if (want) element.classList.add(name); else element.classList.remove(name);
                return want;
            },
        };
    }
    get children() { return this.childNodes.filter(node => node instanceof FakeElement); }
    get childElementCount() { return this.children.length; }
    get className() { return this.getAttribute('class') ?? ''; }
    set className(value) { this.setAttribute('class', value); }
    get id() { return this.getAttribute('id') ?? ''; }
    set id(value) { this.setAttribute('id', value); }
    get title() { return this.getAttribute('title') ?? ''; }
    set title(value) { this.setAttribute('title', value); }
    get placeholder() { return this.getAttribute('placeholder') ?? ''; }
    set placeholder(value) { this.setAttribute('placeholder', value); }
    get options() { return this.children.filter(child => child.tagName === 'OPTION'); }
    get offsetWidth() { return 0; }
    get offsetHeight() { return 0; }
    get scrollHeight() { return 0; }
    setAttribute(name, value) { this.attributes.set(name, String(value)); }
    getAttribute(name) { return this.attributes.has(name) ? this.attributes.get(name) : null; }
    hasAttribute(name) { return this.attributes.has(name); }
    removeAttribute(name) { this.attributes.delete(name); }
    matches(selector) { return matchesSelector(this, selector, this); }
    closest(selector) {
        for (let node = this; node instanceof FakeElement; node = node.parentNode) if (node.matches(selector)) return node;
        return null;
    }
    querySelectorAll(selector) {
        const found = [];
        const walk = node => {
            for (const child of node.children) {
                if (matchesSelector(child, selector, this)) found.push(child);
                walk(child);
            }
        };
        walk(this);
        return found;
    }
    querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
    insertAdjacentElement(position, element) {
        if (position === 'afterend') this.parentNode.insertBefore(element, this.nextSibling);
        else if (position === 'beforebegin') this.parentNode.insertBefore(element, this);
        else if (position === 'afterbegin') this.insertBefore(element, this.firstChild);
        else this.appendChild(element);
        return element;
    }
    set innerHTML(html) {
        this.replaceChildren();
        const stack = [this];
        const token = /<\/([\w-]+)\s*>|<([\w-]+)((?:\s+[^\s=>]+(?:="[^"]*")?)*)\s*(\/?)>|([^<]+)/g;
        for (const match of String(html).matchAll(token)) {
            const top = stack.at(-1);
            if (match[1]) { stack.pop(); continue; }
            if (match[2]) {
                const element = this.ownerDocument.createElement(match[2]);
                for (const attribute of match[3].matchAll(/([^\s=]+)(?:="([^"]*)")?/g)) element.setAttribute(attribute[1], attribute[2] ?? '');
                top.appendChild(element);
                if (!match[4] && !VOID_TAGS.has(match[2].toLowerCase())) stack.push(element);
                continue;
            }
            if (match[5].trim() !== '') top.appendChild(this.ownerDocument.createTextNode(match[5]));
        }
    }
    focus() { this.ownerDocument.activeElement = this; }
    blur() { if (this.ownerDocument.activeElement === this) this.ownerDocument.activeElement = this.ownerDocument.body; }
    select() {}
    setSelectionRange() {}
    getBoundingClientRect() { return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }; }
    click() { this.dispatchEvent(new Event('click', { bubbles: true, cancelable: true })); }
}

class FakeDocument extends FakeNode {
    constructor() {
        super(null);
        this.ownerDocument = this;
        this.nodeType = 9;
        this.documentElement = this.createElement('html');
        this.appendChild(this.documentElement);
        this.body = this.createElement('body');
        this.documentElement.appendChild(this.body);
        this.activeElement = this.body;
        this.styleSheets = [];
    }
    createElement(tagName) { return new FakeElement(this, tagName); }
    createElementNS(_namespace, tagName) { return new FakeElement(this, tagName); }
    createTextNode(data) { return new FakeText(this, data); }
    querySelectorAll(selector) {
        return [...(matchesSelector(this.documentElement, selector, null) ? [this.documentElement] : []), ...this.documentElement.querySelectorAll(selector)];
    }
    querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
    getElementById(id) { return this.querySelector(`#${id}`); }
}

// ------------------------------------------------------------------ the Scene

const BUILTINS = [
    ['common', 'prompt-common', 'custom_prompt'],
    ['background', 'prompt-background', 'prompt_background'],
    ['style', 'prompt-style', 'prompt_style'],
    ['positive', 'prompt-positive', 'api_prompt'],
    ['positive_right', 'prompt-positive-right', 'api_prompt_right'],
    ['negative', 'prompt-negative', 'api_neg_prompt'],
    ['negative_left', 'prompt-negative-left', 'api_neg_prompt_left'],
    ['negative_right', 'prompt-negative-right', 'api_neg_prompt_right'],
    ['exclude', 'prompt-exclude', 'prompt_ban'],
];

function sceneSettings(overrides = {}) {
    return {
        language: 'en-US',
        css_style: 'dark',
        api_model_type: 'Checkpoint',
        regional_condition: false,
        regional_split: 'left-right',
        ...Object.fromEntries(BUILTINS.map(([, , settingsKey]) => [settingsKey, ''])),
        prompt_custom_fields: [],
        prompt_positive_order: [],
        prompt_negative_order: [],
        prompt_field_muted: [],
        prompt_field_collapsed: [],
        prompt_field_presets: {},
        character_slots: [],
        ...overrides,
    };
}

function bootScene(settings) {
    const document = new FakeDocument();
    Object.assign(globalThis, {
        document,
        Node: { ELEMENT_NODE: 1, TEXT_NODE: 3 },
        MutationObserver: class { observe() {} disconnect() {} },
        getComputedStyle: () => ({ lineHeight: '20px' }),
        innerHeight: 800,
        globalSettings: settings,
        cachedFiles: { language: { 'en-US': {} } },
        prompt: {},
    });
    document.body.innerHTML = `<section id="prompt-text-container"><div class="ui-card-head"><div class="ui-card-tools"></div></div>`
        + `<div class="ui-card-body prompt-fields">${BUILTINS.map(([, className]) => `<div class="${className} prompt-field"></div>`).join('')}`
        + '<div class="ai-card"></div></div></section><div class="dropdown-view"></div>';
    const controls = BUILTINS.map(([key, className, settingsKey]) => {
        const control = setupTextbox(className, key, { value: settings[settingsKey] }, false, value => { settings[settingsKey] = value; });
        globalThis.prompt[key] = control;
        return control;
    });
    // callbacks.js callback_regional_condition shows the side rows while Regional is on
    for (const className of ['prompt-positive-right', 'prompt-negative-left', 'prompt-negative-right']) {
        document.querySelector(`.${className}`).style.display = settings.regional_condition ? 'block' : 'none';
    }
    globalThis.prompt.tagCapsuleFields = setupTagCapsuleFields(controls, { keys: BUILTINS.map(([key]) => key) });
    globalThis.prompt.fieldManager = setupPromptFieldManager();
    return { document, settings, manager: globalThis.prompt.fieldManager, set: globalThis.prompt.tagCapsuleFields };
}

const planIds = entries => (entries ?? []).map(entry => entry.id);
const rowOf = (document, id) => document.querySelector(`.prompt-scene .prompt-field[data-field-id="${id}"]`) ?? document.querySelector(`.prompt-scene .prompt-${id.replaceAll('_', '-')}`);

// ------------------------------------------------------------------ mute

test('a muted row keeps its text but leaves generation, the Final prompt preview and the batch plan', () => {
    const settings = sceneSettings({
        custom_prompt: 'masterpiece',
        api_prompt: 'smile',
        api_neg_prompt: 'lowres',
        prompt_custom_fields: [{ id: 'cf_hat', name: 'Hat', polarity: 'positive', text: 'hat' }],
        positive_weight_plans: [{ id: 'smile#0', mode: 'increment', min: 1, max: 1.2, step: 0.1 }],
        positive_batch: { enabled: true, count: 3 },
    });
    const { manager, set } = bootScene(settings);
    globalThis.viewList = { getValue: () => ['from above', 'None'], getTextValue: () => 1 };

    assert.match(set.expandAll(1, 0)[0].positive, /^masterpiece, smile, hat$/);
    assert.equal(set.getBatchExpansion().variable, 1);
    assert.equal(readPromptValue('positive'), 'smile');
    assert.equal(getViewTags(0, false), 'from above, ');

    manager.setMuted('positive', true);
    manager.setMuted('cf_hat', true);
    manager.setMuted('views', true);

    // the text stays in the row and in the settings
    assert.equal(globalThis.prompt.positive.getValue(), 'smile');
    assert.equal(settings.prompt_custom_fields.find(field => field.id === 'cf_hat').text, 'hat');
    // generation
    assert.equal(readPromptValue('positive'), '');
    assert.deepEqual(getCustomFieldTexts('positive').find(field => field.id === 'cf_hat'), { id: 'cf_hat', text: '' });
    assert.equal(getViewTags(0, false), '');
    // Final prompt preview and batch plan
    assert.equal(set.expandAll(1, 0)[0].positive, 'masterpiece');
    assert.deepEqual(set.getBatchExpansion(), { enabled: false, count: 1, variable: 0 });

    manager.setMuted('positive', false);
    assert.equal(readPromptValue('positive'), 'smile');
    assert.equal(set.expandAll(1, 0)[0].positive, 'masterpiece, smile');
});

test('a settings reload (preset, undo) re-syncs the preview mute from the settings', () => {
    const settings = sceneSettings({ api_prompt: 'smile', api_neg_prompt: 'lowres' });
    const { manager, set } = bootScene(settings);
    assert.equal(set.expandAll(1, 0)[0].negative, 'lowres');
    settings.prompt_field_muted = ['negative'];
    manager.refresh();
    assert.equal(set.expandAll(1, 0)[0].negative, '');
    assert.equal(readPromptValue('negative'), '');
});

test('a muted side row stays out of its Regional negative, and the preview lists the negative as generation merges it', () => {
    const settings = sceneSettings({
        regional_condition: true,
        api_neg_prompt: 'lowres',
        api_neg_prompt_left: 'blurry',
        api_neg_prompt_right: 'jpeg',
        prompt_custom_fields: [
            { id: 'cf_nboth', name: 'NegBoth', polarity: 'negative', text: 'watermark' },
            { id: 'cf_nleft', name: 'NegL', polarity: 'negative', text: 'extra arms', side: 'left' },
        ],
        prompt_negative_order: ['negative', 'cf_nboth', 'cf_nleft'],
    });
    const { manager, set } = bootScene(settings);
    const generated = getNegativePrompts();
    assert.equal(generated.merged, 'lowres, watermark, blurry, extra arms, jpeg');
    assert.equal(set.expandAll(1, 0)[0].negative, generated.merged);

    manager.setMuted('negative_left', true);
    assert.equal(getNegativePrompts().left, 'lowres, watermark, extra arms');
    assert.equal(set.expandAll(1, 0)[0].negative, getNegativePrompts().merged);
});

test('the Action row a checkpoint hides never reaches its prompt or preview; Diffusion keeps it', () => {
    const settings = sceneSettings({
        api_prompt: 'smile',
        prompt_custom_fields: [{ id: 'cf_action', name: 'Action', polarity: 'positive', text: '@char1 hugs @char2' }],
    });
    const { document, manager, set } = bootScene(settings);
    assert.equal(rowOf(document, 'cf_action').style.display, 'none');
    assert.equal(getCustomFieldTexts('positive').some(field => field.id === 'cf_action'), false);
    assert.equal(set.expandAll(1, 0)[0].positive, 'smile');

    settings.api_model_type = 'Diffusion';
    manager.refresh();
    assert.deepEqual(getCustomFieldTexts('positive').find(field => field.id === 'cf_action'), { id: 'cf_action', text: '@char1 hugs @char2' });
    assert.equal(set.expandAll(1, 0)[0].positive, 'smile, @char1 hugs @char2');
});

// ------------------------------------------------------------------ Swap and reloads

test('Swap moves the texts, weight plans and mute of the side rows together', () => {
    const settings = sceneSettings({
        regional_condition: true,
        api_prompt: 'smile, 1girl',
        api_prompt_right: 'frown, 1boy',
        positive_weight_plans: [{ id: 'smile#0', mode: 'increment', min: 0.8, max: 1.4, step: 0.1 }],
        positive_right_weight_plans: [{ id: 'frown#0', mode: 'random', min: 0.5, max: 1.5, step: 0.1 }],
        api_neg_prompt_left: 'blurry',
        api_neg_prompt_right: 'jpeg',
        prompt_field_muted: ['positive_right'],
        prompt_custom_fields: [{ id: 'cf_sword', name: 'Sword', polarity: 'positive', text: 'sword', side: 'left', muted: true }],
    });
    const { manager, set } = bootScene(settings);
    assert.equal(readPromptValue('positive_right'), '');

    manager.swapSides();

    assert.equal(globalThis.prompt.positive.getValue(), 'frown, 1boy');
    assert.equal(globalThis.prompt.positive_right.getValue(), 'smile, 1girl');
    assert.deepEqual(planIds(settings.positive_weight_plans), ['frown#0']);
    assert.deepEqual(planIds(settings.positive_right_weight_plans), ['smile#0']);
    assert.deepEqual(planIds(set.get('positive').getPlans()), ['frown#0']);
    assert.deepEqual(planIds(set.get('positive_right').getPlans()), ['smile#0']);
    // the muted text stays muted on the side it moved to
    assert.deepEqual(settings.prompt_field_muted, ['positive']);
    assert.equal(readPromptValue('positive'), '');
    assert.equal(readPromptValue('positive_right'), 'smile, 1girl');
    assert.equal(set.expandAll(1, 0)[0].positive, '');
    const sword = settings.prompt_custom_fields.find(field => field.id === 'cf_sword');
    assert.equal(sword.side, 'right');
    assert.equal(sword.muted, true);
    assert.equal(globalThis.prompt.negative_left.getValue(), 'jpeg');
});

test('a reload that rewrites text and plans together (preset load, model-type restore) keeps the stored plans', () => {
    const settings = sceneSettings({
        api_prompt: 'frown',
        positive_weight_plans: [{ id: 'frown#0', mode: 'random', min: 0.5, max: 1.5, step: 0.1 }],
        prompt_custom_fields: [{ id: 'cf_hat', name: 'Hat', polarity: 'positive', text: 'hat', weight_plans: [{ id: 'hat#0', mode: 'increment', min: 1, max: 1.3, step: 0.1 }] }],
    });
    const { manager, set } = bootScene(settings);

    // language.js updateSettings / callbacks.js applyPromptsForModelType: the settings are
    // written first, then the controls are pushed the values, then the plans are reloaded
    Object.assign(settings, {
        api_prompt: 'smile',
        positive_weight_plans: [{ id: 'smile#0', mode: 'increment', min: 0.8, max: 1.2, step: 0.1 }],
        prompt_custom_fields: [{ id: 'cf_hat', name: 'Hat', polarity: 'positive', text: 'cap', weight_plans: [{ id: 'cap#0', mode: 'random', min: 0.9, max: 1.1, step: 0.1 }] }],
    });
    globalThis.prompt.positive.setValue(settings.api_prompt);
    manager.refresh();
    set.loadFromSettings(settings);

    assert.deepEqual(planIds(settings.positive_weight_plans), ['smile#0']);
    assert.deepEqual(planIds(set.get('positive').getPlans()), ['smile#0']);
    assert.equal(globalThis.prompt.cf_hat.getValue(), 'cap');
    assert.deepEqual(planIds(settings.prompt_custom_fields.find(field => field.id === 'cf_hat').weight_plans), ['cap#0']);
    assert.deepEqual(planIds(set.get('cf_hat').getPlans()), ['cap#0']);
});

// ------------------------------------------------------------------ drag, Move up / down, fixed rows

function dataTransfer() {
    const data = new Map();
    return {
        effectAllowed: 'all',
        dropEffect: 'none',
        get types() { return [...data.keys()]; },
        setData: (type, value) => data.set(type, value),
        getData: type => data.get(type) ?? '',
    };
}

function dragEvent(type, transfer) {
    const event = new Event(type, { bubbles: true, cancelable: true });
    event.dataTransfer = transfer;
    return event;
}

function startRowDrag(document, row) {
    row.querySelector('.scene-grip').dispatchEvent(new Event('mousedown', { bubbles: true }));
    const transfer = dataTransfer();
    row.dispatchEvent(dragEvent('dragstart', transfer));
    return transfer;
}

test('a row released over itself, or its pinned unit released in its own box, stays where it was', () => {
    const settings = sceneSettings({
        regional_condition: true,
        prompt_custom_fields: [
            { id: 'cf_hat', name: 'Hat', polarity: 'positive', text: 'hat' },
            { id: 'cf_night', name: 'Night', polarity: 'positive', text: 'night' },
        ],
    });
    const { document } = bootScene(settings);
    const before = [...settings.prompt_positive_order];

    const hat = rowOf(document, 'cf_hat');
    let transfer = startRowDrag(document, hat);
    assert.equal(transfer.types.includes('text/plain'), false, 'no text a textarea would take');
    const over = hat.querySelector('textarea');
    over.dispatchEvent(dragEvent('dragover', transfer));
    over.dispatchEvent(dragEvent('drop', transfer));
    hat.dispatchEvent(dragEvent('dragend', transfer));
    assert.deepEqual(settings.prompt_positive_order, before);

    const positive = rowOf(document, 'positive');
    transfer = startRowDrag(document, positive);
    const boxHead = document.querySelector('.scene-side.is-left .scene-side-head');
    boxHead.dispatchEvent(dragEvent('dragover', transfer));
    boxHead.dispatchEvent(dragEvent('drop', transfer));
    positive.dispatchEvent(dragEvent('dragend', transfer));
    assert.deepEqual(settings.prompt_positive_order, before);

    // a real move still works: Night before Hat
    const night = rowOf(document, 'cf_night');
    transfer = startRowDrag(document, night);
    hat.querySelector('textarea').dispatchEvent(dragEvent('drop', transfer));
    night.dispatchEvent(dragEvent('dragend', transfer));
    assert.deepEqual(settings.prompt_positive_order.slice(-3), ['cf_night', 'cf_hat', 'cf_action']);
});

test('a row over a place it may not take refuses the drop instead of leaving it to a textarea', () => {
    const settings = sceneSettings({ regional_condition: true });
    const { document } = bootScene(settings);
    const common = rowOf(document, 'common');
    const transfer = startRowDrag(document, common);
    const event = dragEvent('dragover', transfer);
    rowOf(document, 'positive').querySelector('textarea').dispatchEvent(event);
    assert.equal(event.defaultPrevented, true);
    assert.equal(transfer.dropEffect, 'none');
});

function clickMenuItem(document, row, label) {
    row.querySelector('.scene-menu-button').click();
    const item = [...document.querySelectorAll('.scene-row-menu button')].find(button => button.textContent === label);
    assert.ok(item, `menu item ${label}`);
    item.click();
}

test('Move up / down pass over the units the Scene does not show', () => {
    const settings = sceneSettings({ character_slots: [{ key: 'alice' }, { key: 'bob' }] });
    const { document } = bootScene(settings);
    assert.deepEqual(settings.prompt_positive_order,
        ['common', 'views', 'background', 'style', 'artist', 'ai', 'characters', 'cf_cast1', 'cf_cast2', 'positive', 'cf_action']);

    clickMenuItem(document, rowOf(document, 'positive'), 'Move up');
    assert.deepEqual(settings.prompt_positive_order,
        ['common', 'views', 'background', 'positive', 'style', 'artist', 'ai', 'characters', 'cf_cast1', 'cf_cast2', 'cf_action']);

    // below Style the chain holds only blocks and hidden rows: nothing to pass, nothing moves
    const afterUp = [...settings.prompt_positive_order];
    clickMenuItem(document, rowOf(document, 'style'), 'Move down');
    assert.deepEqual(settings.prompt_positive_order, afterUp);

    clickMenuItem(document, rowOf(document, 'positive'), 'Move down');
    assert.deepEqual(settings.prompt_positive_order,
        ['common', 'views', 'background', 'style', 'positive', 'artist', 'ai', 'characters', 'cf_cast1', 'cf_cast2', 'cf_action']);
});

const rowControls = row => [...row.querySelectorAll('.scene-polarity, .scene-delete')].map(button => button.hidden);

function doubleClickLabel(row) {
    row.querySelector('.scene-label').dispatchEvent(new Event('dblclick', { bubbles: true, cancelable: true }));
    return row.querySelector('.scene-rename');
}

function renameRow(row, name) {
    const input = doubleClickLabel(row);
    assert.ok(input, 'the row opened its rename box');
    input.value = name;
    const enter = new Event('keydown', { bubbles: true, cancelable: true });
    enter.key = 'Enter';
    input.dispatchEvent(enter);
}

test("a hand-made row named Action stays the user's; the rows the cast owns are the fixed ones", () => {
    const settings = sceneSettings({
        api_model_type: 'Diffusion',
        character_slots: [{ key: 'alice' }],
        prompt_custom_fields: [{ id: 'cf_mine', name: 'Pose', polarity: 'positive', text: 'waving' }],
    });
    const { document } = bootScene(settings);
    // the cast row and the Action row the cast added: no polarity, no delete, no rename
    assert.deepEqual(rowControls(rowOf(document, 'cf_cast1')), [true, true]);
    assert.deepEqual(rowControls(rowOf(document, 'cf_action')), [true, true]);
    assert.equal(doubleClickLabel(rowOf(document, 'cf_action')), null, "the cast's Action row is not renamed");

    // the hand-made row keeps its buttons when its name turns it into an action, and goes back
    assert.deepEqual(rowControls(rowOf(document, 'cf_mine')), [false, false]);
    renameRow(rowOf(document, 'cf_mine'), 'Action');
    assert.equal(settings.prompt_custom_fields.find(field => field.id === 'cf_mine').name, 'Action');
    assert.deepEqual(rowControls(rowOf(document, 'cf_mine')), [false, false]);
    renameRow(rowOf(document, 'cf_mine'), 'Pose');
    assert.equal(settings.prompt_custom_fields.find(field => field.id === 'cf_mine').name, 'Pose');
    assert.equal(rowOf(document, 'cf_mine').querySelector('.scene-rename'), null);
});

test("renaming or deleting the hand-made row that served as the Action brings the cast's own back", () => {
    const madeAction = () => sceneSettings({
        api_model_type: 'Diffusion',
        character_slots: [{ key: 'alice' }],
        prompt_custom_fields: [{ id: 'cf_mine', name: 'Action', polarity: 'positive', text: '@char1 waves' }],
    });

    const deleted = madeAction();
    const first = bootScene(deleted);
    // a field named Action already serves the cast, so no cf_action row was added
    assert.equal(deleted.prompt_custom_fields.some(field => field.id === 'cf_action'), false);
    rowOf(first.document, 'cf_mine').querySelector('.scene-delete').click();
    assert.equal(deleted.prompt_custom_fields.some(field => field.id === 'cf_mine'), false);
    assert.equal(deleted.prompt_custom_fields.find(field => field.id === 'cf_action')?.text, '');
    assert.ok(deleted.prompt_positive_order.includes('cf_action'));
    assert.ok(rowOf(first.document, 'cf_action'), 'and the Scene shows it');

    const renamed = madeAction();
    const second = bootScene(renamed);
    renameRow(rowOf(second.document, 'cf_mine'), 'Pose');
    assert.equal(renamed.prompt_custom_fields.find(field => field.id === 'cf_mine').name, 'Pose');
    assert.ok(renamed.prompt_custom_fields.some(field => field.id === 'cf_action'));
    assert.ok(rowOf(second.document, 'cf_action'));
});

// the Scene's row hosts: the shared column and the two side boxes; the block is one row
const sceneColumn = document => [...document.querySelector('.prompt-scene').children]
    .map(node => (node.classList.contains('scene-regional') ? 'BLOCK' : (node.dataset.fieldId ?? node.className.split(' ')[0])));
const boxRows = (document, side) => [...document.querySelectorAll(`.scene-side.is-${side} .prompt-field[data-scene-row]`)]
    .map(row => row.dataset.fieldId ?? row.className.split(' ')[0]);

test('Move up / down inside the Regional block passes the rows of the same box only', () => {
    const settings = sceneSettings({
        regional_condition: true,
        api_prompt: 'smile',
        prompt_custom_fields: [
            { id: 'cf_l', name: 'L', polarity: 'positive', text: 'sword', side: 'left' },
            { id: 'cf_r', name: 'R', polarity: 'positive', text: 'shield', side: 'right' },
            { id: 'cf_both', name: 'Both', polarity: 'positive', text: 'night' },
        ],
        prompt_positive_order: ['common', 'views', 'background', 'style', 'artist', 'ai', 'characters', 'positive', 'cf_l', 'cf_r', 'cf_both'],
    });
    const { document, set } = bootScene(settings);
    const sides = () => ({ positive: set.expandAll(1, 0)[0].positive, right: set.expandAll(1, 0)[0].positiveRight });
    assert.deepEqual(boxRows(document, 'left').slice(0, 2), ['prompt-positive', 'cf_l']);
    assert.deepEqual(sides(), { positive: 'smile, sword, night', right: 'shield, night' });

    // the other box's row is no neighbour: nothing above the right row, so nothing moves
    const before = [...settings.prompt_positive_order];
    clickMenuItem(document, rowOf(document, 'cf_r'), 'Move up');
    assert.deepEqual(settings.prompt_positive_order, before);
    assert.deepEqual(sides(), { positive: 'smile, sword, night', right: 'shield, night' });

    // the shared row below the block crosses it as one row: above every side row, and back
    assert.ok(sceneColumn(document).indexOf('cf_both') > sceneColumn(document).indexOf('BLOCK'));
    clickMenuItem(document, rowOf(document, 'cf_both'), 'Move up');
    assert.ok(sceneColumn(document).indexOf('cf_both') < sceneColumn(document).indexOf('BLOCK'));
    // (cf_action is the hidden Action row the cast keeps at the chain's end)
    assert.deepEqual(settings.prompt_positive_order.slice(-5), ['cf_both', 'positive', 'cf_l', 'cf_r', 'cf_action']);
    assert.deepEqual(sides(), { positive: 'night, smile, sword', right: 'night, shield' });
    clickMenuItem(document, rowOf(document, 'cf_both'), 'Move down');
    assert.deepEqual(settings.prompt_positive_order, before);

    // inside the box the rows still swap
    clickMenuItem(document, rowOf(document, 'cf_l'), 'Move up');
    assert.deepEqual(boxRows(document, 'left').slice(0, 2), ['cf_l', 'prompt-positive']);
    assert.equal(sides().positive, 'sword, smile, night');
});

test('a row the model type hides keeps its weight plans and batch out of the expansion', () => {
    const settings = sceneSettings({
        api_prompt: 'smile',
        character_slots: [{ key: 'alice' }],
        prompt_custom_fields: [{
            id: 'cf_cast1', name: '@char1', polarity: 'positive', text: 'red hair',
            weight_plans: [{ id: 'red hair#0', mode: 'increment', min: 0.8, max: 1.2, step: 0.1 }],
            batch: { enabled: true, count: 4 },
        }],
    });
    const { document, manager, set } = bootScene(settings);
    // a checkpoint hides the cast row: one click stays one image
    assert.equal(rowOf(document, 'cf_cast1').style.display, 'none');
    assert.deepEqual(set.getBatchExpansion(), { enabled: false, count: 1, variable: 0 });
    assert.equal(set.expandAll(1, 0)[0].positive, 'smile');

    settings.api_model_type = 'Diffusion';
    manager.refresh();
    assert.deepEqual(set.getBatchExpansion(), { enabled: true, count: 4, variable: 1 });
    assert.equal(set.expandAll(1, 0)[0].positive.startsWith('smile, (red hair:'), true);
});

test('the Regional negative preview drops a side row that repeats a shared one, as generation does', () => {
    const settings = sceneSettings({
        regional_condition: true,
        api_neg_prompt: 'lowres',
        api_neg_prompt_left: 'lowres',
        api_neg_prompt_right: 'jpeg',
        prompt_custom_fields: [
            { id: 'cf_nboth', name: 'NegBoth', polarity: 'negative', text: 'watermark' },
            { id: 'cf_nright', name: 'NegR', polarity: 'negative', text: 'watermark', side: 'right' },
        ],
        prompt_negative_order: ['negative', 'cf_nboth', 'cf_nright'],
    });
    const { set } = bootScene(settings);
    assert.equal(getNegativePrompts().merged, 'lowres, watermark, jpeg');
    assert.equal(set.expandAll(1, 0)[0].negative, getNegativePrompts().merged);
});

test('the Exclude row switched off stops marking the chips of the other rows', () => {
    const settings = sceneSettings({ api_prompt: 'smile, blush', prompt_ban: 'blush' });
    const { document, manager, set } = bootScene(settings);
    set.setMode('capsule');
    const excluded = () => [...document.querySelectorAll('.prompt-positive .tag-capsule-chip')]
        .filter(chip => chip.classList.contains('is-excluded')).map(chip => chip.textContent);
    assert.deepEqual(excluded(), ['blush']);

    manager.setMuted('exclude', true);
    assert.deepEqual(excluded(), [], 'the row is off, so nothing is excluded');
    assert.equal(readPromptValue('exclude'), '');

    manager.setMuted('exclude', false);
    assert.deepEqual(excluded(), ['blush']);
});
