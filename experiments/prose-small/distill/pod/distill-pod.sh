#!/usr/bin/env bash
# Prose distillation on a Runpod pod (RTX 4090 24 GB or larger): teacher answers from
# Gemma4-12B-QAT-Uncensored (all layers on the GPU, 4 parallel slots) through a prebuilt
# llama.cpp llama-server (ubuntu cuda 12.8 release), then the Qwen3.5-2B LoRA in a uv venv, merge, GGUF.
# Everything durable goes under /workspace (survives STOP -> START).
#
#   bash distill-pod.sh prepare   # llama-server + teacher GGUF, node, venv, converter (idempotent)
#   bash distill-pod.sh build     # only when the release binary fails (glibc): compile llama-server here
#   bash distill-pod.sh teach     # inputs.jsonl -> teacher.jsonl (nohup, log in /workspace/distill/logs)
#   bash distill-pod.sh train     # teacher.jsonl -> out/v1/student-q8_0.gguf
#   bash distill-pod.sh status    # progress of both
#
# Files to upload first (runpodctl send, or the relay):
#   /workspace/distill/repo/scripts/shared/prosePrompt.js   (+ castMembers.js it imports)
#   /workspace/distill/repo/experiments/prose-small/distill/{teach.mjs,train.py,eval.mjs,student-system.txt,inputs.jsonl}
# The tarball made by pack.ps1 next to this script lays them out exactly like that.
set -u
D=/workspace/distill
LOG=$D/logs
REPO=$D/repo
DIST=$REPO/experiments/prose-small/distill
STUDENT=${STUDENT:-huihui-ai/Huihui-Qwen3.5-2B-abliterated}
PORT=${PORT:-8089}
SLOTS=${SLOTS:-4}
mkdir -p "$LOG" "$D/hf"
export HF_HOME=$D/hf
log() { printf '[distill] %s\n' "$*"; }

LLAMA_DIR=$D/llama-bin
# Teacher: Qwen3.5-35B-A3B uncensored (the 12B Gemma leaves "@1" refs in half its answers).
# 22 GB Q4: fits whole on a 40 GB+ card; on 24 GB the experts of the first N layers stay on the CPU.
TEACHER_REPO=${TEACHER_REPO:-HauhauCS/Qwen3.5-35B-A3B-Uncensored-HauhauCS-Aggressive}
GGUF=$D/models/${TEACHER_FILE:-Qwen3.5-35B-A3B-Uncensored-HauhauCS-Aggressive-Q4_K_M.gguf}
LLAMA_TAG=${LLAMA_TAG:-b11173}
llama_server() { echo "$LLAMA_DIR/llama-server"; }

