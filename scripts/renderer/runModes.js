// The run bar's three modes and its Generate button (docs/sequence-batch-plan.md D32 / D34).
//
//   Single    one image
//   Batch     the run bar's count of images, each drawn anew
//   Sequence  the scene edit mode: one scene of the open sequence is on the screen (the
//             strip above Prompts, sequenceEdit.js). Generate splits in two there: Sample
//             makes one image of the scene on the screen, Run makes the whole sequence, its
//             scenes x the picked characters x the count (here the patterns per character
//             and scene, sequenceBatchUi.js holds them)
//
// Generate carries what it will make: "Generate (5)", "Run 12". A sequence that cannot
// start leaves Run off, and the reasons are its tooltip. The mode is kept (settings
// `run_mode`). Picking Sequence puts the scene touched last on the screen (the first scene
// when that one is gone, the dialog when the sequence has none); picking Single or Batch
// ends the edit mode and the screen gets its own settings back.
export const RUN_MODES = Object.freeze(['single', 'batch', 'sequence']);

export function normalizeRunMode(value) {
    return RUN_MODES.includes(value) ? value : 'single';
}

function lang() {
    const settings = globalThis.globalSettings ?? {};
    return globalThis.cachedFiles?.language?.[settings.language] ?? {};
}

function text(key, fallback) {
    const value = lang()[key];
    return typeof value === 'string' && value ? value : fallback;
}

function sequenceAvailable() {
    return !globalThis.inBrowser && Boolean(globalThis.sequenceBatch);
}

function editing() {
    return Boolean(globalThis.sequenceEdit?.isActive?.());
}

/** The mode the run bar is in: the kept mode, Single where there is no Sequence. */
export function currentRunMode() {
    const mode = normalizeRunMode(globalThis.globalSettings?.run_mode);
    if (mode === 'sequence' && !sequenceAvailable()) return 'single';
    return mode;
}

/**
 * What Generate says and whether it can run, for a mode and the counts it multiplies:
 * { label, count, blocked: [reason text], paused, run, sampleOff }. In Sequence the button
 * is two: `label` is Sample (one image of the scene on the screen; `sampleOff` without one)
 * and `run` is { label, count } for the whole sequence, which `blocked` keeps off.
 */
export function generateState({ mode, batch, sequenceTotal = 0, sequenceBlocked = [], paused = false, sceneOnScreen = true, labels = {} }) {
    const base = paused ? (labels.paused ?? 'Generate (Paused)') : (labels.run ?? 'Generate');
    if (mode === 'batch') {
        const count = Math.max(1, Math.floor(Number(batch) || 1));
        return { label: paused ? base : `${base} (${count})`, count, blocked: [], paused, run: null, sampleOff: false };
    }
    if (mode === 'sequence') {
        return {
            label: labels.sample ?? 'Sample', count: 1, blocked: [...sequenceBlocked], paused, sampleOff: !sceneOnScreen,
            run: { label: `${labels.sequence ?? 'Run'} ${sequenceTotal}`, count: sequenceTotal },
        };
    }
    return { label: base, count: 1, blocked: [], paused, run: null, sampleOff: false };
}

const COLORS = {
    run: ['var(--saa-run)', 'var(--saa-run-hover)', 'var(--saa-run-disabled)'],
    sample: ['var(--saa-run-sample)', 'var(--saa-run-sample-hover)', 'var(--saa-run-sample-disabled)'],
};

let ui = null;
let poll = null;
let chain = Promise.resolve();

// mode changes, the dialog closing and a scene picked in it run one after another: each
// puts settings on the screen, and two at once would leave the wrong ones there
function serial(task) {
    chain = chain.then(task).catch(error => console.error('[RunModes]', error));
    return chain;
}

function countValue(mode) {
    if (mode === 'sequence') return globalThis.sequenceBatch?.candidates?.() ?? 1;
    return Number(globalThis.globalSettings?.batch) || 1;
}

function dot(className) {
    const node = document.createElement('span');
    node.className = className;
    node.setAttribute('aria-hidden', 'true');
    return node;
}

function paintModeButton(button, name) {
    const label = text(`ui_run_mode_${name}`, name[0].toUpperCase() + name.slice(1));
    if (button.dataset.label === label) return;
    button.dataset.label = label;
    button.textContent = label;
}

