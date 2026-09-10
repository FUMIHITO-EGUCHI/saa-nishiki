// The same six cases in Pony Diffusion V6 XL's prompt dialect, so the two checkpoints
// can be compared on identical interactions, seeds and appearance tags.
//
// Pony ignores the usual danbooru quality words and expects its own score / source /
// rating prefix instead; without it the output is visibly worse, which would make any
// comparison meaningless. Everything after the prefix - the interaction tags, the two
// appearance descriptions - is left exactly as the Illustrious runs had it.

import { ANOTHERS_CASES, SINGLE_CASES } from './casesVocab.mjs';
import { NL_CASES, hybridPrompt, nlPrompt } from './casesNL.mjs';

const ILLUSTRIOUS_QUALITY = 'masterpiece, best quality, amazing quality';
export const PONY_QUALITY = 'score_9, score_8_up, score_7_up, source_anime, rating_safe';
export const PONY_NEGATIVE = 'score_6, score_5, score_4, source_pony, source_furry, '
    + 'worst quality, low quality, jpeg artifacts, signature, watermark';

const toPony = text => text.replace(ILLUSTRIOUS_QUALITY, PONY_QUALITY);

export const PONY_CASES = ANOTHERS_CASES.map(entry => ({
    ...entry,
    base: toPony(entry.base),
}));

export const PONY_SINGLE_CASES = SINGLE_CASES.map(entry => ({
    ...entry,
    prompt: toPony(entry.prompt),
}));

// The same sentence / hybrid prompts, with Pony's prefix swapped in. Pony's own text
// encoder is the same CLIP pair SDXL ships, so if a sentence binds an action to one of
// two characters here and not on Illustrious, the difference is the training data.
export const PONY_NL = NL_CASES.map(entry => ({ id: entry.id, prompt: toPony(nlPrompt(entry)) }));
export const PONY_HYBRID = NL_CASES.map(entry => ({ id: entry.id, prompt: toPony(hybridPrompt(entry)) }));