prepare() {
  log "GPU: $(nvidia-smi --query-gpu=name,memory.total,driver_version --format=csv,noheader 2>/dev/null || echo unknown)"
  mkdir -p "$LLAMA_DIR" "$D/models"
  if [ ! -x "$LLAMA_DIR/llama-server" ]; then
    log "fetching llama.cpp $LLAMA_TAG (ubuntu cuda 12.8 build + cudart)"
    for f in "llama-$LLAMA_TAG-bin-ubuntu-cuda-12.8-x64.tar.gz" "cudart-llama-$LLAMA_TAG-bin-ubuntu-cuda-12.8-x64.tar.gz"; do
      curl -L -sS -o "$D/$f" "https://github.com/ggml-org/llama.cpp/releases/download/$LLAMA_TAG/$f" && tar -xzf "$D/$f" -C "$LLAMA_DIR" --strip-components=1 && rm -f "$D/$f"
    done
    # the tarball nests bin/ and lib/; flatten so llama-server finds its .so files next to it
    [ -x "$LLAMA_DIR/bin/llama-server" ] && cp -a "$LLAMA_DIR/bin/." "$LLAMA_DIR/" && ([ -d "$LLAMA_DIR/lib" ] && cp -a "$LLAMA_DIR/lib/." "$LLAMA_DIR/" || true)
    find "$LLAMA_DIR" -maxdepth 1 -name '*.so*' | head -n 3
  fi
  export LD_LIBRARY_PATH="$LLAMA_DIR:${LD_LIBRARY_PATH:-}"
  "$LLAMA_DIR/llama-server" --version 2>&1 | grep -i version || log "llama-server does not run"
  if [ ! -s "$GGUF" ]; then
    log "fetching the teacher GGUF (about 22 GB)"
    curl -L -sS -o "$GGUF" "https://huggingface.co/$TEACHER_REPO/resolve/main/$(basename "$GGUF")"
  fi
  log "teacher gguf: $(du -h "$GGUF" | cut -f1)"
  if ! command -v node >/dev/null && [ ! -x "$D/node/bin/node" ]; then
    log "installing node"
    mkdir -p "$D/node"
    curl -L -sS https://nodejs.org/dist/v22.12.0/node-v22.12.0-linux-x64.tar.xz | tar -xJ -C "$D/node" --strip-components=1
  fi
  export PATH="$D/node/bin:$HOME/.local/bin:$PATH"
  log "node $(node --version)"
  if [ ! -x "$HOME/.local/bin/uv" ] && ! command -v uv >/dev/null; then
    curl -LsSf https://astral.sh/uv/install.sh | sh >/dev/null
  fi
  if [ ! -d "$D/.venv" ]; then
    log "creating venv (torch cu128 + unsloth, several minutes)"
    uv python install 3.12 >/dev/null
    uv venv --python 3.12 --python-preference only-managed "$D/.venv" >/dev/null
    . "$D/.venv/bin/activate"
    # cu128 wheels want driver >= 570; older hosts (CUDA 12.4 drivers) get cu126, which the
    # 12.x minor-version compatibility runs on a 525+ driver
    local drv; drv=$(nvidia-smi --query-gpu=driver_version --format=csv,noheader | head -n 1 | cut -d. -f1)
    local cu=cu128; [ "${drv:-570}" -lt 570 ] && cu=cu126
    log "torch index $cu (driver $drv)"
    uv pip install torch torchvision --index-url "https://download.pytorch.org/whl/$cu" >/dev/null
    uv pip install unsloth trl peft datasets transformers accelerate sentencepiece protobuf huggingface_hub >/dev/null
  fi
  . "$D/.venv/bin/activate"
  if [ ! -f "$D/llama.cpp/convert_hf_to_gguf.py" ]; then
    log "fetching llama.cpp source (converter + gguf-py)"
    curl -sL -o "$D/llama.zip" https://github.com/ggml-org/llama.cpp/archive/refs/heads/master.zip
    python - <<'PY'
import zipfile, os, shutil
d = '/workspace/distill'
z = zipfile.ZipFile(os.path.join(d, 'llama.zip')); top = z.namelist()[0].split('/')[0]
z.extractall(d)
if os.path.exists(os.path.join(d, 'llama.cpp')): shutil.rmtree(os.path.join(d, 'llama.cpp'))
os.rename(os.path.join(d, top), os.path.join(d, 'llama.cpp'))
PY
    rm -f "$D/llama.zip"
    uv pip install -e "$D/llama.cpp/gguf-py" >/dev/null
  fi
  python -c "from huggingface_hub import snapshot_download; print('student base at', snapshot_download('$STUDENT'))"
  python -c "import torch, unsloth; print('torch', torch.__version__, 'cuda', torch.cuda.is_available())"
  log "prepare done"
}