function runDisabled() {
    return currentRunMode() !== 'sequence' || ui.blocked || !ui.generateClickable;
}

/** Repaint the mode switch, the count field and Generate. */
export function refreshRunModes() {
    if (!ui) return;
    const mode = currentRunMode();
    const canSequence = sequenceAvailable();
    for (const button of ui.modeButtons) {
        const name = button.dataset.mode;
        paintModeButton(button, name);
        button.setAttribute('aria-checked', String(name === mode));
        if (name === 'sequence') button.hidden = !canSequence;
    }

    // the count: images for Batch, patterns for Sequence, unused for Single
    const sequence = mode === 'sequence';
    if (ui.countLabel) {
        const key = sequence ? 'ui_run_pattern' : 'ui_run_batch';
        ui.countLabel.dataset.uiText = key;
        ui.countLabel.textContent = text(key, sequence ? 'Pattern' : 'Batch');
    }
    if (ui.countParam) ui.countParam.classList.toggle('is-idle', mode === 'single');
    const slider = globalThis.generate?.batch;
    const want = countValue(mode);
    if (slider && Number(slider.getValue()) !== Number(want)) {
        ui.syncing = true;
        try { slider.setValue(want); } finally { ui.syncing = false; }
    }

    const state = generateState({
        mode,
        batch: globalThis.globalSettings?.batch,
        sequenceTotal: sequence ? (globalThis.sequenceBatch?.total?.() ?? 0) : 0,
        sequenceBlocked: sequence ? (globalThis.sequenceBatch?.blockers?.() ?? []) : [],
        paused: globalThis.globalSettings?.generate_auto_start === false,
        sceneOnScreen: editing(),
        labels: {
            run: text('run_button', 'Generate'), paused: text('run_button_paused', 'Generate (Paused)'),
            sample: text('ui_run_sample', 'Sample'), sequence: text('ui_run_sequence_run', 'Run'),
        },
    });
    const generate = globalThis.generate?.generate_single;
    generate?.setTitle?.(state.label);
    const colors = sequence ? COLORS.sample : COLORS.run;
    if (ui.colors !== colors) {
        ui.colors = colors;
        generate?.setColors?.(...colors);
    }
    ui.sampleOff = state.sampleOff;
    ui.blocked = sequence && state.blocked.length > 0;
    applyClickable();

    ui.box?.classList.toggle('is-split', sequence);
    const run = ui.runButton;
    if (run) {
        run.hidden = !sequence;
        const label = state.run?.label ?? '';
        if (run.dataset.label !== label) {
            run.dataset.label = label;
            run.replaceChildren(dot('run-sequence-dot'), document.createTextNode(label));
        }
        run.title = state.blocked.join('\n');
    }
}

// Sample (the generate button) is off while a run is being queued, and in Sequence while
// no scene is on the screen; Run is off while a run is being queued and while the sequence
// cannot start. The generation code switches the button by itself (setClickable).
function applyClickable() {
    if (!ui) return;
    ui.setGenerateClickable?.(ui.generateClickable && !ui.sampleOff);
    if (ui.runButton) ui.runButton.disabled = runDisabled();
}

/** The count field moved: the batch size, or the patterns while Sequence is on. */
export function onCountChange(value) {
    if (ui?.syncing) return;
    if (currentRunMode() === 'sequence') globalThis.sequenceBatch?.setCandidates?.(value);
    else if (globalThis.globalSettings) globalThis.globalSettings.batch = value;
    refreshRunModes();
}

/**
 * Sequence mode and the edit mode go together: in Sequence a scene is on the screen (the
 * one touched last, else the first; with no scene the dialog opens), anywhere else none is.
 */
async function settle({ openEmpty = false } = {}) {
    const batch = globalThis.sequenceBatch;
    const edit = globalThis.sequenceEdit;
    if (!batch || !edit) return;
    if (currentRunMode() !== 'sequence') {
        if (edit.isActive()) await edit.exit();
        return;
    }
    if (edit.isActive() || batch.isOpen?.()) return;
    const scenes = batch.current().scenes;
    if (!scenes.length) {
        if (openEmpty) batch.open({ page: 'scenes', trigger: ui?.sequenceButton ?? null });
        return;
    }
    const last = batch.lastScene?.();
    const scene = scenes.find(entry => entry.id === last) ?? scenes[0];
    await edit.enter(scene.id);
}

