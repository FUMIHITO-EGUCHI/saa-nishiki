# Regional interaction test bench

Two characters, one picture, and an action that belongs to both of them. **Can "who does
what to whom" be made to render reliably?**

Nothing here is wired into SAA. Build the graphs, run them, judge the pictures, and only
then decide whether anything is worth porting into `scripts/main/comfyui_workflow.js`.

## The two branches

**A — what SAA does today.** `ConditioningSetMask` on each side, `ConditioningCombine`,
one `KSampler`. ComfyUI runs the UNet once per conditioning and blends the results by
mask, so the left side is denoised without ever seeing the right side's prompt.

**B — Impact Pack's `RegionalSampler`.** Its base sampler runs the whole canvas at every
step; `base_only_steps` runs it alone before any region is applied. The composition is
decided by the Base prompt, and the regions repaint inside their masks afterwards.

Both branches read the same **Base** node through `ConditioningConcat`, use the same mask
pair SAA builds (`CreateTillingPNGMask` → `PngRectanglesToMask`), the same latent and the
same seed. Branch B also carries a per-side negative, so the Negative (left) /
Negative (right) fields survive the method change.

## Use

```
node build.mjs                 # writes both JSON files
node run.mjs --save=./out      # queue the API JSON and download the images
node sweep.mjs --only=A --seeds=1,2,3 --out=./out --set=default
node bigsheet.mjs --in=./out --out=./big/a --cell=520 --rows=3
```

`--set` picks a case set from `cases.mjs` / `casesVocab.mjs`: `default` (the original
wording), `split` (directional tag on the acting side only), `anothers` (real Danbooru
tags). `casesNL.mjs` holds the sentence and hybrid variants, `casesPony.mjs` the Pony
dialect of all of them.

**Judge at 520px per cell, not 300.** The 250-300px contact sheets `sheet.mjs` produces
are fine for spotting a completely broken image and useless for everything else: a third
figure at the edge of the frame, a swapped eye colour and a second spoon are all
invisible at that size. Several conclusions in the first version of this file were wrong
for exactly that reason. `bigsheet.mjs` exists to avoid repeating it.

### Running on a Pod

The Runpod pod has no node runtime, so graphs are built on the workstation against the
**Pod's** `/object_info` and only finished API prompts travel over SSH:

```
node podjobs.mjs --specs=./pod-object-info.json --exp=vocab,nl --out=./pod-jobs.json
# ship pod-jobs.json + poddriver.py to the Pod, then:
python3 poddriver.py run   --jobs=/tmp/pod-jobs.json --out=/tmp/podout
python3 poddriver.py sheet --out=/tmp/podout --cell=300
python3 poddriver.py emit  --file=/tmp/podout/sheet_vocab.jpg   # base64 on stdout
```

`--exp` selects experiments: `baseline`, `vocab`, `split-detail`, `single-detail`,
`strength`, `asym`, `nl`, `pony`.

### Options

```
--host=http://127.0.0.1:8189   --model=<checkpoint>
--width= --height= --steps= --cfg= --sampler= --scheduler= --seed=
--layout=1,0.2,1               left,overlap,right — SAA sends image_ratio/50, overlap/100, 2-(image_ratio/50)
--mask-strength=1.0            branch A: ConditioningSetMask strength (SAA's Left/Right Str)
--base-only-steps=8            branch B: steps before any region is applied
--overlap-factor=32            branch B: mask dilation that blends the region seams
```

`graph.mjs` also accepts `maskStrengthLeft` / `maskStrengthRight` — see the strength
finding below for why a single uniform value cannot do anything.

## Known trap: no ancestral sampler in branch B

`euler_ancestral` re-injects noise at every step and `RegionalSampler`'s per-step latent
restore never removes it — branch B comes back as **pure RGB noise**, no error, no
warning. `euler`, `dpmpp_2m` and other non-ancestral samplers are fine.

SAA's default sampler is `euler_ancestral`, so a RegionalSampler path in SAA would have
to force a non-ancestral sampler while Regional is on, or warn.

## What the runs found

