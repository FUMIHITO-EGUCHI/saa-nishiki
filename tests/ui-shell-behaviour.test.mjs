// scripts/renderer/uiShell.js run on the in-memory DOM: setupUiShell() builds the shell
// over a markup skeleton shaped like html_shared_body.js, and the tests click, type and
// change settings the way the app does. What is checked here is what the shell did to the
// DOM - the pipeline summaries, the run bar, the AI card, the info panel and the Refine
// review panel - not what its source says.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { FakeElement, withFakeDom } from './helpers/fakeDom.mjs';
import { setupUiShell } from '../scripts/renderer/uiShell.js';
import { SLIDER_RANGE_EVENT } from '../scripts/renderer/components/mySlider.js';
import { summarizeADetailer, summarizeControlNet, summarizeHires, summarizeLoRA } from '../scripts/renderer/tools/pipelineSummary.js';

const projectRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const language = JSON.parse(fs.readFileSync(path.join(projectRoot, 'data/language.json'), 'utf8'));
const EN = language['en-US'];

// The debounces in the shell are 50 / 120 ms; give the longest one room.
const settle = (ms = 180) => new Promise(resolve => setTimeout(resolve, ms));
const tick = () => new Promise(resolve => setImmediate(resolve));

// ------------------------------------------------------------------ mutation observers
// The fake DOM raises no mutation records, so `observe` only records what the shell
// watches and the test delivers the records itself - with the target / subtree matching a
// browser does. That keeps "which nodes does the shell watch, and with which options"
// and "does a record reach the refresh" both honest; only the browser's own delivery is
// taken on trust.
function createObservers() {
    const entries = [];
    class TestMutationObserver {
        constructor(callback) {
            this.callback = callback;
            this.entries = [];
        }

        observe(target, options = {}) {
            const entry = { observer: this, target, options };
            this.entries.push(entry);
            entries.push(entry);
        }

        disconnect() {
            for (const entry of this.entries) entries.splice(entries.indexOf(entry), 1);
            this.entries = [];
        }

        takeRecords() { return []; }
    }

    return {
        MutationObserver: TestMutationObserver,
        watchers: node => entries.filter(entry => entry.target === node),
        notify(node, type = 'childList') {
            const records = [{ type, target: node }];
            for (const entry of [...entries]) {
                const reached = entry.target === node || (entry.options.subtree === true && entry.target.contains(node));
                if (!reached) continue;
                if (type === 'childList' && entry.options.childList !== true) continue;
                if (type === 'attributes' && entry.options.attributes !== true) continue;
                entry.observer.callback(records, entry.observer);
            }
        },
    };
}

// innerHTML has no getter on the fake element; this records what was written to one and
// still lets the write through.
const innerHtmlSetter = Object.getOwnPropertyDescriptor(FakeElement.prototype, 'innerHTML').set;
function watchMarkup(node) {
    const writes = [];
    Object.defineProperty(node, 'innerHTML', {
        configurable: true,
        set(value) { writes.push(String(value)); innerHtmlSetter.call(node, value); },
    });
    return writes;
}

// ------------------------------------------------------------------ markup

function el(document, tag, properties = {}, children = []) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(properties)) {
        if (key === 'class') node.className = value;
        else if (key === 'dataset') Object.assign(node.dataset, value);
        else node[key] = value;
    }
    for (const child of children) node.appendChild(child);
    return node;
}

const PIPE_ROWS = [
    ['hires', 'highres-fix'],
    ['refiner', 'refiner'],
    ['adetailer', 'adetailer'],
    ['controlnet', 'controlnet'],
    ['lora', 'add-lora'],
    ['json', 'jsonlist'],
];

