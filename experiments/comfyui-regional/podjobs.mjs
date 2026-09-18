// Builds every job of the three-experiment batch into one JSON file, ready to be shipped
// to the Pod and posted there. The Pod has no node, so the graph building happens here
// and only finished API-format prompts travel over SSH.
//
//   node podjobs.mjs --specs=./pod-object-info.json --out=./pod-jobs.json
//
// The three experiments:
//
//   vocab          branch A (what SAA does today) with the interaction written in real
//                  Danbooru tags in Base and appearance only on the sides.
//   split-detail   branch A with the previous best prompt layout (SPLIT_CASES), then a
//                  per-face detailer pass that repaints each face with its own prompt.
//   single-detail  no regions at all, one prompt, then the same detailer pass.
//
// Every graph saves the picture before the detailer as well as after it, so the pass can
// be judged on what it changed rather than on the final image alone.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { CASE_SETS, NEGATIVE } from './cases.mjs';
import { ANOTHERS_CASES, FACES, SINGLE_CASES } from './casesVocab.mjs';
import { DEFAULT_SETTINGS, buildApi, fetchSpecs, selectNodes, validate } from './graph.mjs';
import { detailerNodes, singleNodes } from './detailer.mjs';
import { PONY_CASES, PONY_HYBRID, PONY_NEGATIVE, PONY_NL, PONY_SINGLE_CASES } from './casesPony.mjs';
import { NL_CASES, hybridPrompt, nlPrompt } from './casesNL.mjs';
import { luminaNodes } from './lumina.mjs';
import { animaNodes } from './anima.mjs';

const arg = (name, fallback) => process.argv.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const num = (name, fallback) => Number(arg(name, fallback));

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SPECS_FILE = arg('specs', '');
const HOST = arg('host', 'http://127.0.0.1:8189').replace(/\/$/, '');
const OUT = arg('out', path.join(HERE, 'pod-jobs.json'));
const SEEDS = arg('seeds', '1,2,3').split(',').map(Number);
const WANTED = arg('exp', 'vocab,split-detail,single-detail').split(',').filter(Boolean);

const specs = SPECS_FILE ? JSON.parse(fs.readFileSync(SPECS_FILE, 'utf8')) : await fetchSpecs(HOST);

const settingsFor = seed => ({
    ...DEFAULT_SETTINGS,
    seed,
    steps: num('steps', DEFAULT_SETTINGS.steps),
    cfg: num('cfg', DEFAULT_SETTINGS.cfg),
    model: arg('model', DEFAULT_SETTINGS.model),
});

const detailFor = (entry, seed, prefix, { image, negative }) => detailerNodes({
    first: 100,
    image,
    model: [1, 0],
    clip: [1, 1],
    vae: [1, 2],
    negative,
    left: FACES[entry.id].left,
    right: FACES[entry.id].right,
    seed,
    prefix,
    options: { denoise: Number(arg('detail-denoise', 0.55)), dilation: num('detail-dilation', 40) },
});

const STRENGTHS = arg('strengths', '0.7,0.5,0.3').split(',').map(Number);
const ASYM = [['asymR', 0.4, 1.0], ['asymL', 1.0, 0.4]];
const PONY_MODEL = arg('pony-model', 'ponyDiffusionV6XL.safetensors');
const jobs = [];

