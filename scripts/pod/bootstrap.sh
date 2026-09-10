#!/usr/bin/env bash
# SAA pod bootstrap: restore what a Runpod STOP -> START wipes and bring the
# services up. Everything durable lives under /workspace; the container disk
# (pip site-packages, /usr/local) is volatile.
#
#   bash /workspace/saa/bootstrap.sh                # restore + start (idempotent)
#   bash /workspace/saa/bootstrap.sh --pull MODEL   # also pull an Ollama model (repeatable, or a,b,c)
#   bash /workspace/saa/bootstrap.sh --no-comfy     # leave ComfyUI as it is
#
# LLM on a 12 GB pod (translation batches, Refine / Expand), see README_POD.md:
#   --pull hf.co/HauhauCS/Gemma4-12B-QAT-Uncensored-HauhauCS-Balanced:Q4_K_M   # ~8 GB, strong Japanese
#   --pull huihui_ai/qwen3-abliterated:8b                                      # ~5 GB, fast fallback
# Ollama is started with flash attention, a q8_0 KV cache and one loaded model
# at a time so a 12B Q4 model fits; SAA unloads it before an image generation.
#
# Layout it expects (created on first use):
#   /workspace/ollama/dist/bin/ollama   Ollama binary (tarball extracted here)
#   /workspace/ollama/models            OLLAMA_MODELS (persists across STOP)
#   /workspace/saa/logs                 service logs
set -u

COMFY_DIR="${COMFY_DIR:-/workspace/runpod-slim/ComfyUI}"
EXTRA_MODEL_PATHS="${EXTRA_MODEL_PATHS:-/workspace/runpod-slim/extra_model_paths.yaml}"
COMFY_PORT="${COMFY_PORT:-8188}"
# ComfyUI's interpreter: the pod image keeps a venv under the (durable) ComfyUI
# dir; a plain SSH shell has no `python` on PATH, only python3.
if [ -z "${PYTHON:-}" ]; then
  for candidate in "$COMFY_DIR/.venv-cu128/bin/python" "$COMFY_DIR/.venv/bin/python" "$(command -v python 2>/dev/null)" "$(command -v python3)"; do
    [ -n "$candidate" ] && [ -x "$candidate" ] && PYTHON="$candidate" && break
  done
fi
OLLAMA_DIST="${OLLAMA_DIST:-/workspace/ollama/dist}"
OLLAMA_TARBALL_URL="${OLLAMA_TARBALL_URL:-https://github.com/ollama/ollama/releases/latest/download/ollama-linux-amd64.tar.zst}"
LOG_DIR=/workspace/saa/logs
PULL_MODELS=""
START_COMFY=1

while [ $# -gt 0 ]; do
  case "$1" in
    --pull) PULL_MODELS="$PULL_MODELS $(printf '%s' "$2" | tr ',' ' ')"; shift 2 ;;
    --no-comfy) START_COMFY=0; shift ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

mkdir -p "$LOG_DIR" /workspace/ollama/models
log() { printf '[bootstrap] %s\n' "$*"; }

# ---------------------------------------------------------------- facts first
log "GPU: $(nvidia-smi --query-gpu=name,memory.total --format=csv,noheader 2>/dev/null || echo unknown)"
log "workspace: $(df -h /workspace 2>/dev/null | awk 'NR==2 {print $4 " free of " $2}')"