Six hard cases (`princess-carry`, `piggyback`, `headpat`, `kneel-and-stand`,
`hands-apart`, `feeding`) × three seeds, WAI Illustrious v17.0, 1216×832, 28 steps,
cfg 5.0, euler/normal, judged by eye at 520px.

### The one thing that gave real direction control: a sentence inside the tags

Scoring direction needs a prompt that states one, so `casesNL.mjs` names the actor and the
receiver. Five cases have a direction (`hands-apart` is mutual), so 15 judgements per arm.

| arm | direction correct |
|---|---|
| tags only | not expressible — uncontrolled |
| sentence only | **3/15** |
| tags + one action sentence | **9/15** |

The hybrid prompt is ordinary tags for scene and appearance with the action written once
as a clause:

```
2girls, indoors, full body, long blonde hair, blue eyes, white dress,
short black hair, red eyes, black suit,
the black haired girl is carrying the blonde girl in her arms
```

`princess-carry` 3/3, `piggyback` 2/3, `kneel-and-stand` 2/3, `feeding` 2/3. `piggyback`
was deliberately specified against the prior the tags produce, and the sentence still won
twice. `headpat` is 0/3 — a tag with a strong prior is not overridden by the sentence.

**Replacing the tags with prose is much worse.** Sentence-only prompts stop forming the
action at all (`princess-carry` 0/3 — the two just embrace standing up), collapse the two
descriptions into **one character wearing both outfits** (`kneel-and-stand`, `feeding`),
or turn the interaction into a solo act (a girl feeding herself while the other sits at a
different table). WAI v14+ is merged from Illustrious **v1.0**; per the Illustrious paper
natural-language captioning only arrives in v1.1, which matches what these runs show.

### Regional masking

**The original claim in this file, that branch A "cannot form" a cross-region action, was
wrong.** Re-run against the same seeds, the current method forms the carry 3/3 and the
piggyback 3/3. What it actually fails at is *duplicating the action*: `feeding` came back
with **two spoons in 3/3**, `kneel-and-stand` with **both girls kneeling in 2/3**. Base is
concatenated into both sides, so a tag describing the act is equally true of the receiver.

Two independent fixes for that, both partial:

- **Directional tag on the acting side only** (`--set=split`). `kneel-and-stand` 1/3 → **3/3**,
  confirmed. `feeding` reaches 2/3, not the 3/3 first recorded here. `princess-carry`
  **0/3** — the carry stops forming altogether, so this helps a static pose and hurts a
  lift.
- **Real Danbooru tags in Base** (`--set=anothers`): `carrying person` (17k posts),
  `hand on another's head` (53k), `looking at another` (436k). `feeding` goes to **one
  spoon 3/3** and `princess-carry` 2/3 → 3/3, but `piggyback` and `hands-apart` each drop
  from 3/3 to 2/3. **Net neutral: one win, two losses, three ties.**

### Mask strength is a no-op

`ConditioningCombine` normalises overlapping conditionings, so scaling both sides by the
same factor leaves their ratio — and the picture — unchanged. Measured mean absolute pixel
difference against strength 1.0, over six cases × three seeds:

| change | mean difference (0-255) |
|---|---|
| strength 1.0 → 0.7 | 0.8 – 3.2 |
| strength 1.0 → **0.5** | **0.0 for four of six cases (bit-identical)** |
| strength 1.0 → 0.3 | 0.8 – 3.1 |
| *control: a different seed* | *51.8 – 64.2* |

0.5 is exactly representable in binary and produces the identical image; 0.7 and 0.3 drift
by rounding alone. **SAA's Left Str / Right Str do nothing while both hold the same
value.** Setting them *differently* does move the picture (12.7 – 23.5), but it changes how
large and prominent each character is, not who acts on whom — and the weakened side gets
swallowed, turning `piggyback` into a three-person picture.

### Everything else that was tried and did not work

- **`RegionalSampler`, `base_only_steps=8`** — forms the interaction, **destroys the
  separation**. In `headpat` the blonde disappears entirely 3/3; in `feeding` the
  attributes cross completely (left girl black-haired with blue eyes, right girl blonde
  with red eyes); in `princess-carry` the blonde becomes the carrier.
- **`base_only_steps=3`** — the two characters **fuse into one body**, faces smear into a
  blur, and three-person results appear. Worse than described in the first version here.