// The parts of html_shared_body.js the shell looks up, in the same nesting.
function buildMarkup(document) {
    const dom = {};
    const make = (tag, properties, children) => el(document, tag, properties, children);

    dom.view = make('div', { class: 'dropdown-view' }, [make('div', { class: 'view-select' })]);

    dom.rows = new Map();
    const rows = PIPE_ROWS.map(([pipe, toggle]) => {
        const summary = make('span', { class: 'pipe-row-summary', dataset: { pipeSummary: pipe } });
        const count = make('span', { class: 'pipe-row-count', dataset: { pipeCount: pipe } });
        const chevron = make('button', { class: 'pipe-row-chevron', dataset: { pipeToggle: toggle } });
        const body = make('div', { class: 'pipe-row-body' });
        const row = make('div', { class: 'pipe-row', dataset: { pipe } }, [
            make('div', { class: 'pipe-row-head' }, [chevron, summary, count]),
            body,
        ]);
        dom.rows.set(pipe, { row, summary, count, chevron, body, head: row.querySelector('.pipe-row-head') });
        return row;
    });
    dom.pipelineCard = make('div', { id: 'pipeline-card', class: 'ui-card pipeline-card' }, rows);

    dom.aiSegment = make('div', { id: 'ai-mode-segment' });
    dom.aiStatus = make('span', { id: 'ai-card-status' });
    dom.aiNote = make('p', { id: 'ai-card-note' });
    dom.aiCard = make('div', { id: 'ai-card', class: 'ui-card' }, [dom.aiSegment, dom.aiStatus, dom.aiNote]);

    dom.promptsTitle = make('h2', { dataset: { uiText: 'ui_prompts_title' } });
    dom.promptsSub = make('p', { dataset: { uiText: 'ui_prompts_sub' } });
    dom.promptsCard = make('div', { class: 'ui-card prompts-card' }, [dom.promptsTitle, dom.promptsSub]);
    dom.artistCard = make('div', { id: 'artist-card' });
    dom.animaDefaults = make('button', { id: 'anima-defaults' });

    dom.seedRandom = make('button', { id: 'seed-random-button' });
    dom.seedReuse = make('button', { id: 'seed-reuse-button' });
    dom.sizeLabel = make('span', { id: 'run-size-label' });
    dom.widthBox = make('div', { class: 'run-number' });
    dom.heightBox = make('div', { class: 'run-number' });
    dom.batchButton = make('button', { id: 'generate-batch-menu-button' });
    dom.batchExpand = make('button', { id: 'generate-batch-expand' });
    dom.batchList = make('div', { id: 'generate-batch-menu-list', hidden: true }, [dom.batchExpand]);
    dom.queueStatus = make('button', { id: 'queue-status' });
    dom.queueDrawer = make('div', { id: 'queue-drawer', hidden: true });
    dom.footnote = make('button', { id: 'run-footnote' });
    dom.runBar = make('div', { id: 'run-bar' }, [
        dom.seedRandom,
        dom.seedReuse,
        make('div', { class: 'run-param-size' }, [dom.sizeLabel, dom.widthBox, dom.heightBox]),
        make('div', { id: 'generate-batch-menu' }, [dom.batchButton, dom.batchList]),
        dom.queueStatus,
        dom.queueDrawer,
        dom.footnote,
    ]);

    dom.infoTabs = ['info', 'characters', 'ai'].map(name => make('button', { class: 'info-tab', dataset: { infoTab: name } }));
    dom.aiResultText = make('pre', { class: 'ai-result-text' });
    dom.aiInfoPanel = make('div', { class: 'info-panel', dataset: { infoPanel: 'ai' } }, [dom.aiResultText]);
    dom.infoPanels = [
        make('div', { class: 'info-panel', dataset: { infoPanel: 'info' } }),
        make('div', { class: 'info-panel', dataset: { infoPanel: 'characters' } }),
        dom.aiInfoPanel,
    ];
    dom.infoPanel = make('div', { id: 'info-panel' }, [...dom.infoTabs, ...dom.infoPanels]);
    dom.splitter = make('div', { id: 'left-splitter' });
    dom.viewerStatus = make('span', { id: 'viewer-status' });
    dom.gallery = make('div', { class: 'gallery-main-container' }, [make('div', { class: 'gallery-main-main' })]);
    dom.left = make('div', { id: 'left' }, [dom.gallery, dom.splitter, dom.infoPanel, dom.viewerStatus]);

    dom.queueContainer = make('div', { class: 'queue-main' });

    document.body.append(
        dom.left,
        make('div', { id: 'right' }, [
            dom.view, dom.promptsCard, dom.artistCard, dom.animaDefaults,
            dom.aiCard, dom.pipelineCard, dom.runBar,
        ]),
        dom.queueContainer,
    );
    return dom;
}

// ------------------------------------------------------------------ world

function defaultSettings() {
    return {
        language: 'en-US',
        api_model_type: 'Checkpoint',
        api_hf_enable: true,
        api_hf_scale: 1.5,
        api_hf_upscaler_selected: 'models/RealESRGAN_x4.pth',
        api_hf_denoise: 0.4,
        api_hf_steps: 20,
        width: 832,
        height: 1216,
        api_refiner_enable: false,
        api_adetailer_enable: true,
        api_controlnet_enable: false,
        ai_interface: 'None',
        ai_local_prompt_mode: 'Expand',
        generate_auto_start: true,
        tag_assist: true,
        wildcard_random: false,
    };
}

