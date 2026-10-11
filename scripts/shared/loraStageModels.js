// Which model every sampling pass of a ComfyUI run takes from "LoRA Loader from Text"
// (ComfyUI_Mira LoRAfromText). Pure, no I/O.
//
// The node reads the <lora:…> tags of the positive prompt and applies them twice: once
// for the first pass (output 0, model / output 1, clip) and once for the hires pass
// (output 2 / 3, with the tag's hires strengths). Every pass that should carry the
// prompt's LoRAs — first pass, hires, ADetailer — samples from one of those outputs; a
// pass wired to the bare loader instead runs without them (the Anima hires pass and
// every ADetailer did, until 2026-10-10).
//
// The two outputs are separate ModelPatcher clones even when their strengths match.
// ComfyUI's dynamic VRAM keeps the weights on the GPU for one patch set at a time, so a
// run that samples from output 0, then output 2 (or the bare loader), drops them and
// reads the whole model file again: ~4 GB, ~40 s per switch from a hard disk (measured
// 2026-10-10). When no tag gives the hires pass other strengths, both outputs hold the
// same weights and every pass shares output 0 — one patch set for the whole run.
//
// The node also runs again whenever its text input changes, and every run makes new
// clones. Fed the whole prompt, it gave each new prompt a new patch set: the model and
// the text encoder read from disk again, ~6.3 GB / ~70 s per image for an SDXL
// checkpoint on a hard disk (measured 2026-10-12). So it is fed the <lora:…> tags only
// (splitLoraText), and the text encoders take the rest of the prompt: a run reuses the
// last run's clones as long as the tags stay the same.

export const LORA_FROM_TEXT_OUTPUT = Object.freeze({ model: 0, clip: 1, hiresModel: 2, hiresClip: 3, text: 4 });

const LORA_TAG = /<lora:[^>]*>/g;
// str.strip() in Python takes off what str.isspace() calls whitespace
const PY_STRIP = /^[\t\n\v\f\r \x1c-\x1f\x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+|[\t\n\v\f\r \x1c-\x1f\x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+$/g;

/**
 * The positive prompt split the way LoRAfromText splits it: `tags`, the <lora:…> tags
 * alone (what the node loads LoRAs from), and `plain`, the prompt without them (the
 * node's plain_text output, remove_brackets in Lora.py).
 */
export function splitLoraText(text) {
    const source = String(text ?? '');
    return {
        tags: (source.match(LORA_TAG) ?? []).join(''),
        plain: source.replace(LORA_TAG, '').replace(PY_STRIP, ''),
    };
}

// float() in Python takes more than this (inf, nan, 1_0); a tag with such a number is
// left to the node to read and counted as one whose strengths may differ
const PLAIN_NUMBER = /^\s*[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?\s*$/;

/**
 * The tags of `text` as ComfyUI_Mira Lora.py (extract_bracket_content / parse_content)
 * reads them: <lora:name>, <lora:name:m>, <lora:name:m:c>, <lora:name:m:c:hm:hc>.
 * Missing values are 1.0, except that two values (m:c) are reused for the hires pass.
 * A tag with an empty name is skipped like the node skips it; one with a number this
 * parser cannot read for sure comes back as { name, unknown: true }.
 */
export function parseLoraTags(text) {
    const tags = [];
    for (const [content] of String(text ?? '').matchAll(LORA_TAG)) {
        const parts = content.slice(6, -1).split(':');
        const name = parts[0];
        if (!name) continue;
        const raw = parts.slice(1);
        if (raw.some(value => !PLAIN_NUMBER.test(value))) {
            tags.push({ name, unknown: true });
            continue;
        }
        const numbers = raw.map(Number);
        let values = [1, 1, 1, 1];
        if (numbers.length === 2) {
            values = [numbers[0], numbers[1], numbers[0], numbers[1]];
        } else {
            numbers.slice(0, 4).forEach((value, i) => { values[i] = value; });
        }
        const [model, clip, hiresModel, hiresClip] = values;
        tags.push({ name, model, clip, hiresModel, hiresClip });
    }
    return tags;
}

/**
 * The LoRAfromText output the hires pass samples from: output 2 only when a tag gives the
 * hires pass other strengths than the first pass (a LoRA slot set to Base or HiFix, a
 * hand-typed <lora:x:0.8>, which the node applies at 1.0 for hires), else output 0.
 */
export function hiresModelOutput(text) {
    const differs = parseLoraTags(text).some(tag => tag.unknown
        || tag.model !== tag.hiresModel || tag.clip !== tag.hiresClip);
    return differs ? LORA_FROM_TEXT_OUTPUT.hiresModel : LORA_FROM_TEXT_OUTPUT.model;
}

/**
 * Model links of one run's passes, all from the LoRAfromText node `loraNode`:
 *   hires  — what the hires sampler takes
 *   last   — what the run ends on (the hires model, or the first-pass one without hires),
 *            the model ADetailer re-samples faces / hands from
 */
export function loraStageModels(loraNode, { text, hires = false } = {}) {
    const node = String(loraNode);
    const first = [node, LORA_FROM_TEXT_OUTPUT.model];
    const hiresLink = [node, hiresModelOutput(text)];
    return { first, hires: hiresLink, last: hires ? hiresLink : first };
}
