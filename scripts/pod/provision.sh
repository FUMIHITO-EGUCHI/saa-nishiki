#!/usr/bin/env bash
# One-time provisioning of a fresh Runpod pod for SAA: the custom nodes and the
# model files that bootstrap.sh expects to already be on /workspace. A stock
# runpod-slim pod has ComfyUI and its venv but neither of those, so this runs
# once per pod (the setup wizard in SAA drives it through the SSH relay).
#
# Re-runnable: anything already present with the right sha256 is skipped.
#
#   bash /workspace/saa/provision.sh                       # everything except the checkpoint
#   bash /workspace/saa/provision.sh --components nodes,fastlora
#   CIVITAI_TOKEN=xxxx bash /workspace/saa/provision.sh    # the checkpoint as well
#
# Components (--components takes a comma separated subset, default: all but checkpoint):
#   nodes       ComfyUI_Mira, MiraSubPack, Impact-Pack, Impact-Subpack, controlnet_aux
#   checkpoint  waiIllustriousSDXL_v170 (needs CIVITAI_TOKEN; Civitai answers 403 without one)
#   fastlora    DMD2 4-step LoRA, what SAA's fast mode applies
#   adetailer   face / hand YOLO detectors and the SAM model FaceDetailer needs
#   upscaler    RealESRGAN_x4plus_anime_6B, the Hires fix upscaler
#   controlnet  the SDXL openpose ControlNet
#   pip         the custom nodes' own requirements
set -u

COMFY_DIR=/workspace/runpod-slim/ComfyUI
NODES="$COMFY_DIR/custom_nodes"
MODELS=/workspace/models
LOG_DIR=/workspace/saa/logs
PYTHON="$COMFY_DIR/.venv-cu128/bin/python"
ALL_COMPONENTS="nodes fastlora adetailer upscaler controlnet checkpoint pip"
COMPONENTS="nodes fastlora adetailer upscaler controlnet pip"
[ -n "${CIVITAI_TOKEN:-}" ] && COMPONENTS="$COMPONENTS checkpoint"

while [ $# -gt 0 ]; do
  case "$1" in
    --components) COMPONENTS=$(printf '%s' "$2" | tr ',' ' '); shift 2 ;;
    --all) COMPONENTS="$ALL_COMPONENTS"; shift ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

want() { case " $COMPONENTS " in *" $1 "*) return 0 ;; *) return 1 ;; esac; }

mkdir -p "$LOG_DIR" "$MODELS"/{checkpoints,loras,vae,controlnet,upscale_models,embeddings,clip_vision,ultralytics/bbox,ultralytics/segm,sams}
log() { printf '[provision] %s\n' "$*"; }
log "components: $COMPONENTS"

