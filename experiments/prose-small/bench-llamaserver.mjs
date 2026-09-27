// The Prose request of bench.mjs sent to a llama-server (OpenAI API) instead of Ollama, so that
// flags Ollama does not pass (--cpu-moe, --swa-full, --spec-type ...) can be measured.
// Ollama ships llama-server.exe in %LOCALAPPDATA%\Programs\Ollama\lib\ollama; the CUDA backend
// lives in its cuda_v13 subfolder and is found only when GGML_BACKEND_PATH names the dll:
//
//   $src = "$env:LOCALAPPDATA\Programs\Ollama\lib\ollama"
//   $env:PATH = "$src\cuda_v13;$src;" + $env:PATH; $env:GGML_BACKEND_PATH = "$src\cuda_v13\ggml-cuda.dll"
//   & "$src\llama-server.exe" -m <blob.gguf> --port 8089 -ngl 99 --cpu-moe -fa on -c 4096 -np 1 -b 1024 -ub 1024 --jinja --reasoning-budget 0 --no-webui
//   node experiments/prose-small/bench-llamaserver.mjs [princess-carry,piggyback,headpat]
//
// Prints llama-server's own timings: prompt_n / cache_n (tokens re-processed / reused),
// prompt and decode t/s, draft acceptance when speculative decoding is on.

import { PROSE_SYSTEM_PROMPT, PROSE_RESPONSE_FORMAT, buildProseUserContent, parseProseResponse } from '../../scripts/shared/prosePrompt.js';
import { NL_CASES } from '../comfyui-regional/casesNL.mjs';

const URL_ = process.env.LLAMA_URL || 'http://127.0.0.1:8089';
const QUALITY = 'masterpiece, best quality, score_7, safe';
const EN_ACTION = {
    'princess-carry': '@1 is carrying @2 in her arms',
    piggyback: '@2 is giving @1 a piggyback ride on her back',
    headpat: '@1 is patting @2 on the head',
    'kneel-and-stand': '@2 kneels on the floor and @1 stands in front of her looking down at her',
    'hands-apart': 'the two face each other with their arms stretched out, holding hands',
    feeding: '@1 is feeding @2 with a spoon',
};

function fieldsFor(entry) {
    const scene = entry.scene.split(', ');
    const looks = entry.looks.split(', ');
    return {
        common: `${QUALITY}, ${scene[0]}`,
        characters: [{ ref: '@1', tags: looks.slice(3).join(', ') }, { ref: '@2', tags: looks.slice(0, 3).join(', ') }],
        view: scene.at(-1), background: scene.slice(1, -1).join(', '), style: '', positive: '', action: EN_ACTION[entry.id],
    };
}

const ids = (process.argv[2] || 'princess-carry,piggyback,headpat').split(',');
for (const entry of NL_CASES.filter(c => ids.includes(c.id))) {
    const fields = fieldsFor(entry);
    const t0 = Date.now();
    const res = await fetch(`${URL_}/v1/chat/completions`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            model: 'x',
            messages: [{ role: 'system', content: PROSE_SYSTEM_PROMPT }, { role: 'user', content: buildProseUserContent(fields) }],
            response_format: { type: 'json_schema', json_schema: { name: 'prose', schema: PROSE_RESPONSE_FORMAT } },
            temperature: 0.3, seed: 1, max_tokens: 768, stream: false,
            chat_template_kwargs: { enable_thinking: false },
        }),
    });
    const body = await res.json();
    if (!res.ok) { console.log(JSON.stringify(body)); continue; }
    const t = body.timings || {};
    const content = body.choices?.[0]?.message?.content ?? '';
    const parsed = parseProseResponse(content);
    console.log(`[${entry.id}] wall ${((Date.now() - t0) / 1000).toFixed(1)}s prompt_n=${t.prompt_n} cache_n=${t.cache_n ?? '?'}`
        + ` prompt ${(t.prompt_ms / 1000).toFixed(2)}s (${t.prompt_per_second?.toFixed(1)} t/s)`
        + ` out ${t.predicted_n}t/${(t.predicted_ms / 1000).toFixed(2)}s (${t.predicted_per_second?.toFixed(1)} t/s) ok=${parsed.ok}`
        + (t.draft_n ? ` draft_n=${t.draft_n} accepted=${t.draft_n_accepted}` : ''));
    console.log(`  ${parsed.prompt || content.slice(0, 300)}`);
}