- **ControlNet OpenPose** — `kneel-and-stand` still 1/3 with a skeleton supplied. Pose is
  constrained, direction is not.
- **Horizontal split** (`Colum_first=false`) — the composition forms 6/6 and **every
  single result is two blondes**: both heads land in the top region.
- **Grid layouts** — more regions make more people; each region independently renders a
  person.
- **Per-face detailer** (`BboxDetectorSEGS` → `ImpactSEGSOrderedFilter(x1)` →
  `DetailerForEach` ×2, `detailer.mjs`) — one fix, two breakages. It repaired a bled eye
  colour once; on overlapping faces the second detailer's dilated box reaches into the
  first face and repaints it wrong, and with no regions the x1 order does not say which
  character is which, so the two prompts get swapped.
- **Attention Couple** — not measured. The Civitai author reports interaction gets
  *harder* with it.

### No regions at all is the strongest single change

One prompt, no masks: `princess-carry` 3/3 clean, `piggyback` 3/3 clean,
`kneel-and-stand` 3/3 (the only method that differentiates the two postures),
`hands-apart` 3/3, `headpat` 3/3. No extra people, attributes almost always correct. Its
two costs: **left/right placement is random**, and `feeding` keeps two spoons 2/3 — the
one axis where the mask genuinely helps.

### Beyond two characters

SAA's non-Regional route concatenates up to six character tags into one prompt with no
masking (`generate.js:409`, `characterSelectionModal.js:381`). `plainchars.mjs` renders
that shape: with three characters one was **duplicated and another vanished** in 2/3; with
six the crowd reads right but no individual identity survives. The `tag_assist` data that
might have helped covers 197 of 5090 characters.

The prior explains it. On Danbooru, `solo` has 7,053,008 posts and `1girl` 8,398,052,
against `2girls` 1,435,882 (17%) and `3girls` 327,463 (4%).

### Pony Diffusion V6 XL, for comparison

Same six cases, same seeds, same appearance tags; only the checkpoint and the quality /
negative prefix change (`score_9, score_8_up, score_7_up, source_anime, rating_safe`).
Run at cfg 5.0 and again at cfg 7.0 — the results are the same, so the washed-out look is
not under-guidance.

The claim that Pony handles multiple characters better **did not reproduce**. Sentence-only
prompts collapse to a single character in nearly every case (and produce red splatter
artifacts on `piggyback` at both cfg values); tag prompts produce three-person results more
often than WAI does; the hybrid arm forms `princess-carry` 3/3 and little else.

Two honest limits: these runs are `rating_safe`, and Pony's multi-person reputation comes
from its explicit training domain, which is untested here; and the interaction tags are
Illustrious-native vocabulary, which favours WAI in the tag arms — though the sentence arms
are vocabulary-neutral and Pony loses those too.

### A language-model encoder: NetaYume Lumina v4

If CLIP's bag-of-words reading is what loses "A does X to B", a model whose text encoder is
a language model should keep it. NetaYume v4 (Lumina 2, Gemma-2-2B encoder, `lumina.mjs`)
got the same five directed cases × three seeds, with its own recommended settings
(res_multistep / linear_quadratic, 40 steps, cfg 5.5, shift 6, system prompt `superior`).

| arm | WAI v17.0 | NetaYume v4 | Anima base v1.0 | WAI-ANIMA v1.0 |
|---|---|---|---|---|
| sentence only | 3/15 | **12/15** | **12/15** | **12/15** |
| tags + one action sentence | 9/15 | 10/15 | 9/15 | 7/15 |

The sentence arm flips from WAI's worst to the best result on the bench, and NetaYume never
fused the two characters into one. Its hybrid arm loses `feeding` 0/3, so for this model
the plain sentence is the prompt to write. The two encoder families want opposite prompt
shapes: a language-model encoder reads the sentence as a sentence, CLIP needs the scene and
the looks as tags with only the action in words.

