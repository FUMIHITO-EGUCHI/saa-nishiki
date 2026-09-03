// Glue for the 2026-08-30 layout (wai-stack/SAA-ui-redesign.md):
//   pipeline rows (switch + summary + chevron), AI card (Off | Expand | Refine),
//   run bar (seed buttons, batch menu, queue drawer, progress rows), left panel
//   (tabs + resizable info panel), header status pills, [data-ui-text] labels.
// Everything here only rearranges / decorates components that renderer.js already
// created; generation logic and settings keys are untouched.
import { setupRunProgress } from './components/runProgress.js';
import { setupStatusPills } from './components/statusPills.js';
import { AI_MODES, applyAiMode, deriveAiMode, describeAiStatus } from './components/aiModeLogic.js';
import {
    countLabel, summarizeADetailer, summarizeControlNet, summarizeHires, summarizeJson, summarizeLoRA, summarizeRefiner,
} from './tools/pipelineSummary.js';

const CAT = '[UiShell]';

const ICONS = {
    dice: '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2.5" y="2.5" width="11" height="11" rx="2"/><circle cx="6" cy="6" r=".9" fill="currentColor"/><circle cx="10" cy="10" r=".9" fill="currentColor"/><circle cx="10" cy="6" r=".9" fill="currentColor"/><circle cx="6" cy="10" r=".9" fill="currentColor"/></svg>',
    lock: '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3.5" y="7" width="9" height="6.5" rx="1.5"/><path d="M5.5 7V5a2.5 2.5 0 015 0v2"/></svg>',
    chevD: '<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6l5 5 5-5"/></svg>',
    layers: '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 2.5l6 3-6 3-6-3z"/><path d="M2 8.5l6 3 6-3M2 11l6 3 6-3"/></svg>',
};

const PIPE_TABS = { 'highres-fix': 'hires', refiner: 'refiner', adetailer: 'aDetailer', controlnet: 'controlnet', 'add-lora': 'lora', jsonlist: 'jsonlist' };

function lang() {
    return globalThis.cachedFiles?.language?.[globalThis.globalSettings?.language] ?? {};
}

function uiText(key, fallback) {
    const value = lang()[key];
    return typeof value === 'string' && value ? value : fallback;
}

export function applyUiText(root = document) {
    const LANG = lang();
    for (const element of root.querySelectorAll('[data-ui-text]')) {
        const value = LANG[element.dataset.uiText];
        if (typeof value === 'string' && value) element.textContent = value;
    }
}

function debounce(fn, wait) {
    let handle = null;
    return (...args) => {
        clearTimeout(handle);
        handle = setTimeout(() => fn(...args), wait);
    };
}

