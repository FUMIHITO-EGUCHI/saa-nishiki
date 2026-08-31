import test from 'node:test';
import assert from 'node:assert/strict';

import {
    PROMPT_MODE_EXPAND,
    PROMPT_MODE_REFINE,
    LEGACY_REFINE_SYSTEM_PROMPT,
    REFINE_SYSTEM_PROMPT,
    applyAiPromptResult,
    buildRefineUserContent,
    buildRefineV2UserContent,
    normalizePromptMode,
    parseRefineEnvelope,
    parseRefineResponse,
    removeAiPromptMarker,
    renderAiPromptInfo,
    resolveRefineSystemPrompt,
} from '../scripts/aiPromptRefiner.js';

test('v2 refine request separates editable fields from rendered generation context', () => {
    const content = buildRefineV2UserContent({
        instruction: '背景を弱めて',
        editorFields: {
            common: 'masterpiece',
            positive: 'portrait, {day|night}',
            positiveRight: 'full body',
            negative: 'worst quality',
        },
        generationContext: {
            positive: 'masterpiece, city, alice, portrait, <lora:style:0.8>',
            positiveRight: 'masterpiece, city, bob, full body',
            negative: 'worst quality, extra arms',
        },
    });

    assert.deepEqual(JSON.parse(content), {
        schema_version: 2,
        instruction: '背景を弱めて',
        editor: {
            common: 'masterpiece',
            positive: 'portrait, {day|night}',
            positive_right: 'full body',
            negative: 'worst quality',
        },
        generation_context: {
            positive: 'masterpiece, city, alice, portrait, <lora:style:0.8>',
            positive_right: 'masterpiece, city, bob, full body',
            negative: 'worst quality, extra arms',
        },
    });
});

test('v2 response is strict and explicitly classified for generation and editor apply', () => {
    const result = parseRefineEnvelope(JSON.stringify({
        schema_version: 2,
        common: 'masterpiece',
        positive: 'portrait',
        positive_right: '',
        negative: '',
        changes: 'Reorganized the prompt.',
    }), { regional: false });

    assert.equal(result.format, 'v2');
    assert.equal(result.validForGeneration, true);
    assert.equal(result.validForEditorApply, true);
    assert.deepEqual(result.editorFields, {
        common: 'masterpiece',
        positive: 'portrait',
        positiveRight: '',
        negative: '',
    });
});

test('unsupported schema versions are invalid instead of falling back to legacy', () => {
    const result = parseRefineEnvelope(JSON.stringify({
        schema_version: 3,
        positive: 'portrait',
        negative: '',
        changes: '',
    }));

    assert.equal(result.format, 'invalid');
    assert.equal(result.validForGeneration, false);
    assert.equal(result.validForEditorApply, false);
    assert.match(result.error, /schema_version/i);
});

test('versionless positive/negative response remains generation-only legacy output', () => {
    const result = parseRefineEnvelope(JSON.stringify({
        positive: 'masterpiece, portrait',
        negative: 'worst quality',
        changes: 'Legacy result.',
    }), {
        originalPrompts: { positive: 'old positive', positiveRight: '', negative: 'old negative' },
    });

    assert.equal(result.format, 'legacy');
    assert.equal(result.validForGeneration, true);
    assert.equal(result.validForEditorApply, false);
    assert.equal(result.generationFallback.positive, 'masterpiece, portrait');
});

test('prompt processing mode keeps Expand as the backward-compatible default', () => {
    assert.equal(normalizePromptMode(), PROMPT_MODE_EXPAND);
    assert.equal(normalizePromptMode('unknown'), PROMPT_MODE_EXPAND);
    assert.equal(normalizePromptMode('refine'), PROMPT_MODE_REFINE);
});