# ---------------------------------------------------------------- pip (volatile)
# ADetailer / tagger / metadata deps that ComfyUI custom nodes import at start,
# plus every custom node's own requirements so a rebuilt venv comes back complete.
# Some of those carry a git+ line (Impact-Pack's sam2) that prompts for GitHub
# credentials on the pod and kills the session, so those lines are filtered out.
log "python: $PYTHON"
if ! "$PYTHON" -c "import onnxruntime, piexif, ultralytics, segment_anything" >/dev/null 2>&1; then
  log "restoring pip packages (this takes about a minute)"
  REQ_DIR=/workspace/saa/reqs
  rm -rf "$REQ_DIR"; mkdir -p "$REQ_DIR"
  REQ_ARGS=()
  for req in "$COMFY_DIR"/custom_nodes/*/requirements.txt; do
    [ -f "$req" ] || continue
    node_name=$(basename "$(dirname "$req")")
    grep -v 'git+' "$req" > "$REQ_DIR/$node_name.txt"
    REQ_ARGS+=(-r "$REQ_DIR/$node_name.txt")
  done
  "$PYTHON" -m pip install --quiet onnxruntime piexif segment-anything ultralytics "${REQ_ARGS[@]}" > "$LOG_DIR/pip.log" 2>&1 \
    && log "pip packages restored" \
    || log "pip restore FAILED - see $LOG_DIR/pip.log"
else
  log "pip packages already present"
fi

# ---------------------------------------------------------------- ollama (durable)
if [ ! -x "$OLLAMA_DIST/bin/ollama" ]; then
  log "installing Ollama into $OLLAMA_DIST"
  mkdir -p "$OLLAMA_DIST" /workspace/ollama/dl
  TARBALL=/workspace/ollama/dl/ollama-linux-amd64.tar.zst
  [ -s "$TARBALL" ] || curl -L -sS -o "$TARBALL" "$OLLAMA_TARBALL_URL"
  if ! command -v zstd >/dev/null 2>&1; then
    (apt-get update && apt-get install -y zstd) > "$LOG_DIR/apt.log" 2>&1 || log "zstd install failed - see $LOG_DIR/apt.log"
  fi
  tar --zstd -xf "$TARBALL" -C "$OLLAMA_DIST" && log "Ollama extracted" || log "Ollama extract FAILED"
fi

if ! curl -s -m 3 http://127.0.0.1:11434/api/version >/dev/null 2>&1; then
  log "starting Ollama (loopback only)"
  # flash attention + q8_0 KV cache keep a 12B Q4 model inside 12 GB; one model
  # loaded at a time (SAA unloads it before image generation needs the VRAM)
  OLLAMA_MODELS=/workspace/ollama/models OLLAMA_HOST=127.0.0.1:11434 OLLAMA_KEEP_ALIVE="${OLLAMA_KEEP_ALIVE:-10m}" \
    OLLAMA_FLASH_ATTENTION="${OLLAMA_FLASH_ATTENTION:-1}" OLLAMA_KV_CACHE_TYPE="${OLLAMA_KV_CACHE_TYPE:-q8_0}" \
    OLLAMA_MAX_LOADED_MODELS="${OLLAMA_MAX_LOADED_MODELS:-1}" OLLAMA_NUM_PARALLEL="${OLLAMA_NUM_PARALLEL:-1}" \
    nohup "$OLLAMA_DIST/bin/ollama" serve > "$LOG_DIR/ollama.log" 2>&1 &
  for _ in $(seq 1 20); do
    curl -s -m 2 http://127.0.0.1:11434/api/version >/dev/null 2>&1 && break
    sleep 1
  done
fi
if curl -s -m 3 http://127.0.0.1:11434/api/version >/dev/null 2>&1; then
  log "Ollama up: $(curl -s -m 3 http://127.0.0.1:11434/api/version)"
  log "models: $(OLLAMA_MODELS=/workspace/ollama/models "$OLLAMA_DIST/bin/ollama" list 2>/dev/null | tail -n +2 | awk '{print $1}' | tr '\n' ' ')"
else
  log "Ollama did not come up - see $LOG_DIR/ollama.log"
fi

for PULL_MODEL in $PULL_MODELS; do
  log "pulling $PULL_MODEL (large download, keep the session open)"
  OLLAMA_MODELS=/workspace/ollama/models "$OLLAMA_DIST/bin/ollama" pull "$PULL_MODEL" 2>&1 | tail -n 2
done

# ---------------------------------------------------------------- comfyui
# Restarted so the custom nodes see the restored packages. Outputs and temp
# files go to RAM (/dev/shm): nothing generated is written to the pod's disks.
if [ "$START_COMFY" = 1 ]; then
  if pgrep -f "main.py --listen" >/dev/null 2>&1; then
    # /proc/<pid>/cmdline separates the arguments with NULs, hence the tr.
    if tr '\0' ' ' < "/proc/$(pgrep -f "main.py --listen" | head -1)/cmdline" 2>/dev/null \
         | grep -q -- "--output-directory /dev/shm" \
       && "$PYTHON" -c "import onnxruntime, ultralytics" >/dev/null 2>&1; then
      log "ComfyUI already running with RAM output dirs"
    else
      log "restarting ComfyUI"
      pkill -f "main.py --listen"; sleep 2
    fi
  fi
  if ! pgrep -f "main.py --listen" >/dev/null 2>&1; then
    mkdir -p /dev/shm/comfy_out /dev/shm/comfy_tmp
    # ComfyUI aborts on a missing --extra-model-paths-config file, so the flag is
    # only passed once provision.sh has put the config in place.
    EXTRA_ARGS=()
    if [ -f "$EXTRA_MODEL_PATHS" ]; then
      EXTRA_ARGS=(--extra-model-paths-config "$EXTRA_MODEL_PATHS")
    else
      log "no $EXTRA_MODEL_PATHS - starting without the /workspace/models roots"
    fi
    (cd "$COMFY_DIR" && nohup "$PYTHON" main.py --listen 0.0.0.0 --port "$COMFY_PORT" --enable-cors-header \
        "${EXTRA_ARGS[@]}" \
        --output-directory /dev/shm/comfy_out --temp-directory /dev/shm/comfy_tmp > "$LOG_DIR/comfy.log" 2>&1 &)
    for _ in $(seq 1 90); do
      curl -s -m 2 "http://127.0.0.1:$COMFY_PORT/system_stats" >/dev/null 2>&1 && break
      sleep 1
    done
  fi
  if curl -s -m 3 "http://127.0.0.1:$COMFY_PORT/system_stats" >/dev/null 2>&1; then
    log "ComfyUI up on $COMFY_PORT ($(grep -c 'IMPORT FAILED' "$LOG_DIR/comfy.log" 2>/dev/null; true) custom node import failures)"
  else
    log "ComfyUI did not come up - see $LOG_DIR/comfy.log"
  fi
fi
log "done"