// ------------------------------------------------------------------ pipeline rows
function setupPipelineRows() {
    const card = document.getElementById('pipeline-card');
    if (!card) return null;

    const rows = [...card.querySelectorAll('.pipe-row')];
    const syncExpanded = () => {
        for (const row of rows) {
            const button = row.querySelector('[data-pipe-toggle]');
            const key = button?.dataset.pipeToggle;
            const tab = key ? globalThis.collapsedTabs?.[PIPE_TABS[key]] : null;
            const collapsed = tab ? tab.getCollapsed() : !row.querySelector('.pipe-row-body')?.classList.contains('collapsed') === false;
            button?.setAttribute('aria-expanded', String(!collapsed));
            row.classList.toggle('is-open', !collapsed);
        }
    };

    for (const row of rows) {
        const head = row.querySelector('.pipe-row-head');
        const button = row.querySelector('[data-pipe-toggle]');
        const image = button?.querySelector('img');
        const key = button?.dataset.pipeToggle;
        const toggle = () => {
            const tab = globalThis.collapsedTabs?.[PIPE_TABS[key]];
            if (tab) tab.setCollapsed(!tab.getCollapsed());
            syncExpanded();
        };
        head?.addEventListener('click', event => {
            if (event.target === image) { requestAnimationFrame(syncExpanded); return; } // myCollapsed handles the img itself
            if (event.target.closest('.pipe-row-switch, .pipe-row-count, input, select, button:not(.pipe-row-chevron)')) return;
            toggle();
        });
    }

    const summaryText = () => ({
        denoise: uiText('ui_sum_denoise', 'denoise'), steps: uiText('ui_sum_steps', 'steps'), ratio: uiText('ui_sum_ratio', 'ratio'),
        addNoise: uiText('ui_sum_add_noise', 'add noise'), noSlots: uiText('ui_sum_no_slots', 'no slots'), none: uiText('ui_sum_none', 'none'),
        off: uiText('ui_sum_off', 'off'), slot: uiText('ui_sum_slot', 'slot'),
    });

    const readLora = () => {
        try { return (globalThis.lora?.getValues?.() ?? []).map(([name, strength, , enable]) => ({ name, strength, enabled: enable !== 'OFF' })); } catch { return []; }
    };
    const readADetailer = () => {
        try { return (globalThis.aDetailer?.getValues?.() ?? []).map(row => ({ model: row[0], sam: row[3], denoise: row[9], enabled: Boolean(row[0]) && row[0] !== 'None' })); } catch { return []; }
    };
    const readControlNet = () => {
        try { return (globalThis.controlnet?.getValues?.() ?? []).map(row => ({ model: row[3], strength: row[4], enabled: row[2] !== 'OFF' })); } catch { return []; }
    };
    const readJson = () => {
        try { return (globalThis.jsonlist?.getSlots?.() ?? []).map(name => ({ name: String(name).replace(/^slot-/, 'slot ') })); } catch { return []; }
    };

    function refresh() {
        const SETTINGS = globalThis.globalSettings ?? {};
        const text = summaryText();
        const set = (key, value) => { const el = card.querySelector(`[data-pipe-summary="${key}"]`); if (el) el.textContent = value; };
        const count = (key, value) => { const el = card.querySelector(`[data-pipe-count="${key}"]`); if (el) el.textContent = countLabel(value); };
        set('hires', summarizeHires(SETTINGS, text));
        set('refiner', summarizeRefiner(SETTINGS, text));
        const ad = readADetailer();
        set('adetailer', summarizeADetailer(ad, text));
        const cn = readControlNet();
        set('controlnet', summarizeControlNet(cn, text));
        const lora = readLora();
        set('lora', summarizeLoRA(lora, text));
        count('lora', lora.length);
        const json = readJson();
        set('json', json.length ? `${json.length} ${uiText('ui_sum_files', 'files')}` : summarizeJson([], text));
        count('json', json.length);
        card.querySelector('[data-pipe="hires"]')?.classList.toggle('is-off', !SETTINGS.api_hf_enable);
        card.querySelector('[data-pipe="refiner"]')?.classList.toggle('is-off', !SETTINGS.api_refiner_enable);
        card.querySelector('[data-pipe="adetailer"]')?.classList.toggle('is-off', !SETTINGS.api_adetailer_enable);
        card.querySelector('[data-pipe="controlnet"]')?.classList.toggle('is-off', !SETTINGS.api_controlnet_enable);
        syncExpanded();
    }

    const debounced = debounce(refresh, 120);
    card.addEventListener('change', debounced);
    card.addEventListener('input', debounced);
    card.addEventListener('click', debounced);
    const timer = setInterval(() => { if (!document.hidden) refresh(); }, 2000);
    refresh();
    return { refresh, destroy: () => clearInterval(timer) };
}

// ------------------------------------------------------------------ characters & views
// myViewsList renders two unlabeled dropdowns; add a label row above them (Angle / Camera).
function setupCharactersCard() {
    const view = document.querySelector('.characters-card .dropdown-view');
    if (!view) return null;
    let labels = view.querySelector('.view-labels');
    function render() {
        const LANG = lang();
        const names = [LANG.view_angle || 'Angle', LANG.view_camera || 'Camera'];
        if (!labels) {
            labels = document.createElement('div');
            labels.className = 'view-labels';
            view.prepend(labels);
        }
        labels.replaceChildren(...names.map(name => {
            const span = document.createElement('span');
            span.textContent = name;
            return span;
        }));
    }
    render();
    // setOptions() rebuilds the dropdown markup; keep the label row on top.
    const observer = new MutationObserver(() => { if (!view.contains(labels)) render(); else if (view.firstElementChild !== labels) view.prepend(labels); });
    observer.observe(view, { childList: true });
    return { render };
}