**Anima** (`anima.mjs`: 2B DiT, Qwen3-0.6B encoder, the model SAA already ships a UNET
workflow for) matches NetaYume on sentences with an encoder a quarter of Gemma's size:
`princess-carry`, `headpat`, `kneel-and-stand` and `feeding` 3/3 each, no fused
characters. Run with the public `anima-base-v1.0` from `circlestone-labs/Anima` (er_sde /
simple, 30 steps, cfg 4.5), not WAI-ANIMA, which needs a Civitai token. Its one hard miss
is `piggyback`, 0/3 in both arms: the black-haired girl carries the blonde every time,
against the sentence. That is a prior winning, not a binding failure; the same case is
WAI's hardest. The hybrid arm drops to 9/15 (`feeding` reversed on two seeds; on
`kneel-and-stand` the tags pull the kneeling girl onto all fours on every seed and one seed
kneels both). As with NetaYume, a language-model encoder wants the sentence alone.

**WAI-ANIMA v1.0** (Civitai; a fine-tune of Anima base 1.0 that ships the identical Qwen3
encoder and VAE, so only the DiT changes; `--exp=waianima`, same settings) reads the
sentences exactly like the base model, cell for cell: 12/15, `piggyback` 0/3 again. The
hybrid arm is worse at 7/15: on `kneel-and-stand` the tags put the black-haired girl down
on all fours or kneeling as well on every seed, and `feeding` reverses or turns mutual on
two seeds. The fine-tune changes the look, not how the sentence is read.

Anima needs the sentence in English. ComfyUI runs the prompt through both the Qwen3 and the
T5-XXL tokenizers, and the DiT receives the conditioning laid out along the T5 token ids
(`preprocess_text_embeds(context, t5xxl_ids)`). A Japanese sentence comes out of the T5
tokenizer as a single `<unk>` (checked on the Pod), so nothing it says reaches the picture.

### Sentences written by a local LLM

Writing the paragraph by hand is what the sentence arm costs. `prose.mjs` lays each case out
as SAA's fields (quality tags and the count in Common, the place in Background, the framing
in View, three appearance tags per side, the action in its own field, once in English and
once in Japanese) and has a local Ollama model write the paragraph. Both models ran on the
CPU only (`num_gpu 0`), which is how they would run next to WAI-ANIMA on a 12 GB card. The
paragraphs (`prose-results-v2.json`) then went through WAI-ANIMA v1.0 with the same seeds
and settings (`--exp=prose`).

| | Gemma4-12B uncensored | Qwen3.5-35B-A3B uncensored |
|---|---|---|
| time per paragraph, model loaded | ~34 s (4.1 tok/s) | ~8 s (12.3 tok/s) |
| model load | 10.5 s | 18.7 – 23.9 s |
| paragraphs that follow the instructions | 12/12 | 4/12 (adds "stands" 4×, restates the action in the passive 4×) |
| direction, Action typed in English | 8/15 | 9/15 |
| direction, Action typed in Japanese | **13/15** | 11/15 |
| *hand-written sentence, for reference* | *12/15* | |

The first prompt (`prose-results.json`) also had Qwen add "stand" to 7 of 12 paragraphs and
write "with no specific lighting or color style defined" into one; forbidding both fixed
the second and halved the first.

**How the action is worded matters more than which model writes it.** From an English
Action both models keep the bench's own phrase almost word for word, and two of those
phrases lose. "Giving ... a piggyback ride" brings back the prior (the black-haired girl
carries, 0/3, as it does for the hand-written sentence). "Is kneeling on the floor and the
black haired girl is standing over her" puts both girls on all fours, or one over the
other, on every seed for both models, where the hand-written "kneeling on the floor
looking up at a girl ... who stands over her" gets 3/3. From a Japanese Action the models
have to paraphrase, and the paraphrase describes the bodies rather than naming the act:
"carries the girl with short black hair on her back" wins `piggyback` 2/3 for Gemma, the
first time a sentence has won that case on an Anima model, and "stands in front of her and
looks down at her" gets `kneel-and-stand` to 2/3. Qwen's added "stands" and passive
restatements did not flip a direction on their own; its two extra losses are a piggyback
and a kneel seed.

Smaller things seen in the pictures: Gemma wrote identical paragraphs for both `feeding`
arms, so those two columns are the same images; "the scene is an upper body view" once
came back letterboxed with black bars; on the winning Gemma `piggyback` seed the blonde
also wears the black jacket.

