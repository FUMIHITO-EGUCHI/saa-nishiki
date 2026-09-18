// One chip (tagCapsuleChip.js) drawn on the in-memory DOM: the dictionary marks, the
// weight the plan puts on it (with the icon of its mode), what a screen reader is told,
// and the keyed diff that keeps the chip elements across a re-render.
import assert from 'node:assert/strict';
import test from 'node:test';

import { withFakeDom } from './helpers/fakeDom.mjs';
import { createChip, createIcon, modeIconName, renderChips, updateChip } from '../scripts/renderer/components/tagCapsuleChip.js';

const text = key => `«${key}»`;

const fixed = weight => ({ mode: 'fixed', min: weight, max: weight, step: 0.05, seed: 0 });
const plan = (mode, min, max, extra = {}) => ({ mode, min, max, step: 0.05, seed: 0, ...extra });

function capsule(value, weightPlan = fixed(1), extra = {}) {
    return { id: `${value}#0`, value, weightPlan, ...extra };
}

function chipOf(capsuleValue, options = {}) {
    return createChip(capsuleValue, { text, ...options });
}

const iconNames = element => element.querySelectorAll('.tag-ui-icon')
    .flatMap(icon => String(icon.className).split(' '))
    .filter(name => name !== 'tag-ui-icon' && name.startsWith('tag-ui-icon-'));

// ------------------------------------------------------------------ dictionary marks

test('the dictionary status marks the chip as unknown or as a sentence, and nothing else', async () => {
    await withFakeDom(() => {
        const plain = chipOf(capsule('long hair'));
        assert.equal(plain.classList.contains('is-unknown'), false);
        assert.equal(plain.classList.contains('is-sentence'), false);

        const unknown = chipOf(capsule('zzz not a tag'), { status: 'unknown' });
        assert.equal(unknown.classList.contains('is-unknown'), true, 'no tag matches this value');
        assert.equal(unknown.classList.contains('is-sentence'), false);

        const sentence = chipOf(capsule('a girl is standing in the rain'), { status: 'sentence' });
        assert.equal(sentence.classList.contains('is-sentence'), true);
        assert.equal(sentence.classList.contains('is-unknown'), false);

        // and the mark follows a later answer from the dictionary
        updateChip(unknown, capsule('zzz not a tag'), { text, status: '' });
        assert.equal(unknown.classList.contains('is-unknown'), false, 'the tag is known now');
        updateChip(unknown, capsule('zzz not a tag'), { text, status: 'unknown' });
        assert.equal(unknown.classList.contains('is-unknown'), true);
    });
});

// ------------------------------------------------------------------ the weight

test('modeIconName names an icon for the three variable modes and for nothing else', () => {
    assert.equal(modeIconName('increment'), 'increment');
    assert.equal(modeIconName('decrement'), 'decrement');
    assert.equal(modeIconName('random'), 'random');
    assert.equal(modeIconName('fixed'), null);
    assert.equal(modeIconName(''), null);
    assert.equal(modeIconName(undefined), null);
});