// ------------------------------------------------------------------ AI card
function setupAiCard() {
    const card = document.getElementById('ai-card');
    const segment = document.getElementById('ai-mode-segment');
    const status = document.getElementById('ai-card-status');
    const note = document.getElementById('ai-card-note');
    if (!card || !segment) return null;
    let lastInterface = globalThis.globalSettings?.ai_interface && globalThis.globalSettings.ai_interface !== 'None' ? globalThis.globalSettings.ai_interface : 'Local';

    const buttons = new Map();
    for (const mode of AI_MODES) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'ai-mode-button';
        button.dataset.mode = mode;
        button.setAttribute('role', 'radio');
        button.addEventListener('click', () => setMode(mode));
        segment.append(button);
        buttons.set(mode, button);
    }

    function labels() {
        return { off: uiText('ui_ai_mode_off', 'Off'), expand: uiText('ui_ai_mode_expand', 'Expand'), refine: uiText('ui_ai_mode_refine', 'Refine') };
    }

    function render() {
        const SETTINGS = globalThis.globalSettings ?? {};
        const mode = deriveAiMode(SETTINGS);
        const text = labels();
        for (const [key, button] of buttons) {
            button.textContent = text[key];
            const on = key === mode;
            button.classList.toggle('is-on', on);
            button.setAttribute('aria-checked', String(on));
        }
        card.classList.toggle('is-off', mode === 'off');
        card.dataset.mode = mode;
        if (status) status.textContent = describeAiStatus(SETTINGS, { text: { off: text.off, local: uiText('ui_ai_local', 'Local'), remote: uiText('ui_ai_remote', 'Remote'), pod: uiText('ui_ai_pod', 'Pod'), lastRun: uiText('ui_ai_last_run', 'last run') } });
        if (note) {
            note.textContent = mode === 'refine' ? uiText('ui_ai_note_refine', 'Refine rewrites the whole prompt with one Ollama call per batch before the first image.')
                : mode === 'expand' ? uiText('ui_ai_note_expand', 'Expand inserts AI tags at the marker (or the end) before each batch.')
                    : uiText('ui_ai_note_off', 'AI is off. Prompts are sent as written.');
        }
    }

    function setMode(mode) {
        const SETTINGS = globalThis.globalSettings;
        if (!SETTINGS) return;
        if (SETTINGS.ai_interface && SETTINGS.ai_interface !== 'None') lastInterface = SETTINGS.ai_interface;
        const patch = applyAiMode(mode, SETTINGS, lastInterface);
        Object.assign(SETTINGS, patch);
        try {
            if (patch.ai_interface !== undefined) globalThis.ai?.interface?.updateDefaults?.(patch.ai_interface);
            if (patch.ai_local_prompt_mode !== undefined) globalThis.ai?.local_prompt_mode?.updateDefaults?.(patch.ai_local_prompt_mode);
            if (patch.ai_prompt_role !== undefined) globalThis.ai?.ai_select?.setValue?.(patch.ai_prompt_role);
        } catch (error) {
            console.warn(CAT, 'AI mode sync failed:', error);
        }
        render();
        globalThis.uiShell?.settingsConditions?.();
    }

    card.addEventListener('change', () => requestAnimationFrame(render));
    card.addEventListener('click', event => { if (!event.target.closest('.ai-mode-button')) requestAnimationFrame(render); });
    render();
    return { render, setMode };
}

