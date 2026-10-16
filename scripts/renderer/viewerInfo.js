// The Info tab of the viewer: how long the image on show took and where the time went,
// and what it was made with (scripts/shared/imageSummary.js). It follows the gallery's
// selection (VIEWER_SELECT_EVENT). A picture of this session carries its record; one
// from elsewhere is read for the records saved in it (saa_recipe, saa_time, parameters).
// The prompts themselves are the Prompt tab's.

import { VIEWER_SELECT_EVENT } from './customGallery.js';
import { showInFolder } from './libraryClient.js';
import { sendWebSocketMessage } from '../webserver/front/wsRequest.js';
import { summarizeImage } from '../shared/imageSummary.js';
import { formatDuration } from '../shared/runTiming.js';

export const SEGMENT_COLORS = Object.freeze({
    ai: '#c084fc',
    prose: '#d66aa8',
    prepare: '#8b93a1',
    queue: '#6b7280',
    load: '#a3a3ad',
    base: '#4da3ff',
    refiner: '#38bdf8',
    hires: '#35c47a',
    detailer: '#ffb454',
    finish: '#7c8594',
    backend: '#4da3ff',
    transfer: '#5a6069',
});

const SEGMENT_TEXT = Object.freeze({
    ai: ['viewer_time_ai', 'AI prompt'],
    prose: ['viewer_time_prose', 'Prose'],
    prepare: ['viewer_time_prepare', 'Getting ready'],
    queue: ['viewer_time_queue', 'Queue wait'],
    load: ['viewer_time_load', 'Loading'],
    base: ['viewer_time_base', 'Base pass'],
    refiner: ['viewer_time_refiner', 'Refiner'],
    hires: ['viewer_time_hires', 'Hires fix'],
    detailer: ['viewer_time_detailer', 'Detailer'],
    finish: ['viewer_time_finish', 'Decode · save'],
    backend: ['viewer_time_backend', 'Generation'],
    transfer: ['viewer_time_transfer', 'Transfer'],
});

function lang() {
    const settings = globalThis.globalSettings ?? {};
    return globalThis.cachedFiles?.language?.[settings.language] ?? {};
}

function text(key, fallback) {
    const value = lang()[key];
    return typeof value === 'string' && value ? value : fallback;
}

function element(tag, className, content) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (content !== undefined && content !== null) node.textContent = String(content);
    return node;
}

function number(value) {
    return Number.isFinite(value) ? String(Math.round(value * 100) / 100) : '—';
}

/** The legend name of a segment: "Prose (Student)" when the distilled writer wrote it. */
export function segmentLabel(id, { writer = '' } = {}) {
    const [key, fallback] = SEGMENT_TEXT[id] ?? ['', id];
    const label = text(key, fallback);
    return id === 'prose' && writer === 'student' ? `${label} (Student)` : label;
}

function timeSection(summary, writer) {
    const section = element('section', 'viewer-time');
    section.setAttribute('aria-label', text('viewer_generation_time', 'Generation time'));
    section.append(element('span', 'viewer-info-label', text('viewer_generation_time', 'Generation time')));
    const time = summary.time;
    section.append(element('span', 'viewer-time-total', time ? formatDuration(time.total) : '—'));
    // a step that took no time worth reading (under 0.05 s) stays out of the legend
    const segments = (time?.segments ?? []).filter(segment => segment.ms >= 50);
    if (segments.length > 0) {
        const total = segments.reduce((sum, segment) => sum + segment.ms, 0) || 1;
        const bar = element('span', 'viewer-time-bar');
        bar.setAttribute('aria-hidden', 'true');
        const legend = element('div', 'viewer-time-legend');
        for (const segment of segments) {
            const color = SEGMENT_COLORS[segment.id] ?? '#7c8594';
            const piece = element('span', 'viewer-time-piece');
            piece.style.width = `${(segment.ms / total) * 100}%`;
            piece.style.background = color;
            bar.append(piece);
            const row = element('div', 'viewer-time-row');
            row.dataset.segment = segment.id;
            const dot = element('span', 'viewer-time-dot');
            dot.style.background = color;
            row.append(dot, element('span', 'viewer-time-name', segmentLabel(segment.id, { writer })), element('span', 'viewer-time-sec', formatDuration(segment.ms)));
            legend.append(row);
        }
        section.append(bar, legend);
    }
    if (summary.fast) section.append(element('span', 'viewer-time-note', `Fast · ${summary.fast.lora} ${number(summary.fast.strength)}`));
    return section;
}

function row(list, label, value) {
    list.append(element('dt', '', label));
    const dd = element('dd', '');
    if (value && typeof value === 'object') dd.append(value);
    else dd.textContent = value;
    list.append(dd);
    return dd;
}

function sizeText(summary) {
    const parts = [];
    if (Number.isFinite(summary.width) && Number.isFinite(summary.height)) parts.push(`${summary.width} × ${summary.height}`);
    if (summary.state === 'full') {
        parts.push(summary.hires ? `Hires ${number(summary.hires.scale)}×` : text('viewer_hires_off', 'Hires off'));
        if (summary.detailers.length > 0) parts.push(`${text('viewer_time_detailer', 'Detailer')} ${summary.detailers.join(', ')}`);
    }
    return parts.join(' · ') || '—';
}

