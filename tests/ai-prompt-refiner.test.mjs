import test from 'node:test';
import assert from 'node:assert/strict';

import {
    PROMPT_MODE_EXPAND,
    PROMPT_MODE_REFINE,
    LEGACY_FULL_REFINE_SYSTEM_PROMPT,
    LEGACY_REFINE_SYSTEM_PROMPT,
    LEGACY_V2_REFINE_SYSTEM_PROMPT,
    REFINE_SYSTEM_PROMPT,
    applyAiPromptResult,
    buildRefineUserContent,
    buildRefineV2UserContent,
    buildRefineV3UserContent,
    isStructuredRefineFormat,
    normalizePromptMode,
    parseRefineEnvelope,
    parseRefineResponse,
    previousRefineSystemPromptDefaults,
    refineRequestSchema,
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
        // schema 2 knows no per-side negatives, so the generated ones are kept
        negativeLeft: null,
        negativeRight: null,
    });
});

test('v3 refine request adds the editable and rendered per-side negatives', () => {
    const content = buildRefineV3UserContent({
        instruction: '左側だけ影を減らして',
        editorFields: {
            common: 'masterpiece',
            positive: 'left portrait',
            positiveRight: 'right full body',
            negative: 'worst quality',
            negativeLeft: 'harsh shadow',
            negativeRight: '',
        },
        generationContext: {
            positive: 'masterpiece, alice, left portrait',
            positiveRight: 'masterpiece, bob, right full body',
            negative: 'worst quality, harsh shadow, extra arms',
            negativeLeft: 'worst quality, harsh shadow, extra arms',
            negativeRight: 'worst quality',
        },
    });

    assert.deepEqual(JSON.parse(content), {
        schema_version: 3,
        instruction: '左側だけ影を減らして',
        editor: {
            common: 'masterpiece',
            positive: 'left portrait',
            positive_right: 'right full body',
            negative: 'worst quality',
            negative_left: 'harsh shadow',
            negative_right: '',
        },
        generation_context: {
            positive: 'masterpiece, alice, left portrait',
            positive_right: 'masterpiece, bob, right full body',
            negative: 'worst quality, harsh shadow, extra arms',
            negative_left: 'worst quality, harsh shadow, extra arms',
            negative_right: 'worst quality',
        },
    });
});

test('v3 response makes the per-side negatives editable fields of their own', () => {
    const result = parseRefineEnvelope(JSON.stringify({
        schema_version: 3,
        common: 'masterpiece',
        positive: 'left portrait',
        positive_right: 'right full body',
        negative: 'worst quality',
        negative_left: 'harsh shadow',
        negative_right: '',
        changes: 'Moved the shadow exclusion to the left side.',
    }), { regional: true });

    assert.equal(result.format, 'v3');
    assert.equal(result.validForGeneration, true);
    assert.equal(result.validForEditorApply, true);
    assert.deepEqual(result.editorFields, {
        common: 'masterpiece',
        positive: 'left portrait',
        positiveRight: 'right full body',
        negative: 'worst quality',
        negativeLeft: 'harsh shadow',
        negativeRight: '',
    });
});

test('Regional v3 output must carry every side field', () => {
    const base = {
        schema_version: 3,
        common: '',
        positive: 'left',
        positive_right: 'right',
        negative: '',
        negative_left: '',
        negative_right: '',
        changes: '',
    };
    for (const missing of ['positive_right', 'negative_left', 'negative_right']) {
        const { [missing]: _dropped, ...partial } = base;
        const result = parseRefineEnvelope(JSON.stringify(partial), { regional: true });
        assert.equal(result.format, 'invalid', `${missing} is required`);
        assert.equal(result.error, `${missing} is required for Regional Refine`);
    }
    assert.equal(parseRefineEnvelope(JSON.stringify(base), { regional: true }).format, 'v3');
});

test('outside Regional an answer may leave out the Regional-only fields', () => {
    const base = { schema_version: 3, common: 'masterpiece', positive: 'portrait', negative: 'blurry', changes: '' };
    for (const answer of [base, { ...base, positive_right: null, negative_left: null, negative_right: null }]) {
        const result = parseRefineEnvelope(JSON.stringify(answer), { regional: false });
        assert.equal(result.format, 'v3');
        assert.deepEqual(result.editorFields, {
            common: 'masterpiece',
            positive: 'portrait',
            positiveRight: '',
            negative: 'blurry',
            negativeLeft: null,
            negativeRight: null,
        });
    }
    // present ones must still be strings
    assert.equal(parseRefineEnvelope(JSON.stringify({ ...base, negative_left: 3 }), { regional: false }).format, 'invalid');
});