for (const seed of SEEDS) {
    // ---- vocab: branch A, interaction in Base as real Danbooru tags ----------------
    if (WANTED.includes('vocab')) {
        for (const entry of ANOTHERS_CASES) {
            const S = { ...settingsFor(seed), prefixA: `pod/vocab/${entry.id}/s${seed}` };
            const nodes = selectNodes({
                settings: S,
                prompt: { base: entry.base, left: entry.left, right: entry.right, negative: NEGATIVE },
                only: 'A',
            });
            jobs.push({ name: `vocab/${entry.id}/s${seed}`, prompt: buildApi(specs, validate(specs, nodes)) });
        }
    }

    // ---- adj: an adjective the tag vocabulary never paired with this noun ------------
    // "long staff" and "ancient staff" are not Danbooru tags; "long" is bound to hair by
    // 6.2M posts and "ancient" to Egyptian / Greek costume. The character is fixed with
    // short hair and plain clothes so that an adjective leaking off the staff shows up as
    // longer hair or a changed outfit. wooden_staff (500 posts) is the in-vocabulary control.
    if (WANTED.includes('adj')) {
        const base = 'masterpiece, best quality, amazing quality, 1girl, solo, short black hair, '
            + 'red eyes, white shirt, black skirt, holding staff, standing, simple background, full body';
        const arms = [
            ['adjbase', base],
            ['adjlong', `${base}, long staff`],
            ['adjancient', `${base}, ancient staff`],
            ['adjwooden', `${base}, wooden staff`],
            ['adjsentence', `${base}, she is holding a very long ancient wooden staff`],
        ];
        for (const [tag, text] of arms) {
            const S = { ...settingsFor(seed), prefixA: `pod/${tag}/staff/s${seed}` };
            jobs.push({
                name: `${tag}/staff/s${seed}`,
                prompt: buildApi(specs, validate(specs, singleNodes(S, text, NEGATIVE))),
            });
        }
    }

    // ---- lumina: the same three prompt styles on a Gemma-encoded anime model --------
    // WAI scored 9/15 (tags + sentence) and 3/15 (sentence only) on these exact prompts.
    // NetaYume's encoder is a language model, so if CLIP's lack of binding was the limit,
    // both numbers should rise here - the sentence-only arm most of all.
    if (WANTED.includes('lumina')) {
        const byId = Object.fromEntries(SINGLE_CASES.map(entry => [entry.id, entry.prompt]));
        const arms = [
            ['lumtags', entry => byId[entry.id]],
            ['lumnl', nlPrompt],
            ['lumhybrid', hybridPrompt],
        ];
        for (const [tag, build] of arms) {
            for (const entry of NL_CASES) {
                const nodes = luminaNodes({ seed }, build(entry), NEGATIVE, `pod/${tag}/${entry.id}/s${seed}`);
                jobs.push({ name: `${tag}/${entry.id}/s${seed}`, prompt: buildApi(specs, validate(specs, nodes)) });
            }
        }
    }

    // ---- anima: the same three prompt styles on the Qwen3-encoded model SAA ships ---
    // NetaYume (Gemma-2-2B) scored 12/15 on the sentences. Anima's encoder is Qwen3-0.6B;
    // if it binds verbs to their actor as well, SAA's existing UNET workflow is the fix.
    // `waianima` runs the same arms on WAI-ANIMA v1.0 (Civitai), a fine-tune of Anima base
    // 1.0 that ships the identical Qwen3 encoder and VAE - only the DiT differs.
    for (const [experiment, prefix, unet] of [
        ['anima', 'anima', undefined],
        ['waianima', 'waianima', 'waiANIMA_v10Base10.safetensors'],
    ]) {
        if (!WANTED.includes(experiment)) continue;
        const byId = Object.fromEntries(SINGLE_CASES.map(entry => [entry.id, entry.prompt]));
        const arms = [
            [`${prefix}tags`, entry => byId[entry.id]],
            [`${prefix}nl`, nlPrompt],
            [`${prefix}hybrid`, hybridPrompt],
        ];
        for (const [tag, build] of arms) {
            for (const entry of NL_CASES) {
                const nodes = animaNodes({ seed, ...(unet ? { unet } : {}) }, build(entry), NEGATIVE, `pod/${tag}/${entry.id}/s${seed}`);
                jobs.push({ name: `${tag}/${entry.id}/s${seed}`, prompt: buildApi(specs, validate(specs, nodes)) });
            }
        }
    }

    // ---- prose: WAI-ANIMA reading paragraphs a local LLM wrote from SAA's fields ------
    // The hand-written sentences scored 12/15 on WAI-ANIMA. prose.mjs lays the same content
    // out as SAA's fields (tags per side, the action in English or Japanese) and has an LLM
    // write the paragraph; if the LLM keeps the direction, the score should hold.
    if (WANTED.includes('prose')) {
        const file = arg('prose', path.join(HERE, 'prose-results-v2.json'));
        const { results } = JSON.parse(fs.readFileSync(file, 'utf8'));
        for (const r of results) {
            const tag = `waiprose-${r.model}-${r.lang}`;
            const nodes = animaNodes({ seed, unet: 'waiANIMA_v10Base10.safetensors' }, r.prompt, NEGATIVE, `pod/${tag}/${r.id}/s${seed}`);
            jobs.push({ name: `${tag}/${r.id}/s${seed}`, prompt: buildApi(specs, validate(specs, nodes)) });
        }
    }

    // ---- nl: a sentence instead of tags, no regions ---------------------------------
    // These prompts name the actor and the receiver, so unlike every earlier run there
    // is a right answer for the direction and it can simply be scored.
    if (WANTED.includes('nl')) {
        for (const [tag, build] of [['nl', nlPrompt], ['hybrid', hybridPrompt]]) {
            for (const entry of NL_CASES) {
                const S = { ...settingsFor(seed), prefixA: `pod/${tag}/${entry.id}/s${seed}` };
                jobs.push({
                    name: `${tag}/${entry.id}/s${seed}`,
                    prompt: buildApi(specs, validate(specs, singleNodes(S, build(entry), NEGATIVE))),
                });
            }
        }
    }

    // ---- pony: the same six cases on Pony Diffusion V6 XL ---------------------------
    // The claim under test is that Pony handles more than one character better than the
    // Illustrious family. Same seeds, same interaction tags, same appearance tags; only
    // the checkpoint and the quality/negative prefix change. Both arms are run because
    // the Illustrious results differ sharply between them.
    if (WANTED.includes('pony')) {
        for (const entry of PONY_CASES) {
            const S = { ...settingsFor(seed), model: PONY_MODEL, prefixA: `pod/ponyreg/${entry.id}/s${seed}` };
            jobs.push({
                name: `ponyreg/${entry.id}/s${seed}`,
                prompt: buildApi(specs, validate(specs, selectNodes({
                    settings: S,
                    prompt: { base: entry.base, left: entry.left, right: entry.right, negative: PONY_NEGATIVE },
                    only: 'A',
                }))),
            });
        }
        for (const [tag, set] of [['ponysingle', PONY_SINGLE_CASES], ['ponynl', PONY_NL], ['ponyhybrid', PONY_HYBRID]]) {
            for (const entry of set) {
                const S = { ...settingsFor(seed), model: PONY_MODEL, prefixA: `pod/${tag}/${entry.id}/s${seed}` };
                jobs.push({
                    name: `${tag}/${entry.id}/s${seed}`,
                    prompt: buildApi(specs, validate(specs, singleNodes(S, entry.prompt, PONY_NEGATIVE))),
                });
            }
        }
    }

    // ---- asym: the two sides at DIFFERENT mask strengths ----------------------------
    // A uniform strength is a no-op (measured). A difference between the sides is the
    // only thing the widget can actually express, and it is a direct handle on which
    // character dominates - which is the whole question.
    if (WANTED.includes('asym')) {
        for (const [tag, left, right] of ASYM) {
            for (const entry of ANOTHERS_CASES) {
                const S = {
                    ...settingsFor(seed),
                    maskStrengthLeft: left, maskStrengthRight: right,
                    prefixA: `pod/${tag}/${entry.id}/s${seed}`,
                };
                const nodes = selectNodes({
                    settings: S,
                    prompt: { base: entry.base, left: entry.left, right: entry.right, negative: NEGATIVE },
                    only: 'A',
                });
                jobs.push({ name: `${tag}/${entry.id}/s${seed}`, prompt: buildApi(specs, validate(specs, nodes)) });
            }
        }
    }

    // ---- strength: how far the mask can be turned down before it stops placing -------
    // ConditioningSetMask strength is a continuum between "regional" (1.0, what SAA
    // sends today) and "no regions at all". The no-region run produced the better
    // compositions; the question is whether a middle value keeps the left/right
    // placement while letting the two bodies interact.
    if (WANTED.includes('strength')) {
        for (const maskStrength of STRENGTHS) {
            const tag = `str${String(maskStrength).replace('.', '')}`;
            for (const entry of ANOTHERS_CASES) {
                const S = { ...settingsFor(seed), maskStrength, prefixA: `pod/${tag}/${entry.id}/s${seed}` };
                const nodes = selectNodes({
                    settings: S,
                    prompt: { base: entry.base, left: entry.left, right: entry.right, negative: NEGATIVE },
                    only: 'A',
                });
                jobs.push({ name: `${tag}/${entry.id}/s${seed}`, prompt: buildApi(specs, validate(specs, nodes)) });
            }
        }
    }

    // ---- baseline: branch A with the ORIGINAL Base wording, for a direct A/B --------
    if (WANTED.includes('baseline')) {
        for (const entry of CASE_SETS.default) {
            const S = { ...settingsFor(seed), prefixA: `pod/baseline/${entry.id}/s${seed}` };
            const nodes = selectNodes({
                settings: S,
                prompt: { base: entry.base, left: entry.left, right: entry.right, negative: NEGATIVE },
                only: 'A',
            });
            jobs.push({ name: `baseline/${entry.id}/s${seed}`, prompt: buildApi(specs, validate(specs, nodes)) });
        }
    }

    // ---- split-detail: last run's best layout, plus a per-face detailer ------------
    if (WANTED.includes('split-detail')) {
        for (const entry of CASE_SETS.split) {
            const S = { ...settingsFor(seed), prefixA: `pod/splitdetail/${entry.id}/s${seed}_pre` };
            const nodes = selectNodes({
                settings: S,
                prompt: { base: entry.base, left: entry.left, right: entry.right, negative: NEGATIVE },
                only: 'A',
            });
            // node 23 is branch A's VAEDecode, node 5 the unmasked negative
            nodes.push(...detailFor(entry, seed, `pod/splitdetail/${entry.id}/s${seed}_post`, {
                image: [23, 0], negative: [5, 0],
            }));
            jobs.push({ name: `split-detail/${entry.id}/s${seed}`, prompt: buildApi(specs, validate(specs, nodes)) });
        }
    }

    // ---- single-detail: no regions at all, plus the same detailer ------------------
    if (WANTED.includes('single-detail')) {
        for (const entry of SINGLE_CASES) {
            const S = { ...settingsFor(seed), prefixA: `pod/singledetail/${entry.id}/s${seed}_pre` };
            const nodes = singleNodes(S, entry.prompt, NEGATIVE);
            nodes.push(...detailFor(entry, seed, `pod/singledetail/${entry.id}/s${seed}_post`, {
                image: [23, 0], negative: [5, 0],
            }));
            jobs.push({ name: `single-detail/${entry.id}/s${seed}`, prompt: buildApi(specs, validate(specs, nodes)) });
        }
    }
}

fs.writeFileSync(OUT, JSON.stringify({ jobs }, null, 0));
console.log(`${jobs.length} jobs -> ${OUT} (${(fs.statSync(OUT).size / 1024).toFixed(0)} KB)`);
for (const name of new Set(jobs.map(job => job.name.split('/')[0]))) {
    console.log(`  ${name}: ${jobs.filter(job => job.name.startsWith(`${name}/`)).length}`);
}