test('Refine always rebuilds and reorganizes the complete prompt set', () => {
    assert.match(REFINE_SYSTEM_PROMPT, /rebuild the entire positive and negative prompts/i);
    assert.match(REFINE_SYSTEM_PROMPT, /complete replacement/i);
    assert.match(REFINE_SYSTEM_PROMPT, /reorder/i);
    assert.match(REFINE_SYSTEM_PROMPT, /quality.*subject.*composition.*appearance.*clothing.*action.*setting.*lighting.*finish/i);
    assert.match(REFINE_SYSTEM_PROMPT, /slightly.*must use exactly 1\.10.*must use exactly 0\.90/i);
    assert.match(REFINE_SYSTEM_PROMPT, /never place.*desired or preserved.*negative prompt/i);
});

test('saved legacy default migrates to full reconstruction while custom prompts are preserved', () => {
    assert.equal(resolveRefineSystemPrompt(LEGACY_REFINE_SYSTEM_PROMPT), REFINE_SYSTEM_PROMPT);
    assert.equal(resolveRefineSystemPrompt(''), REFINE_SYSTEM_PROMPT);
    assert.equal(
        resolveRefineSystemPrompt('My intentionally customized refine instructions.'),
        'My intentionally customized refine instructions.',
    );
});

test('refine request carries the existing prompts and Japanese instruction', () => {
    const content = buildRefineUserContent({
        instruction: '顔を強調し、背景を弱めて',
        positive: 'masterpiece, portrait, city background',
        negative: 'worst quality, blurry',
        positiveRight: '',
    });

    assert.deepEqual(JSON.parse(content), {
        instruction: '顔を強調し、背景を弱めて',
        positive: 'masterpiece, portrait, city background',
        negative: 'worst quality, blurry',
    });
});

test('valid refine response applies weighted prompts and preserves missing LoRA tokens', () => {
    const result = parseRefineResponse(
        JSON.stringify({
            positive: 'masterpiece, portrait, (detailed eyes:1.25), (city background:0.75)',
            negative: 'worst quality, blurry, deformed eyes',
            changes: 'Emphasized the eyes and reduced the background.',
        }),
        {
            positive: 'masterpiece, portrait, city background, <lora:character_style:0.8>',
            negative: 'worst quality, blurry',
            positiveRight: '',
        },
    );

    assert.equal(result.ok, true);
    assert.match(result.positive, /\(detailed eyes:1\.25\)/);
    assert.match(result.positive, /<lora:character_style:0\.8>/);
    assert.equal(result.negative, 'worst quality, blurry, deformed eyes');
    assert.equal(result.changes, 'Emphasized the eyes and reduced the background.');
});

test('regional refine response requires and returns both positive prompts', () => {
    const result = parseRefineResponse(
        JSON.stringify({
            positive: 'masterpiece, left subject, (red lighting:1.20)',
            positive_right: 'masterpiece, right subject, (blue lighting:1.20)',
            negative: 'worst quality',
            changes: 'Balanced the two regions.',
        }),
        {
            positive: 'masterpiece, left subject',
            positiveRight: 'masterpiece, right subject',
            negative: 'worst quality',
        },
    );

    assert.equal(result.ok, true);
    assert.equal(result.positiveRight, 'masterpiece, right subject, (blue lighting:1.20)');
});

test('invalid refine response falls back to the original prompts', () => {
    const original = {
        positive: 'masterpiece, portrait',
        positiveRight: '',
        negative: 'worst quality',
    };

    const result = parseRefineResponse('not json', original);

    assert.equal(result.ok, false);
    assert.equal(result.positive, original.positive);
    assert.equal(result.positiveRight, original.positiveRight);
    assert.equal(result.negative, original.negative);
    assert.match(result.error, /JSON/i);
});

test('Expand mode keeps the existing behavior and inserts generated tags at the marker', () => {
    const result = applyAiPromptResult({
        mode: 'Expand',
        content: 'soft lighting, cherry blossoms',
        marker: '_|AI|_',
        positive: 'masterpiece, _|AI|_, portrait',
        positiveRight: '',
        negative: 'worst quality',
    });

    assert.equal(result.ok, true);
    assert.equal(result.positive, 'masterpiece, soft lighting, cherry blossoms, portrait');
    assert.equal(result.negative, 'worst quality');
});