test('an answer is read against the schema its request was built with', () => {
    const v3 = {
        schema_version: 3,
        common: '',
        positive: 'left',
        positive_right: 'right',
        negative: 'blurry',
        negative_left: '',
        negative_right: '',
        changes: '',
    };
    // a schema 2 request never showed the side negatives, so a schema 3 answer cannot empty them
    const downgraded = parseRefineEnvelope(JSON.stringify(v3), { regional: true, requestSchema: 2 });
    assert.equal(downgraded.format, 'v2');
    assert.equal(downgraded.editorFields.negativeLeft, null);
    assert.equal(downgraded.editorFields.negativeRight, null);
    assert.equal(parseRefineEnvelope(JSON.stringify(v3), { regional: true, requestSchema: 0 }).format, 'v2', 'nor did a legacy request');
    assert.equal(parseRefineEnvelope(JSON.stringify(v3), { regional: true, requestSchema: 3 }).format, 'v3');

    // a structured request is answered with editor fields; without schema_version they are
    // not finished prompts
    const { schema_version: _version, ...versionless } = v3;
    for (const requestSchema of [2, 3]) {
        const result = parseRefineEnvelope(JSON.stringify(versionless), { regional: true, requestSchema });
        assert.equal(result.format, 'invalid');
        assert.equal(result.error, 'Refine response has no schema_version');
    }
    // a legacy request (or an unknown one) still reads a versionless answer as legacy
    const legacyOriginals = { positive: 'old', positiveRight: 'old right', negative: 'old' };
    assert.equal(parseRefineEnvelope(JSON.stringify(versionless), { regional: true, requestSchema: 0, originalPrompts: legacyOriginals }).format, 'legacy');
    assert.equal(parseRefineEnvelope(JSON.stringify(versionless), { regional: true, originalPrompts: legacyOriginals }).format, 'legacy');
});

test('the request schema is read from reworded and translated system prompts', () => {
    assert.equal(refineRequestSchema(REFINE_SYSTEM_PROMPT), 3);
    assert.equal(refineRequestSchema(''), 3, 'an empty setting sends the default');
    assert.equal(refineRequestSchema(LEGACY_V2_REFINE_SYSTEM_PROMPT), 2);
    for (const prompt of previousRefineSystemPromptDefaults()) {
        assert.equal(refineRequestSchema(prompt), /"schema_version": 3/.test(prompt) ? 3 : 2);
    }
    const firstLine = 'numeric "schema_version": 3';
    assert.equal(refineRequestSchema(REFINE_SYSTEM_PROMPT.replace(firstLine, 'schema_version set to the number 3')), 3);
    assert.equal(refineRequestSchema(REFINE_SYSTEM_PROMPT.replace(firstLine, 'schema_version には数値 3 を入れる')), 3);
    assert.equal(refineRequestSchema(REFINE_SYSTEM_PROMPT.replace(firstLine, 'schema_version は ３')), 3, 'full-width digit');
    // the return-format line removed: only "verify that schema_version is numeric 3" is left
    assert.equal(refineRequestSchema(REFINE_SYSTEM_PROMPT.split('\n').filter(line => !line.startsWith('Return exactly one JSON')).join('\n')), 3);
    // the number may sit on the next line after the mention
    assert.equal(refineRequestSchema('Return one JSON object with:\nschema_version:\n3\ncommon, positive, negative'), 3);
    // a schema 3 prompt that also names the old format still asks for 3: the request is
    // built from this same answer, so a schema 3 request answered with schema 2 is read as
    // schema 2, while a schema 2 request never sees the per-side negatives at all
    assert.equal(refineRequestSchema(`${REFINE_SYSTEM_PROMPT}\nNever answer with schema_version 2.`), 3);
    assert.equal(refineRequestSchema(`${LEGACY_V2_REFINE_SYSTEM_PROMPT}\nMy own rule.`), 2, 'a customized schema 2 prompt stays schema 2');
    // a mention without any number, or none at all
    assert.equal(refineRequestSchema('Answer with schema_version and the fields.'), 2);
    assert.equal(refineRequestSchema('My intentionally customized refine instructions.'), 0);
});

test('both structured schemas rebuild the editor, legacy output never does', () => {
    assert.equal(isStructuredRefineFormat('v2'), true);
    assert.equal(isStructuredRefineFormat('v3'), true);
    assert.equal(isStructuredRefineFormat('legacy'), false);
    assert.equal(isStructuredRefineFormat('invalid'), false);
    assert.equal(isStructuredRefineFormat(undefined), false);
});

test('unsupported schema versions are invalid instead of falling back to legacy', () => {
    const result = parseRefineEnvelope(JSON.stringify({
        schema_version: 4,
        positive: 'portrait',
        negative: '',
        changes: '',
    }));

    assert.equal(result.format, 'invalid');
    assert.equal(result.validForGeneration, false);
    assert.equal(result.validForEditorApply, false);
    assert.match(result.error, /schema_version/i);
});

