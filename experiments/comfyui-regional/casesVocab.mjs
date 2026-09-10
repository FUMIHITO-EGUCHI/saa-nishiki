// The Danbooru vocabulary experiment.
//
// Danbooru encodes direction in the tag itself, and the model is trained on it:
// `hand on another's head` (53k posts) belongs to the girl whose hand it is,
// `carrying person` (17k) to the one doing the supporting, `hug from behind` (39k) to
// the one behind, `looking at another` (436k) to the one looking. The earlier runs
// never used that vocabulary - they used English-ish phrases like "feeding another"
// and "one girl kneeling before another", which the model has never seen as tags.
//
// ANOTHERS_CASES puts the whole interaction in Base as real tags, and leaves the two
// side prompts carrying APPEARANCE ONLY - no pose, no role, nothing that says who is
// acting. If the vocabulary is doing the work, the action should still come out with
// one carrier and one carried, one spoon, one kneeler.
//
// SINGLE_CASES is the same tags with no regions at all: one prompt, the way SAA's
// non-Regional path already works, so the masking is the only variable.

import { CASE_SETS } from './cases.mjs';

const QUALITY = 'masterpiece, best quality, amazing quality';

export const ANOTHERS_CASES = [
    {
        id: 'princess-carry',
        base: `${QUALITY}, 2girls, princess carry, carrying person, height difference, looking at another, indoors, full body`,
        left: '1girl, long blonde hair, blue eyes, white dress',
        right: '1girl, short black hair, red eyes, black suit',
    },
    {
        id: 'piggyback',
        base: `${QUALITY}, 2girls, piggyback, carrying person, on another's back, arms around another's neck, outdoors, park, full body`,
        left: '1girl, long blonde hair, blue eyes, white dress',
        right: '1girl, short black hair, red eyes, black jacket',
    },
    {
        id: 'headpat',
        base: `${QUALITY}, 2girls, headpat, hand on another's head, height difference, looking at another, indoors, upper body`,
        left: '1girl, short blonde hair, blue eyes, white blouse',
        right: '1girl, long black hair, red eyes, black coat',
    },
    {
        id: 'kneel-and-stand',
        base: `${QUALITY}, 2girls, kneeling, standing, height difference, looking up at another, looking down at another, hand on another's cheek, indoors, full body`,
        left: '1girl, long blonde hair, blue eyes, white dress',
        right: '1girl, short black hair, red eyes, black coat',
    },
    {
        id: 'hands-apart',
        base: `${QUALITY}, 2girls, holding hands, facing another, arms outstretched, standing, outdoors, full body`,
        left: '1girl, long blonde hair, blue eyes, white summer dress',
        right: '1girl, short black hair, red eyes, black jacket',
    },
    {
        id: 'feeding',
        base: `${QUALITY}, 2girls, feeding, holding spoon, outstretched arm, open mouth, looking at another, cafe, upper body`,
        left: '1girl, long blonde hair, blue eyes, white blouse',
        right: '1girl, short black hair, red eyes, black jacket',
    },
];

CASE_SETS.anothers = ANOTHERS_CASES;

// One face prompt per side for the detailer pass. Short on purpose: the detailer
// redraws a face-sized crop, so a full body description only confuses it.
export const FACES = {
    'princess-carry': { left: '1girl, long blonde hair, blue eyes', right: '1girl, short black hair, red eyes' },
    'piggyback': { left: '1girl, long blonde hair, blue eyes', right: '1girl, short black hair, red eyes' },
    'headpat': { left: '1girl, short blonde hair, blue eyes', right: '1girl, long black hair, red eyes' },
    'kneel-and-stand': { left: '1girl, long blonde hair, blue eyes', right: '1girl, short black hair, red eyes' },
    'hands-apart': { left: '1girl, long blonde hair, blue eyes', right: '1girl, short black hair, red eyes' },
    'feeding': { left: '1girl, long blonde hair, blue eyes', right: '1girl, short black hair, red eyes' },
};

const looksOnly = text => text.replace(/^1girl,\s*/, '');

export const SINGLE_CASES = ANOTHERS_CASES.map(entry => ({
    id: entry.id,
    prompt: `${entry.base}, ${looksOnly(entry.left)}, ${looksOnly(entry.right)}`,
}));