// ------------------------------------------------------------------ run bar
function setupRunBar() {
    const bar = document.getElementById('run-bar');
    if (!bar) return null;

    const randomButton = document.getElementById('seed-random-button');
    const reuseButton = document.getElementById('seed-reuse-button');
    if (randomButton) {
        randomButton.innerHTML = ICONS.dice;
        randomButton.addEventListener('click', () => globalThis.generate?.seed?.setValue?.(-1));
    }
    if (reuseButton) {
        reuseButton.innerHTML = ICONS.lock;
        reuseButton.addEventListener('click', () => {
            const last = globalThis.generate?.lastSeed;
            if (Number.isFinite(last) && last >= 0) globalThis.generate.seed.setValue(last);
        });
    }

    // Remember the seed of the latest gallery image for the reuse button.
    const gallery = globalThis.mainGallery;
    if (gallery && typeof gallery.appendImageData === 'function' && !gallery.__uiShellWrapped) {
        const original = gallery.appendImageData;
        gallery.appendImageData = function (base64, seed, ...rest) {
            const parsed = Number(seed);
            if (Number.isFinite(parsed)) globalThis.generate.lastSeed = parsed;
            const result = original.call(this, base64, seed, ...rest);
            globalThis.uiShell?.refreshViewerStatus?.();
            return result;
        };
        gallery.__uiShellWrapped = true;
    }

    // Batch menu: wraps the existing Batch (Random) / Batch (Last) buttons.
    const menuButton = document.getElementById('generate-batch-menu-button');
    const menuList = document.getElementById('generate-batch-menu-list');
    const expandItem = document.getElementById('generate-batch-expand');
    const closeMenu = () => { if (menuList) menuList.hidden = true; menuButton?.setAttribute('aria-expanded', 'false'); };
    if (menuButton && menuList) {
        menuButton.addEventListener('click', event => {
            event.stopPropagation();
            const open = menuList.hidden;
            menuList.hidden = !open;
            menuButton.setAttribute('aria-expanded', String(open));
        });
        menuList.addEventListener('click', event => {
            if (event.target.closest('button')) setTimeout(closeMenu, 0);
        });
        document.addEventListener('click', event => { if (!event.target.closest('#generate-batch-menu')) closeMenu(); });
        document.addEventListener('keydown', event => { if (event.key === 'Escape') closeMenu(); });
    }
    expandItem?.addEventListener('click', () => {
        const field = globalThis.prompt?.tagCapsuleFields?.get?.('positive');
        if (!field) return;
        const button = field.element?.querySelector?.('.tag-capsule-batch');
        if (button && button.getClientRects().length) {
            button.click();
        } else {
            field.setMode?.('capsule', { focus: true });
        }
    });

    // Queue drawer
    const queueStatus = document.getElementById('queue-status');
    const drawer = document.getElementById('queue-drawer');
    queueStatus?.addEventListener('click', () => {
        if (!drawer) return;
        drawer.hidden = !drawer.hidden;
        queueStatus.setAttribute('aria-expanded', String(!drawer.hidden));
    });

    const footnote = document.getElementById('run-footnote');
    footnote?.addEventListener('click', () => {
        globalThis.headerIcon?.settings?.setPage?.('prompt-editing');
        globalThis.headerIcon?.settings?.open?.();
    });

    function refresh() {
        const SETTINGS = globalThis.globalSettings ?? {};
        if (menuButton) {
            menuButton.innerHTML = '';
            menuButton.append(document.createTextNode(uiText('ui_run_batch_menu', 'Batch')));
            const chevron = document.createElement('span');
            chevron.innerHTML = ICONS.chevD;
            menuButton.append(chevron);
        }
        if (expandItem) {
            expandItem.innerHTML = '';
            const icon = document.createElement('span');
            icon.innerHTML = ICONS.layers;
            expandItem.append(icon, document.createTextNode(uiText('ui_run_expand_weights', 'Expand weights per image…')));
        }
        if (queueStatus) {
            const count = globalThis.queueManager?.getSlotsCount?.() ?? 0;
            const auto = SETTINGS.generate_auto_start ? uiText('ui_run_autostart_on', 'auto-start on') : uiText('ui_run_autostart_off', 'auto-start off');
            queueStatus.innerHTML = '';
            const icon = document.createElement('span');
            icon.innerHTML = ICONS.layers;
            queueStatus.append(icon, document.createTextNode(`${uiText('ui_run_queue', 'Queue')} ${count} · ${auto}`));
            queueStatus.classList.toggle('is-paused', !SETTINGS.generate_auto_start);
        }
        if (footnote) {
            const on = uiText('ui_on', 'on');
            const off = uiText('ui_off', 'off');
            footnote.textContent = `${uiText('ui_run_tag_assist', 'Tag assist')} ${SETTINGS.tag_assist ? on : off} · ${uiText('ui_run_wildcard', 'Wildcard seed')} ${SETTINGS.wildcard_random ? on : off} ↗ ${uiText('system_settings', 'Settings')}`;
        }
    }
    const timer = setInterval(() => { if (!document.hidden) refresh(); }, 1000);
    bar.addEventListener('click', () => requestAnimationFrame(refresh));
    refresh();
    return { refresh, destroy: () => clearInterval(timer) };
}