test('v2 schema requires a bounded string changes field', () => {
    const base = { schema_version: 2, common: '', positive: 'portrait', positive_right: '', negative: '' };
    const missing = parseRefineEnvelope(JSON.stringify(base));
    assert.equal(missing.format, 'invalid');
    assert.match(missing.error, /changes must be a string/i);

    const oversized = parseRefineEnvelope(JSON.stringify({ ...base, changes: 'x'.repeat(2001) }));
    assert.equal(oversized.format, 'invalid');
    assert.match(oversized.error, /changes is too long/i);
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
    assert.match(REFINE_SYSTEM_PROMPT, /"schema_version": 3/);
    assert.match(REFINE_SYSTEM_PROMPT, /common.*positive.*positive_right.*negative.*negative_left.*negative_right/is);
    assert.match(REFINE_SYSTEM_PROMPT, /generation_context/i);
    assert.match(REFINE_SYSTEM_PROMPT, /rebuild the entire positive and negative prompts/i);
    assert.match(REFINE_SYSTEM_PROMPT, /complete replacement/i);
    assert.match(REFINE_SYSTEM_PROMPT, /reorder/i);
    assert.match(REFINE_SYSTEM_PROMPT, /quality.*subject.*composition.*appearance.*clothing.*action.*setting.*lighting.*finish/i);
    assert.match(REFINE_SYSTEM_PROMPT, /slightly.*must use exactly 1\.10.*must use exactly 0\.90/i);
    assert.match(REFINE_SYSTEM_PROMPT, /never place.*desired or preserved.*negative field/i);
    // the side negatives only exist while Regional is on
    assert.match(REFINE_SYSTEM_PROMPT, /outside Regional mode positive_right, negative_left and negative_right must be empty strings/i);
});

test('saved legacy default migrates to full reconstruction while custom prompts are preserved', () => {
    assert.equal(resolveRefineSystemPrompt(LEGACY_REFINE_SYSTEM_PROMPT), REFINE_SYSTEM_PROMPT);
    assert.equal(resolveRefineSystemPrompt(LEGACY_FULL_REFINE_SYSTEM_PROMPT), REFINE_SYSTEM_PROMPT);
    assert.equal(resolveRefineSystemPrompt(LEGACY_V2_REFINE_SYSTEM_PROMPT), REFINE_SYSTEM_PROMPT);
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
test('a switched-off field is named as locked instead of offered as an empty one', () => {
    const editorFields = {
        common: '',
        positive: 'portrait',
        positiveRight: '',
        negative: 'blurry',
        negativeLeft: '',
        negativeRight: 'lens flare',
        locked: ['common', 'negativeLeft'],
    };
    const v3 = JSON.parse(buildRefineV3UserContent({ instruction: 'x', editorFields, generationContext: {} }));
    assert.deepEqual(v3.locked, ['common', 'negative_left']);
    assert.equal(v3.editor.common, '', 'the field itself still goes out, empty');
    // schema 2 sends no side negatives, so it names none as locked either
    assert.deepEqual(JSON.parse(buildRefineV2UserContent({ instruction: 'x', editorFields, generationContext: {} })).locked, ['common']);
    // nothing switched off: no locked key at all
    const none = JSON.parse(buildRefineV3UserContent({ instruction: 'x', editorFields: { ...editorFields, locked: [] }, generationContext: {} }));
    assert.equal(Object.hasOwn(none, 'locked'), false);
    assert.equal(Object.hasOwn(JSON.parse(buildRefineV3UserContent({ instruction: 'x', editorFields: {}, generationContext: {} })), 'locked'), false);
    // and the system prompt says what a locked field means
    assert.match(REFINE_SYSTEM_PROMPT, /^14\. The user message may carry "locked"/m);
    assert.match(REFINE_SYSTEM_PROMPT, /never move content into one/);
});

test('an answer reused from an earlier run cannot empty this run\'s Regional side fields', () => {
    // what a run outside Regional answers: every side field is an empty string
    const outside = {
        schema_version: 3, common: 'masterpiece', positive: '1girl', positive_right: '',
        negative: 'blurry', negative_left: '', negative_right: '', changes: '',
    };
    const reused = parseRefineEnvelope(JSON.stringify(outside), { regional: true, requestSchema: 3, reused: true });
    assert.equal(reused.format, 'v3');
    assert.deepEqual(reused.editorFields, {
        common: 'masterpiece',
        positive: '1girl',
        positiveRight: null,
        negative: 'blurry',
        negativeLeft: null,
        negativeRight: null,
    }, 'null: the side fields keep what they have');
    // a side field the reused answer does fill is an answer like any other
    const filled = parseRefineEnvelope(JSON.stringify({ ...outside, positive_right: '1boy', negative_right: 'lens flare' }), { regional: true, requestSchema: 3, reused: true });
    assert.equal(filled.editorFields.positiveRight, '1boy');
    assert.equal(filled.editorFields.negativeRight, 'lens flare');
    assert.equal(filled.editorFields.negativeLeft, null);
    // this run's own answer may empty them
    const fresh = parseRefineEnvelope(JSON.stringify(outside), { regional: true, requestSchema: 3 });
    assert.equal(fresh.editorFields.positiveRight, '');
    assert.equal(fresh.editorFields.negativeLeft, '');
    // outside Regional a reused answer is read as before
    assert.equal(parseRefineEnvelope(JSON.stringify(outside), { regional: false, reused: true }).editorFields.positiveRight, '');
});
