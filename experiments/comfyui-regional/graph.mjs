// The two graphs, as data. build.mjs writes them to disk, sweep.mjs queues many
// variants of them. See README.md for what A and B are and why.

export const DEFAULT_SETTINGS = {
    model: 'waiIllustriousSDXL_v170.safetensors',
    width: 1216,
    height: 832,
    steps: 28,
    cfg: 5.0,
    // NOT euler_ancestral: an ancestral sampler re-injects noise every step and
    // RegionalSampler's per-step latent restore never removes it, so branch B comes
    // back as pure noise. Any non-ancestral sampler works (euler, dpmpp_2m, ...).
    sampler: 'euler',
    scheduler: 'normal',
    seed: 12345,
    // "<first>,<overlap>,<second>" - SAA sends image_ratio/50, overlap/100, 2-(image_ratio/50).
    // The full syntax is "[blocks per column]@weights;weights", so a 2x2 grid is possible too.
    layout: '1,0.2,1',
    // true cuts vertically (the left/right split SAA hardcodes), false cuts horizontally.
    // With false the "left" prompt is the TOP region and "right" the bottom one.
    columFirst: true,
    maskStrength: 1.0,      // branch A: ConditioningSetMask strength (SAA's Left/Right Str)
    // Per-side overrides. A uniform maskStrength is a no-op: ConditioningCombine
    // normalises the overlapping conditionings, so scaling both sides by the same
    // factor leaves their ratio - and the picture - unchanged (measured: 0.0 mean
    // pixel difference between 1.0 and 0.5). Only a DIFFERENCE between the sides
    // moves anything, which is what these two are for.
    maskStrengthLeft: null,
    maskStrengthRight: null,
    baseOnlySteps: 8,       // branch B: steps before any region is applied
    overlapFactor: 32,      // branch B: mask dilation that blends the region seams
    additionalMode: 'ratio between',
    additionalSampler: 'AUTO',
    prefixA: 'regional/A_current',
    prefixB: 'regional/B_sampler',
    prefixPose: 'regional/pose',
    // Set `image` (a filename already in ComfyUI's input folder) to drive both branches
    // with an OpenPose skeleton. Prompt tags cannot say which girl is the one acting;
    // a skeleton can, because the pose itself carries the direction.
    controlNet: null, // { image, model, strength, startPercent, endPercent, resolution, applyToRegions }
};

export const DEFAULT_PROMPT = {
    base: 'masterpiece, best quality, amazing quality, 2girls, hug from behind, standing, indoors, window light, looking at viewer',
    left: '1girl, long blonde hair, blue eyes, white blouse, blush',
    right: '1girl, short black hair, red eyes, black jacket, smile',
    negative: 'bad quality, worst quality, worst detail, sketch, censor, jpeg artifacts, signature, watermark',
    negativeLeft: '',
    negativeRight: '',
};

// col / row only place the node on the canvas. `to` is {input: [nodeId, outputSlot]}.
export function nodesFor(S, P) {
    const nodes = baseNodes(S, P);
    const cn = S.controlNet;
    if (!cn?.image) return nodes;

    // The skeleton is applied to the conditioning both branches sample from: branch A's
    // combined pair, and branch B's base pipe. Region pipes stay unconstrained unless
    // applyToRegions is set - the pose is a property of the whole picture, not of a half.
    nodes.push(
        { id: 37, type: 'ControlNetLoader', title: 'OpenPose model', branch: '', col: 3, row: 7, widgets: { control_net_name: cn.model } },
        { id: 38, type: 'LoadImage', title: 'Pose source', branch: '', col: 3, row: 8, widgets: { image: cn.image } },
        { id: 39, type: 'AIO_Preprocessor', title: 'OpenPose', branch: '', col: 4, row: 8, widgets: { preprocessor: 'OpenposePreprocessor', resolution: cn.resolution }, to: { image: [38, 0] } },
        { id: 40, type: 'SaveImage', title: 'the skeleton', branch: '', col: 5, row: 8, widgets: { filename_prefix: S.prefixPose }, to: { images: [39, 0] } },
        { id: 41, type: 'ControlNetApplyAdvanced', title: 'A: pose', branch: 'A', col: 5, row: 2, widgets: { strength: cn.strength, start_percent: cn.startPercent, end_percent: cn.endPercent }, to: { positive: [18, 0], negative: [21, 0], control_net: [37, 0], image: [39, 0] } },
        { id: 42, type: 'ControlNetApplyAdvanced', title: 'B: pose (base)', branch: 'B', col: 3, row: 4, widgets: { strength: cn.strength, start_percent: cn.startPercent, end_percent: cn.endPercent }, to: { positive: [2, 0], negative: [5, 0], control_net: [37, 0], image: [39, 0] } },
    );

    const at = id => nodes.find(node => node.id === id);
    at(22).to.positive = [41, 0];
    at(22).to.negative = [41, 1];
    at(25).to.positive = [42, 0];
    at(25).to.negative = [42, 1];
    if (cn.applyToRegions) {
        nodes.push(
            { id: 43, type: 'ControlNetApplyAdvanced', title: 'B: pose (left)', branch: 'B', col: 3, row: 5, widgets: { strength: cn.strength, start_percent: cn.startPercent, end_percent: cn.endPercent }, to: { positive: [8, 0], negative: [10, 0], control_net: [37, 0], image: [39, 0] } },
            { id: 44, type: 'ControlNetApplyAdvanced', title: 'B: pose (right)', branch: 'B', col: 3, row: 6, widgets: { strength: cn.strength, start_percent: cn.startPercent, end_percent: cn.endPercent }, to: { positive: [9, 0], negative: [11, 0], control_net: [37, 0], image: [39, 0] } },
        );
        at(27).to.positive = [43, 0];
        at(27).to.negative = [43, 1];
        at(30).to.positive = [44, 0];
        at(30).to.negative = [44, 1];
    }
    return nodes;
}