**Third prompt: the action as bodies, not as the name of the act.** One rule added
(`prose-results-v3.json`): write where each character is relative to the other, what holds
or touches what, and who looks at whom; never the name of the act or pose, even when the
input uses it. Same seeds and settings.

| direction | Gemma EN | Gemma JA | Qwen EN | Qwen JA |
|---|---|---|---|---|
| second prompt | 8/15 | 13/15 | 9/15 | 11/15 |
| third prompt | 9/15 | 13/15 | 11/15 | **14/15** |

Qwen from a Japanese Action is now the best arm on the bench, two above the hand-written
sentence, and the only one that has won `piggyback` twice (the hand-written sentence and
Anima base never won it). What the rule did and did not do:

- Both models now write `piggyback` as "carries ... on her back" from the English input
  too, and it still loses 2/3 there. The wording removed the tag, not the prior; from the
  Japanese input the same sentence shape won 1/3 (Gemma) and 2/3 (Qwen). Which seed wins
  is not stable across arms, so this case sits at the edge of what the model will do.
- `kneel-and-stand` from an English Action still comes back as "stands over her" from both
  models — the rule was not applied to a phrase the input already had in English — and
  still fails 0/3 (Gemma) and 1/3 (Qwen): the two end up on the floor together. From the
  Japanese input both write "stands in front of her, looking down at her" and get 3/3.
- Everything else is unchanged at 3/3 (`headpat`, `feeding`, and `princess-carry` except
  one Gemma seed where the two just stand).

So the paraphrase the LLM is forced into by a Japanese Action is what wins, and an English
Action that already names the pose is copied through. For SAA that means the conversion
should be told the action is a description to rewrite, not text to keep — or the user
writes the Action in Japanese, which is the natural case anyway. Qwen's extra "stands"
and passive restatements are still there in the third prompt and still did not cost a
direction.

Three of the twelve Qwen JA pictures came back letterboxed (black bars) from "framed as an
upper body shot" / "seen in full body view"; the framing words read as a film frame.

### Adjectives the tag list does not have

Does CLIP use an adjective + noun pair that is not a tag? Base prompt `1girl, solo, ...,
holding staff, standing, simple background, full body` on WAI, seeds 1–4, with one phrase
added. Danbooru has `staff` (83,044 posts), `holding_staff` (50,943) and `wooden_staff`
(500), and no `long_staff` or `ancient_staff`.

| added | what changed | pixel diff vs base, s1 / s2 / s3 |
|---|---|---|
| `long staff` | nothing | 6.6 / 3.8 / 3.2 |
| `ancient staff` | nothing | 10.1 / 9.0 / 3.5 |
| `wooden staff` | the staff is wooden, 4/4 | 12.0 / 15.6 / 12.4 |
| `she is holding a very long ancient wooden staff` | wooden 4/4, and the **hair** got longer 2/4 | 11.8 / 8.8 / 30.4 |

A different seed moves the same image by 30.3 / 31.3 / 32.8, so the two made-up tags are
inside noise (seed 4 was volatile for every arm and is left out). The prediction that
"long" would leak onto the hair when written as a tag was wrong: as a tag it is simply
ignored. The leak happens in the sentence, where "long" is free to attach to any noun.
SAA marks capsules the dictionary does not know for this reason.

## Practical line

- Two characters interacting, direction matters → a **language-model-encoder model with a
  plain sentence** (Anima or NetaYume, 12/15). Anima already runs through SAA's UNET
  workflow.
- Staying on WAI → **tags plus one action sentence**, no regions (9/15). It keeps the
  existing tag prompt.
- Deterministic left/right placement needed → Regional, accepting that the action may
  duplicate; keep tools and act tags out of the shared Base field.
- Three or more characters → outside what masking can do.

## What to look at when judging a run

1. Does the interaction happen, and in the direction the prompt asked for?
2. How many people are in the frame? Extra figures are the most common regional failure
   and the easiest to miss in a small thumbnail.
3. Do hair, eyes and clothes stay with the right character?
4. Time. Branch B samples each region on top of the base at every step, so it costs
   noticeably more than A.