build() {
  # The release binaries need glibc 2.38 (Ubuntu 24.04); on an older image build llama-server
  # from the source zip that prepare fetched for the converter. cmake comes from uv, nvcc
  # from the image's CUDA toolkit.
  . "$D/.venv/bin/activate"
  export PATH="/usr/local/cuda/bin:$HOME/.local/bin:$PATH"
  command -v cmake >/dev/null || uv pip install cmake ninja >/dev/null
  local arch; arch=$(nvidia-smi --query-gpu=compute_cap --format=csv,noheader | head -n 1 | tr -d '.')
  log "building llama-server for sm_$arch with $(nvcc --version | tail -n 1)"
  cd "$D/llama.cpp"
  cmake -B build -G Ninja -DGGML_CUDA=ON -DCMAKE_CUDA_ARCHITECTURES="$arch" -DLLAMA_CURL=OFF -DCMAKE_BUILD_TYPE=Release > "$LOG/cmake.log" 2>&1 \
    && cmake --build build --config Release -j "$(nproc)" --target llama-server >> "$LOG/cmake.log" 2>&1 \
    || { log "build failed, see $LOG/cmake.log"; tail -n 5 "$LOG/cmake.log"; exit 1; }
  rm -rf "$LLAMA_DIR" && mkdir -p "$LLAMA_DIR"
  cp build/bin/llama-server "$LLAMA_DIR/"
  find build -name '*.so*' -exec cp -a {} "$LLAMA_DIR/" \;
  LD_LIBRARY_PATH="$LLAMA_DIR" "$LLAMA_DIR/llama-server" --list-devices 2>&1 | grep -E 'CUDA|version'
  log "build done"
}

teach() {
  export PATH="$D/node/bin:$PATH"
  export LD_LIBRARY_PATH="$LLAMA_DIR:${LD_LIBRARY_PATH:-}"
  local blob; blob=$GGUF
  [ -s "$blob" ] || { log "teacher gguf missing; run prepare"; exit 1; }
  if ! curl -s "http://127.0.0.1:$PORT/health" | grep -q ok; then
    log "starting llama-server on :$PORT ($SLOTS slots, all layers on the GPU)"
    nohup "$(llama_server)" -m "$blob" --port "$PORT" -ngl 99 -fa on -c $((4096 * SLOTS)) -np "$SLOTS" -b 1024 -ub 1024 \
      --jinja --reasoning-budget 0 --no-webui --cache-ram 8192 --swa-full > "$LOG/llama-server.log" 2>&1 &
    for i in $(seq 1 60); do sleep 2; curl -s "http://127.0.0.1:$PORT/health" | grep -q ok && break; done
  fi
  cd "$REPO"
  LLAMA_URL="http://127.0.0.1:$PORT" nohup node "$DIST/teach.mjs" --in="$DIST/inputs.jsonl" --out="$DIST/teacher.jsonl" --parallel="$SLOTS" > "$LOG/teach.log" 2>&1 &
  log "teach.mjs started; tail $LOG/teach.log"
}

train() {
  . "$D/.venv/bin/activate"
  cd "$DIST"
  nohup python train.py --model "$STUDENT" --data teacher.jsonl --out "$D/out/v1" --epochs 2 --eval-rows 100 --batch 8 --grad-accum 2 > "$LOG/train.log" 2>&1 &
  log "train.py started; tail $LOG/train.log; GGUF lands in $D/out/v1/student-q8_0.gguf"
}

status() {
  [ -f "$DIST/teacher.jsonl" ] && log "teacher rows: $(wc -l < "$DIST/teacher.jsonl") (ok: $(grep -c '"ok":true' "$DIST/teacher.jsonl"))"
  [ -f "$LOG/teach.log" ] && tail -n 2 "$LOG/teach.log"
  [ -f "$LOG/train.log" ] && grep -E "train rows|loss|eval|gguf ->|Traceback" "$LOG/train.log" | tail -n 5
  ls -la "$D/out/v1/student-q8_0.gguf" 2>/dev/null
}

case "${1:-}" in
  prepare) prepare ;;
  build) build ;;
  teach) teach ;;
  train) train ;;
  status) status ;;
  *) echo "usage: $0 prepare|teach|train|status"; exit 2 ;;
esac