function recipeSection(summary) {
    const section = element('section', 'viewer-recipe');
    const list = element('dl', 'viewer-recipe-list');
    if (summary.path) {
        const file = element('span', 'viewer-recipe-file');
        const name = element('span', 'viewer-recipe-path', summary.path);
        name.title = summary.path;
        const reveal = element('button', 'viewer-link-button', text('viewer_show_in_folder', 'Show in folder'));
        reveal.type = 'button';
        reveal.addEventListener('click', () => showInFolder(summary.path));
        file.append(name);
        if (!globalThis.inBrowser) file.append(reveal);
        row(list, text('viewer_file', 'File'), file);
    }
    if (summary.model) row(list, text('viewer_model', 'Model'), summary.type ? `${summary.model} · ${summary.type}` : summary.model);
    if (summary.sampler) row(list, text('viewer_sampler', 'Sampler'), [summary.sampler, summary.scheduler].filter(Boolean).join(' · '));
    if (Number.isFinite(summary.steps) || Number.isFinite(summary.cfg)) {
        const steps = element('span', 'viewer-recipe-steps');
        steps.append(document.createTextNode(`${number(summary.steps)} · ${number(summary.cfg)}`));
        if (summary.fast) steps.append(element('span', 'viewer-badge viewer-badge-fast', 'Fast'));
        if (summary.asked) steps.append(element('span', 'viewer-recipe-asked', `${text('viewer_you_set', 'you set')} ${number(summary.asked.steps)} · ${number(summary.asked.cfg)}`));
        row(list, text('viewer_steps_cfg', 'Steps · CFG'), steps);
    }
    if (Number.isFinite(summary.seed)) {
        const seed = element('span', 'viewer-recipe-seed');
        const put = element('button', 'viewer-seed-button');
        put.type = 'button';
        const label = text('viewer_seed_to_field', 'Put this seed in the Seed field');
        put.setAttribute('aria-label', label);
        put.title = label;
        put.innerHTML = '<svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M7 2.5h3v7H7M1.5 6h6M5 3.5L7.5 6 5 8.5"></path></svg>';
        put.addEventListener('click', () => globalThis.generate?.seed?.setValue?.(summary.seed));
        seed.append(put, document.createTextNode(String(summary.seed)));
        row(list, text('viewer_seed', 'Seed'), seed);
    }
    row(list, text('viewer_size', 'Size'), sizeText(summary));
    if (summary.loras.length > 0) {
        const chips = element('span', 'viewer-lora-chips');
        for (const lora of summary.loras) {
            const chip = element('span', 'viewer-lora-chip', lora.name);
            chip.title = lora.file;
            chip.append(element('span', 'viewer-lora-weight', lora.fast ? `${number(lora.weight)} · Fast` : number(lora.weight)));
            chips.append(chip);
        }
        row(list, 'LoRA', chips);
    }
    section.append(list);
    const actions = element('div', 'viewer-recipe-actions');
    section.append(actions);
    return section;
}

function renderBadge(badge, summary) {
    if (!badge) return;
    badge.hidden = summary.state === 'none';
    badge.className = `viewer-recipe-badge is-${summary.state}`;
    badge.textContent = summary.state === 'full' ? `● SAA recipe v${summary.version}` : text('viewer_partial_recipe', 'partial recipe');
}

/**
 * Draws `summary` into the Info panel; `extras` (Use settings… etc.) go under the recipe.
 * Returns the actions box for the caller's buttons.
 */
export function renderViewerInfo(panel, summary, { badge = null, writer = '' } = {}) {
    panel.replaceChildren();
    if (!summary) {
        if (badge) badge.hidden = true;
        return null;
    }
    renderBadge(badge, summary);
    const grid = element('div', 'viewer-info-grid');
    const recipe = recipeSection(summary);
    grid.append(timeSection(summary, writer), recipe);
    panel.append(grid);
    return recipe.querySelector('.viewer-recipe-actions');
}

async function readImageRecords(dataUrl) {
    if (!dataUrl?.startsWith?.('data:image/')) return null;
    const result = globalThis.inBrowser
        ? await sendWebSocketMessage({ type: 'API', method: 'readBase64Image', params: [dataUrl] })
        : await globalThis.api?.readBase64Image?.(dataUrl);
    return result?.metadata ?? null;
}

// action builders the later parts of the viewer add (Use settings…): (actions, entry, summary) => void
const actionBuilders = [];

/** Adds a button maker for the actions under the recipe. */
export function addViewerInfoAction(builder) {
    if (typeof builder === 'function') actionBuilders.push(builder);
}

export function setupViewerInfo() {
    const panel = document.querySelector('.viewer-info');
    const badge = document.getElementById('viewer-recipe-badge');
    if (!panel) return null;
    let token = 0;
    let shown = null;

    async function show(entry) {
        const mine = ++token;
        shown = entry;
        if (!entry) {
            panel.replaceChildren();
            if (badge) badge.hidden = true;
            return;
        }
        let summary;
        const record = entry.record;
        if (record?.recipe || record?.timing) {
            summary = summarizeImage({ recipe: record.recipe, timing: record.timing, path: record.path, seed: entry.seed });
        } else {
            summary = summarizeImage({ seed: entry.seed });
            const metadata = await readImageRecords(entry.image).catch(() => null);
            if (mine !== token) return;   // the selection moved on
            summary = summarizeImage({ recipe: metadata?.saa_recipe, timing: metadata?.saa_time, parameters: metadata?.parameters ?? metadata?.data ?? '', path: record?.path ?? '', seed: entry.seed });
        }
        const writer = record?.recipe?.run?.prose?.writer ?? '';
        const actions = renderViewerInfo(panel, summary, { badge, writer });
        for (const build of actionBuilders) {
            try { build(actions, entry, summary); } catch (error) { console.error('[ViewerInfo] action failed:', error); }
        }
    }

    document.addEventListener(VIEWER_SELECT_EVENT, event => { show(event.detail ?? null); });
    const api = {
        show,
        refresh: () => show(shown),
        current: () => shown,
    };
    globalThis.viewerInfo = api;
    show(globalThis.mainGallery?.currentEntry?.() ?? null);
    return api;
}