function baseNodes(S, P) {
    return [
        { id: 1, type: 'CheckpointLoaderSimple', title: 'Checkpoint', col: 0, row: 0, widgets: { ckpt_name: S.model } },

        { id: 2, type: 'CLIPTextEncode', title: 'Base (both sides)', col: 1, row: 0, widgets: { text: P.base }, to: { clip: [1, 1] } },
        { id: 3, type: 'CLIPTextEncode', title: 'Left', col: 1, row: 1, widgets: { text: P.left }, to: { clip: [1, 1] } },
        { id: 4, type: 'CLIPTextEncode', title: 'Right', col: 1, row: 2, widgets: { text: P.right }, to: { clip: [1, 1] } },
        { id: 5, type: 'CLIPTextEncode', title: 'Negative (both sides)', col: 1, row: 3, widgets: { text: P.negative }, to: { clip: [1, 1] } },
        { id: 6, type: 'CLIPTextEncode', title: 'Negative (left)', col: 1, row: 4, widgets: { text: P.negativeLeft }, to: { clip: [1, 1] } },
        { id: 7, type: 'CLIPTextEncode', title: 'Negative (right)', col: 1, row: 5, widgets: { text: P.negativeRight }, to: { clip: [1, 1] } },

        // Base is prepended to each side so both branches read one Base node
        { id: 8, type: 'ConditioningConcat', title: 'Base + Left', col: 2, row: 0, to: { conditioning_to: [2, 0], conditioning_from: [3, 0] } },
        { id: 9, type: 'ConditioningConcat', title: 'Base + Right', col: 2, row: 1, to: { conditioning_to: [2, 0], conditioning_from: [4, 0] } },
        { id: 10, type: 'ConditioningConcat', title: 'Negative + left', col: 2, row: 2, to: { conditioning_to: [5, 0], conditioning_from: [6, 0] } },
        { id: 11, type: 'ConditioningConcat', title: 'Negative + right', col: 2, row: 3, to: { conditioning_to: [5, 0], conditioning_from: [7, 0] } },

        { id: 12, type: 'EmptyLatentImage', title: 'Latent (shared)', col: 2, row: 4, widgets: { width: S.width, height: S.height, batch_size: 1 } },

        // the same mask pair SAA builds: column 0 + the overlap column, column 2 + the overlap column
        { id: 13, type: 'CreateTillingPNGMask', title: 'Regional layout', col: 2, row: 5, widgets: { Width: S.width, Height: S.height, Colum_first: S.columFirst, Rows: 1, Colums: 1, Layout: S.layout } },
        { id: 14, type: 'PngRectanglesToMask', title: 'Mask left', col: 3, row: 5, widgets: { Intenisity: 1, Blur: 0, Start_At_Index: 0, Overlap: 'Next', Overlap_Count: 1 }, to: { PngRectangles: [13, 2] } },
        { id: 15, type: 'PngRectanglesToMask', title: 'Mask right', col: 3, row: 6, widgets: { Intenisity: 1, Blur: 0, Start_At_Index: 2, Overlap: 'Previous', Overlap_Count: 1 }, to: { PngRectangles: [13, 2] } },

        // ---- A: current SAA method ---------------------------------------------
        { id: 16, type: 'ConditioningSetMask', title: 'A: left masked', col: 4, row: 0, widgets: { strength: S.maskStrengthLeft ?? S.maskStrength, set_cond_area: 'default' }, to: { conditioning: [8, 0], mask: [14, 0] } },
        { id: 17, type: 'ConditioningSetMask', title: 'A: right masked', col: 4, row: 1, widgets: { strength: S.maskStrengthRight ?? S.maskStrength, set_cond_area: 'default' }, to: { conditioning: [9, 0], mask: [15, 0] } },
        { id: 18, type: 'ConditioningCombine', title: 'A: positive', col: 5, row: 0, to: { conditioning_1: [16, 0], conditioning_2: [17, 0] } },
        { id: 19, type: 'ConditioningSetMask', title: 'A: neg left masked', col: 4, row: 2, widgets: { strength: S.maskStrengthLeft ?? S.maskStrength, set_cond_area: 'default' }, to: { conditioning: [10, 0], mask: [14, 0] } },
        { id: 20, type: 'ConditioningSetMask', title: 'A: neg right masked', col: 4, row: 3, widgets: { strength: S.maskStrengthRight ?? S.maskStrength, set_cond_area: 'default' }, to: { conditioning: [11, 0], mask: [15, 0] } },
        { id: 21, type: 'ConditioningCombine', title: 'A: negative', col: 5, row: 1, to: { conditioning_1: [19, 0], conditioning_2: [20, 0] } },
        { id: 22, type: 'KSampler', title: 'A: sampler', col: 6, row: 0, widgets: { seed: S.seed, steps: S.steps, cfg: S.cfg, sampler_name: S.sampler, scheduler: S.scheduler, denoise: 1 }, to: { model: [1, 0], positive: [18, 0], negative: [21, 0], latent_image: [12, 0] } },
        { id: 23, type: 'VAEDecode', title: 'A: decode', col: 7, row: 0, to: { samples: [22, 0], vae: [1, 2] } },
        { id: 24, type: 'SaveImage', title: 'A: current (SetMask + Combine)', col: 8, row: 0, widgets: { filename_prefix: S.prefixA }, to: { images: [23, 0] } },

        // ---- B: Impact Pack RegionalSampler -------------------------------------
        { id: 25, type: 'ToBasicPipe', title: 'B: base pipe', col: 4, row: 4, to: { model: [1, 0], clip: [1, 1], vae: [1, 2], positive: [2, 0], negative: [5, 0] } },
        { id: 26, type: 'KSamplerAdvancedProvider', title: 'B: base sampler', col: 5, row: 4, widgets: { cfg: S.cfg, sampler_name: S.sampler, scheduler: S.scheduler, sigma_factor: 1 }, to: { basic_pipe: [25, 0] } },

        { id: 27, type: 'ToBasicPipe', title: 'B: left pipe', col: 4, row: 5, to: { model: [1, 0], clip: [1, 1], vae: [1, 2], positive: [8, 0], negative: [10, 0] } },
        { id: 28, type: 'KSamplerAdvancedProvider', title: 'B: left sampler', col: 5, row: 5, widgets: { cfg: S.cfg, sampler_name: S.sampler, scheduler: S.scheduler, sigma_factor: 1 }, to: { basic_pipe: [27, 0] } },
        { id: 29, type: 'RegionalPrompt', title: 'B: left region', col: 6, row: 5, to: { mask: [14, 0], advanced_sampler: [28, 0] } },

        { id: 30, type: 'ToBasicPipe', title: 'B: right pipe', col: 4, row: 6, to: { model: [1, 0], clip: [1, 1], vae: [1, 2], positive: [9, 0], negative: [11, 0] } },
        { id: 31, type: 'KSamplerAdvancedProvider', title: 'B: right sampler', col: 5, row: 6, widgets: { cfg: S.cfg, sampler_name: S.sampler, scheduler: S.scheduler, sigma_factor: 1 }, to: { basic_pipe: [30, 0] } },
        { id: 32, type: 'RegionalPrompt', title: 'B: right region', col: 6, row: 6, to: { mask: [15, 0], advanced_sampler: [31, 0] } },

        { id: 33, type: 'CombineRegionalPrompts', title: 'B: regions', col: 7, row: 5, to: { regional_prompts1: [29, 0], regional_prompts2: [32, 0] } },
        {
            id: 34, type: 'RegionalSampler', title: 'B: regional sampler', col: 8, row: 4,
            widgets: {
                seed: S.seed, seed_2nd: 0, seed_2nd_mode: 'ignore',
                steps: S.steps, base_only_steps: S.baseOnlySteps, denoise: 1,
                overlap_factor: S.overlapFactor, restore_latent: true,
                additional_mode: S.additionalMode, additional_sampler: S.additionalSampler, additional_sigma_ratio: 0.3,
            },
            to: { samples: [12, 0], base_sampler: [26, 0], regional_prompts: [33, 0] },
        },
        { id: 35, type: 'VAEDecode', title: 'B: decode', col: 9, row: 4, to: { samples: [34, 0], vae: [1, 2] } },
        { id: 36, type: 'SaveImage', title: 'B: RegionalSampler', col: 10, row: 4, widgets: { filename_prefix: S.prefixB }, to: { images: [35, 0] } },
    ];
}