test('the weight badge shows the plan with the icon of its mode, and disappears at 1.00', async () => {
    await withFakeDom(() => {
        const badge = chip => chip.querySelector('.tag-capsule-chip-weight');

        const one = chipOf(capsule('long hair', fixed(1)));
        assert.equal(badge(one).hidden, true, 'an unweighted tag carries no badge');
        assert.equal(badge(one).textContent, '');
        assert.deepEqual(iconNames(badge(one)), []);

        const up = chipOf(capsule('long hair', fixed(1.2)));
        assert.equal(badge(up).hidden, false);
        assert.equal(badge(up).textContent, ':1.20');
        assert.deepEqual(iconNames(badge(up)), [], 'a fixed weight is not a mode with an icon');
        assert.equal(up.classList.contains('is-up'), true);
        assert.equal(up.classList.contains('is-down'), false);

        const down = chipOf(capsule('long hair', fixed(0.8)));
        assert.equal(down.classList.contains('is-down'), true);
        assert.equal(badge(down).textContent, ':0.80');

        for (const [mode, expected] of [['increment', 'tag-ui-icon-increment'], ['decrement', 'tag-ui-icon-decrement'], ['random', 'tag-ui-icon-random']]) {
            const chip = chipOf(capsule('long hair', plan(mode, 1, 1.3)));
            assert.deepEqual(iconNames(badge(chip)), [expected], `${mode} has its own icon`);
            assert.equal(badge(chip).textContent, '1.00–1.30');
            assert.equal(chip.classList.contains('is-plan'), true);
        }

        const perImage = chipOf(capsule('long hair', plan('increment', 1, 1.3, { autoStep: true })));
        assert.equal(badge(perImage).textContent, '1.00–1.30 ÷n', 'the step comes from the batch count');

        const warned = chipOf(capsule('long hair', fixed(2)));
        assert.equal(warned.classList.contains('is-warn'), true, 'outside 0.50 - 1.50');
        assert.equal(chipOf(capsule('long hair', fixed(1.3))).classList.contains('is-warn'), false);
    });
});

// ------------------------------------------------------------------ what is announced

test('the chip announces its value, its weight and the states it is in', async () => {
    await withFakeDom(() => {
        const bare = chipOf(capsule('long hair'));
        assert.equal(bare.querySelector('.tag-capsule-chip-name').textContent, 'long hair');
        assert.equal(bare.getAttribute('aria-label'), 'long hair');
        assert.equal(bare.getAttribute('aria-pressed'), 'true', 'an enabled tag is pressed');
        assert.equal(bare.title, 'long hair');
        assert.equal(bare.draggable, true);
        assert.equal(bare.tabIndex, -1, 'the field hands out the one tab stop');

        assert.equal(chipOf(capsule('long hair', fixed(1.2))).getAttribute('aria-label'), 'long hair, weight 1.20');
        assert.equal(chipOf(capsule('long hair', plan('increment', 1, 1.3))).getAttribute('aria-label'),
            'long hair, increment 1.00 to 1.30 step 0.05');

        const excluded = chipOf(capsule('long hair'), { excluded: true });
        assert.equal(excluded.classList.contains('is-excluded'), true);
        assert.equal(excluded.getAttribute('aria-label'), `long hair, ${text('tag_ui_excluded')}`);
        assert.equal(excluded.title, `long hair — ${text('tag_ui_excluded')}`);

        const off = chipOf(capsule('long hair', fixed(1), { disabled: true }));
        assert.equal(off.classList.contains('is-disabled'), true);
        assert.equal(off.getAttribute('aria-pressed'), 'false');
        assert.equal(off.getAttribute('aria-label'), `long hair, ${text('tag_ui_disabled')}`);
        assert.equal(off.querySelector('.tag-capsule-chip-toggle').title, text('tag_ui_enable_tag'));
        assert.equal(chipOf(capsule('long hair')).querySelector('.tag-capsule-chip-toggle').title, text('tag_ui_disable_tag'));

        const star = chipOf(capsule('long hair'), { favorite: true });
        assert.equal(star.classList.contains('is-fav'), true);
        assert.equal(star.querySelector('.tag-capsule-chip-fav').hidden, false);
        assert.equal(chipOf(capsule('long hair')).querySelector('.tag-capsule-chip-fav').hidden, true);
    });
});

test('createIcon draws the strokes of the icon it was asked for', async () => {
    await withFakeDom(document => {
        const close = createIcon('close', 12);
        assert.equal(close.getAttribute('width'), '12');
        assert.equal(close.getAttribute('aria-hidden'), 'true');
        assert.deepEqual(close.children.map(path => path.getAttribute('d')), ['M4 4l8 8', 'M12 4l-8 8']);
        // random is the only mode icon made of shapes rather than paths
        const random = createIcon('random');
        assert.deepEqual(random.children.map(node => node.tagName), ['RECT', 'CIRCLE', 'CIRCLE', 'CIRCLE']);
        assert.deepEqual(createIcon('increment').children.map(path => path.getAttribute('d')), ['M3 12l10-8', 'M7 4h6v6']);
        assert.deepEqual(createIcon('decrement').children.map(path => path.getAttribute('d')), ['M3 4l10 8', 'M7 12h6V6']);
        // an icon nobody declared is an empty frame, not a crash
        assert.deepEqual(createIcon('no-such-icon').children, []);
        assert.equal(document.createElement('div').children.length, 0);
    });
});

