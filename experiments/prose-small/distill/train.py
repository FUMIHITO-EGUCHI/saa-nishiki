"""Prose distillation: LoRA fine-tune of a small chat model on teacher.jsonl.

Runs in the WSL venv (~/distill/.venv, unsloth + trl). The student learns the
teacher's paragraph from the same JSON fields, but under a short system prompt, so
SAA can drop the 900-token rule text once it switches models.

    python train.py --model Qwen/Qwen3.5-2B --data teacher.jsonl --out out/qwen35-2b [--epochs 2] [--max-rows N]

Writes the LoRA adapter, the merged bf16 model (out/<name>/merged) and, when the
gguf converter is importable, a q8_0 GGUF next to it.
"""
import argparse, json, os, random, subprocess, sys

# The short system prompt the student is trained under; qa-llamaserver.mjs --system reads
# the same file, so the app and the bench send exactly what training saw.
with open(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'student-system.txt'), encoding='utf-8') as _f:
    STUDENT_SYSTEM = _f.read().strip()

def load_rows(path, max_rows=None, seed=1):
    rows = []
    with open(path, encoding='utf-8') as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            r = json.loads(line)
            if not r.get('ok'):
                continue
            user = json.dumps(r['fields'], ensure_ascii=False, indent=2)
            assistant = json.dumps({'prompt': r['prompt']}, ensure_ascii=False)
            rows.append({'messages': [
                {'role': 'system', 'content': STUDENT_SYSTEM},
                {'role': 'user', 'content': user},
                {'role': 'assistant', 'content': assistant},
            ], 'source': {k: r[k] for k in ('id', 'lang', 'count', 'scope', 'fields', 'prompt') if k in r}})
    random.Random(seed).shuffle(rows)
    if max_rows:
        rows = rows[:max_rows]
    return rows

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--model', default='Qwen/Qwen3.5-2B')
    ap.add_argument('--data', default='teacher.jsonl')
    ap.add_argument('--out', default='out/student')
    ap.add_argument('--epochs', type=float, default=2)
    ap.add_argument('--lr', type=float, default=2e-4)
    ap.add_argument('--rank', type=int, default=32)
    ap.add_argument('--max-rows', type=int, default=None)
    ap.add_argument('--max-seq', type=int, default=1024)
    ap.add_argument('--batch', type=int, default=4)
    ap.add_argument('--grad-accum', type=int, default=4)
    ap.add_argument('--eval-rows', type=int, default=100)
    ap.add_argument('--no-gguf', action='store_true')
    ap.add_argument('--merge-only', action='store_true', help='skip training; merge out/<name>/lora into the base and convert')
    args = ap.parse_args()
    if args.merge_only:
        merge_and_convert(args)
        return

    from unsloth import FastLanguageModel
    from datasets import Dataset
    from trl import SFTTrainer, SFTConfig
    import torch

    rows = load_rows(args.data, args.max_rows)
    eval_rows, train_rows = rows[:args.eval_rows], rows[args.eval_rows:]
    print(f'{len(train_rows)} train rows, {len(eval_rows)} eval rows', flush=True)
    # the held-out rows in the input shape, for eval.mjs against the exported GGUF
    os.makedirs(args.out, exist_ok=True)
    with open(os.path.join(args.out, 'holdout.jsonl'), 'w', encoding='utf-8') as f:
        for r in eval_rows:
            f.write(json.dumps(r['source'], ensure_ascii=False) + '\n')

    model, tokenizer = FastLanguageModel.from_pretrained(
        model_name=args.model, max_seq_length=args.max_seq, dtype=torch.bfloat16, load_in_4bit=False,
    )
    model = FastLanguageModel.get_peft_model(
        model, r=args.rank, lora_alpha=args.rank, lora_dropout=0.0, bias='none',
        target_modules=['q_proj', 'k_proj', 'v_proj', 'o_proj', 'gate_proj', 'up_proj', 'down_proj'],
        use_gradient_checkpointing='unsloth', random_state=1,
    )

    def to_text(batch):
        return {'text': [tokenizer.apply_chat_template(m, tokenize=False, add_generation_prompt=False) for m in batch['messages']]}
    train_ds = Dataset.from_list([{'messages': r['messages']} for r in train_rows]).map(to_text, batched=True, remove_columns=['messages'])
    eval_ds = Dataset.from_list([{'messages': r['messages']} for r in eval_rows]).map(to_text, batched=True, remove_columns=['messages'])
    print(train_ds[0]['text'][:1500], flush=True)

    trainer = SFTTrainer(
        model=model, tokenizer=tokenizer, train_dataset=train_ds, eval_dataset=eval_ds,
        args=SFTConfig(
            output_dir=args.out, per_device_train_batch_size=args.batch, gradient_accumulation_steps=args.grad_accum,
            num_train_epochs=args.epochs, learning_rate=args.lr, lr_scheduler_type='cosine', warmup_ratio=0.03,
            logging_steps=10, eval_strategy='steps', eval_steps=100, save_strategy='no', bf16=True,
            max_length=args.max_seq, dataset_text_field='text', report_to='none', seed=1,
        ),
    )
    stats = trainer.train()
    print(stats, flush=True)
    print('eval', trainer.evaluate(), flush=True)

    model.save_pretrained(os.path.join(args.out, 'lora'))
    tokenizer.save_pretrained(os.path.join(args.out, 'lora'))
    del model, trainer
    torch.cuda.empty_cache()
    merge_and_convert(args)

