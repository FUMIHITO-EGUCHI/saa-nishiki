// ComfyUI /object_info -> model name lists (issue #8). Pure helpers shared by the
// main process (scripts/main/remoteModelList.js) and tests.
//
// Each loader node's first widget is a combo whose options are the file names
// ComfyUI can see. Two encodings exist side by side (ComfyUI 0.26 mixes them):
//   classic : { <field>: [[names], { tooltip }] }
//   v3 combo: { <field>: ["COMBO", { options: [names], multiselect }] }

export const REMOTE_MODEL_NODES = Object.freeze({
    checkpoints: { node: 'CheckpointLoaderSimple', field: 'ckpt_name' },
    loras: { node: 'LoraLoader', field: 'lora_name' },
    vae: { node: 'VAELoader', field: 'vae_name' },
    upscalers: { node: 'UpscaleModelLoader', field: 'model_name' },
    controlnet: { node: 'ControlNetLoader', field: 'control_net_name' },
    diffusion: { node: 'UNETLoader', field: 'unet_name' },
    textEncoders: { node: 'CLIPLoader', field: 'clip_name' },
});

export const REMOTE_MODEL_NODE_NAMES = Object.freeze(Object.values(REMOTE_MODEL_NODES).map(entry => entry.node));

// The combo options of one input field, or null when the node / field is absent.
export function comboOptions(nodeInfo, node, field) {
    const inputs = nodeInfo?.[node]?.input;
    if (!inputs) return null;
    for (const group of ['required', 'optional']) {
        const spec = inputs[group]?.[field];
        if (!Array.isArray(spec)) continue;
        if (Array.isArray(spec[0])) return spec[0].map(name => String(name)).filter(Boolean);
        if (spec[0] === 'COMBO' && Array.isArray(spec[1]?.options)) return spec[1].options.map(name => String(name)).filter(Boolean);
    }
    return null;
}

// { checkpoints: [...] | null, loras: [...] | null, ... } from a map of
// node name -> /object_info/<node> payload (null entries are skipped).
export function extractModelLists(infoByNode) {
    const lists = {};
    for (const [key, { node, field }] of Object.entries(REMOTE_MODEL_NODES)) {
        const payload = infoByNode?.[node];
        lists[key] = payload ? comboOptions(payload, node, field) : null;
    }
    return lists;
}

// Same filter rule as the local checkpoint scan (comma separated substrings, '*' = all).
export function applyModelFilter(names, keyword, enabled) {
    if (!Array.isArray(names)) return [];
    if (!enabled || !keyword || keyword === '*') return [...names];
    const filters = String(keyword).split(',').map(part => part.trim().toLowerCase()).filter(Boolean);
    if (filters.length === 0) return [...names];
    return names.filter(name => filters.some(filter => name.toLowerCase().includes(filter)));
}

export function countLists(lists) {
    const counts = {};
    for (const [key, value] of Object.entries(lists ?? {})) {
        if (Array.isArray(value)) counts[key] = value.length;
    }
    return counts;
}