// ------------------------------------------------------------------ the keyed diff

test('a re-render reuses the chip elements, reorders them and keeps the add slot last', async () => {
    await withFakeDom(document => {
        const container = document.createElement('div');
        document.body.appendChild(container);
        const trailing = document.createElement('button');
        trailing.className = 'tag-capsule-add';

        const a = capsule('long hair');
        const b = capsule('smile');
        const c = capsule('blue eyes');
        const first = renderChips(container, [a, b, c], { text, trailing });
        assert.deepEqual(first.map(chip => chip.querySelector('.tag-capsule-chip-name').textContent),
            ['long hair', 'smile', 'blue eyes']);
        assert.equal(container.children.at(-1), trailing, 'the add slot stays last');

        const reordered = renderChips(container, [c, a, b], { text, trailing });
        assert.deepEqual(reordered, [first[2], first[0], first[1]], 'the same elements, in the new order');
        assert.deepEqual(container.querySelectorAll(':scope > .tag-capsule-chip'), reordered);
        assert.equal(container.children.at(-1), trailing);

        const shorter = renderChips(container, [c, b], { text, trailing });
        assert.deepEqual(shorter, [first[2], first[1]]);
        assert.equal(first[0].parentElement, null, 'the dropped tag is out of the page');
        assert.deepEqual(container.querySelectorAll(':scope > .tag-capsule-chip'), shorter);
    });
});

test('only the chips whose signature changed are redrawn', async () => {
    await withFakeDom(document => {
        const container = document.createElement('div');
        document.body.appendChild(container);
        // every redraw asks the text resolver for the enable / disable title, so counting
        // its calls counts the chips that were redrawn
        let redraws = 0;
        const counted = key => { redraws += 1; return text(key); };
        const capsules = [capsule('long hair'), capsule('smile')];
        const [long, smile] = renderChips(container, capsules, { text: counted });
        const signatures = [long.dataset.signature, smile.dataset.signature];
        assert.equal(redraws, 2, 'both chips were drawn once');

        // the same input draws nothing new
        redraws = 0;
        renderChips(container, capsules, { text: counted });
        assert.equal(redraws, 0, 'nothing changed, so nothing was redrawn');
        assert.deepEqual([long.dataset.signature, smile.dataset.signature], signatures);

        // a weight, an exclusion, a favourite and a dictionary mark each change one
        renderChips(container, [capsule('long hair', fixed(1.2)), capsules[1]], { text: counted });
        assert.equal(redraws, 1, 'only the chip whose weight moved');
        assert.notEqual(long.dataset.signature, signatures[0]);
        assert.equal(long.querySelector('.tag-capsule-chip-weight').textContent, ':1.20');
        assert.equal(smile.dataset.signature, signatures[1], 'the untouched chip was left alone');

        renderChips(container, capsules, { text: counted, excludedSet: new Set(['smile']) });
        assert.equal(smile.classList.contains('is-excluded'), true);
        renderChips(container, capsules, { text: counted, isFavorite: value => value === 'smile' });
        assert.equal(smile.classList.contains('is-excluded'), false);
        assert.equal(smile.classList.contains('is-fav'), true);
        renderChips(container, capsules, { text: counted, tagStatus: value => (value === 'smile' ? 'unknown' : '') });
        assert.equal(smile.classList.contains('is-unknown'), true);
        assert.equal(long.classList.contains('is-unknown'), false);

        // a dictionary answer on its own is a change: the signature has to carry the status
        redraws = 0;
        renderChips(container, capsules, { text: counted });
        assert.equal(redraws, 1, 'the chip the dictionary answered for');
        assert.equal(smile.classList.contains('is-unknown'), false);
    });
});