async function withShell(body, { settings = defaultSettings(), slots = {}, queueContainer = true } = {}) {
    const calls = [];
    const record = (name, ...args) => { calls.push([name, ...args]); };
    const observers = createObservers();
    const store = new Map();
    // Every interval the shell starts, recorded and unref'd so a leak cannot hold node open.
    const realSetInterval = setInterval;
    const realClearInterval = clearInterval;
    const intervals = [];

    let shell = null;
    let dom = null;
    await withFakeDom(async document => {
        dom = buildMarkup(document);
        const world = {
            document,
            dom,
            calls,
            observers,
            settings,
            store,
            intervals,
            took: name => calls.filter(entry => entry[0] === name).map(entry => entry.slice(1)),
            get shell() { return shell; },
        };
        globalThis.queueManager = { container: queueContainer ? dom.queueContainer : null, getSlotsCount: () => slots.queue ?? 0 };
        shell = setupUiShell();
        calls.length = 0;
        try {
            await body(world);
        } finally {
            await settle();   // let the debounces run out before the observers go
            shell.pipeline?.destroy?.();
            shell.runBar?.destroy?.();
        }
    }, {
        MutationObserver: observers.MutationObserver,
        setInterval: (handler, ms) => {
            const handle = realSetInterval(handler, ms);
            handle.unref?.();
            intervals.push({ handler, ms, handle, cleared: false });
            return handle;
        },
        clearInterval: handle => {
            for (const entry of intervals) if (entry.handle === handle) entry.cleared = true;
            realClearInterval(handle);
        },
        localStorage: {
            getItem: key => (store.has(key) ? store.get(key) : null),
            setItem: (key, value) => { store.set(key, String(value)); },
            removeItem: key => { store.delete(key); },
        },
        navigator: { clipboard: { writeText: async text => record('clipboard', text) } },
        globalSettings: settings,
        cachedFiles: { language },
        inGenerating: false,
        uiShell: undefined,
        infoPanel: undefined,
        queueManager: undefined,
        collapsedTabs: Object.fromEntries(['hires', 'refiner', 'aDetailer', 'controlnet', 'lora', 'jsonlist'].map(key => {
            let collapsed = true;
            return [key, { getCollapsed: () => collapsed, setCollapsed: next => { collapsed = next; record('setCollapsed', key, next); } }];
        })),
        lora: { getValues: () => slots.lora ?? [] },
        aDetailer: { getValues: () => slots.adetailer ?? [] },
        controlnet: { getValues: () => slots.controlnet ?? [] },
        jsonlist: { getSlots: () => slots.json ?? [] },
        generate: {
            seed: { setValue: value => record('seed', value) },
            queueAutostart: { setTitle: title => record('autostartTitle', title) },
            width: { setValue: value => record('width', value), setRange: () => {} },
            height: { setValue: value => record('height', value), setRange: () => {} },
            step: { setValue: value => record('step', value) },
            cfg: { setValue: value => record('cfg', value) },
            sampler: { updateDefaults: value => record('sampler', value) },
            scheduler: { updateDefaults: value => record('scheduler', value) },
        },
        ai: {
            interface: { updateDefaults: value => record('aiInterface', value) },
            local_prompt_mode: { updateDefaults: value => record('aiPromptMode', value) },
            ai_select: { setValue: value => record('aiRole', value) },
        },
        prompt: { tagCapsuleFields: { get: key => slots.fields?.[key] ?? null } },
        mainGallery: { appendImageData: (...args) => record('appendImageData', ...args) },
        headerIcon: { settings: { setPage: page => record('settingsPage', page), open: () => record('settingsOpen'), applyConditions: () => record('applyConditions') } },
        api: undefined,
        podControls: undefined,
    });
    return { shell, dom, calls };
}

// ------------------------------------------------------------------ pipeline rows

test('the pipeline summaries are what the slot state says, and the off rows are marked', async () => {
    const settings = defaultSettings();
    const slots = {
        lora: [['loras/style.safetensors', '0.8', '', 'ON'], ['loras/off.safetensors', '1', '', 'OFF']],
        adetailer: [['face_yolov8n.pt', '', '', 'sam_vit_b_01ec64.pth', '', '', '', '', '', '0.35']],
        controlnet: [['', '', 'ON', 'control_openpose.safetensors', '0.9']],
        json: ['slot-1', 'slot-2'],
    };
    await withShell(async ({ dom }) => {
        const text = { denoise: EN.ui_sum_denoise, steps: EN.ui_sum_steps, ratio: EN.ui_sum_ratio, addNoise: EN.ui_sum_add_noise, noSlots: EN.ui_sum_no_slots, none: EN.ui_sum_none, off: EN.ui_sum_off, slot: EN.ui_sum_slot };
        assert.equal(dom.rows.get('hires').summary.textContent, summarizeHires(settings, text));
        assert.match(dom.rows.get('hires').summary.textContent, /^×1\.5 · RealESRGAN_x4 · denoise 0\.40 · 20 steps · → 1248 × 1824$/);
        assert.equal(dom.rows.get('lora').summary.textContent, summarizeLoRA([{ name: 'loras/style.safetensors', strength: '0.8', enabled: true }, { name: 'loras/off.safetensors', strength: '1', enabled: false }], text));
        assert.equal(dom.rows.get('lora').count.textContent, '2');
        assert.equal(dom.rows.get('adetailer').summary.textContent, summarizeADetailer([{ model: 'face_yolov8n.pt', sam: 'sam_vit_b_01ec64.pth', denoise: '0.35', enabled: true }], text));
        assert.equal(dom.rows.get('controlnet').summary.textContent, summarizeControlNet([{ model: 'control_openpose.safetensors', strength: '0.9', enabled: true }], text));
        assert.equal(dom.rows.get('json').summary.textContent, `2 ${EN.ui_sum_files}`);
        assert.equal(dom.rows.get('json').count.textContent, '2');

        assert.equal(dom.rows.get('hires').row.classList.contains('is-off'), false, 'Hires is on');
        assert.equal(dom.rows.get('refiner').row.classList.contains('is-off'), true, 'Refiner is off');
        assert.equal(dom.rows.get('adetailer').row.classList.contains('is-off'), false);
        assert.equal(dom.rows.get('controlnet').row.classList.contains('is-off'), true);
    }, { settings, slots });
});