const branchOf = node => node.branch ?? (node.id >= 16 && node.id <= 24 ? 'A' : node.id >= 25 ? 'B' : '');

export async function fetchSpecs(host) {
    const response = await fetch(`${host.replace(/\/$/, '')}/object_info`);
    if (!response.ok) throw new Error(`${host} answered ${response.status} for /object_info`);
    return response.json();
}

// CombineRegionalPrompts declares only regional_prompts1: the frontend adds
// regional_prompts2.. as they are connected and the backend takes them by name.
function dynamicInput(type, name) {
    if (type === 'CombineRegionalPrompts' && /^regional_prompts\d+$/.test(name)) return ['REGIONAL_PROMPTS'];
    return null;
}

function specOf(specs, type) {
    const spec = specs[type];
    if (!spec) throw new Error(`${type} is not installed on this ComfyUI`);
    return spec;
}

// Declared input order, required first - the order widgets_values must follow.
function inputOrder(spec) {
    const order = spec.input_order;
    if (order) return [...(order.required ?? []), ...(order.optional ?? [])];
    return [...Object.keys(spec.input?.required ?? {}), ...Object.keys(spec.input?.optional ?? {})];
}

function inputSpec(spec, name) {
    return spec.input?.required?.[name] ?? spec.input?.optional?.[name];
}

