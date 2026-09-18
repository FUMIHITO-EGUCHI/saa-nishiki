// Natural language versus tags, for the one thing tags cannot express: which of the two
// girls is doing the thing.
//
// Illustrious v0.1 was trained on Danbooru tags alone and its own paper says it "has
// difficulty processing natural language-based prompts, especially longer ones".
// v1.0 - the base WAI v14+ is merged from - added paraphrasing ("1girl" -> "one girl"),
// and full natural language captioning only arrives in v1.1. So some sentence
// understanding should be there, and it should be weaker than a v1.1/v2.0 model.
//
// Unlike every earlier run, these prompts state a direction, so there is a right answer:
// the sentence names the actor and the receiver. Scoring is whether the picture obeys it.
//
//   tags    what the bench has been sending: an unordered tag soup
//   nl      one sentence, no interaction tags at all
//   hybrid  scene and appearance as tags, the action as one sentence

const QUALITY = 'masterpiece, best quality, amazing quality';

// left/blonde is the receiver in most cases, right/black the actor - kept from the
// earlier case set so the appearance tags are identical across every run.
export const NL_CASES = [
    {
        id: 'princess-carry',
        scene: '2girls, indoors, full body',
        looks: 'long blonde hair, blue eyes, white dress, short black hair, red eyes, black suit',
        action: 'the black haired girl is carrying the blonde girl in her arms',
        sentence: 'A girl with short black hair and red eyes in a black suit is carrying a girl with '
            + 'long blonde hair and blue eyes in a white dress in her arms, indoors, full body',
        actor: 'black',
    },
    {
        id: 'piggyback',
        scene: '2girls, outdoors, park, full body',
        looks: 'long blonde hair, blue eyes, white dress, short black hair, red eyes, black jacket',
        action: 'the blonde girl is giving the black haired girl a piggyback ride on her back',
        sentence: 'A girl with long blonde hair and blue eyes in a white dress is giving a piggyback '
            + 'ride to a girl with short black hair and red eyes in a black jacket, in a park, full body',
        actor: 'blonde',
    },
    {
        id: 'headpat',
        scene: '2girls, indoors, upper body',
        looks: 'short blonde hair, blue eyes, white blouse, long black hair, red eyes, black coat',
        action: "the black haired girl is patting the blonde girl's head",
        sentence: 'A tall girl with long black hair and red eyes in a black coat is patting the head of '
            + 'a shorter girl with short blonde hair and blue eyes in a white blouse, indoors, upper body',
        actor: 'black',
    },
    {
        id: 'kneel-and-stand',
        scene: '2girls, indoors, full body',
        looks: 'long blonde hair, blue eyes, white dress, short black hair, red eyes, black coat',
        action: 'the blonde girl is kneeling on the floor and the black haired girl is standing over her',
        sentence: 'A girl with long blonde hair and blue eyes in a white dress is kneeling on the floor '
            + 'looking up at a girl with short black hair and red eyes in a black coat who stands over her, '
            + 'indoors, full body',
        actor: 'black',
    },
    {
        id: 'hands-apart',
        scene: '2girls, outdoors, full body',
        looks: 'long blonde hair, blue eyes, white summer dress, short black hair, red eyes, black jacket',
        action: 'the two girls are facing each other and holding hands with their arms outstretched',
        sentence: 'A girl with long blonde hair and blue eyes in a white summer dress and a girl with '
            + 'short black hair and red eyes in a black jacket are facing each other and holding hands '
            + 'with their arms outstretched, outdoors, full body',
        actor: 'both',
    },
    {
        id: 'feeding',
        scene: '2girls, cafe, upper body',
        looks: 'long blonde hair, blue eyes, white blouse, short black hair, red eyes, black jacket',
        action: 'the black haired girl is feeding the blonde girl with a spoon',
        sentence: 'A girl with short black hair and red eyes in a black jacket is holding out a spoon to '
            + 'feed a girl with long blonde hair and blue eyes in a white blouse, who has her mouth open, '
            + 'in a cafe, upper body',
        actor: 'black',
    },
];

export const nlPrompt = entry => `${QUALITY}, ${entry.sentence}`;
export const hybridPrompt = entry => `${QUALITY}, ${entry.scene}, ${entry.looks}, ${entry.action}`;