test('a slot filled from outside the card redraws the summaries through the body observer', async () => {
    const slots = { lora: [] };
    await withShell(async ({ document, dom, observers }) => {
        assert.equal(dom.rows.get('lora').summary.textContent, EN.ui_sum_none);

        // every row body is watched, deep, for children and for a class change
        for (const [, row] of dom.rows) {
            const watchers = observers.watchers(row.body);
            assert.equal(watchers.length, 1, 'the row body is watched exactly once');
            assert.deepEqual(watchers[0].options, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
        }
        // and nothing that refresh() writes into sits inside a watched body, so the
        // observer cannot feed itself
        for (const [, row] of dom.rows) {
            assert.equal(row.body.contains(row.summary), false);
            assert.equal(row.body.contains(row.count), false);
            assert.equal(row.body.contains(row.row), false);
        }

        // Image Info's "Add ControlNet" / a dropped JSON file fills a slot inside the body
        slots.lora = [['loras/new.safetensors', '1.0', '', 'ON']];
        const slotRow = dom.rows.get('lora').body.appendChild(el(document, 'div', { class: 'lora-slot' }));
        observers.notify(slotRow);
        await settle();
        assert.equal(dom.rows.get('lora').summary.textContent, 'new 1.0');
        assert.equal(dom.rows.get('lora').count.textContent, '1');
    }, { slots });
});

test('a preset applied elsewhere, and a language change, redraw the rows', async () => {
    const settings = defaultSettings();
    await withShell(async ({ document, dom, shell }) => {
        settings.api_hf_enable = false;
        settings.api_hf_steps = 12;
        document.dispatchEvent({ type: 'saa-settings-applied' });
        await settle();
        assert.equal(dom.rows.get('hires').row.classList.contains('is-off'), true);
        assert.match(dom.rows.get('hires').summary.textContent, /12 steps/);

        settings.language = 'zh-CN';
        shell.updateLanguage();
        await settle();
        assert.match(dom.rows.get('hires').summary.textContent, new RegExp(`12 ${language['zh-CN'].ui_sum_steps}`));
    }, { settings });
});

test('clicking a pipeline row head collapses and expands its tab; the count and the chevron do not', async () => {
    await withShell(async ({ dom, took }) => {
        const row = dom.rows.get('adetailer');
        row.head.dispatchEvent({ type: 'click', bubbles: true, target: row.head, preventDefault() {}, stopPropagation() {} });
        await tick();
        assert.deepEqual(took('setCollapsed'), [['aDetailer', false]]);
        assert.equal(row.row.classList.contains('is-open'), true);

        row.head.dispatchEvent({ type: 'click', bubbles: true, target: row.chevron, preventDefault() {}, stopPropagation() {} });
        await tick();
        assert.deepEqual(took('setCollapsed').at(-1), ['aDetailer', true], 'the chevron toggles like the head');
        assert.equal(row.row.classList.contains('is-open'), false);

        const before = took('setCollapsed').length;
        row.head.dispatchEvent({ type: 'click', bubbles: true, target: row.count, preventDefault() {}, stopPropagation() {} });
        await tick();
        assert.equal(took('setCollapsed').length, before, 'the count is a control of its own');
    });
});

// ------------------------------------------------------------------ run bar

test('the run bar seed buttons, and the gallery that feeds the reuse button', async () => {
    await withShell(async ({ dom, took }) => {
        dom.seedRandom.click();
        assert.deepEqual(took('seed'), [[-1]]);

        dom.seedReuse.click();
        assert.deepEqual(took('seed'), [[-1]], 'with no image yet there is no seed to reuse');

        globalThis.mainGallery.appendImageData('data:image/png;base64,AA', '123456', []);
        assert.deepEqual(took('appendImageData'), [['data:image/png;base64,AA', '123456', []]], 'the gallery still gets the call');
        dom.seedReuse.click();
        assert.deepEqual(took('seed').at(-1), [123_456]);
    });
});

test('the size label turns red while either box is over the limit, and only clears when both are back', async () => {
    await withShell(async ({ dom }) => {
        const over = (box, value) => box.dispatchEvent({ type: SLIDER_RANGE_EVENT, detail: { over: value } });
        over(dom.widthBox, true);
        assert.equal(dom.sizeLabel.classList.contains('is-over'), true);
        over(dom.heightBox, true);
        over(dom.widthBox, false);
        assert.equal(dom.sizeLabel.classList.contains('is-over'), true, 'the height box is still over');
        over(dom.heightBox, false);
        assert.equal(dom.sizeLabel.classList.contains('is-over'), false);
    });
});

test('the batch menu opens on its button and closes on a click outside, on Escape and on a choice', async () => {
    await withShell(async ({ document, dom }) => {
        const click = (node, target = node) => node.dispatchEvent({ type: 'click', bubbles: true, target, preventDefault() {}, stopPropagation() {} });
        click(dom.batchButton);
        assert.equal(dom.batchList.hidden, false);
        assert.equal(dom.batchButton.getAttribute('aria-expanded'), 'true');

        document.dispatchEvent({ type: 'click', target: dom.footnote });
        assert.equal(dom.batchList.hidden, true);
        assert.equal(dom.batchButton.getAttribute('aria-expanded'), 'false');

        click(dom.batchButton);
        document.dispatchEvent({ type: 'keydown', key: 'Escape' });
        assert.equal(dom.batchList.hidden, true);

        click(dom.batchButton);
        click(dom.batchList, dom.batchExpand);
        await settle(20);
        assert.equal(dom.batchList.hidden, true, 'picking an entry closes the menu');
    });
});

test('Expand weights per image opens the capsule view when the batch button is not on screen', async () => {
    const opened = [];
    const batchButton = { getClientRects: () => [] };
    const field = {
        element: { querySelector: () => batchButton },
        setMode: (mode, options) => opened.push([mode, options]),
    };
    await withShell(async ({ dom }) => {
        dom.batchExpand.click();
        assert.deepEqual(opened, [['capsule', { focus: true }]]);

        batchButton.getClientRects = () => [{ width: 20, height: 20 }];
        batchButton.click = () => opened.push(['batch-button']);
        dom.batchExpand.click();
        assert.deepEqual(opened.at(-1), ['batch-button'], 'a visible batch button is clicked instead');
    }, { slots: { fields: { positive: field } } });
});

test('the queue drawer, the queue pill and the footnote follow the settings', async () => {
    const settings = defaultSettings();
    await withShell(async ({ document, dom, took }) => {
        assert.equal(dom.footnote.textContent, `${EN.ui_run_tag_assist} ${EN.ui_on} · ${EN.ui_run_wildcard} ${EN.ui_off} ↗ ${EN.system_settings}`);
        assert.equal(dom.queueStatus.classList.contains('is-paused'), false);

        dom.queueStatus.click();
        assert.equal(dom.queueDrawer.hidden, false);
        assert.equal(dom.queueStatus.getAttribute('aria-expanded'), 'true');
        dom.queueStatus.click();
        assert.equal(dom.queueDrawer.hidden, true);

        settings.wildcard_random = true;
        settings.generate_auto_start = false;
        document.dispatchEvent({ type: 'saa-settings-applied' });
        await settle();
        assert.equal(dom.footnote.textContent, `${EN.ui_run_tag_assist} ${EN.ui_on} · ${EN.ui_run_wildcard} ${EN.ui_on} ↗ ${EN.system_settings}`);
        assert.equal(dom.queueStatus.classList.contains('is-paused'), true);

        dom.footnote.click();
        assert.deepEqual(took('settingsPage'), [['prompt-editing']]);
        assert.equal(took('settingsOpen').length, 1);
    }, { settings });
});

test('the run bar writes its markup once per change: the queue label is escaped and only rewritten when it differs', async () => {
    const settings = defaultSettings();
    let queue = 0;
    await withShell(async ({ document, dom, shell }) => {
        const writes = watchMarkup(dom.queueStatus);
        shell.runBar.refresh();
        assert.equal(writes.length, 0, 'nothing changed, nothing is written');

        queue = 2;
        document.dispatchEvent({ type: 'saa-settings-applied' });
        await settle();
        assert.equal(writes.length, 1);
        assert.match(writes[0], new RegExp(`${EN.ui_run_queue} 2 · ${EN.ui_run_autostart_on}`));

        shell.runBar.refresh();
        assert.equal(writes.length, 1, 'the same markup is not assigned twice');

        // a label with markup in it is escaped, never parsed
        settings.language = 'evil';
        globalThis.cachedFiles.language.evil = { ...EN, ui_run_queue: '<img src=x onerror="alert(1)">' };
        shell.runBar.refresh();
        assert.match(writes.at(-1), /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/);
        assert.doesNotMatch(writes.at(-1), /<img /);
    }, { settings, slots: { get queue() { return queue; } } });
});

test('with a queue container the run bar watches it; without one it falls back to a poll that stops on destroy', async () => {
    let slotCount = 0;
    const slots = { get queue() { return slotCount; } };
    await withShell(async ({ dom, observers, intervals }) => {
        assert.deepEqual(intervals, [], 'a watched queue needs no poll');
        assert.equal(observers.watchers(dom.queueContainer).length, 1);
        assert.deepEqual(observers.watchers(dom.queueContainer)[0].options, { childList: true });

        const writes = watchMarkup(dom.queueStatus);
        slotCount = 3;
        observers.notify(dom.queueContainer);   // myQueueSlot.attach() added a row
        await settle();
        assert.match(writes.at(-1) ?? '', new RegExp(`${EN.ui_run_queue} 3`));
    }, { slots });

    await withShell(async ({ shell, intervals }) => {
        assert.equal(intervals.length, 1, 'no container to watch: a poll instead');
        assert.equal(intervals[0].ms, 1000);
        assert.equal(intervals[0].cleared, false);
        shell.runBar.destroy();
        assert.equal(intervals[0].cleared, true);
    }, { slots, queueContainer: false });
});

test('the pipeline rows never poll: the card is watched, not sampled', async () => {
    await withShell(async ({ intervals }) => {
        assert.deepEqual(intervals, []);
    });
});

// ------------------------------------------------------------------ AI card

test('the AI card segment writes the settings the three modes stand for', async () => {
    const settings = defaultSettings();
    await withShell(async ({ dom, took }) => {
        const buttons = Object.fromEntries(dom.aiSegment.children.map(node => [node.dataset.mode, node]));
        assert.deepEqual(Object.keys(buttons), ['off', 'expand', 'refine']);
        assert.deepEqual(dom.aiSegment.children.map(node => node.textContent), [EN.ui_ai_mode_off, EN.ui_ai_mode_expand, EN.ui_ai_mode_refine]);
        assert.equal(buttons.off.classList.contains('is-on'), true);
        assert.equal(buttons.off.getAttribute('aria-checked'), 'true');
        assert.equal(dom.aiCard.classList.contains('is-off'), true);
        assert.equal(dom.aiNote.textContent, EN.ui_ai_note_off);

        buttons.refine.click();
        assert.equal(settings.ai_interface, 'Local');
        assert.equal(settings.ai_local_prompt_mode, 'Refine');
        assert.equal(settings.ai_prompt_role, 1);
        assert.deepEqual(took('aiInterface'), [['Local']]);
        assert.deepEqual(took('aiPromptMode'), [['Refine']]);
        assert.deepEqual(took('aiRole'), [[1]]);
        assert.equal(dom.aiCard.dataset.mode, 'refine');
        assert.equal(dom.aiNote.textContent, EN.ui_ai_note_refine);
        assert.equal(dom.aiStatus.textContent, EN.ui_ai_local);
        assert.equal(took('applyConditions').length, 1);

        settings.ai_interface = 'Remote';
        buttons.off.click();
        assert.equal(settings.ai_interface, 'None');
        buttons.expand.click();
        assert.equal(settings.ai_interface, 'Remote', 'turning the card back on restores the backend it had');
        assert.equal(settings.ai_local_prompt_mode, 'Expand');
        assert.equal(dom.aiNote.textContent, EN.ui_ai_note_expand);
    }, { settings });
});

// ------------------------------------------------------------------ model type

test('the Diffusion model type renames the Prompts card and puts the body in cast mode', async () => {
    const settings = defaultSettings();
    await withShell(async ({ document, dom, shell }) => {
        assert.equal(document.body.classList.contains('cast-mode'), false);
        assert.equal(dom.promptsTitle.textContent, EN.ui_prompts_title);
        assert.equal(dom.artistCard.hidden, true, 'the Artist card is an Anima idea');
        assert.equal(dom.animaDefaults.hidden, true);

        settings.api_model_type = 'Diffusion';
        shell.modelTypeUi.render();
        assert.equal(document.body.classList.contains('cast-mode'), true);
        assert.equal(dom.promptsTitle.textContent, EN.ui_scene_title);
        assert.equal(dom.promptsSub.textContent, EN.ui_scene_sub);
        assert.equal(dom.artistCard.hidden, false);
        assert.equal(dom.animaDefaults.hidden, false);
    }, { settings });
});

test('the Anima defaults button writes the sampling set and keeps the orientation', async () => {
    const settings = { ...defaultSettings(), api_model_type: 'Diffusion', width: 1216, height: 832 };
    await withShell(async ({ dom, took }) => {
        dom.animaDefaults.click();
        assert.equal(settings.api_model_sampler, 'er_sde');
        assert.equal(settings.api_model_scheduler, 'simple');
        assert.equal(settings.step, 30);
        assert.equal(settings.cfg, 4.5);
        assert.deepEqual([settings.width, settings.height], [1216, 832], 'a landscape image stays landscape');
        assert.deepEqual(took('width'), [[1216]]);
        assert.deepEqual(took('height'), [[832]]);

        settings.width = 832;
        settings.height = 1216;
        dom.animaDefaults.click();
        assert.deepEqual([settings.width, settings.height], [832, 1216], 'a portrait image stays portrait');
    }, { settings });
});

// ------------------------------------------------------------------ characters card

test('the View row keeps its Angle / Camera labels on top when the dropdowns are rebuilt', async () => {
    await withShell(async ({ document, dom, observers }) => {
        const labels = dom.view.querySelector('.view-labels');
        assert.ok(labels);
        assert.deepEqual(labels.children.map(node => node.textContent), [EN.view_angle, EN.view_camera]);
        assert.equal(dom.view.firstElementChild, labels, 'the labels sit above the dropdowns');

        // setOptions() rebuilds the dropdown markup below the labels, which leaves the
        // label row somewhere in the middle; the observer puts it back on top.
        dom.view.appendChild(el(document, 'div', { class: 'view-select' }));
        dom.view.appendChild(labels);
        assert.notEqual(dom.view.firstElementChild, labels);
        observers.notify(dom.view);
        assert.equal(dom.view.firstElementChild, labels, 'the label row is moved back above the dropdowns');

        // the labels follow the language on the next render
        globalThis.globalSettings.language = 'zh-CN';
        globalThis.uiShell.characters.render();
        assert.deepEqual(labels.children.map(node => node.textContent), [language['zh-CN'].view_angle, language['zh-CN'].view_camera]);
    });
});

// ------------------------------------------------------------------ info panel

test('the info tabs switch panels and remember the last one', async () => {
    await withShell(async ({ dom, store }) => {
        const [info, characters, ai] = dom.infoTabs;
        assert.equal(info.classList.contains('is-active'), true);
        assert.equal(dom.infoPanels[0].hidden, false);
        assert.equal(dom.aiInfoPanel.hidden, true);

        characters.click();
        assert.equal(characters.getAttribute('aria-selected'), 'true');
        assert.equal(info.classList.contains('is-active'), false);
        assert.equal(dom.infoPanels[1].hidden, false);
        assert.equal(store.get('saa.infoTab'), 'characters');

        globalThis.infoPanel.setTab('ai');
        assert.equal(ai.classList.contains('is-active'), true);
        assert.equal(dom.aiInfoPanel.hidden, false);
    });
});

test('an AI answer that arrives while another tab is open only marks the AI tab', async () => {
    await withShell(async ({ dom }) => {
        globalThis.infoPanel.showAiResult('1girl, smile');
        assert.equal(dom.aiResultText.textContent, '1girl, smile');
        assert.equal(dom.infoTabs[2].classList.contains('has-new'), true);
        assert.equal(dom.infoTabs[0].classList.contains('is-active'), true, 'the open tab is not stolen');

        dom.infoTabs[2].click();
        assert.equal(dom.infoTabs[2].classList.contains('has-new'), false, 'reading it clears the mark');

        globalThis.infoPanel.showAiResult('another', { focus: true });
        assert.equal(dom.infoTabs[2].classList.contains('is-active'), true);
    });
});

// ------------------------------------------------------------------ Refine pending panel

const REFINE_XSS = '<img src=x onerror="alert(1)"> & <script>alert(2)</script>';

function pendingOf(dom) {
    return dom.aiInfoPanel.querySelector('.ai-refine-pending');
}

test('the Refine review shows the model answer as text, never as markup', async () => {
    await withShell(async ({ dom }) => {
        globalThis.infoPanel.showRefinePending({ runId: 'run-1', text: REFINE_XSS });
        const pending = pendingOf(dom);
        const summary = pending.querySelector('.ai-refine-summary');
        assert.equal(summary.tagName, 'PRE');
        assert.equal(summary.textContent, REFINE_XSS, 'the answer is kept exactly as it came');
        assert.deepEqual(summary.children, [], 'and nothing in it became a node');
        assert.equal(pending.querySelectorAll('img').length, 0);
        assert.equal(pending.querySelectorAll('script').length, 0);
        assert.equal(pending.dataset.runId, 'run-1');
        assert.equal(pending.getAttribute('aria-label'), 'AI Refine editor update');

        const status = pending.querySelector('.ai-refine-status');
        assert.equal(status.getAttribute('role'), 'status');
        assert.equal(status.getAttribute('aria-live'), 'polite');
        assert.equal(status.textContent, 'Pending editor update');
        assert.deepEqual(pending.querySelectorAll('.ai-refine-actions button').map(node => [node.type, node.textContent]), [
            ['button', 'Apply to prompt'],
            ['button', 'Discard'],
        ]);
    });
});

test('Apply reports what the editor did, and a refused apply leaves the buttons usable', async () => {
    await withShell(async ({ dom }) => {
        let answer = { status: 'conflict' };
        globalThis.infoPanel.showRefinePending({ runId: 'run-1', text: 'a, b', onApply: async () => answer });
        const buttons = () => pendingOf(dom).querySelectorAll('.ai-refine-actions button');
        const status = () => pendingOf(dom).querySelector('.ai-refine-status').textContent;

        buttons()[0].click();
        await tick();
        assert.equal(status(), 'Not applied: prompt changed after this run started');
        assert.deepEqual(buttons().map(node => node.disabled), [false, false], 'the run can be applied again');

        answer = { status: 'applied', discardedPlans: 2 };
        buttons()[0].click();
        await tick();
        assert.equal(status(), 'Applied · 2 incompatible Weight Plan(s) removed');
        assert.equal(pendingOf(dom).querySelector('.ai-refine-actions'), null, 'an applied run offers nothing more');
    });
});

test('only the newest Refine run is actionable, and Discard takes the panel away', async () => {
    await withShell(async ({ dom }) => {
        const applied = [];
        const discarded = [];
        globalThis.infoPanel.showRefinePending({ runId: 'old', text: 'old', onApply: async () => { applied.push('old'); return { status: 'applied' }; } });
        const oldApply = pendingOf(dom).querySelectorAll('.ai-refine-actions button')[0];

        globalThis.infoPanel.showRefinePending({ runId: 'new', text: 'new', onApply: async () => { applied.push('new'); return { status: 'applied' }; }, onDiscard: () => discarded.push('new') });
        assert.equal(dom.aiInfoPanel.querySelectorAll('.ai-refine-pending').length, 1, 'the older panel is replaced');
        assert.equal(pendingOf(dom).querySelector('.ai-refine-summary').textContent, 'new');

        oldApply.click();
        await tick();
        assert.deepEqual(applied, [], 'the button of the superseded run does nothing');

        pendingOf(dom).querySelectorAll('.ai-refine-actions button')[1].click();
        await tick();
        assert.deepEqual(discarded, ['new']);
        assert.equal(pendingOf(dom), null);
    });
});

test('a run with nothing to apply shows the status alone', async () => {
    await withShell(async ({ dom }) => {
        globalThis.infoPanel.showRefinePending({ runId: 'run-1', text: 'a', status: 'Cancelled', canApply: false, focus: true });
        assert.equal(pendingOf(dom).querySelector('.ai-refine-status').textContent, 'Cancelled');
        assert.equal(pendingOf(dom).querySelector('.ai-refine-actions'), null);
        assert.equal(dom.infoTabs[2].classList.contains('is-active'), true, 'focus opens the AI tab');
    });
});

test('the large view mirrors the pending summary and proxies its buttons', async () => {
    await withShell(async ({ document, dom }) => {
        const applied = [];
        globalThis.infoPanel.showRefinePending({ runId: 'run-1', text: REFINE_XSS, onApply: async () => { applied.push('apply'); return { status: 'applied' }; } });
        dom.aiInfoPanel.querySelector('.ai-result-expand').click();

        const backdrop = document.body.querySelector('.ai-result-modal-backdrop');
        assert.ok(backdrop, 'the modal opened');
        const body = backdrop.querySelector('.ai-result-modal-text');
        assert.equal(body.textContent, REFINE_XSS);
        assert.deepEqual(body.children, [], 'the large view is text too');

        const actions = backdrop.querySelectorAll('.ai-result-modal-actions button');
        assert.deepEqual(actions.map(node => node.textContent), ['Copy', 'Apply to prompt', 'Discard']);
        actions[1].click();
        await tick();
        assert.deepEqual(applied, ['apply'], 'the proxy presses the button in the panel');
        assert.equal(document.body.querySelector('.ai-result-modal-backdrop'), null, 'and the modal closes behind it');
    });
});

// ------------------------------------------------------------------ viewer status

test('the viewer line counts the rendered images and names the last seed', async () => {
    await withShell(async ({ document, dom, shell }) => {
        assert.equal(dom.viewerStatus.textContent, '');
        const main = document.querySelector('.gallery-main-main');
        main.appendChild(el(document, 'img', { class: 'cg-gallery-image' }));
        shell.refreshViewerStatus();
        assert.equal(dom.viewerStatus.textContent, `1 ${EN.ui_viewer_image}`);

        main.appendChild(el(document, 'img', { class: 'cg-gallery-image' }));
        globalThis.mainGallery.appendImageData('data:image/png;base64,AA', '77', []);
        assert.equal(dom.viewerStatus.textContent, `2 ${EN.ui_viewer_images} · seed 77`);
    });
});

// ------------------------------------------------------------------ language

test('updateLanguage retitles every [data-ui-text] label and the queue switch', async () => {
    const settings = defaultSettings();
    await withShell(async ({ dom, shell, took }) => {
        assert.equal(dom.promptsTitle.textContent, EN.ui_prompts_title);
        shell.updateLanguage();
        assert.deepEqual(took('autostartTitle'), [[EN.ui_run_autostart]], 'the queue switch is renamed away from the legacy title');

        settings.language = 'zh-CN';
        shell.updateLanguage();
        const zh = language['zh-CN'];
        assert.equal(dom.promptsTitle.textContent, zh.ui_prompts_title);
        assert.equal(dom.promptsSub.textContent, zh.ui_prompts_sub);
        assert.deepEqual(dom.aiSegment.children.map(node => node.textContent), [zh.ui_ai_mode_off, zh.ui_ai_mode_expand, zh.ui_ai_mode_refine]);
        assert.match(dom.footnote.textContent, new RegExp(zh.ui_run_tag_assist));
        // zh-CN has no ui_run_autostart: a missing key leaves the title where it was
        assert.equal(zh.ui_run_autostart, undefined);
        assert.equal(took('autostartTitle').length, 1);
    }, { settings });
});
