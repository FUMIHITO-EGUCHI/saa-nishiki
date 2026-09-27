#!/bin/bash
# Student v2, in the WSL venv (~/distill): the local teacher rows (teacher.jsonl, the
# first 569 from 2026-09-25) plus the v2 batch (teacher-v2.jsonl: characters by name
# alone, multi-sentence state actions), 3 epochs on the abliterated Qwen3.5-2B, merged,
# converted, copied next to v1 as student-v2-q8_0.gguf.
#   wsl -d Ubuntu-24.04 -e bash -lc '~/distill/train-v2.sh'
set -u
cd ~/distill
export PATH="$HOME/.local/bin:$PATH"
source .venv/bin/activate
D=/mnt/c/Users/kurah/Documents/Git/SAA-regional/experiments/prose-small/distill
cp "$D/train.py" "$D/student-system.txt" ~/distill/
cat "$D/teacher.jsonl" "$D/teacher-v2.jsonl" > ~/distill/teacher-v2-all.jsonl
echo "TRAIN_START $(date) rows=$(grep -c '"ok":true' ~/distill/teacher-v2-all.jsonl)"
python train.py --model huihui-ai/Huihui-Qwen3.5-2B-abliterated --data ~/distill/teacher-v2-all.jsonl --out out/v2 --epochs 3 --eval-rows 100 --batch 4 --grad-accum 4
echo TRAIN_EXIT=$?
cp out/v2/student-q8_0.gguf "/mnt/c/Users/kurah/Documents/Codex/2026-08-15/huggingface-llm-uncensored/wai-stack/models/llm/student-v2-q8_0.gguf" && echo COPIED
cp out/v2/holdout.jsonl "$D/holdout-v2.jsonl"
echo TRAIN_V2_DONE
