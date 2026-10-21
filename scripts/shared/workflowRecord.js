// Graph reachability is provenance, not proof that a node ran (custom/lazy nodes
// may choose inputs internally). Execution evidence is recorded separately.
const REQUEST_KEYS = ['model', 'vpred', 'unet', 'positive', 'negative', 'positive_left', 'positive_right',
    'negative_left', 'negative_right', 'width', 'height', 'cfg', 'step', 'seed', 'sampler', 'scheduler',
    'hifix', 'refiner', 'adetailer', 'vae', 'regional'];

export function requestedSettings(input = {}) {
    return structuredClone(Object.fromEntries(REQUEST_KEYS.filter(key => input[key] !== undefined).map(key => [key, input[key]])));
}

export function ancestors(workflow, start) {
    const visited = new Set();
    function visit(id) {
        id = String(id);
        if (visited.has(id) || !workflow[id]) return;
        visited.add(id);
        for (const value of Object.values(workflow[id].inputs ?? {})) {
            if (Array.isArray(value) && value.length === 2 && typeof value[1] === 'number') visit(value[0]);
        }
    }
    visit(start);
    return [...visited];
}

export function describeWorkflow(workflow, outputNode = '29') {
    const path = new Set(ancestors(workflow, outputNode));
    const nodes = {};
    for (const [id, node] of Object.entries(workflow)) {
        const sources = {};
        for (const key of ['model', 'clip', 'vae', 'positive', 'negative', 'basic_pipe']) {
            if (Array.isArray(node.inputs?.[key])) sources[key] = ancestors(workflow, node.inputs[key][0]);
        }
        nodes[id] = { classType: node.class_type, inputs: structuredClone(node.inputs), sources,
            onOutputPath: path.has(id), state: path.has(id)?'unknown':'not-on-selected-output-path' };
    }
    return { outputNode, graphInterpretation: 'static-dependencies; custom node internal selection is unknown', nodes };
}

export function withStagePreviews(input, outputNode = '29') {
    const workflow = structuredClone(input);
    const stages = [];
    // Only outputs whose IMAGE slot is known, and which the selected output already
    // depends on. No extra decoder/sampler is introduced for an unused branch.
    const imageNodes = new Set(['VAEDecode', 'VAEDecodeTiled', 'FaceDetailer', 'MaskDetailerPipe', 'ImageColorTransferMira']);
    for (const id of ancestors(input, outputNode).reverse()) {
        if (!imageNodes.has(input[id].class_type)) continue;
        const output = `saa_preview_${id}`;
        workflow[output] = { class_type: 'PreviewImage', inputs: { images: [id, 0] } };
        stages.push({ node: output, source: id, label: `${input[id].class_type} #${id}` });
    }
    return { workflow, stages };
}
