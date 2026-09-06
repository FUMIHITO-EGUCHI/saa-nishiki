#!/usr/bin/env bash
# SAA pod bootstrap: restore what a Runpod STOP -> START wipes and bring the
# services up. Everything durable lives under /workspace; the container disk
# (pip site-packages, /usr/local) is volatile.
#
#   bash /workspace/saa/bootstrap.sh                # restore + start (idempotent)
#   bash /workspace/saa/bootstrap.sh --pull MODEL   # also pull an Ollama model
#   bash /workspace/saa/bootstrap.sh --no-comfy     # leave ComfyUI as it is
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
PULL_MODEL=""
START_COMFY=1

while [ $# -gt 0 ]; do
  case "$1" in
    --pull) PULL_MODEL="$2"; shift 2 ;;
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
# ADetailer / tagger / metadata deps that ComfyUI custom nodes import at start.
# Impact-Pack's requirements carry a git+ line (sam2) that prompts for GitHub
# credentials on the pod and kills the session, so it is filtered out.
log "python: $PYTHON"
if ! "$PYTHON" -c "import onnxruntime, piexif, ultralytics, segment_anything" >/dev/null 2>&1; then
  log "restoring pip packages (this takes about a minute)"
  IMPACT_REQ="$COMFY_DIR/custom_nodes/ComfyUI-Impact-Pack/requirements.txt"
  REQ_ARGS=()
  if [ -f "$IMPACT_REQ" ]; then
    grep -v 'git+' "$IMPACT_REQ" > /workspace/saa/impact-req.txt
    REQ_ARGS=(-r /workspace/saa/impact-req.txt)
  fi
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
  OLLAMA_MODELS=/workspace/ollama/models OLLAMA_HOST=127.0.0.1:11434 OLLAMA_KEEP_ALIVE="${OLLAMA_KEEP_ALIVE:-10m}" \
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

if [ -n "$PULL_MODEL" ]; then
  log "pulling $PULL_MODEL (large download, keep the session open)"
  OLLAMA_MODELS=/workspace/ollama/models "$OLLAMA_DIST/bin/ollama" pull "$PULL_MODEL" 2>&1 | tail -n 2
fi

# ---------------------------------------------------------------- comfyui
# Restarted so the custom nodes see the restored packages. Outputs and temp
# files go to RAM (/dev/shm): nothing generated is written to the pod's disks.
if [ "$START_COMFY" = 1 ]; then
  if pgrep -f "main.py --listen" >/dev/null 2>&1; then
    if grep -q "output-directory /dev/shm" /proc/$(pgrep -f "main.py --listen" | head -1)/cmdline 2>/dev/null \
       && "$PYTHON" -c "import onnxruntime, ultralytics" >/dev/null 2>&1; then
      log "ComfyUI already running with RAM output dirs"
    else
      log "restarting ComfyUI"
      pkill -f "main.py --listen"; sleep 2
    fi
  fi
  if ! pgrep -f "main.py --listen" >/dev/null 2>&1; then
    mkdir -p /dev/shm/comfy_out /dev/shm/comfy_tmp
    (cd "$COMFY_DIR" && nohup "$PYTHON" main.py --listen 0.0.0.0 --port "$COMFY_PORT" --enable-cors-header \
        --extra-model-paths-config "$EXTRA_MODEL_PATHS" \
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