// A widget is any declared input whose type is not a link type (an array of choices is
// a COMBO widget; a bare uppercase name like MODEL or MASK is a connection).
function isWidget(entry) {
    const type = entry?.[0];
    if (Array.isArray(type)) return true;
    return ['INT', 'FLOAT', 'STRING', 'BOOLEAN', 'COMBO'].includes(type);
}

function widgetValue(specs, node, name) {
    if (Object.hasOwn(node.widgets ?? {}, name)) return node.widgets[name];
    const entry = inputSpec(specOf(specs, node.type), name);
    if (Array.isArray(entry[0])) return entry[1]?.default ?? entry[0][0];
    if (Object.hasOwn(entry[1] ?? {}, 'default')) return entry[1].default;
    throw new Error(`${node.type}#${node.id} needs a value for "${name}"`);
}

export function selectNodes({ settings = {}, prompt = {}, only = '' } = {}) {
    const S = { ...DEFAULT_SETTINGS, ...settings };
    const P = { ...DEFAULT_PROMPT, ...prompt };
    const wanted = String(only).toUpperCase();
    const nodes = nodesFor(S, P);
    if (wanted !== 'A' && wanted !== 'B') return nodes;
    return nodes.filter(node => {
        const branch = branchOf(node);
        return !branch || branch === wanted;
    });
}

export function validate(specs, nodes) {
    const byId = new Map(nodes.map(node => [node.id, node]));
    for (const node of nodes) {
        const spec = specOf(specs, node.type);
        for (const [name, [fromId, slot]] of Object.entries(node.to ?? {})) {
            const want = inputSpec(spec, name) ?? dynamicInput(node.type, name);
            if (!want) throw new Error(`${node.type}#${node.id} has no input "${name}"`);
            const source = byId.get(fromId);
            if (!source) throw new Error(`${node.type}#${node.id}.${name} points at missing node ${fromId}`);
            const got = specOf(specs, source.type).output[slot];
            // COMBO inputs accept anything the graph feeds them; link types must match
            if (!Array.isArray(want[0]) && want[0] !== got && want[0] !== '*') {
                throw new Error(`${node.type}#${node.id}.${name} wants ${want[0]} but ${source.type}#${fromId}[${slot}] gives ${got}`);
            }
        }
        for (const name of Object.keys(node.widgets ?? {})) {
            if (!inputSpec(spec, name)) throw new Error(`${node.type}#${node.id} has no widget "${name}"`);
        }
    }
    return nodes;
}