# ------------------------------------------------------------------ custom nodes
# GitHub can rate-limit a Runpod IP into an auth prompt on `git clone`, which kills
# the SSH session; the codeload tarballs need no credentials.
fetch_node() {
    local repo="$1" name="$2"; shift 2
    if [ -d "$NODES/$name" ]; then log "$name already installed"; return 0; fi
    local tmp; tmp=$(mktemp -d)
    for branch in "$@"; do
        if curl -fL -sS -m 300 -o "$tmp/src.tar.gz" \
             "https://codeload.github.com/$repo/tar.gz/refs/heads/$branch"; then
            mkdir -p "$tmp/x" && tar -xzf "$tmp/src.tar.gz" -C "$tmp/x" || { log "$name: extract failed"; rm -rf "$tmp"; return 1; }
            mv "$tmp/x"/*/ "$NODES/$name" && log "$name installed (branch $branch)"
            rm -rf "$tmp"; return 0
        fi
    done
    log "$name: no branch of $repo could be downloaded (${*})"
    rm -rf "$tmp"; return 1
}

if want nodes; then
    fetch_node mirabarukaso/ComfyUI_Mira         ComfyUI_Mira            main master
    fetch_node mirabarukaso/ComfyUI_MiraSubPack  ComfyUI_MiraSubPack     main master
    fetch_node ltdrdata/ComfyUI-Impact-Pack      ComfyUI-Impact-Pack     Main main
    fetch_node ltdrdata/ComfyUI-Impact-Subpack   ComfyUI-Impact-Subpack  Main main
    fetch_node Fannovel16/comfyui_controlnet_aux comfyui_controlnet_aux  main
fi

# ------------------------------------------------------------------ models
human() {
    awk -v b="${1:-0}" 'BEGIN { split("B KB MB GB TB", u, " "); i = 1;
        while (b >= 1024 && i < 5) { b /= 1024; i++ }
        printf (i == 1 ? "%d %s" : "%.1f %s"), b, u[i] }'
}

# get_model <dest> <sha256> <url> <expected bytes> [token]
# Downloads in the background and reports how far it got every few seconds, so a
# multi-GB file does not look like a hang in SAA's wizard. With a token the whole
# request is fed to curl on stdin (-K -): a token in the URL would otherwise be
# visible in `ps` for the length of the download.
get_model() {
    local dest="$1" sha="$2" url="$3" total="${4:-0}" token="${5:-}" name
    name=$(basename "$dest")
    if [ -f "$dest" ] && [ "$(sha256sum "$dest" | cut -d' ' -f1)" = "$sha" ]; then
        log "$name already present (sha ok)"; return 0
    fi
    log "downloading $name ($(human "$total"))"
    rm -f "$dest.part"
    if [ -n "$token" ]; then
        case "$url" in *\?*) url="$url&token=$token" ;; *) url="$url?token=$token" ;; esac
        printf 'url = "%s"\noutput = "%s"\n' "$url" "$dest.part" | curl -fL -sS -m 7200 -K - &
    else
        curl -fL -sS -m 7200 -o "$dest.part" "$url" &
    fi
    local pid=$! last=-1 got
    while kill -0 "$pid" 2>/dev/null; do
        sleep 2
        got=$(stat -c %s "$dest.part" 2>/dev/null || echo 0)
        [ "$got" = "$last" ] && continue
        last="$got"
        if [ "$total" -gt 0 ] 2>/dev/null; then
            log "  $name $(human "$got") / $(human "$total") ($((got * 100 / total))%)"
        else
            log "  $name $(human "$got")"
        fi
    done
    wait "$pid" || { log "$name: download FAILED"; rm -f "$dest.part"; return 1; }
    local digest; digest=$(sha256sum "$dest.part" | cut -d' ' -f1)
    if [ "$digest" = "$sha" ]; then
        mv "$dest.part" "$dest"; log "$name ok"
    else
        log "$name SHA MISMATCH: got $digest want $sha (kept as .part)"
        return 1
    fi
}

if want adetailer; then
    get_model "$MODELS/ultralytics/bbox/face_yolov8m.pt" \
        717923c19b3f4bbf5250b728f1fa6b2cb72a33aed1d236ea9caf0e21ad943e5f \
        https://huggingface.co/Bingsu/adetailer/resolve/main/face_yolov8m.pt 52026019
    get_model "$MODELS/ultralytics/bbox/hand_yolov8n.pt" \
        3991202eb69e9ddcb3b9ba80cdeb41e734ffaf844403d6c9f47d515cd88c6f29 \
        https://huggingface.co/Bingsu/adetailer/resolve/main/hand_yolov8n.pt 6237883
    get_model "$MODELS/sams/sam_vit_b_01ec64.pth" \
        ec2df62732614e57411cdcf32a23ffdf28910380d03139ee0f4fcbe91eb8c912 \
        https://dl.fbaipublicfiles.com/segment_anything/sam_vit_b_01ec64.pth 375042383
fi

if want upscaler; then
    get_model "$MODELS/upscale_models/RealESRGAN_x4plus_anime_6B.pth" \
        f872d837d3c90ed2e05227bed711af5671a6fd1c9f7d7e91c911a61f155e99da \
        https://github.com/xinntao/Real-ESRGAN/releases/download/v0.2.2.4/RealESRGAN_x4plus_anime_6B.pth 17938799
fi

if want fastlora; then
    get_model "$MODELS/loras/dmd2_sdxl_4step_lora_fp16.safetensors" \
        b3d9173815a4b595991c3a7a0e0e63ad821080f314a0b2a3cc31ecd7fcf2cbb8 \
        https://huggingface.co/tianweiy/DMD2/resolve/main/dmd2_sdxl_4step_lora_fp16.safetensors 393854592
fi

if want controlnet; then
    get_model "$MODELS/controlnet/control-lora-openposeXL2-rank256.safetensors" \
        8afa079285bf9384eaf8f6322884cb4f24bbe405da490f91f5540d3bff585e75 \
        https://huggingface.co/thibaud/controlnet-openpose-sdxl-1.0/resolve/main/control-lora-openposeXL2-rank256.safetensors 774423024
fi

# The checkpoint lives on Civitai, which refuses an unauthenticated download.
# CIVITAI_TOKEN arrives in the environment, never on a command line, so it stays
# out of `ps` and out of the log below.
#
# The plain version URL is the one to use: Civitai answers 404 when the query
# narrows the file to a variant that does not exist, and this build is published
# as a pruned fp16 file rather than a full one.
CKPT="$MODELS/checkpoints/waiIllustriousSDXL_v170.safetensors"
CKPT_SHA=f116b0c78ff441467b0cdc8f1936e1ed18ea31e9997c7b132b1b8db533f0bd04
CKPT_BYTES=6938040682
CKPT_URL="${CIVITAI_URL:-https://civitai.com/api/download/models/2883731}"
if want checkpoint; then
    if [ -n "${CIVITAI_TOKEN:-}" ]; then
        get_model "$CKPT" "$CKPT_SHA" "$CKPT_URL" "$CKPT_BYTES" "$CIVITAI_TOKEN"
    else
        log "checkpoint requested but CIVITAI_TOKEN is empty - Civitai answers 403 without one"
    fi
elif [ ! -f "$CKPT" ]; then
    log "no checkpoint on the pod - generation stays impossible until one is installed"
fi

# ------------------------------------------------------------------ pip (in the venv)
if want pip; then
    log "installing custom node requirements"
    REQS=()
    for req in "$NODES"/*/requirements.txt; do
        [ -f "$req" ] || continue
        node_name=$(basename "$(dirname "$req")")
        grep -v 'git+' "$req" > "/tmp/$node_name.req"   # git+ lines prompt for GitHub credentials
        REQS+=(-r "/tmp/$node_name.req")
    done
    if [ ${#REQS[@]} -gt 0 ]; then
        "$PYTHON" -m pip install --quiet "${REQS[@]}" > "$LOG_DIR/provision-pip.log" 2>&1 \
            && log "node requirements installed" \
            || log "node requirements FAILED - see $LOG_DIR/provision-pip.log"
    fi
fi

log "inventory:"
find "$MODELS" -type f \( -name '*.pt' -o -name '*.pth' -o -name '*.safetensors' -o -name '*.part' \) -printf '  %10s  %p\n' | sort -k2
ls "$NODES" | sed 's/^/  node: /'
log "done - restart ComfyUI with: bash /workspace/saa/bootstrap.sh"
