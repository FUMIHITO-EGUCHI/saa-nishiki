// Test cases for the one thing the Regional split is bad at: an action that belongs to
// both sides at once, with a direction — who carries whom, who reaches into whose half.
//
// The easy case (two girls standing side by side hugging) already works with the
// current method, because the bodies meet in the overlap column. Everything here breaks
// that assumption on purpose:
//
//   - the two bodies are not the same shape or height, so a straight left/right split
//     cannot contain them
//   - the action starts in one half and lands in the other, so the acting side has to
//     draw a limb that only makes sense because of what is in the opposite region
//   - swapping the two sides would produce a different, wrong picture - which makes it
//     easy to see whether the direction survived
//
// `left` is always the subordinate / receiving side, `right` the acting one.

const QUALITY = 'masterpiece, best quality, amazing quality';

export const CASES = [
    {
        id: 'princess-carry',
        why: 'one body is horizontal and off the ground: no left/right split contains it',
        base: `${QUALITY}, 2girls, princess carry, indoors, full body`,
        left: '1girl, long blonde hair, blue eyes, white dress, carried, arms around another\'s neck, legs together',
        right: '1girl, short black hair, red eyes, black suit, carrying, standing, holding another',
    },
    {
        id: 'piggyback',
        why: 'the two bodies fully overlap instead of sitting side by side',
        base: `${QUALITY}, 2girls, piggyback, outdoors, park, full body`,
        left: '1girl, long blonde hair, blue eyes, white dress, carried, arms around another\'s neck',
        right: '1girl, short black hair, red eyes, black jacket, carrying, walking',
    },
    {
        id: 'headpat',
        why: 'a hand has to cross into the other region and land on a specific spot',
        base: `${QUALITY}, 2girls, headpat, hand on another's head, height difference, indoors`,
        left: '1girl, short blonde hair, blue eyes, white blouse, shorter, blush, looking up',
        right: '1girl, long black hair, red eyes, black coat, taller, gentle smile, looking down at another',
    },
    {
        id: 'kneel-and-stand',
        why: 'the heads are at different heights, so the sides carry different vertical content',
        base: `${QUALITY}, 2girls, one girl kneeling before another, indoors, full body`,
        left: '1girl, long blonde hair, blue eyes, white dress, kneeling, looking up, hands on lap',
        right: '1girl, short black hair, red eyes, black coat, standing, looking down at another, arms crossed',
    },
    {
        id: 'hands-apart',
        why: 'only the hands meet, in a thin strip at the seam between the two masks',
        base: `${QUALITY}, 2girls, holding hands, arms outstretched, facing each other, standing apart, outdoors`,
        left: '1girl, long blonde hair, blue eyes, white summer dress, smile',
        right: '1girl, short black hair, red eyes, black jacket, serious',
    },
    {
        id: 'feeding',
        why: 'the acting arm reaches deep into the other region and must end at a mouth',
        base: `${QUALITY}, 2girls, feeding another, holding spoon, cafe, upper body`,
        left: '1girl, long blonde hair, blue eyes, white blouse, open mouth, blush, being fed',
        right: '1girl, short black hair, red eyes, black jacket, holding spoon, smile',
    },
];

// The same situations with the directional tag taken OUT of the Base prompt.
//
// Base goes into both sides' conditioning, so "feeding another" written there is just as
// true of the girl being fed - which is how you get two spoons, or both girls kneeling.
// Here Base carries only the place and the head count, the acting tag exists only on the
// right, and the receiving tag only on the left. Nothing in the left region says anyone
// is performing the action.
export const SPLIT_CASES = [
    {
        id: 'princess-carry',
        base: `${QUALITY}, 2girls, indoors, full body`,
        left: '1girl, long blonde hair, blue eyes, white dress, carried, lifted, lying in another\'s arms, legs together, arms around another\'s neck',
        right: '1girl, short black hair, red eyes, black suit, princess carry, carrying, holding another, standing',
    },
    {
        id: 'piggyback',
        base: `${QUALITY}, 2girls, outdoors, park, full body`,
        left: '1girl, long blonde hair, blue eyes, white dress, carried, on another\'s back, arms around another\'s neck',
        right: '1girl, short black hair, red eyes, black jacket, piggyback, carrying, walking',
    },
    {
        id: 'headpat',
        base: `${QUALITY}, 2girls, height difference, indoors`,
        left: '1girl, short blonde hair, blue eyes, white blouse, shorter, blush, looking up, head tilted down',
        right: '1girl, long black hair, red eyes, black coat, taller, headpat, hand on another\'s head, gentle smile, looking down at another',
    },
    {
        id: 'kneel-and-stand',
        base: `${QUALITY}, 2girls, indoors, full body`,
        left: '1girl, long blonde hair, blue eyes, white dress, kneeling, sitting on floor, looking up, hands on lap',
        right: '1girl, short black hair, red eyes, black coat, standing, looking down at another, arms crossed',
    },
    {
        id: 'hands-apart',
        base: `${QUALITY}, 2girls, facing each other, standing apart, outdoors`,
        left: '1girl, long blonde hair, blue eyes, white summer dress, smile, holding hands, arm outstretched',
        right: '1girl, short black hair, red eyes, black jacket, serious, holding hands, arm outstretched',
    },
    {
        id: 'feeding',
        base: `${QUALITY}, 2girls, cafe, upper body`,
        left: '1girl, long blonde hair, blue eyes, white blouse, open mouth, blush, being fed, hands on lap',
        right: '1girl, short black hair, red eyes, black jacket, feeding another, holding spoon, outstretched arm, smile',
    },
];

export const CASE_SETS = { default: CASES, split: SPLIT_CASES };

export const NEGATIVE = 'bad quality, worst quality, worst detail, sketch, censor, jpeg artifacts, signature, watermark';
