// Union ControlNet models (xinsir controlnet-union-sdxl, ProMax, …) bundle
// every control kind in one file and need to be told which one an input is.
// ComfyUI does that with a SetUnionControlNetType node between the loader and
// Apply ControlNet; a plain (single purpose) model ignores the type.
//
// A slot carries `controlType`: one of UNION_CONTROL_TYPES or 'auto'. 'auto'
// derives the type from the pre-processor when the post model looks like a
// union model, and leaves a plain model alone.

export const UNION_CONTROL_TYPES = Object.freeze([
    'openpose',
    'depth',
    'hed/pidi/scribble/ted',
    'canny/lineart/anime_lineart/mlsd',
    'normal',
    'segment',
    'tile',
    'repaint',
]);

export const CONTROL_TYPE_AUTO = 'auto';
export const CONTROL_TYPE_OPTIONS = Object.freeze([CONTROL_TYPE_AUTO, ...UNION_CONTROL_TYPES]);

// Pre-processor name (comfyui_controlnet_aux AIO names and the WebUI module
// names) -> union control type. Order matters: the first matching rule wins.
const PREPROCESSOR_RULES = [
    [/openpose|dwpre|dw_openpose|animalpose|animal_openpose|densepose|facemesh|mediapipe_face/i, 'openpose'],
    [/normal/i, 'normal'],
    [/depth|zoe|leres|midas|meshgraphormer|metric3d/i, 'depth'],
    [/semseg|oneformer|uniformer|sampreprocessor|mobile_sam|seg_/i, 'segment'],
    [/tile|ttplanet|blur/i, 'tile'],
    [/hed|pidi|scribble|teed|fakescribble|softedge/i, 'hed/pidi/scribble/ted'],
    [/canny|lineart|anyline|manga2anime|mlsd|m-lsd|binary/i, 'canny/lineart/anime_lineart/mlsd'],
    [/inpaint|repaint/i, 'repaint'],
];

export function controlTypeFromPreprocessor(preprocessor) {
    const name = String(preprocessor ?? '').trim();
    if (!name || name.toLowerCase() === 'none') return null;
    for (const [pattern, type] of PREPROCESSOR_RULES) {
        if (pattern.test(name)) return type;
    }
    return null;
}

export function isUnionControlNet(modelName) {
    return /union|promax/i.test(String(modelName ?? ''));
}

export function normalizeControlType(value) {
    const type = String(value ?? '').trim().toLowerCase();
    return UNION_CONTROL_TYPES.includes(type) ? type : CONTROL_TYPE_AUTO;
}

// The type to hand to SetUnionControlNetType, or null when no node is needed:
// an explicit type is always applied; 'auto' applies only to a union model,
// using the pre-processor's kind (falling back to ComfyUI's own 'auto').
export function resolveUnionControlType({ preModel, postModel, controlType } = {}) {
    const explicit = normalizeControlType(controlType);
    if (explicit !== CONTROL_TYPE_AUTO) return explicit;
    if (!isUnionControlNet(postModel)) return null;
    return controlTypeFromPreprocessor(preModel) ?? CONTROL_TYPE_AUTO;
}