test('Refine mode replaces both prompts with the validated Gemma result', () => {
    const result = applyAiPromptResult({
        mode: 'Refine',
        content: JSON.stringify({
            positive: 'masterpiece, portrait, (detailed eyes:1.25)',
            negative: 'worst quality, deformed eyes',
            changes: 'Adjusted eye emphasis.',
        }),
        marker: '_|AI|_',
        positive: 'masterpiece, _|AI|_, portrait',
        positiveRight: '',
        negative: 'worst quality',
    });

    assert.equal(result.ok, true);
    assert.equal(result.positive, 'masterpiece, portrait, (detailed eyes:1.25)');
    assert.equal(result.negative, 'worst quality, deformed eyes');
    assert.equal(result.preview, 'Adjusted eye emphasis.');
});

test('removing the AI marker also removes separator artifacts', () => {
    assert.equal(
        removeAiPromptMarker('_|AI|_, character, portrait', '_|AI|_'),
        'character, portrait',
    );
    assert.equal(
        removeAiPromptMarker('masterpiece, _|AI|_, portrait', '_|AI|_'),
        'masterpiece, portrait',
    );
});

test('invalid Refine output removes the marker and preserves original prompts', () => {
    const result = applyAiPromptResult({
        mode: 'Refine',
        content: 'invalid',
        marker: '_|AI|_',
        positive: 'masterpiece, _|AI|_, portrait',
        positiveRight: '',
        negative: 'worst quality',
    });

    assert.equal(result.ok, false);
    assert.equal(result.positive, 'masterpiece, portrait');
    assert.equal(result.negative, 'worst quality');
});

test('Refine info shows final prompts instead of inserting the changes sentence into Positive', () => {
    const info = [
        'Seed: 42',
        'Positive:',
        '[color=Purple]_|AI|_, [/color][color=Blue]manhattan cafe \\(umamusume\\), [/color]',
        'Negative:',
        '[color=Red]worst quality[/color]',
        '',
        'Layout: 640 x 832',
    ].join('\n');

    const rendered = renderAiPromptInfo({
        info,
        mode: 'Refine',
        marker: '_|AI|_',
        preview: "Added 'white lace ornament on each hand' to the positive prompt.",
        positive: 'manhattan cafe \\(umamusume\\), (white lace ornament on each hand:1.2)',
        negative: 'worst quality',
    });

    assert.doesNotMatch(rendered, /Added 'white lace ornament/);
    assert.equal(
        rendered.includes('Positive:\nmanhattan cafe \\(umamusume\\), (white lace ornament on each hand:1.2)'),
        true,
    );
    assert.match(rendered, /Negative:\nworst quality/);
});

test('Expand info keeps inserting generated tags at the AI marker', () => {
    const rendered = renderAiPromptInfo({
        info: 'Positive:\nmasterpiece, _|AI|_, portrait\nNegative:\nworst quality\n\nLayout:',
        mode: 'Expand',
        marker: '_|AI|_',
        preview: 'soft lighting',
        positive: '',
        negative: '',
    });

    assert.equal(
        rendered,
        'Positive:\nmasterpiece, soft lighting, portrait\nNegative:\nworst quality\n\nLayout:',
    );
});

test('Regional Refine info shows both final positive prompts', () => {
    const rendered = renderAiPromptInfo({
        info: 'Positive Left:\n_|AI|_, left old\nPositive Right:\n_|AI|_, right old\nNegative:\nold negative\n\nLayout:',
        mode: 'Refine',
        marker: '_|AI|_',
        preview: 'Adjusted both prompts.',
        positive: 'left final',
        positiveRight: 'right final',
        negative: 'final negative',
        regional: true,
    });

    assert.doesNotMatch(rendered, /Adjusted both prompts/);
    assert.match(rendered, /Positive Left:\nleft final/);
    assert.match(rendered, /Positive Right:\nright final/);
    assert.match(rendered, /Negative:\nfinal negative/);
});
