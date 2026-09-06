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

## SAA settings

- **Backend → Pod SSH**: enable, SSH target `<podId>-<hash>@ssh.runpod.io`, the private key path, ComfyUI port `8188`. The status pill in the toolbar switches image generation between **GPU: Local** and **GPU: Pod**.
- **AI → interface `Pod`**: with Pod SSH configured the AI prompt / Refine requests go to the pod's Ollama through the same SSH relay. The `Pod address` (HTTPS proxy) field is only used when SSH is not configured.
- The Ollama status in the header is only probed through an already-open relay: it reads *pod relay not connected* until the first generation or AI request opens the session.

## Tag dictionary batches

`scripts/categorizeTags.mjs` sends every batch to Codex first; a batch Codex refuses or garbles is re-run on the pod's Ollama when Pod SSH is configured in `settings/app.json` (`--fallback ollama` for the local model instead, `--backend pod` to use the pod for everything, `--pod-model` to pick the model).

## Troubleshooting

- *Ollama is not running on the pod (port 11434 refused)* → run `bootstrap.sh` on the pod.
- *ComfyUI is not running on the pod (port 8188 refused)* → same; check `/workspace/saa/logs/comfy.log`.
- The SSH proxy ignores remote commands and always opens an interactive shell; `-L` port forwarding is refused. Everything SAA needs runs inside that shell.
- `pip` fails with `ResolutionImpossible` when installing with `--target`: the script installs into the (volatile) system site-packages on purpose.
