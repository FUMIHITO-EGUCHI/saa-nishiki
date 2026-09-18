// Anima: a 2B anime DiT whose text encoder is Qwen3-0.6B, not CLIP.
//
// NetaYume (Gemma-2-2B) turned the sentence prompts from 3/15 on WAI into 12/15. Anima is
// the language-model-encoder model SAA already ships a workflow for (WORKFLOW_UNET /
// WORKFLOW_REIONAL_UNET), so if it reads "A does X to B" as well as NetaYume does, the
// fix needs no new backend at all. Its encoder is a quarter of Gemma's size, which is the
// open question.
//
// The three parts load separately, exactly as SAA's workflow does: UNETLoader for the
// DiT, CLIPLoader (type stable_diffusion) for Qwen3, VAELoader for the Qwen-Image VAE.
// EmptyLatentImage is fine: ComfyUI widens an empty latent to the model's channel count.

export const ANIMA_DEFAULTS = {
    unet: 'anima-base-v1.0.safetensors',
    clip: 'qwen_3_06b_base.safetensors',
    vae: 'qwen_image_vae.safetensors',
    width: 1216,
    height: 832,
    // Anima's card: er_sde or euler_a, 30-50 steps, cfg 4-5
    steps: 30,
    cfg: 4.5,
    sampler: 'er_sde',
    scheduler: 'simple',
};

export function animaNodes(S, positive, negative, prefix) {
    const A = { ...ANIMA_DEFAULTS, ...S };
    return [
        { id: 1, type: 'UNETLoader', title: 'Anima DiT', col: 0, row: 0, widgets: { unet_name: A.unet, weight_dtype: 'default' } },
        { id: 2, type: 'CLIPLoader', title: 'Qwen3-0.6B', col: 0, row: 1, widgets: { clip_name: A.clip, type: 'stable_diffusion', device: 'default' } },
        { id: 3, type: 'VAELoader', title: 'Qwen-Image VAE', col: 0, row: 2, widgets: { vae_name: A.vae } },
        { id: 4, type: 'CLIPTextEncode', title: 'Positive', col: 1, row: 0, widgets: { text: positive }, to: { clip: [2, 0] } },
        { id: 5, type: 'CLIPTextEncode', title: 'Negative', col: 1, row: 1, widgets: { text: negative }, to: { clip: [2, 0] } },
        { id: 6, type: 'EmptyLatentImage', title: 'Latent', col: 1, row: 2, widgets: { width: A.width, height: A.height, batch_size: 1 } },
        { id: 7, type: 'KSampler', title: 'sampler', col: 2, row: 0, widgets: { seed: A.seed, steps: A.steps, cfg: A.cfg, sampler_name: A.sampler, scheduler: A.scheduler, denoise: 1 }, to: { model: [1, 0], positive: [4, 0], negative: [5, 0], latent_image: [6, 0] } },
        { id: 8, type: 'VAEDecode', title: 'decode', col: 3, row: 0, to: { samples: [7, 0], vae: [3, 0] } },
        { id: 9, type: 'SaveImage', title: 'result', col: 4, row: 0, widgets: { filename_prefix: prefix }, to: { images: [8, 0] } },
    ];
}
