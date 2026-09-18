// What one image drew: which option each "{a|b}" took and what each __wildcard__ became.
//
// The tag prompt is resolved once and records its draws here; everything that has to
// describe that same image - the coloured copy shown in the Info panel, and the units the
// Prose step sends to the LLM - replays them instead of rolling the dice again. Without
// this the paragraph could say "blue dress" while the prompt that produced it said red.
//
// Replay is by content, in order: the second "{a|b}" of an image gets the second draw, so
// two identical choices stay as independent as they were. A miss (material resolved in a
// different order, or not recorded at all) falls back to the last draw of that content,
// and then to a fresh one, which is exactly what happened before this existed.

/** A fresh record. `replay()` ends recording and starts a pass over the same material. */
export function createPromptMaterials() {
    const choices = new Map();      // brace content -> the options taken, in order
    const wildcards = new Map();    // wildcard name -> what it became
    const cursor = new Map();       // brace content -> how many have been replayed
    let recording = true;

    return {
        /** processRandomString: the option to take, or null to draw (and record) one. */
        pick(content) {
            if (recording) return null;
            const taken = choices.get(content);
            if (!taken || taken.length === 0) return null;
            const index = cursor.get(content) ?? 0;
            cursor.set(content, index + 1);
            return taken[Math.min(index, taken.length - 1)];
        },
        remember(content, option) {
            if (!recording) return;
            const taken = choices.get(content);
            if (taken) taken.push(option);
            else choices.set(content, [option]);
        },
        /** replaceWildcardsAsync: what this wildcard became, or undefined to load it. */
        wildcard(name) {
            return wildcards.get(name);
        },
        rememberWildcard(name, value) {
            if (!wildcards.has(name)) wildcards.set(name, value);
        },
        replay() {
            recording = false;
            cursor.clear();
            return this;
        },
    };
}
