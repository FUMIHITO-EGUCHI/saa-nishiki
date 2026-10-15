// The heat tier of a tag on its chip, end to end: the real dictionary answers the real
// lookup, a rare tag (under 100 posts) is underlined as weak, a thin one (under 1,000)
// as thin, a common one is left unmarked, and each tooltip names the tier with the
// exact count. Real app (`npm run test:e2e`); no image is generated.
import assert from 'node:assert/strict';
import test from 'node:test';

import { launchApp } from './harness.mjs';

let app = null;

// Checkpoint: a language-model encoder (Diffusion) gets no dictionary marks at all
test.before(async () => { app = await launchApp({ settings: { api_model_type: 'Checkpoint' } }); });
test.after(async () => { await app?.close(); });

const CHIPS = `(() => JSON.stringify([...document.querySelectorAll('.prompt-positive .tag-capsule-chip')].map(chip => ({
    name: chip.querySelector('.tag-capsule-chip-name')?.textContent ?? '',
    weak: chip.classList.contains('is-heat-weak'),
    thin: chip.classList.contains('is-heat-thin'),
    unknown: chip.classList.contains('is-unknown'),
    title: chip.title,
}))))()`;

test('a rare tag is marked weak, a thin one thin, a common one not at all, and the tooltip gives the count', async () => {
    const { page } = app;
    // fig: 99 posts, cuirass: 999, 1girl: millions (data/danbooru_e621_merged.csv)
    await app.typePositive('1girl, fig, cuirass, zzzqqq');
    await page.evaluate(`(() => {
        const wrapper = document.querySelector('.myTextbox-prompt-positive-textarea').closest('.myTextbox-wrapper');
        const [, chipsButton] = wrapper.querySelectorAll('.tag-view-button');
        chipsButton?.click();
    })()`);
    await page.waitFor(`document.querySelectorAll('.prompt-positive .tag-capsule-chip').length === 4`, { label: 'the four chips' });
    // the dictionary answers in one batched lookup; the marks land on the re-render
    await page.waitFor(`document.querySelector('.prompt-positive .tag-capsule-chip.is-heat-weak') !== null`, { label: 'the weak mark' });
    const chips = JSON.parse(await page.evaluate(CHIPS));
    const byName = Object.fromEntries(chips.map(chip => [chip.name, chip]));
    assert.deepEqual(Object.keys(byName).sort(), ['1girl', 'cuirass', 'fig', 'zzzqqq']);

    assert.equal(byName.fig.weak, true, 'fig has under 100 posts');
    assert.equal(byName.fig.thin, false);
    assert.match(byName.fig.title, /^fig — .+ \(99\)$/, `the tooltip names the tier and the count: ${byName.fig.title}`);

    assert.equal(byName.cuirass.thin, true, 'cuirass has under 1,000 posts');
    assert.equal(byName.cuirass.weak, false);
    assert.match(byName.cuirass.title, /^cuirass — .+ \(999\)$/, byName.cuirass.title);

    assert.equal(byName['1girl'].weak, false, 'a common tag carries no mark');
    assert.equal(byName['1girl'].thin, false);
    assert.match(byName['1girl'].title, /^1girl — .+ \([\d,]{7,}\)$/, `the count still shows: ${byName['1girl'].title}`);

    // one word, so it is read as a tag no entry matches (four words would be a sentence)
    assert.equal(byName.zzzqqq.unknown, true, 'a value no tag matches keeps its unknown mark');
    assert.equal(byName.zzzqqq.weak, false, 'and gets no tier');
    assert.equal(byName.zzzqqq.title, 'zzzqqq');
});
