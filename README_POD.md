# Runpod pod setup (Nishiki)

SAA can run image generation and the LLM features on a Runpod pod. Everything goes through **one SSH session**: a small relay (`scripts/pod/comfy_ws_relay.py`) is deployed into the pod's RAM when SAA connects, talks to ComfyUI and Ollama on the pod's loopback, and streams images and answers back over the SSH channel. No HTTP port of the pod is exposed and nothing generated is written to the pod's disks.

## What lives where

| Path on the pod | Survives STOP → START | Content |
| --- | --- | --- |
| `/workspace/runpod-slim/ComfyUI` | yes | ComfyUI and the custom nodes (ComfyUI_Mira, Impact-Pack, …) |
| `/workspace/models` | yes | checkpoints, LoRAs, upscalers (`extra_model_paths.yaml`) |
| `/workspace/ollama/dist` | yes | the Ollama binary |
| `/workspace/ollama/models` | yes | pulled Ollama models (`OLLAMA_MODELS`) |
| `/workspace/saa/bootstrap.sh` | yes | the restore script below |
| `/workspace/saa/logs` | yes | `pip.log`, `ollama.log`, `comfy.log` |
| pip site-packages, `/usr/local` | **no** | restored by `bootstrap.sh` |
| `/dev/shm/comfy_out`, `/dev/shm/comfy_tmp` | no (RAM) | ComfyUI output / temp — images never touch a disk |

> [!CAUTION]
> **STOP** the pod when you are done (GPU billing stops, the volume stays). Never **TERMINATE** it: `/workspace` and everything above is deleted with it.

## First time

1. Start the pod and open an SSH session (the Runpod basic proxy needs a PTY, hence `-tt`):
   ```
   ssh -tt -o IdentitiesOnly=yes -i ~/.ssh/id_ed25519 <podId>-<hash>@ssh.runpod.io
   ```
2. Copy `scripts/pod/bootstrap.sh` to `/workspace/saa/bootstrap.sh` (paste it, or `base64 -w0 bootstrap.sh` locally and `echo … | base64 -d > /workspace/saa/bootstrap.sh` on the pod).
3. Run it once with the model you want:
   ```
   bash /workspace/saa/bootstrap.sh --pull huihui_ai/qwen3-abliterated:8b
   ```
   It installs the pip packages the custom nodes need, downloads and extracts Ollama into `/workspace/ollama`, starts it on `127.0.0.1:11434`, pulls the model (about 5 GB for an 8B model) and restarts ComfyUI with RAM-only output directories.

   Pick the model for the pod's VRAM: an 8B Q4 model (~5 GB) fits next to an SDXL checkpoint on a 12 GB card; a 14B model needs the GPU to itself while it runs. Image generation and an LLM batch should not run at the same time on a 12 GB pod.

## Every start

```
bash /workspace/saa/bootstrap.sh
```

About a minute: restores pip packages, starts Ollama if it is down, restarts ComfyUI if it was started without the RAM output directories. It is idempotent — run it whenever something on the pod looks off.

## Start / stop from SAA

