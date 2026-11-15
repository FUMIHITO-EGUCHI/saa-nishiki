// The locks on the random sources, end to end: a row's "{a|b}" choice and a Random character
// slot, locked after a run, keep what that run drew through a batch on fresh seeds while an
// unlocked row draws anew; the image's recipe says what its rows drew.
import assert from 'node:assert/strict';
import test from 'node:test';

import { launchApp, workflow } from './harness.mjs';

const MOODS = ['smile', 'frown', 'crying', 'laughing', 'angry', 'sleepy', 'surprised', 'blush'];
const COLORS = ['red', 'blue', 'green', 'white', 'black', 'pink', 'yellow', 'purple'];

let app = null;

test.before(async () => {
    app = await launchApp({
        settings: {
            custom_prompt: `1girl, solo, white background, {${MOODS.join('|')}}`,
            api_prompt: `{${COLORS.join('|')}} shirt`,
            character_slots: [{ key: 'Random', weight: 1 }],
            character1: 'Random',
        },
    });
});
test.after(async () => { await app?.close(); });

// the moods a prompt has (as tags), and the shirt's colour ("white background" is no shirt)
const pick = (prompt, words) => words.filter(word => new RegExp(`(^|, )${word}(,|$)`).test(prompt));
const shirt = prompt => COLORS.filter(color => prompt.includes(`${color} shirt`));
// a character's tag as the prompt writes it (generate.js escapes the brackets)
const asWritten = tag => String(tag).replaceAll('\\', '\\\\').replaceAll('(', '\\(').replaceAll(')', '\\)');

test('a locked row and a locked Random slot keep what they drew through a batch; an unlocked row draws anew', async () => {
    const { page } = app;
    const first = await app.generate({ expectImages: 1 });
    assert.equal(first.error, '');
    const firstPrompt = workflow.positive(first.history[0].workflow, first.history[0].outputs) ?? '';
    const [color] = shirt(firstPrompt);
    assert.ok(color, `a colour in ${firstPrompt}`);
    const run = JSON.parse(await page.evaluate('JSON.stringify(globalThis.mainGallery.currentEntry().record.recipe.run)'));
    assert.deepEqual(run.draws.fields.positive.left.choices, { [COLORS.join('|')]: [color] }, 'the recipe says what the row drew');
    const character = run.characters[0];
    assert.ok(character && character !== 'None' && character !== 'Random', `the slot drew a character, not ${character}`);
    const characterTag = asWritten(await page.evaluate(`globalThis.cachedFiles.characterList[${JSON.stringify(character)}]`));
    assert.ok(firstPrompt.includes(characterTag), `${characterTag} in ${firstPrompt}`);

    // the Positive row's lock (beside its ⋯) and the slot's (after its weight), clicked as a person does
    await page.click('.prompt-positive .prompt-row-lock');
    await page.click('.dropdown-character .character-selection-lock');
    await page.waitFor(`document.querySelector('.prompt-positive .prompt-row-lock').getAttribute('aria-pressed') === 'true'
        && document.querySelector('.dropdown-character .character-selection-lock').getAttribute('aria-pressed') === 'true'`, { label: 'both locks on' });
    assert.equal(await page.evaluate(`document.querySelector('.prompt-positive .prompt-lock-drawn').textContent`), `→ ${color}`);

    await app.setSeed(-1);
    await app.setBatch(3);
    const batch = await app.generate({ mode: 'batch', expectImages: 3 });
    await app.setBatch(1);
    assert.equal(batch.error, '');
    assert.equal(batch.history.length, 3);
    assert.equal(new Set(batch.images.map(image => image.seed)).size, 3, 'three fresh seeds');
    const prompts = batch.history.map(entry => workflow.positive(entry.workflow, entry.outputs) ?? '');
    for (const prompt of prompts) {
        assert.deepEqual(shirt(prompt), [color], `the locked row keeps ${color}: ${prompt}`);
        assert.ok(prompt.includes(characterTag), `the locked slot keeps ${characterTag} (the seed would pick another): ${prompt}`);
    }
    // Common was not locked: its choice is drawn per image (8 options, 4 images)
    const moods = new Set([firstPrompt, ...prompts].map(prompt => pick(prompt, MOODS).join()));
    assert.ok(moods.size > 1, `the unlocked row drew anew: ${[...moods]}`);
});