function setMode(mode) {
    // a sequence run puts its scenes on the screen for a moment (generate.js): not now
    if (globalThis.sequenceRunApplying === true) return Promise.resolve();
    globalThis.globalSettings.run_mode = normalizeRunMode(mode);
    globalThis.settingsAutosave?.markDirty?.('app');
    refreshRunModes();
    return serial(async () => {
        await settle({ openEmpty: currentRunMode() === 'sequence' });
        refreshRunModes();
    });
}

/** Edit one scene (a tile of the dialog): Sequence mode with that scene on the screen. */
export function editScene(sceneId) {
    globalThis.sequenceBatch?.setLastScene?.(sceneId);
    if (globalThis.globalSettings && currentRunMode() !== 'sequence') {
        globalThis.globalSettings.run_mode = 'sequence';
        globalThis.settingsAutosave?.markDirty?.('app');
    }
    return serial(async () => {
        await globalThis.sequenceEdit?.enter?.(sceneId);
        refreshRunModes();
    });
}

/** The dialog closed or the app started: the screen follows the mode again. */
export function settleRunMode() {
    return serial(async () => {
        await settle();
        refreshRunModes();
    });
}

/** Sample has nothing to make: Sequence with no scene on the screen. */
export function sampleBlocked() {
    return currentRunMode() === 'sequence' && !editing();
}

async function runSequence() {
    if (!ui || runDisabled()) return;
    await globalThis.sequenceBatch?.run?.();
}

export function setupRunModes() {
    const modes = document.getElementById('run-modes');
    if (!modes) return;
    const countParam = document.querySelector('.run-param-batch');
    const generate = globalThis.generate?.generate_single;
    ui = {
        modeButtons: [...modes.querySelectorAll('.run-mode')],
        sequenceButton: modes.querySelector('.run-mode[data-mode="sequence"]'),
        runButton: document.getElementById('run-sequence-go'),
        box: document.getElementById('run-generate'),
        countParam,
        countLabel: countParam?.querySelector('.run-param-label') ?? null,
        blocked: false,
        sampleOff: false,
        generateClickable: true,
        colors: null,
        syncing: false,
        setGenerateClickable: null,
    };
    // the generation code turns the button off and on (setClickable): that is kept as the
    // run's own state, and the button shows it together with Sample's (applyClickable)
    if (generate?.setClickable) {
        generate.__ownSetClickable ??= generate.setClickable;
        ui.setGenerateClickable = generate.__ownSetClickable;
        generate.setClickable = value => {
            if (!ui) { generate.__ownSetClickable(value); return; }
            ui.generateClickable = Boolean(value);
            applyClickable();
        };
    }
    for (const button of ui.modeButtons) button.addEventListener('click', () => setMode(button.dataset.mode));
    modes.addEventListener('keydown', event => {
        if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
        const enabled = ui.modeButtons.filter(button => !button.hidden && !button.disabled);
        const at = enabled.findIndex(button => button.dataset.mode === currentRunMode());
        const next = enabled[(at + (event.key === 'ArrowRight' ? 1 : enabled.length - 1)) % enabled.length];
        if (!next) return;
        event.preventDefault();
        setMode(next.dataset.mode);
        next.focus();
    });
    ui.runButton?.addEventListener('click', () => { runSequence(); });
    globalThis.sequenceBatch?.onChange?.(() => refreshRunModes());
    globalThis.sequenceBatch?.onClose?.(() => settleRunMode());
    // what blocks a sequence (Regional, ControlNet, the backend…) changes elsewhere
    clearInterval(poll);
    poll = setInterval(() => { if (currentRunMode() === 'sequence') refreshRunModes(); }, 700);
    globalThis.runModes = {
        refresh: refreshRunModes, current: currentRunMode, isBlocked: () => Boolean(ui?.blocked),
        sampleBlocked, editScene, settle: settleRunMode, set: setMode,
    };
    // the app was closed in edit mode: that is Sequence (an edit mode from before D34 too)
    if (editing() && sequenceAvailable() && normalizeRunMode(globalThis.globalSettings?.run_mode) !== 'sequence') {
        globalThis.globalSettings.run_mode = 'sequence';
        globalThis.settingsAutosave?.markDirty?.('app');
    }
    refreshRunModes();
    settleRunMode();
}