export function buildApi(specs, nodes) {
    const prompt = {};
    for (const node of nodes) {
        const spec = specOf(specs, node.type);
        const inputs = {};
        for (const name of inputOrder(spec)) {
            const entry = inputSpec(spec, name);
            if (Object.hasOwn(node.to ?? {}, name)) {
                const [fromId, slot] = node.to[name];
                inputs[name] = [String(fromId), slot];
            } else if (isWidget(entry) || Object.hasOwn(node.widgets ?? {}, name)) {
                if (!Object.hasOwn(node.widgets ?? {}, name) && !entry[1]) continue;
                inputs[name] = widgetValue(specs, node, name);
            }
        }
        // dynamic inputs the node declares at runtime (CombineRegionalPrompts)
        for (const [name, [fromId, slot]] of Object.entries(node.to ?? {})) {
            if (!Object.hasOwn(inputs, name)) inputs[name] = [String(fromId), slot];
        }
        prompt[String(node.id)] = { class_type: node.type, inputs, _meta: { title: node.title ?? node.type } };
    }
    return prompt;
}

const COL_WIDTH = 400;
const ROW_HEIGHT = 210;

export function buildWorkflow(specs, nodes) {
    let nextLink = 1;
    const links = [];

    const laid = nodes.map((node, index) => {
        const spec = specOf(specs, node.type);
        const declared = inputOrder(spec);
        const connections = [];
        const widgets = [];

        for (const name of declared) {
            const entry = inputSpec(spec, name);
            if (Object.hasOwn(node.to ?? {}, name)) {
                connections.push({ name, type: Array.isArray(entry[0]) ? 'COMBO' : entry[0], link: null });
            } else if (isWidget(entry)) {
                widgets.push(widgetValue(specs, node, name));
                // seed-like widgets carry a control_after_generate widget right behind them
                if (entry[1]?.control_after_generate) widgets.push('fixed');
            }
        }
        for (const name of Object.keys(node.to ?? {})) {
            if (declared.includes(name)) continue;
            connections.push({ name, type: dynamicInput(node.type, name)?.[0] ?? '*', link: null });
        }
        // the frontend draws an upload button behind LoadImage's file widget
        if (node.type === 'LoadImage' && widgets.length === 1) widgets.push('image');

        const outputs = (spec.output ?? []).map((type, slot) => ({
            name: spec.output_name?.[slot] || type,
            type,
            slot_index: slot,
            links: [],
        }));

        return {
            id: node.id,
            type: node.type,
            pos: [node.col * COL_WIDTH, node.row * ROW_HEIGHT],
            size: [360, 120],
            flags: {},
            order: index,
            mode: 0,
            inputs: connections,
            outputs,
            properties: { 'Node name for S&R': node.type },
            widgets_values: widgets,
            title: node.title ?? node.type,
        };
    });

    const byId = new Map(laid.map(node => [node.id, node]));
    for (const node of nodes) {
        for (const [name, [fromId, slot]] of Object.entries(node.to ?? {})) {
            const target = byId.get(node.id);
            const source = byId.get(fromId);
            const input = target.inputs.find(entry => entry.name === name);
            const type = source.outputs[slot].type;
            const id = nextLink++;
            input.link = id;
            input.type = type;
            source.outputs[slot].links.push(id);
            links.push([id, fromId, slot, node.id, target.inputs.indexOf(input), type]);
        }
    }

    return {
        id: 'saa-regional-compare',
        revision: 0,
        last_node_id: Math.max(...nodes.map(node => node.id)),
        last_link_id: nextLink - 1,
        nodes: laid,
        links,
        groups: [
            { id: 1, title: 'A - current SAA method', bounding: [4 * COL_WIDTH - 20, -40, 5 * COL_WIDTH, 4 * ROW_HEIGHT], color: '#3f789e', font_size: 24, flags: {} },
            { id: 2, title: 'B - Impact Pack RegionalSampler', bounding: [4 * COL_WIDTH - 20, 4 * ROW_HEIGHT - 20, 7 * COL_WIDTH, 3.4 * ROW_HEIGHT], color: '#8A8', font_size: 24, flags: {} },
        ],
        config: {},
        extra: {},
        version: 0.4,
    };
}
