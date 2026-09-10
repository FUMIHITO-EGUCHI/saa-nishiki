# Regional interaction test bench

Two ComfyUI graphs, one seed, one latent, one set of prompts. The question they answer:
**can an interaction that spans both Regional sides — a hug, one character acting on the
other, who does what to whom — be made to render reliably?**

Nothing here is wired into SAA. Build the graphs, open them in ComfyUI, judge the
pictures, and only then decide whether the method is worth porting into
`scripts/main/comfyui_workflow.js`.

## The two branches

**A — what SAA does today.** `ConditioningSetMask` on each side, `ConditioningCombine`,
one `KSampler`. ComfyUI runs the UNet once per conditioning and blends the results by
mask, so the left side is denoised without ever seeing the right side's prompt.

**B — Impact Pack's `RegionalSampler`.** Its base sampler runs the whole canvas at every
step; `base_only_steps` runs it alone before any region is applied. The composition is
decided by the Base prompt, and the regions repaint inside their masks afterwards.
`overlap_factor` dilates the masks so the seam between the two sides blends instead of
reading as a collage.

Both branches read the same **Base** node through `ConditioningConcat`, so editing Base
in the ComfyUI UI changes both pictures at once. Both use the same mask pair SAA builds
(`CreateTillingPNGMask` → `PngRectanglesToMask`, columns 0+overlap and 2+overlap), the
same latent and the same seed.

Branch B also carries a per-side negative — each region gets its own `ToBasicPipe` with
its own negative conditioning — so the Negative (left) / Negative (right) fields survive
the method change.

## Use

```
node build.mjs                 # writes both JSON files
node build.mjs --only=B        # just the RegionalSampler branch, while tuning it
node run.mjs --save=./out      # queue the API JSON and download the images
```

To judge a method you need a batch, not one lucky picture:

```
node sweep.mjs --only=A --seeds=1,2,3 --out=./out   # every case in cases.mjs
node sweep.mjs --cases=princess-carry --base-only-steps=3 --label=b3
node sheet.mjs --in=./out --out=./out/sheet.png     # one contact sheet, a row per case
```

`cases.mjs` holds the hard cases — the ones where the two bodies are different shapes or
heights, or the action starts in one half and has to land in the other. The easy case
(two girls standing side by side, hugging) already works with the current method,
because the bodies meet in the overlap column, so it proves nothing. In every case
`left` is the receiving side and `right` the acting one, so a swapped direction is
obvious at a glance.

Then drag **`regional-compare.workflow.json`** onto the ComfyUI canvas and hit Run.
`regional-compare.api.json` is the same graph in API format, for `POST /prompt`.

`build.mjs` reads `/object_info` from the running ComfyUI, so widget order, defaults and
output names always match the installed node versions. It fails loudly on a type
mismatch or a missing node instead of emitting a graph that dies at run time.

### Options

Every value can be overridden on the command line:

```
--host=http://127.0.0.1:8189   --model=<checkpoint>
--width= --height= --steps= --cfg= --sampler= --scheduler= --seed=
--layout=1,0.2,1               left,overlap,right — SAA sends image_ratio/50, overlap/100, 2-(image_ratio/50)
--mask-strength=1.0            branch A: ConditioningSetMask strength (SAA's Left/Right Str)
--base-only-steps=8            branch B: steps before any region is applied
--overlap-factor=32            branch B: mask dilation that blends the region seams
--additional-mode='ratio between'  branch B: recovery pass for samplers that leave noise
```

## Known trap: no ancestral sampler in branch B

`euler_ancestral` re-injects noise at every step and `RegionalSampler`'s per-step latent
restore never removes it — branch B comes back as **pure RGB noise**, no error, no
warning. `euler`, `dpmpp_2m` and other non-ancestral samplers are fine.

This matters for porting: SAA's default sampler is `euler_ancestral`, so a
RegionalSampler path in SAA would have to either force a non-ancestral sampler while
Regional is on, or warn.

## What the sweeps found

Six hard cases, three seeds each, run through every method. Summary first:

| | action spanning both sides | left/right separation | direction (who acts on whom) |
|---|---|---|---|
| A - current SAA method | cannot form | reliable | unstable |
| B - RegionalSampler (`base_only_steps=8`) | **forms** | breaks | unstable |
| B with `base_only_steps=3` | breaks | partly returns | unstable |
| A + ControlNet OpenPose | partly forms | reliable | unstable |
| **directional tag on one side only** | unchanged | unchanged | **solved** |
| horizontal split | **forms** | breaks | — |

**The direction problem is a prompt placement problem, not a sampling problem.** Base
goes into both sides' conditioning, so `feeding another` written there is equally true of
the girl being fed - which is how two spoons appear, and how both girls end up kneeling.
Moving the directional tag to the acting side only, and leaving nothing action-shaped in
the receiving side, took `feeding` and `kneel-and-stand` from 1/3 to 3/3. Nothing else
tried here came close. `cases.mjs` holds both variants (`--set=default` / `--set=split`).

**Everything else is one trade-off seen from different angles.** A region can only
separate attributes where the mask line separates bodies. Left/right works when the two
figures stand side by side; a carry or a piggyback overlaps them, so whichever way you
cut, one girl's face lands in the other's region and hair and clothes bleed. Branch B
loses the separation for the same reason it gains the composition. The horizontal split
puts both heads in the top region, and every result came back with two blondes.

**More regions make more people.** The grid run (`gridrun.mjs`, top row split for faces
over an undivided bottom row) produced the carry poses but drew three or more figures:
each region independently tries to render a person. Regional masking is pulled hard
toward one-region-one-character, so widening it to three or four regions works against
an interaction, not for it.

**Beyond two characters there is no regional path at all.** SAA's non-Regional route
concatenates up to six character tags into one prompt with no masking
(`generate.js:409`, `characterSelectionModal.js:381`). `plainchars.mjs` renders that
exact shape: with three characters one of them simply did not appear and another was
duplicated; with six the crowd reads right but no individual identity survives. The
`tag_assist` data that might have helped covers 197 of 5090 characters, so for most of
the list this is the real behaviour.

**Practical line:** two characters side by side with an interaction - Regional plus the
one-sided directional tag. Two characters overlapping - a different split direction,
accepting the loss of separation. Three or more - outside what masking can do.

## What to look at

1. Does the interaction in the Base prompt actually happen, and in the right direction
   (who is behind whom, who is holding whom)?
2. Do the per-side prompts still land? Branch B decides the composition first, so a
   strong `base_only_steps` can flatten the side descriptions — clothing especially.
   Lower it if the sides go generic; raise it if the interaction falls apart.
3. Is the seam between the sides visible? That is `overlap_factor` in B, the overlap
   column of `--layout` in A.
4. Time. B samples each region on top of the base at every step, so it costs
   noticeably more than A.
