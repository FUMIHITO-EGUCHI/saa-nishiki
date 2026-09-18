import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import {
    buildWeightCandidates,
    describePlan,
    effectiveStep,
    expandAll,
    normalizeWeightPlan,
    parsePromptToCapsules,
    plansEqual,
    resolveWeight,
} from '../scripts/renderer/components/tagCapsuleLogic.js';

const AUTO = { mode: 'increment', min: 0.8, max: 1.2, step: 0.05, autoStep: true };

test('autoStep survives normalization and distinguishes plans', () => {
    assert.equal(normalizeWeightPlan(AUTO).autoStep, true);
    assert.equal(normalizeWeightPlan({ ...AUTO, autoStep: undefined }).autoStep, false);
    assert.equal(normalizeWeightPlan({ mode: 'fixed', min: 1, autoStep: true }).autoStep, false, 'fixed plans never auto-step');
    assert.equal(plansEqual(AUTO, { ...AUTO, autoStep: false }), false);
});

test('a random plan never carries autoStep: its step and label stay what the popover shows', () => {
    // the popover hides "÷ batch count" in Random; a switch from an auto-stepped Increment
    // used to keep the hidden flag, so the chip read "÷n" and the typed step was ignored
    const random = normalizeWeightPlan({ ...AUTO, mode: 'random', step: 0.1 });
    assert.equal(random.autoStep, false);
    assert.equal(describePlan(random), '0.80–1.20', 'no ÷n on the chip');
    assert.deepEqual(buildWeightCandidates(random, { batchCount: 2 }), [0.8, 0.9, 1, 1.1, 1.2], 'the manual step, not span / (count - 1)');
    assert.deepEqual(buildWeightCandidates(random, {}), buildWeightCandidates(random, { batchCount: 7 }), 'independent of the batch count');
    assert.equal(normalizeWeightPlan({ ...AUTO, mode: 'decrement' }).autoStep, true, 'stepped modes keep it');
    const popover = fs.readFileSync(new URL('../scripts/renderer/components/weightPopover.js', import.meta.url), 'utf8');
    assert.match(popover, /return normalizeWeightPlan\(\{ \.\.\.planDraft, seed: followSeed \? 0 : planDraft\.seed \}\);/, 'Apply normalizes the draft, dropping the flag for Random');
});

test('effectiveStep spreads min..max over the batch count', () => {
    assert.ok(Math.abs(effectiveStep(AUTO, 5) - 0.1) < 1e-9);
    assert.ok(Math.abs(effectiveStep(AUTO, 1) - 0.4) < 1e-9, 'a single image jumps the whole span');
    assert.equal(effectiveStep({ ...AUTO, autoStep: false }, 5), 0.05, 'manual step untouched');
});

test('candidates land exactly on the batch count with autoStep', () => {
    assert.deepEqual(buildWeightCandidates(AUTO, { batchCount: 5 }), [0.8, 0.9, 1, 1.1, 1.2]);
    assert.deepEqual(buildWeightCandidates(AUTO, { batchCount: 3 }), [0.8, 1, 1.2]);
    assert.deepEqual(buildWeightCandidates({ ...AUTO, mode: 'decrement' }, { batchCount: 3 }), [1.2, 1, 0.8]);
    assert.deepEqual(buildWeightCandidates(AUTO), [0.8, 1.2], 'without a count the plan jumps min → max');
});

test('resolveWeight and expandAll thread the batch count through', () => {
    assert.equal(resolveWeight(AUTO, { imageIndex: 2, batchCount: 3 }), 1.2);
    const capsules = parsePromptToCapsules('1girl, (smile:1.0)').map(capsule => (
        capsule.value === 'smile' ? { ...capsule, weightPlan: AUTO } : capsule));
    const rows = expandAll([{ key: 'positive', capsules }], 0, 4);
    assert.deepEqual(rows.map(row => row.fields.positive), [
        '1girl, (smile:0.80)', '1girl, (smile:0.93)', '1girl, (smile:1.07)', '1girl, (smile:1.20)',
    ]);
    assert.deepEqual(rows.map(row => row.terminal.length), [0, 0, 0, 0], 'no image runs out of candidates');
});
