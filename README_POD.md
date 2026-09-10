# Runpod pod setup (Nishiki)

SAA can run image generation and the LLM features on a Runpod pod. Everything goes through **one SSH session**: a small relay (`scripts/pod/comfy_ws_relay.py`) is deployed into the pod's RAM when SAA connects, talks to ComfyUI and Ollama on the pod's loopback, and streams images and answers back over the SSH channel. No HTTP port of the pod is exposed and nothing generated is written to the pod's disks.

## What lives where

| Path on the pod | Survives STOP → START | Content |
| --- | --- | --- |
| `/workspace/runpod-slim/ComfyUI` | yes | ComfyUI and the custom nodes (ComfyUI_Mira, Impact-Pack, …) |
| `/workspace/models` | yes | checkpoints, LoRAs, upscalers (`extra_model_paths.yaml`) |
| `/workspace/ollama/dist` | yes | the Ollama binary |
| `/workspace/ollama/models` | yes | pulled Ollama models (`OLLAMA_MODELS`) |
| `/workspace/runpod-slim/extra_model_paths.yaml` | yes | points ComfyUI at `/workspace/models` |
| `/workspace/runpod-slim/ComfyUI/.venv-cu128` | yes | the interpreter ComfyUI runs on, pip packages included |
| `/workspace/saa/bootstrap.sh` | yes | the restore script below |
| `/workspace/saa/provision.sh` | yes | the one-time setup script below |
| `/workspace/saa/logs` | yes | `pip.log`, `ollama.log`, `comfy.log`, `bootstrap.log`, `provision.log` |
| `/usr/local`, apt packages | **no** | reinstalled by `bootstrap.sh` |
| `/dev/shm/comfy_out`, `/dev/shm/comfy_tmp` | no (RAM) | ComfyUI output / temp — images never touch a disk |

> [!CAUTION]
> **STOP** the pod when you are done (GPU billing stops, the volume stays). Never **TERMINATE** it: `/workspace` and everything above is deleted with it.

## First time (a brand-new pod)

A fresh **runpod-slim** pod has ComfyUI and its venv but no custom nodes and no
model files at all, so `bootstrap.sh` alone is not enough: the pod's durable half
has to be filled in once first.

### With the setup wizard (no SSH session needed)

**Settings → Backend → Runpod pod over SSH → Pod setup wizard.** Three steps:

1. **Connection** — the SSH target (`<podId>-<hash>@ssh.runpod.io`), the private
   key file and the ComfyUI port, then **Test connection**. The wizard reads the
   pod before it changes anything and shows the GPU, the free space on
   `/workspace`, whether ComfyUI and Ollama answer, and how many custom nodes,
   checkpoints and LoRAs are already there.
2. **Components** — what to install. Anything the pod already has is unticked, so
   re-running the wizard only fills gaps. The custom nodes and their Python
   requirements are always on; the rest is optional:

   | Component | Download |
   | --- | --- |
   | Custom nodes (Mira, MiraSubPack, Impact-Pack, Impact-Subpack, controlnet_aux) | ~60 MB |
   | Checkpoint `waiIllustriousSDXL_v170` | 6.5 GB, needs a Civitai token |
   | Fast mode LoRA (DMD2 4-step) — what **Fast generation** applies | 390 MB |
   | ADetailer detectors (face / hand YOLO) and SAM | 430 MB |
   | Hires fix upscaler (RealESRGAN anime 6B) | 18 MB |
   | ControlNet openpose (SDXL) | 770 MB |

   The **Civitai API token** goes in the same step (or in *Civitai API token* in
   the settings). Civitai answers **403** to an unauthenticated download, so the
   checkpoint is the one component that needs it: create a token at
   <https://civitai.com/user/account> → *API Keys*. It is handed to the pod as an
   environment variable for the download process, never on a command line.
3. **Install** — the wizard writes `bootstrap.sh`, `provision.sh` and
   `extra_model_paths.yaml` onto the pod's volume and runs the provisioning,
   streaming the pod's own log into the window. Everything is downloaded on the
   pod and checked against a known sha256. It runs on the pod, so closing the
   window does not stop it. When it finishes, **Run bootstrap** restarts ComfyUI
   with the new nodes and models and **Fetch pod models** refreshes the dropdowns.

The wizard needs nothing on the pod beyond SSH and `python3`; the relay's other
commands (`deploy`, `provision`, `probe`, `log`) work on a pod that has not been
set up at all. It only ever writes those three fixed paths and only ever runs
those two scripts.

### By hand

1. Start the pod and open an SSH session (the Runpod basic proxy needs a PTY, hence `-tt`):
   ```
   ssh -tt -o IdentitiesOnly=yes -i ~/.ssh/id_ed25519 <podId>-<hash>@ssh.runpod.io
   ```