The pod can be started and stopped without the Runpod console (issue #4):

- **Settings → Backend → Runpod pod over SSH**: paste a Runpod API key (Settings → API Keys in the Runpod console; a key with pod read/write is enough) into *Runpod API key*. The pod id is taken from the SSH target (`<podId>-<hash>@ssh.runpod.io`); *Runpod pod id* overrides it.
- Buttons: **Pod status** (desired status, GPU, $/h, uptime), **Start pod**, **Stop pod**, **Run bootstrap** (runs `/workspace/saa/bootstrap.sh` on the pod through the SSH relay — do this once ComfyUI answers after a start; the log is `/workspace/saa/logs/bootstrap.log`), **Fetch pod models** (see below).
- Command line, same key / pod id resolution (`RUNPOD_API_KEY` / `RUNPOD_POD_ID` env overrides):

```
node scripts/podControl.mjs status
node scripts/podControl.mjs start
node scripts/podControl.mjs stop
```

Only `status`, `start` and `stop` exist. There is no terminate / delete anywhere in SAA — a terminated pod loses `/workspace` (models, Ollama, this setup).

## Model lists from the pod

With Pod SSH on, the checkpoint / LoRA / VAE / upscaler / ControlNet lists in the UI come from the pod's ComfyUI (`/object_info`) instead of the local model folders, so the dropdowns show what the pod can actually load. They are refreshed automatically when the relay connects (first generation or AI request) and on the page refresh button; **Fetch pod models** opens the relay on purpose to refresh them right away. The same applies to an HTTPS ComfyUI address; a loopback address keeps the local folder scan.

## SAA settings

- **Backend → Pod SSH**: enable, SSH target `<podId>-<hash>@ssh.runpod.io`, the private key path, ComfyUI port `8188`. The status pill in the toolbar switches image generation between **GPU: Local** and **GPU: Pod**.
- **AI → interface `Pod`**: with Pod SSH configured the AI prompt / Refine requests go to the pod's Ollama through the same SSH relay. The `Pod address` (HTTPS proxy) field is only used when SSH is not configured.
- The Ollama status in the header is only probed through an already-open relay: it reads *pod relay not connected* until the first generation or AI request opens the session.
- The ComfyUI pill shows **ComfyUI down** (yellow, then red) when the relay answers but ComfyUI on the pod does not — after a pod start before ComfyUI is up, or when it crashed: run the bootstrap.

## LLM on the pod (translation batches, Refine / Expand)

The pod's Ollama serves three jobs through the same SSH relay: the app's **Expand** / **Refine** (AI → interface `Pod`), the tag-dictionary batches (`--backend pod`), and the fallback for batches Codex refuses. Nothing is exposed on a public port; the model files live in `/workspace/ollama/models` and survive a STOP.

**Models for a 12 GB pod** (an SDXL checkpoint and the LLM do not fit together; SAA unloads the LLM before every image generation, and `Unload LLM` does it by hand):

| Model | Size | Use |
| --- | --- | --- |
| `hf.co/HauhauCS/Gemma4-12B-QAT-Uncensored-HauhauCS-Balanced:Q4_K_M` | ~8 GB | translation review, Refine / Expand (strong Japanese) |
| `huihui_ai/qwen3-abliterated:8b` | ~5 GB | fast fallback for refused batches |

`bootstrap.sh` starts Ollama with flash attention, a `q8_0` KV cache and one loaded model at a time so the 12B model fits; `--pull` takes several models (`--pull a --pull b` or `--pull a,b`).

**From SAA** (Settings → AI → Runpod pod): *Pod Ollama model* names the model every pod call uses; *Pod LLM keep-alive* (`10m` default, `0` = unload after each answer) keeps it warm between Refine / Expand calls. Buttons: **Pod LLM models** (what is pulled / loaded, and whether the named model is missing), **Pull model** (downloads the named model into the pod's workspace through the relay; minutes), **Unload LLM**.

**Batches on the pod** (the pod model comes from the same setting unless `--pod-model` is given; the run unloads the model and closes the relay when it ends):

```text
node scripts/reviewJapaneseTags.mjs --backend pod --select suspicious,style,ambiguous,missing --min-heat 542 --report review.jsonl
node scripts/categorizeTags.mjs --backend pod --min-heat 2469 --report categories.jsonl
```

With the default `--backend auto`, every batch goes to Codex first and only a batch Codex refuses or garbles (after being split down to 25 rows) is re-run on the pod when Pod SSH is configured in `settings/app.json` (`--fallback ollama` for the local model instead).

## Troubleshooting

- *Ollama is not running on the pod (port 11434 refused)* → run `bootstrap.sh` on the pod.
- *ComfyUI is not running on the pod (port 8188 refused)* → same; check `/workspace/saa/logs/comfy.log`.
- The SSH proxy ignores remote commands and always opens an interactive shell; `-L` port forwarding is refused. Everything SAA needs runs inside that shell.
- `pip` fails with `ResolutionImpossible` when installing with `--target`: the script installs into the (volatile) system site-packages on purpose.
