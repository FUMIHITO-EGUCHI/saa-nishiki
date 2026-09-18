// NetaYume Lumina: an anime model whose text encoder is Gemma-2-2B, not CLIP.
//
// Every failure the bench recorded on the SDXL models - two spoons, both girls kneeling,
// an action that turns into a solo act, two descriptions fused into one body - is what a
// bag-of-words encoder does with "A does X to B": nothing binds the verb to either noun.
// A language model encoder reads the sentence as a sentence. If the diagnosis is right,
// the same prompts that scored 9/15 (hybrid) and 3/15 (prose) on WAI should score
// noticeably higher here; if they do not, the limit is somewhere other than the encoder.
//
// The all-in-one checkpoint carries the DiT, Gemma and the VAE, so CheckpointLoaderSimple
// loads it. Lumina2 conditioning goes through CLIPTextEncodeLumina2, which prepends one of
// two fixed system prompts; the latent is the 16-channel SD3 one.

export const LUMINA_DEFAULTS = {
    model: 'NetaYume_v4_all_in_one.safetensors',
    width: 1216,
    height: 832,
    // NetaYume's card: res_multistep + linear_quadratic, or euler_a + normal; 40-50 steps, cfg 4-7
    steps: 40,
    cfg: 5.5,
    sampler: 'res_multistep',
    scheduler: 'linear_quadratic',
    shift: 6.0,
    systemPrompt: 'superior',
};

export function luminaNodes(S, positive, negative, prefix) {
    const L = { ...LUMINA_DEFAULTS, ...S };
    return [
        { id: 1, type: 'CheckpointLoaderSimple', title: 'NetaYume (DiT + Gemma + VAE)', col: 0, row: 0, widgets: { ckpt_name: L.model } },
        { id: 2, type: 'ModelSamplingAuraFlow', title: 'shift', col: 1, row: 0, widgets: { shift: L.shift }, to: { model: [1, 0] } },
        { id: 3, type: 'CLIPTextEncodeLumina2', title: 'Positive', col: 1, row: 1, widgets: { system_prompt: L.systemPrompt, user_prompt: positive }, to: { clip: [1, 1] } },
        { id: 4, type: 'CLIPTextEncodeLumina2', title: 'Negative', col: 1, row: 2, widgets: { system_prompt: L.systemPrompt, user_prompt: negative }, to: { clip: [1, 1] } },
        { id: 5, type: 'EmptySD3LatentImage', title: 'Latent', col: 1, row: 3, widgets: { width: L.width, height: L.height, batch_size: 1 } },
        { id: 6, type: 'KSampler', title: 'sampler', col: 2, row: 0, widgets: { seed: L.seed, steps: L.steps, cfg: L.cfg, sampler_name: L.sampler, scheduler: L.scheduler, denoise: 1 }, to: { model: [2, 0], positive: [3, 0], negative: [4, 0], latent_image: [5, 0] } },
        { id: 7, type: 'VAEDecode', title: 'decode', col: 3, row: 0, to: { samples: [6, 0], vae: [1, 2] } },
        { id: 8, type: 'SaveImage', title: 'result', col: 4, row: 0, widgets: { filename_prefix: prefix }, to: { images: [7, 0] } },
    ];
}