// ------------------------------------------------------------------ left panel
function setupLeftPanel() {
    const panel = document.getElementById('info-panel');
    const splitter = document.getElementById('left-splitter');
    const left = document.getElementById('left');
    if (!panel || !left) return null;

    const tabs = [...panel.querySelectorAll('.info-tab')];
    const panels = [...panel.querySelectorAll('.info-panel')];
    let active = 'info';
    function setTab(name) {
        if (!panels.some(p => p.dataset.infoPanel === name)) return;
        active = name;
        for (const tab of tabs) {
            const on = tab.dataset.infoTab === name;
            tab.classList.toggle('is-active', on);
            tab.setAttribute('aria-selected', String(on));
            if (on) tab.classList.remove('has-new');
        }
        for (const p of panels) p.hidden = p.dataset.infoPanel !== name;
        try { localStorage.setItem('saa.infoTab', name); } catch { /* ignore */ }
    }
    for (const tab of tabs) tab.addEventListener('click', () => setTab(tab.dataset.infoTab));
    let initial = 'info';
    try { initial = localStorage.getItem('saa.infoTab') || 'info'; } catch { /* ignore */ }
    setTab(initial);

    const aiText = panel.querySelector('.ai-result-text');
    const aiPanel = panel.querySelector('[data-info-panel="ai"]');
    let pendingRunId = '';
    function showAiResult(text, { focus = false } = {}) {
        if (aiText) aiText.textContent = String(text ?? '');
        const tab = tabs.find(t => t.dataset.infoTab === 'ai');
        if (focus) setTab('ai');
        else if (active !== 'ai') tab?.classList.add('has-new');
    }

    function showRefinePending({ runId, text, status = 'Pending editor update', canApply = true, onApply, onDiscard, focus = false } = {}) {
        if (!aiPanel || !runId) return;
        pendingRunId = runId;
        aiPanel.querySelector('.ai-refine-pending')?.remove();
        const container = document.createElement('section');
        container.className = 'ai-refine-pending';
        container.dataset.runId = runId;
        container.setAttribute('aria-label', 'AI Refine editor update');

        const statusNode = document.createElement('div');
        statusNode.className = 'ai-refine-status';
        statusNode.setAttribute('role', 'status');
        statusNode.setAttribute('aria-live', 'polite');
        statusNode.textContent = String(status);
        const summary = document.createElement('pre');
        summary.className = 'ai-refine-summary';
        summary.textContent = String(text ?? '');
        container.append(statusNode, summary);

        if (canApply) {
            const actions = document.createElement('div');
            actions.className = 'ai-refine-actions';
            const apply = document.createElement('button');
            apply.type = 'button';
            apply.textContent = 'Apply to prompt';
            apply.setAttribute('aria-label', 'Apply AI Refine result to prompt fields');
            const discard = document.createElement('button');
            discard.type = 'button';
            discard.textContent = 'Discard';
            discard.setAttribute('aria-label', 'Discard AI Refine result');
            apply.addEventListener('click', async () => {
                if (pendingRunId !== runId) return;
                apply.disabled = true;
                discard.disabled = true;
                statusNode.textContent = 'Applying…';
                const result = await onApply?.();
                if (result?.status === 'applied') {
                    statusNode.textContent = result.discardedPlans > 0
                        ? `Applied · ${result.discardedPlans} incompatible Weight Plan(s) removed`
                        : 'Applied to prompt';
                    actions.remove();
                } else {
                    statusNode.textContent = result?.status === 'conflict'
                        ? 'Not applied: prompt changed after this run started'
                        : `Not applied: ${result?.error ?? result?.status ?? 'unknown error'}`;
                    apply.disabled = false;
                    discard.disabled = false;
                }
            });
            discard.addEventListener('click', () => {
                if (pendingRunId !== runId) return;
                pendingRunId = '';
                container.remove();
                onDiscard?.();
            });
            actions.append(apply, discard);
            container.append(actions);
        }
        aiPanel.append(container);
        const tab = tabs.find(item => item.dataset.infoTab === 'ai');
        if (focus) setTab('ai');
        else if (active !== 'ai') tab?.classList.add('has-new');
    }

    // Resizable: drag the splitter, or ArrowUp / ArrowDown when it has focus.
    const MIN = 120;
    const setHeight = px => {
        const max = Math.max(MIN, Math.floor(left.clientHeight * 0.65));
        const height = Math.max(MIN, Math.min(max, Math.round(px)));
        left.style.setProperty('--info-height', `${height}px`);
        try { localStorage.setItem('saa.infoHeight', String(height)); } catch { /* ignore */ }
    };
    let stored = null;
    try { stored = Number(localStorage.getItem('saa.infoHeight')); } catch { /* ignore */ }
    setHeight(Number.isFinite(stored) && stored > 0 ? stored : 200);
    if (splitter) {
        let dragging = false;
        let startY = 0;
        let startHeight = 0;
        splitter.addEventListener('pointerdown', event => {
            dragging = true;
            startY = event.clientY;
            startHeight = panel.getBoundingClientRect().height;
            splitter.setPointerCapture(event.pointerId);
            splitter.classList.add('is-dragging');
        });
        splitter.addEventListener('pointermove', event => {
            if (!dragging) return;
            setHeight(startHeight - (event.clientY - startY));
        });
        const end = () => { dragging = false; splitter.classList.remove('is-dragging'); };
        splitter.addEventListener('pointerup', end);
        splitter.addEventListener('pointercancel', end);
        splitter.addEventListener('keydown', event => {
            if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
            event.preventDefault();
            const current = panel.getBoundingClientRect().height;
            setHeight(current + (event.key === 'ArrowUp' ? 24 : -24));
        });
        splitter.addEventListener('dblclick', () => setHeight(200));
    }

    const status = document.getElementById('viewer-status');
    function refreshViewerStatus() {
        if (!status) return;
        // The gallery keeps its arrays private; count the rendered images instead.
        const rendered = document.querySelectorAll('.gallery-main-main .cg-gallery-image, .gallery-main-main .cg-preview-image');
        const count = rendered.length;
        if (count === 0) { status.textContent = ''; return; }
        const last = globalThis.generate?.lastSeed;
        status.textContent = `${count} ${uiText(count === 1 ? 'ui_viewer_image' : 'ui_viewer_images', count === 1 ? 'image' : 'images')}${Number.isFinite(last) && last >= 0 ? ` · seed ${last}` : ''}`;
    }
    refreshViewerStatus();

    return { setTab, showAiResult, showRefinePending, refreshViewerStatus, setHeight };
}