2. Copy the three files onto the pod (paste them, or `base64 -w 1000 <file>` locally and
   `base64 -d > <target> <<'EOF' … EOF` on the pod — the proxy's PTY truncates lines past 4 KB):

   | local | on the pod |
   | --- | --- |
   | `scripts/pod/bootstrap.sh` | `/workspace/saa/bootstrap.sh` |
   | `scripts/pod/provision.sh` | `/workspace/saa/provision.sh` |
   | `scripts/pod/extra_model_paths.yaml` | `/workspace/runpod-slim/extra_model_paths.yaml` |

3. Provision the durable half. It downloads the custom nodes (ComfyUI_Mira,
   ComfyUI_MiraSubPack, Impact-Pack, Impact-Subpack, comfyui_controlnet_aux) as
   codeload tarballs — a `git clone` from a Runpod IP can hit a GitHub credential
   prompt and kill the session — then the LoRA, ControlNet, ADetailer, SAM and
   upscaler files into `/workspace/models`, each verified against a known sha256.
   It takes a few minutes, so detach it and read the log:
   ```
   nohup bash /workspace/saa/provision.sh > /workspace/saa/logs/provision.log 2>&1 &
   tail -f /workspace/saa/logs/provision.log
   ```
   The **checkpoint** is the one file it cannot fetch on its own: Civitai refuses an
   unauthenticated download (403). Pass a token from the Civitai account settings:
   ```
   CIVITAI_TOKEN=<token> bash /workspace/saa/provision.sh
   ```
   Everything already in place with the right hash is skipped, so re-running is cheap.

4. Bring the services up and pull the LLM models you want:
   ```
   nohup bash /workspace/saa/bootstrap.sh --pull huihui_ai/qwen3-abliterated:8b > /workspace/saa/logs/bootstrap.log 2>&1 &
   ```
   It installs the pip packages the custom nodes need, downloads and extracts Ollama into
   `/workspace/ollama`, starts it on `127.0.0.1:11434`, pulls the model (about 5 GB for an
   8B model) and restarts ComfyUI with RAM-only output directories.

   Pick the model for the pod's VRAM: an 8B Q4 model (~5 GB) fits next to an SDXL checkpoint
   on a 12 GB card; a 14B model needs the GPU to itself while it runs. Image generation and an
   LLM batch should not run at the same time on a 12 GB pod. A 48 GB card (RTX A6000) holds a
   12B Q4 model and an SDXL checkpoint together with room to spare.

## Every start

```
bash /workspace/saa/bootstrap.sh
```

About a minute: restores pip packages, starts Ollama if it is down, restarts ComfyUI if it was started without the RAM output directories. It is idempotent — run it whenever something on the pod looks off.

## The pod panel

**Settings → Backend → Runpod pod over SSH** is one state-driven panel rather than a row
of buttons. The pill reports the pod, the chips report the services on it, and an action
is only rendered while it applies:

| Row | Shows | Action, when it applies |
| --- | --- | --- |
| Power | Not configured / Not checked / Stopped / Starting / Running / No answer, plus GPU, $/h and uptime | **Check pod** (unchecked or no answer), **Start pod** / **Stop pod** (needs a Runpod API key) |
| Services | ComfyUI and Ollama chips, and what the pod holds (checkpoints, LoRAs, nodes) | **Restart services** only while one is down, **Refresh lists** |
| Setup | how many of the seven components are installed | **Pod setup** (the wizard) |
| Connection | SSH target, key file name, port | **Edit** opens the fields |

How it decides, which is where the awkward cases live:

- A **stopped pod does not refuse an SSH connection, it hangs** until the relay's 60 s
  timeout. So the Runpod REST API is asked first and the relay is dialled only when the
  pod is known to be running, or when you press Check pod.
- **Without a Runpod API key** there is no cheap answer, so the panel says *Not checked*
  and waits rather than guessing "stopped" and hanging the settings page. It still works —
  Check pod dials, and everything except Start / Stop is available.
- A pod that answers nothing reads **No answer** with the SSH error underneath, never
  "stopped": those are different problems.
- Rows that cannot be true yet are not drawn. A stopped or unchecked pod shows no service
  chips, so a stale "ComfyUI down" is never on screen.
- After a start or a **Restart services**, the panel polls by itself until the services
  answer (about four minutes, then it gives up), so nothing has to be pressed twice.

The AI page's pod row works the same way: the model field is the list, so listing is not an
action, and **Download** appears only when the chosen model is not on the pod, **Unload**
only while one is resident.

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

- **Backend → Pod SSH**: enable, SSH target `<podId>-<hash>@ssh.runpod.io`, the private key path, ComfyUI port `8188`. The status pill in the toolbar switches image generation between **GPU: Local** and **GPU: Pod**. **Pod setup wizard** fills a new pod in (see above); *Civitai API token* is used only by that wizard.
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
- `pip` fails with `ResolutionImpossible` when installing with `--target`: the script installs into ComfyUI's venv normally, on purpose.
- **Empty model dropdowns with the relay connected** → the pod has no model files, or ComfyUI was started without `--extra-model-paths-config`. Run the setup wizard (or `provision.sh`), then `bootstrap.sh` to restart ComfyUI. `Fetch pod models` refreshes the lists.
- *provisioning is already running on this pod* → a previous wizard run is still downloading. Reopen the wizard later; the log at `/workspace/saa/logs/provision.log` shows where it is.
- **ComfyUI will not start at all after a fresh install** → it aborts on a missing `--extra-model-paths-config` file. `bootstrap.sh` drops the flag when `/workspace/runpod-slim/extra_model_paths.yaml` is absent, and says so in its log.
- **The checkpoint download returns 403** → Civitai needs an account token; see step 3 above.
- Runpod's `/start.sh` re-syncs only its own baked nodes (ComfyUI-Manager, KJNodes, Civicomfy, RunpodDirect); the nodes `provision.sh` adds are left alone, and it reinstalls custom node requirements itself if it ever rebuilds the venv.
