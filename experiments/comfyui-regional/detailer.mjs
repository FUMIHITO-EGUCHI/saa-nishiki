// A per-face detailer pass, which is how multi-character pictures are actually made in
// production: the first pass decides the composition and the interaction, and the
// identity of each character is fixed afterwards, one detected face at a time.
//
// The piece that makes it work is `ImpactSEGSOrderedFilter` with target `x1`: it sorts
// the detected faces by their left edge, so "the leftmost face" is addressable and can
// be given its own prompt. `FaceDetailer` - which is what SAA's ComfyUI backend builds
// today (generate_backend_comfyui.js:439) - has no such thing and applies one prompt to
// every face it finds.
//
//   detector -> BboxDetectorSEGS -> OrderedFilter(x1)
//                                     |- filtered  -> DetailerForEach (left prompt)
//                                     `- remained  -> DetailerForEach (right prompt)

export const DETAILER_DEFAULTS = {
    detector: 'bbox/face_yolov8m.pt',
    threshold: 0.45,
    // the SEGS mask is the (dilated) bounding box, so dilation is what decides how much
    // hair around the face the detailer is allowed to repaint
    dilation: 40,
    cropFactor: 3.0,
    guideSize: 512,
    maxSize: 1024,
    steps: 20,
    cfg: 5.0,
    sampler: 'euler',
    scheduler: 'normal',
    // higher than a normal face fix: this pass has to change hair and eye colour, not
    // just sharpen what is already there
    denoise: 0.55,
    feather: 5,
};

export function detailerNodes({
    first = 100,
    image,          // [nodeId, slot] - the picture to detail
    model,          // [nodeId, slot]
    clip,           // [nodeId, slot]
    vae,            // [nodeId, slot]
    negative,       // [nodeId, slot] - conditioning
    left = '',
    right = '',
    seed = 0,
    prefix = 'regional/detailed',
    options = {},
} = {}) {
    const D = { ...DETAILER_DEFAULTS, ...options };
    const id = offset => first + offset;
    const sampling = {
        guide_size: D.guideSize, guide_size_for: true, max_size: D.maxSize,
        seed, steps: D.steps, cfg: D.cfg, sampler_name: D.sampler, scheduler: D.scheduler,
        denoise: D.denoise, feather: D.feather, noise_mask: true, force_inpaint: true,
        wildcard: '', cycle: 1,
    };

    return [
        { id: id(0), type: 'UltralyticsDetectorProvider', title: 'face detector', col: 9, row: 0, widgets: { model_name: D.detector } },
        {
            id: id(1), type: 'BboxDetectorSEGS', title: 'faces', col: 10, row: 0,
            widgets: { threshold: D.threshold, dilation: D.dilation, crop_factor: D.cropFactor, drop_size: 10, labels: 'all' },
            to: { bbox_detector: [id(0), 0], image },
        },
        {
            id: id(2), type: 'ImpactSEGSOrderedFilter', title: 'sort faces left to right', col: 11, row: 0,
            widgets: { target: 'x1', order: false, take_start: 0, take_count: 1 },
            to: { segs: [id(1), 0] },
        },
        { id: id(3), type: 'CLIPTextEncode', title: 'face: left', col: 11, row: 1, widgets: { text: left }, to: { clip } },
        { id: id(4), type: 'CLIPTextEncode', title: 'face: right', col: 11, row: 2, widgets: { text: right }, to: { clip } },
        {
            id: id(5), type: 'DetailerForEach', title: 'detail leftmost face', col: 12, row: 0,
            widgets: sampling,
            to: { image, segs: [id(2), 0], model, clip, vae, positive: [id(3), 0], negative },
        },
        {
            id: id(6), type: 'DetailerForEach', title: 'detail the rest', col: 13, row: 0,
            widgets: sampling,
            to: { image: [id(5), 0], segs: [id(2), 1], model, clip, vae, positive: [id(4), 0], negative },
        },
        { id: id(7), type: 'SaveImage', title: 'after per-face detail', col: 14, row: 0, widgets: { filename_prefix: prefix }, to: { images: [id(6), 0] } },
    ];
}

// A plain txt2img graph: one prompt, no regions. What SAA does when Regional is off.
export function singleNodes(S, positive, negative) {
    return [
        { id: 1, type: 'CheckpointLoaderSimple', title: 'Checkpoint', col: 0, row: 0, widgets: { ckpt_name: S.model } },
        { id: 2, type: 'CLIPTextEncode', title: 'Positive', col: 1, row: 0, widgets: { text: positive }, to: { clip: [1, 1] } },
        { id: 5, type: 'CLIPTextEncode', title: 'Negative', col: 1, row: 1, widgets: { text: negative }, to: { clip: [1, 1] } },
        { id: 12, type: 'EmptyLatentImage', title: 'Latent', col: 1, row: 2, widgets: { width: S.width, height: S.height, batch_size: 1 } },
        { id: 22, type: 'KSampler', title: 'sampler', col: 2, row: 0, widgets: { seed: S.seed, steps: S.steps, cfg: S.cfg, sampler_name: S.sampler, scheduler: S.scheduler, denoise: 1 }, to: { model: [1, 0], positive: [2, 0], negative: [5, 0], latent_image: [12, 0] } },
        { id: 23, type: 'VAEDecode', title: 'decode', col: 3, row: 0, to: { samples: [22, 0], vae: [1, 2] } },
        { id: 24, type: 'SaveImage', title: 'before detail', col: 4, row: 0, widgets: { filename_prefix: S.prefixA }, to: { images: [23, 0] } },
    ];
}