// ------------------------------------------------------------------ preview mirror
function setupPreviewMirror() {
    const container = document.querySelector('.gallery-main-container');
    if (!container) return null;
    const img = document.createElement('img');
    img.className = 'viewer-preview';
    img.alt = '';
    img.hidden = true;
    container.append(img);
    return {
        setPreview(base64) {
            if (!base64) { img.hidden = true; return; }
            img.src = base64;
            img.hidden = false;
        },
        clear() { img.hidden = true; img.removeAttribute('src'); },
    };
}

// ------------------------------------------------------------------ entry
export function setupUiShell() {
    const shell = {};
    shell.updateLanguage = () => {
        applyUiText(document);
        // Short placeholders for the two fields whose LANG titles are long explanations.
        const LANG = lang();
        for (const [key, langKey] of [['exclude', 'ui_field_exclude_placeholder'], ['ai', 'ui_field_ai_placeholder']]) {
            const textarea = document.querySelector(`.prompt-${key} textarea`);
            if (textarea && typeof LANG[langKey] === 'string' && LANG[langKey]) textarea.placeholder = LANG[langKey];
        }
        // The queue drawer switch is "Auto-start"; language.js still applies the legacy "Enable Generate" title first.
        if (typeof LANG.ui_run_autostart === 'string' && LANG.ui_run_autostart) globalThis.generate?.queueAutostart?.setTitle?.(LANG.ui_run_autostart);
        shell.characters?.render?.();
        shell.pipeline?.refresh?.();
        shell.aiCard?.render?.();
        shell.runBar?.refresh?.();
        shell.progress?.updateLanguage?.({
            generating: uiText('overlay_title', 'Now generating...'),
            errorTitle: uiText('ui_run_error_title', 'Backend error'),
            errorHint: uiText('ui_run_error_hint', 'Queue paused · press Create Image to retry'),
            details: uiText('ui_run_error_details', 'Details'),
        });
        shell.pills?.updateLanguage?.({ noAnswer: uiText('ui_status_no_answer', 'no answer'), comfyOff: uiText('ui_status_comfy_off', 'ComfyUI not set') });
    };

    shell.characters = setupCharactersCard();
    shell.pipeline = setupPipelineRows();
    shell.aiCard = setupAiCard();
    shell.runBar = setupRunBar();
    shell.leftPanel = setupLeftPanel();
    shell.preview = setupPreviewMirror();
    shell.progress = setupRunProgress({ root: document.getElementById('run-progress') });

    // Preview image follows the progress state: hide it when the run ends.
    const previewObserver = new MutationObserver(() => {
        if (!document.getElementById('cg-loading-overlay')) shell.preview?.clear();
    });
    previewObserver.observe(document.body, { childList: true });

    const pillHost = document.getElementById('header-status');
    if (pillHost && typeof globalThis.api?.getBackendStatus === 'function') {
        shell.pills = setupStatusPills({
            container: pillHost,
            getStatus: () => globalThis.api.getBackendStatus(),
            isBusy: () => Boolean(globalThis.inGenerating),
            onClick: id => {
                globalThis.headerIcon?.settings?.setPage?.(id === 'ollama' ? 'ai' : 'backend');
                globalThis.headerIcon?.settings?.open?.();
            },
        });
    }

    shell.setPreview = base64 => shell.preview?.setPreview(base64);
    shell.refreshViewerStatus = () => shell.leftPanel?.refreshViewerStatus?.();
    shell.settingsConditions = () => globalThis.headerIcon?.settings?.applyConditions?.();

    // A preset was applied to a section (settingsPersistence.js): redraw everything derived from globalSettings.
    shell.refreshFromSettings = () => {
        shell.pipeline?.refresh?.();
        shell.aiCard?.render?.();
        shell.runBar?.refresh?.();
        shell.settingsConditions();
    };
    document.addEventListener('saa-settings-applied', () => requestAnimationFrame(shell.refreshFromSettings));

    globalThis.uiShell = shell;
    globalThis.infoPanel = {
        setTab: name => shell.leftPanel?.setTab?.(name),
        showAiResult: (text, options) => shell.leftPanel?.showAiResult?.(text, options),
        showRefinePending: options => shell.leftPanel?.showRefinePending?.(options),
    };
    shell.updateLanguage();
    return shell;
}
