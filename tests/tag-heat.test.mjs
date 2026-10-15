// The heat tier of a tag (shared/tagHeat.js): the three tiers of a post count, the
// marks and the tooltip they put on a chip (tagCapsuleChip.js), and the heat the
// dictionary status keeps from one lookup (tagDictionaryStatus.js).
import assert from 'node:assert/strict';
import test from 'node:test';

import { withFakeDom } from './helpers/fakeDom.mjs';
import { HEAT_ENOUGH, HEAT_THIN, heatLabel, heatTier, heatTierKey } from '../scripts/shared/tagHeat.js';
import { createChip, renderChips, updateChip } from '../scripts/renderer/components/tagCapsuleChip.js';

const text = key => `«${key}»`;
const fixed = weight => ({ mode: 'fixed', min: weight, max: weight, step: 0.05, seed: 0 });
const capsule = value => ({ id: `${value}#0`, value, weightPlan: fixed(1) });

test('a post count falls into one of three tiers; no count is no tier', () => {
    assert.equal(HEAT_THIN, 100);
    assert.equal(HEAT_ENOUGH, 1000);
    assert.equal(heatTier(0), 'weak');
    assert.equal(heatTier(99), 'weak');
    assert.equal(heatTier(100), 'thin');
    assert.equal(heatTier(999), 'thin');
    assert.equal(heatTier(1000), 'enough');
    assert.equal(heatTier(6008644), 'enough');
    assert.equal(heatTier('250'), 'thin', 'a count that arrived as text still counts');
    for (const none of [null, undefined, '', 'abc', -1, Number.NaN]) assert.equal(heatTier(none), null, `no tier for ${String(none)}`);
    assert.equal(heatTierKey(5), 'tag_ui_heat_weak');
    assert.equal(heatTierKey(null), null);
    assert.equal(heatLabel(text, 99), '«tag_ui_heat_weak» (99)');
    assert.equal(heatLabel(text, 1234567), '«tag_ui_heat_enough» (1,234,567)', 'the exact count, grouped');
    assert.equal(heatLabel(text, null), '');
    assert.equal(heatLabel(null, 99), 'tag_ui_heat_weak (99)', 'without a text function the key stands in');
});

test('a chip carries the weak or thin mark and names the tier with the count in its tooltip; a common tag is unmarked', async () => {
    await withFakeDom(() => {
        const weak = createChip(capsule('fig'), { text, status: 'known', heat: 99 });
        assert.equal(weak.classList.contains('is-heat-weak'), true);
        assert.equal(weak.classList.contains('is-heat-thin'), false);
        assert.equal(weak.title, 'fig — «tag_ui_heat_weak» (99)');
        assert.match(weak.getAttribute('aria-label'), /«tag_ui_heat_weak» \(99\)$/);

        const thin = createChip(capsule('cuirass'), { text, status: 'known', heat: 999 });
        assert.equal(thin.classList.contains('is-heat-thin'), true);
        assert.equal(thin.classList.contains('is-heat-weak'), false);
        assert.equal(thin.title, 'cuirass — «tag_ui_heat_thin» (999)');

        const common = createChip(capsule('1girl'), { text, status: 'known', heat: 6008644 });
        assert.equal(common.classList.contains('is-heat-weak'), false);
        assert.equal(common.classList.contains('is-heat-thin'), false);
        assert.equal(common.title, '1girl — «tag_ui_heat_enough» (6,008,644)', 'the count still shows in the tooltip');

        const unanswered = createChip(capsule('long hair'), { text, status: 'pending' });
        assert.equal(unanswered.classList.contains('is-heat-weak'), false);
        assert.equal(unanswered.title, 'long hair', 'no count, no tier: the tooltip is the value alone');

        // the mark follows a later answer, and an exclusion keeps its place before the tier
        updateChip(unanswered, capsule('long hair'), { text, status: 'known', heat: 50, excluded: true });
        assert.equal(unanswered.classList.contains('is-heat-weak'), true);
        assert.equal(unanswered.title, 'long hair — «tag_ui_excluded» — «tag_ui_heat_weak» (50)');
        updateChip(unanswered, capsule('long hair'), { text, status: 'known', heat: 5000 });
        assert.equal(unanswered.classList.contains('is-heat-weak'), false);
    });
});

test('renderChips asks the heat of a known tag only, and re-renders a chip whose heat arrived', async () => {
    await withFakeDom(() => {
        const container = document.createElement('div');
        const asked = [];
        const heats = new Map([['fig', 99], ['1girl', 6008644]]);
        const status = value => (value === 'zzz nothing' ? 'unknown' : value === 'parts:cape' ? '' : 'known');
        const tagHeat = value => { asked.push(value); return heats.has(value) ? heats.get(value) : null; };
        const partInfo = () => ({ exists: true, count: 2 });
        const capsules = [capsule('fig'), capsule('1girl'), capsule('zzz nothing'), capsule('parts:cape')];
        const chips = renderChips(container, capsules, { text, tagStatus: status, tagHeat, partInfo });
        assert.deepEqual(asked, ['fig', '1girl'], 'an unknown value and a part are never asked');
        assert.equal(chips[0].classList.contains('is-heat-weak'), true);
        assert.equal(chips[1].classList.contains('is-heat-weak'), false);
        assert.equal(chips[2].classList.contains('is-heat-weak'), false);
        assert.equal(chips[3].classList.contains('is-heat-weak'), false);

        // the same chips, the heat of 1girl now thin: only that chip is re-rendered
        heats.set('1girl', 500);
        const again = renderChips(container, capsules, { text, tagStatus: status, tagHeat, partInfo });
        assert.equal(again[1], chips[1], 'the element is kept');
        assert.equal(again[1].classList.contains('is-heat-thin'), true);
        assert.equal(again[0].classList.contains('is-heat-weak'), true);
    });
});