def merge_and_convert(args):
    # Unsloth's save_pretrained_merged hard-links the HF cache file and then fails to
    # overwrite it (EACCES); merging with peft into a fresh folder avoids that.
    import shutil, torch
    from transformers import AutoModelForCausalLM, AutoTokenizer
    from peft import PeftModel
    lora = os.path.join(args.out, 'lora')
    merged = os.path.join(args.out, 'merged')
    if os.path.exists(merged):
        shutil.rmtree(merged)
    base = AutoModelForCausalLM.from_pretrained(args.model, torch_dtype=torch.bfloat16, device_map='cpu')
    # Unsloth trains the multimodal class, whose modules sit under "model.language_model.";
    # the CausalLM class here has them at "model.". An adapter saved with the former's names
    # loads into the latter as "missing adapter keys" and the merge silently applies nothing,
    # so the adapter is rewritten with the names this model has before merging.
    from safetensors.torch import load_file as _load, save_file as _save
    have = set(n for n, _ in base.named_modules())
    adapter = _load(os.path.join(lora, 'adapter_model.safetensors'))
    renamed, unmatched = {}, []
    for key, tensor in adapter.items():
        module = key.removeprefix('base_model.model.').rsplit('.lora_', 1)[0]
        if module not in have and module.replace('language_model.', '', 1) in have:
            key = key.replace('language_model.', '', 1)
        elif module not in have:
            unmatched.append(module)
        renamed[key] = tensor
    if unmatched:
        raise RuntimeError(f'{len(unmatched)} adapter modules not in the base model, e.g. {unmatched[:3]}')
    lora_fixed = os.path.join(args.out, 'lora-merge')
    shutil.copytree(lora, lora_fixed, dirs_exist_ok=True)
    _save(renamed, os.path.join(lora_fixed, 'adapter_model.safetensors'), metadata={'format': 'pt'})
    before = {n: p.detach().clone() for n, p in base.named_parameters() if 'layers.0.' in n and 'proj' in n}
    model = PeftModel.from_pretrained(base, lora_fixed).merge_and_unload()
    changed = sum(1 for n, p in model.named_parameters() if n in before and not torch.equal(p, before[n]))
    print(f'merge: {len(renamed)} adapter tensors, {changed}/{len(before)} sampled layer-0 weights changed', flush=True)
    if changed == 0:
        raise RuntimeError('merge changed no weights: the adapter did not attach')
    model.save_pretrained(merged, safe_serialization=True)
    AutoTokenizer.from_pretrained(lora).save_pretrained(merged)
    # The CausalLM class drops the base's MTP head tensors (mtp.*) while the config keeps
    # announcing them; the converter insists on them for qwen35 and llama.cpp then looks
    # for a layer that is not there. Put the base's MTP tensors back (the head still
    # drafts against the fine-tuned trunk, only with a lower acceptance rate).
    import glob
    from safetensors import safe_open
    from safetensors.torch import load_file, save_file
    from huggingface_hub import snapshot_download
    mtp = {}
    for p in glob.glob(os.path.join(snapshot_download(args.model), '*.safetensors')):
        with safe_open(p, 'pt') as f:
            for k in f.keys():
                if k.startswith('mtp.'):
                    mtp[k] = f.get_tensor(k)
    index_path = os.path.join(merged, 'model.safetensors.index.json')
    if os.path.exists(index_path):
        shard = os.path.join(merged, 'model-mtp.safetensors')
        save_file(mtp, shard, metadata={'format': 'pt'})
        with open(index_path, encoding='utf-8') as f:
            index = json.load(f)
        index['weight_map'].update({k: 'model-mtp.safetensors' for k in mtp})
        with open(index_path, 'w', encoding='utf-8') as f:
            json.dump(index, f, indent=2)
    else:
        single = os.path.join(merged, 'model.safetensors')
        tensors = load_file(single)
        tensors.update(mtp)
        save_file(tensors, single, metadata={'format': 'pt'})
    print(f'merged -> {merged} (+{len(mtp)} mtp tensors)', flush=True)

    if not args.no_gguf:
        candidates = [os.environ.get('LLAMA_CPP_DIR', ''), '/workspace/distill/llama.cpp', os.path.expanduser('~/distill/llama.cpp')]
        conv = next((os.path.join(d, 'convert_hf_to_gguf.py') for d in candidates if d and os.path.exists(os.path.join(d, 'convert_hf_to_gguf.py'))), None)
        if conv:
            gguf = os.path.join(args.out, 'student-q8_0.gguf')
            subprocess.run([sys.executable, conv, merged, '--outtype', 'q8_0', '--outfile', gguf], check=True)
            print('gguf ->', gguf, flush=True)
        else:
            print('convert_hf_to_gguf.py not found; clone llama.cpp into ~/distill/llama.cpp for the GGUF step', flush=True)

if __name__ == '__main__':
    main()
