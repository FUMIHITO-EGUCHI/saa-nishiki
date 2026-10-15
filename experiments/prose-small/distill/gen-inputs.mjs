// Inputs for the Prose distillation: the JSON field sets SAA hands the LLM
// (buildProseFields in scripts/shared/prosePrompt.js), drawn to cover what the app
// actually sends - one to three characters, named or by looks, an action in English
// or Japanese with @refs, a pose named rather than described, the three scopes
// (cast / scene / all), the Refine fallback shape, artist tags, weights, LoRA triggers.
//
//   node experiments/prose-small/distill/gen-inputs.mjs [--n=5000] [--seed=1] [--out=inputs.jsonl] [--v2=0]
//
// --v2=<share>: that share of the samples is drawn the way real use turned out to differ
// from the first batch (student v1, 2026-09-26): characters given by name alone, and an
// action of two or three sentences that describe a state (body, time of day, outfit,
// which way the character faces) rather than one act. v1 never showed either, so the
// student invented an appearance for a bare name and repeated itself once per sentence.
//
// Deterministic for a seed. Tags come from data/danbooru_e621_merged.csv (heat-weighted
// picks from category 0 general tags, category 4 characters) plus curated lists for the
// fields whose tags are few.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const ROOT = path.resolve(HERE, '../../..');
const args = Object.fromEntries(process.argv.slice(2).map(a => { const m = a.match(/^--([^=]+)=(.*)$/); return m ? [m[1], m[2]] : [a.replace(/^--/, ''), 'true']; }));
const N = Number(args.n || 5000);
const OFFSET = Number(args.offset || 0); // first id, so a second batch can be appended to the first
const NSFW = Number(args.nsfw || 0);     // share of samples drawn with the NSFW pools (0..1)
const OUT = path.resolve(HERE, args.out || 'inputs.jsonl');
const V2 = Number(args.v2 || 0);         // share of samples in the v2 shape (see above)

// ---- rng --------------------------------------------------------------------
let s = Number(args.seed || 1) >>> 0 || 1;
const rnd = () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
const pick = arr => arr[Math.floor(rnd() * arr.length)];
const chance = p => rnd() < p;
const shuffle = arr => { const a = arr.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const some = (arr, min, max) => shuffle(arr).slice(0, min + Math.floor(rnd() * (max - min + 1)));

// ---- dictionary -------------------------------------------------------------
const rows = readFileSync(path.join(ROOT, 'data/danbooru_e621_merged.csv'), 'utf8').split('\n').map(l => l.match(/^([^,]+),(\d+),(\d+)/)).filter(Boolean)
    .map(m => ({ tag: m[1], cat: Number(m[2]), heat: Number(m[3]) }));
const general = rows.filter(r => r.cat === 0);
const tagsOf = (re, min) => general.filter(r => re.test(r.tag) && r.heat >= min).map(r => r.tag.replace(/_/g, ' '));
const characters = rows.filter(r => r.cat === 4 && r.heat >= 3000).map(r => r.tag.replace(/_/g, ' '));
const artists = rows.filter(r => r.cat === 1 && r.heat >= 2000).map(r => r.tag);

const HAIR_LEN = ['long hair', 'short hair', 'very long hair', 'medium hair', 'twintails', 'ponytail', 'braid', 'bob cut', 'side ponytail', 'hair bun', 'twin braids', 'low twintails'];
const HAIR_COL = tagsOf(/^(blonde|black|brown|blue|white|pink|grey|purple|red|green|orange|silver|aqua)_hair$/, 1000);
const EYES = tagsOf(/^(blue|red|green|brown|purple|yellow|pink|black|grey|aqua|orange|golden|amber)_eyes$/, 1000);
const TOPS = tagsOf(/^(white|black|blue|red|pink|grey|striped|plaid|sleeveless|collared|dress|t-|off-shoulder)?_?(shirt|blouse|sweater|hoodie|jacket|cardigan|coat|tank_top|crop_top|turtleneck|sailor_collar|serafuku|school_uniform|blazer)$/, 1000);
const BOTTOMS = tagsOf(/^(black|blue|red|white|pleated|plaid|denim|mini|long|frilled|pencil)?_?(skirt|shorts|pants|jeans|miniskirt)$/, 1000);
const DRESSES = tagsOf(/^(white|black|blue|red|pink|frilled|sun|summer|sleeveless|wedding|china|sailor)?_?(dress|gown|kimono|yukata|maid|swimsuit|bikini|one-piece_swimsuit|school_swimsuit|leotard|bodysuit)$/, 1000);
const EXTRAS = tagsOf(/^(thighhighs|pantyhose|kneehighs|socks|gloves|hat|beret|ribbon|hair_ribbon|hair_bow|hairband|hairclip|glasses|necktie|bowtie|scarf|earrings|choker|bag|cat_ears|animal_ears|fox_ears|horns|wings|halo|tail|sneakers|boots|loafers|mary_janes|apron|cape|hood|mask|goggles|headphones|crown|tiara|beanie|baseball_cap|witch_hat|cat_tail)$/, 1000);
const VIEWS = ['full body', 'upper body', 'cowboy shot', 'portrait', 'close-up', 'from side', 'from behind', 'from above', 'from below', 'looking at viewer', 'looking back', 'dutch angle', 'wide shot', 'profile', 'looking at another'];
const BACKGROUNDS = ['classroom', 'beach', 'city street', 'park', 'forest', 'bedroom', 'kitchen', 'library', 'rooftop', 'train station', 'cafe', 'shrine', 'bridge', 'flower field', 'mountain', 'ocean', 'hot spring', 'garden', 'hallway', 'office', 'living room', 'bathroom', 'pool', 'snow', 'rain', 'night city', 'sunset beach', 'starry sky', 'castle', 'ruins', 'alley', 'convenience store', 'school gate', 'gymnasium', 'bus stop', 'balcony', 'festival', 'amusement park', 'aquarium', 'space station', 'underwater', 'simple background, white background', 'grey background', 'gradient background'];
const BG_TIME = ['', '', 'night', 'sunset', 'morning', 'evening', 'day', 'dusk'];
const STYLES = ['soft lighting', 'backlighting', 'cinematic lighting', 'dramatic lighting', 'rim lighting', 'warm colors', 'cool colors', 'pastel colors', 'monochrome', 'sketch', 'watercolor', 'flat color', 'anime screencap', 'retro artstyle', 'film grain', 'depth of field', 'bokeh', 'lens flare', 'high contrast', 'muted colors', 'vibrant colors', 'neon lights', 'golden hour', 'chiaroscuro', 'cel shading', 'thick outlines', 'sparkle', 'light particles', 'glowing', 'volumetric lighting'];
const POSITIVES = ['smile', 'blush', 'open mouth', 'closed eyes', 'serious', 'crying', 'laughing', 'grin', 'embarrassed', 'wind', 'hair blowing', 'holding book', 'holding umbrella', 'holding cup', 'holding phone', 'holding flower', 'wet', 'sweat', 'cherry blossoms', 'falling petals', 'confetti', 'balloons', 'lantern', 'fireworks', 'cat', 'dog', 'bird', 'butterfly', 'food', 'umbrella', 'bicycle', 'car', 'bench', 'fence', 'street lamp', 'vending machine', 'steam', 'snowing', 'wind lift', 'dynamic pose', 'sitting', 'standing', 'lying', 'walking', 'running', 'jumping', 'leaning forward', 'arms up', 'hand on hip', 'hands on own face', 'peace sign', 'waving', 'crossed arms', 'head tilt'];
const COUNTS_ONE = ['1girl, solo', '1girl, solo', '1girl, solo', '1girl, solo', '1boy, solo', '1other, solo'];
const COUNTS_TWO = ['2girls', '2girls', '2girls', '1girl, 1boy', '1girl, 1boy', '2boys', 'multiple girls, 2girls'];
const COUNTS_THREE = ['3girls', '3girls', '2girls, 1boy', 'multiple girls, 3girls'];
const QUALITY = ['masterpiece, best quality, score_7, safe', 'masterpiece, best quality, score_7, safe', 'masterpiece, best quality', 'masterpiece, best quality, score_8, sensitive', 'best quality, score_7, safe', 'masterpiece, best quality, amazing quality', 'masterpiece, best quality, score_7, safe, year 2024', 'masterpiece, best quality, score_7, newest'];
const LORA_WORDS = ['ohwx', 'sks', 'zwx style', 'detailed_eyes', 'xyz_illustration', 'realskin', 'msk style', 'nnn_line'];
// NSFW pools (the app is uncensored; the student must not learn to refuse or to drop these tags)
const NSFW_QUALITY = ['masterpiece, best quality, score_7, nsfw', 'masterpiece, best quality, score_7, explicit', 'masterpiece, best quality, amazing quality, nsfw, explicit', 'masterpiece, best quality, score_8, sensitive'];
const NSFW_OUTFIT = ['nude', 'completely nude', 'topless', 'bottomless', 'underwear only', 'lingerie', 'black bra, black panties', 'white bra, white panties', 'naked shirt', 'naked apron', 'see-through', 'wet shirt', 'micro bikini', 'torn clothes', 'open shirt, no bra', 'thong', 'garter belt, lingerie'];
const NSFW_POSITIVE = ['nipples', 'large breasts', 'small breasts', 'medium breasts', 'pussy', 'anus', 'spread legs', 'ass', 'cameltoe', 'sweat', 'saliva', 'blush', 'heavy breathing', 'embarrassed', 'looking at viewer', 'lying', 'on bed', 'on back', 'all fours', 'sitting', 'kneeling', 'bent over', 'seductive smile', 'half-closed eyes', 'covering breasts', 'covering crotch', 'hand between legs'];
const NSFW_TWO = [
    ['{A} kisses {B} deeply, holding her face', '{A} が {B} の顔を両手で包んでディープキスしている'],
    ['{A} gropes the breasts of {B} from behind', '{A} が後ろから {B} の胸を揉んでいる'],
    ['{A} pins {B} to the bed and kisses her neck', '{A} が {B} をベッドに押し倒して首筋にキスしている'],
    ['{A} lies on top of {B} on the bed, faces close', '{A} が {B} の上に覆いかぶさり顔を寄せている'],
    ['{B} sits on the lap of {A}, facing her, arms around her neck', '{B} が {A} の膝の上に向かい合って座り、首に腕を回している'],
    ['{A} undresses {B}, pulling her shirt over her head', '{A} が {B} のシャツを脱がせている'],
    ['{A} and {B} bathe together, {A} washing the back of {B}', '{A} と {B} が一緒に入浴し、{A} が {B} の背中を洗っている'],
    ['{A} lifts the skirt of {B}', '{A} が {B} のスカートをめくっている'],
    ['{A} licks the ear of {B}', '{A} が {B} の耳を舐めている'],
    ['{A} sucks the nipple of {B}', '{A} が {B} の乳首を吸っている'],
    ['{A} has sex with {B} in the missionary position', '{A} が {B} と正常位でセックスしている'],
    ['{B} rides {A}, cowgirl position', '{B} が {A} に騎乗位でまたがっている'],
    ['{A} fingers {B} from behind', '{A} が後ろから {B} の股間を指で弄っている'],
    ['{A} pushes {B} against the wall and gropes her under her skirt', '{A} が {B} を壁に押しつけてスカートの中に手を入れている'],
];
const NSFW_ONE = [
    ['{A} undresses, pulling her shirt over her head', '{A} がシャツを脱いでいる'],
    ['{A} lies on the bed touching herself', '{A} がベッドで自慰している'],
    ['{A} bathes, washing her hair', '{A} が入浴して髪を洗っている'],
    ['{A} poses on all fours looking back', '{A} が四つん這いで振り返っている'],
    ['{A} spreads her legs sitting on the bed', '{A} がベッドに座って脚を開いている'],
    ['{A} covers her breasts with her arms, embarrassed', '{A} が腕で胸を隠して恥ずかしがっている'],
];

// ---- actions ----------------------------------------------------------------
// [en, ja] pairs; {A}/{B}/{C} are refs, {a}/{b} are the same characters named by
// their looks in a plain-English variant (SAA users also write "the blonde girl").
const TWO = [
    ['{A} is carrying {B} in her arms', '{A} が {B} をお姫様抱っこしている'],
    ['{A} princess carry {B}', '{A} が {B} を姫抱き'],
    ['{B} is giving {A} a piggyback ride on her back', '{B} が {A} をおんぶしている'],
    ['{A} is patting {B} on the head', '{A} が {B} の頭をなでている'],
    ['{A} headpat {B}', '{A} が {B} を頭ぽんぽん'],
    ['{B} kneels on the floor and {A} stands in front of her looking down at her', '{B} が床にひざまずき、{A} がその前に立って見下ろしている'],
    ['the two face each other with their arms stretched out, holding hands', '二人が向かい合って、腕を伸ばして手をつないでいる'],
    ['{A} is feeding {B} with a spoon', '{A} が {B} にスプーンで食べさせている'],
    ['{A} hugs {B} from behind', '{A} が {B} を後ろから抱きしめている'],
    ['{A} lap pillow {B}', '{A} が {B} に膝枕をしている'],
    ['{B} lies with her head on the lap of {A}', '{B} が {A} の膝の上に頭を乗せて寝ている'],
    ['{A} kabedon {B}', '{A} が {B} に壁ドンしている'],
    ['{A} pins {B} against the wall with one hand beside her head', '{A} が片手を壁について {B} を追い詰めている'],
    ['{A} wipes the tears of {B} with a handkerchief', '{A} がハンカチで {B} の涙を拭いている'],
    ['{A} ties the hair of {B}', '{A} が {B} の髪を結んでいる'],
    ['{A} braids the hair of {B} who sits in front of her', '{A} が前に座る {B} の髪を編んでいる'],
    ['{A} holds an umbrella over {B}', '{A} が {B} に傘をさしかけている'],
    ['{A} pulls {B} by the hand', '{A} が {B} の手を引いている'],
    ['{A} pushes {B} on a swing', '{A} が {B} の乗るブランコを押している'],
    ['{A} and {B} share one pair of earphones', '{A} と {B} がイヤホンを片方ずつ分けて聞いている'],
    ['{A} puts a scarf around the neck of {B}', '{A} が {B} の首にマフラーを巻いてあげている'],
    ['{A} sits on the shoulders of {B}', '{A} が {B} に肩車されている'],
    ['{B} carries {A} on her shoulders', '{B} が {A} を肩車している'],
    ['{A} pinches the cheek of {B}', '{A} が {B} の頬をつねっている'],
    ['{A} offers {B} a flower', '{A} が {B} に花を差し出している'],
    ['{A} bandages the arm of {B}', '{A} が {B} の腕に包帯を巻いている'],
    ['{A} leans on the shoulder of {B}, asleep', '{A} が {B} の肩にもたれて眠っている'],
    ['{A} and {B} pinky swear', '{A} と {B} が指切りをしている'],
    ['{A} takes a photo of {B} with a phone', '{A} がスマホで {B} を撮っている'],
    ['{A} teaches {B} to ride a bicycle, holding the back of the seat', '{A} が {B} の自転車のサドルを支えて練習させている'],
    ['{A} kisses the forehead of {B}', '{A} が {B} の額にキスしている'],
    ['{A} wraps a towel around the wet hair of {B}', '{A} が {B} の濡れた髪をタオルで拭いている'],
    ['{A} drags {B} by the collar', '{A} が {B} の襟首をつかんで引きずっている'],
    ['{A} lifts {B} up by the armpits', '{A} が {B} を脇の下から持ち上げている'],
    ['{A} ruffles the hair of {B}, who pouts', '{A} が {B} の髪をくしゃくしゃにして、{B} はふくれている'],
    ['{A} hands a cup of tea to {B}', '{A} が {B} にお茶を手渡している'],
    ['{A} and {B} sit back to back', '{A} と {B} が背中合わせに座っている'],
    ['{A} peeks over the shoulder of {B} at the book she reads', '{A} が {B} の肩越しに本をのぞき込んでいる'],
    ['{A} is chasing {B}', '{A} が {B} を追いかけている'],
    ['{A} lends a hand to {B} who has fallen', '{A} が転んだ {B} に手を差し伸べている'],
];
const ONE = [
    ['{A} reads a book by the window', '{A} が窓辺で本を読んでいる'],
    ['{A} stretches after waking up', '{A} が起きて伸びをしている'],
    ['{A} sips coffee at a counter', '{A} がカウンターでコーヒーを飲んでいる'],
    ['{A} runs through the rain holding a bag over her head', '{A} が鞄を頭にかざして雨の中を走っている'],
    ['{A} looks back over her shoulder', '{A} が肩越しに振り返っている'],
    ['{A} sits on a swing, legs dangling', '{A} がブランコに座って足をぶらぶらさせている'],
    ['{A} ties her shoelaces', '{A} が靴ひもを結んでいる'],
    ['{A} holds a cat up to her face', '{A} が猫を顔の高さに抱き上げている'],
    ['{A} leans on a railing looking at the sea', '{A} が手すりにもたれて海を見ている'],
    ['{A} yawns, covering her mouth', '{A} が口を押さえてあくびをしている'],
    ['{A} balances on one leg', '{A} が片足で立ってバランスをとっている'],
    ['{A} shields her eyes from the sun', '{A} が手で日差しをさえぎっている'],
    ['{A} eats a rice ball on a bench', '{A} がベンチでおにぎりを食べている'],
    ['{A} crouches to pick up a coin', '{A} がしゃがんで小銭を拾っている'],
    ['{A} lies on the grass with her arms spread', '{A} が芝生に大の字で寝転んでいる'],
    ['{A} is doing a peace sign', '{A} がピースサインをしている'],
    ['{A} is jumping', '{A} がジャンプしている'],
];
const THREE = [
    ['{A} and {B} pull {C} by both hands', '{A} と {B} が {C} の両手を引っ張っている'],
    ['{C} stands between {A} and {B}, arms around their shoulders', '{C} が {A} と {B} の間に立って二人の肩に腕を回している'],
    ['{A} braids the hair of {B} while {C} watches, lying on the floor', '{A} が {B} の髪を編み、{C} は床に寝転んで見ている'],
    ['{A} holds up a phone to take a selfie with {B} and {C}', '{A} がスマホをかざして {B} と {C} と自撮りしている'],
    ['{A} carries {B} on her back while {C} runs ahead', '{A} が {B} をおんぶして、{C} が先を走っている'],
    ['the three sit in a row on a bench, {B} asleep on the shoulder of {A}', '三人がベンチに並んで座り、{B} は {A} の肩にもたれて眠っている'],
];

// ---- v2: state descriptions, [en, ja], what people actually type into Action --------
const STATE_BODY = [
    ['{A} is very slender', '{A} の体型はとても細い'],
    ['{A} has large ears', '{A} は大きな耳がついている'],
    ['{A} is petite with a small chest', '{A} は小柄で胸が小さい'],
    ['{A} is tall with an athletic build', '{A} は背が高くて運動選手のような体つき'],
    ['{A} is curvy with wide hips', '{A} は腰回りがふくよか'],
    ['{A} has a slim waist and long legs', '{A} は腰が細くて脚が長い'],
    ['{A} has a soft, plump body', '{A} はやわらかくてぽっちゃりした体'],
];
const STATE_TIME = [
    ['it is night and the room has no lights on', '時間帯は夜で明かりのない暗い部屋'],
    ['it is early morning with soft light through the window', '早朝で窓から柔らかい光が差している'],
    ['it is sunset and the light is orange', '夕方で光がオレンジ色'],
    ['it is noon under strong sunlight', '真昼で強い日差し'],
    ['it is a rainy evening', '雨の夕暮れ'],
    ['the only light is a bedside lamp', '明かりは枕元のランプだけ'],
];
const STATE_OUTFIT = [
    ['{A} wears cute casual clothes', '{A} は可愛らしい私服姿'],
    ['{A} wears pajamas', '{A} はパジャマ姿'],
    ['{A} wears a school uniform', '{A} は制服姿'],
    ['{A} wears a swimsuit', '{A} は水着姿'],
    ['{A} wears only underwear', '{A} は下着だけ'],
    ['{A} wears an oversized shirt and nothing else', '{A} は大きめのシャツ一枚だけ'],
    ['{A} is naked', '{A} は裸'],
];
const STATE_FACING = [
    ['{A} faces the camera with the whole body', '{A} はカメラの方を体ごと向いている'],
    ['{A} looks back over the shoulder at the viewer', '{A} は肩越しにこちらを振り返っている'],
    ['{A} looks away from the camera', '{A} はカメラから目をそらしている'],
    ['{A} is seen from the side', '{A} は横から見た姿'],
    ['{A} turns the back to the viewer', '{A} はこちらに背を向けている'],
    ['{A} looks straight at the viewer', '{A} はまっすぐこちらを見ている'],
];
const STATE_PLACE = [
    ['{A} is in a bedroom', '{A} はベッドルームにいる'],
    ['{A} sits on the edge of a bed', '{A} はベッドの端に座っている'],
    ['{A} stands by the window', '{A} は窓のそばに立っている'],
    ['{A} is in a bathroom', '{A} は浴室にいる'],
    ['{A} lies on a sofa', '{A} はソファに寝そべっている'],
    ['{A} kneels on the floor', '{A} は床に膝をついている'],
];
const STATE_MOOD = [
    ['{A} looks shy', '{A} は恥ずかしそう'],
    ['{A} smiles gently', '{A} は優しく微笑んでいる'],
    ['{A} looks bored', '{A} は退屈そう'],
    ['{A} is about to cry', '{A} は泣きそう'],
    ['{A} looks annoyed', '{A} はむっとしている'],
];
const STATE_GROUPS = [STATE_BODY, STATE_TIME, STATE_OUTFIT, STATE_FACING, STATE_PLACE, STATE_MOOD];
// Two or three state sentences about one character, as separate sentences or lines.
function stateAction(lang, ref) {
    const li = lang === 'ja' ? 1 : 0;
    const groups = shuffle(STATE_GROUPS).slice(0, 2 + (chance(0.5) ? 1 : 0));
    const parts = groups.map(g => refOf(pick(g)[li], [ref]));
    const end = lang === 'ja' ? '。' : '.';
    const sep = chance(0.5) ? '\n' : ' ';
    return parts.map(p => (lang === 'ja' ? p : p.charAt(0).toUpperCase() + p.slice(1)) + end).join(sep);
}

// ---- characters -------------------------------------------------------------
function looks(nsfw = false) {
    const parts = [pick(HAIR_LEN), pick(HAIR_COL), pick(EYES)];
    if (nsfw && chance(0.7)) parts.push(pick(NSFW_OUTFIT));
    else if (chance(0.55)) parts.push(pick(TOPS), pick(BOTTOMS)); else parts.push(pick(DRESSES));
    parts.push(...some(EXTRAS, 0, 2));
    return parts.join(', ');
}
function character(named, nsfw = false, nameOnly = false) {
    // v2: a name alone, or a name and one outfit tag, is how SAA's character slots arrive
    if (named && nameOnly) return chance(0.5) ? pick(characters) : `${pick(characters)}, ${pick(chance(0.5) ? TOPS : DRESSES)}`;
    if (named) return `${pick(characters)}, ${looks(nsfw)}`;
    return looks(nsfw);
}
function refOf(text, refs) {
    return text.replace(/\{A\}/g, refs[0]).replace(/\{B\}/g, refs[1] ?? refs[0]).replace(/\{C\}/g, refs[2] ?? refs[0]);
}

// ---- one sample ---------------------------------------------------------------
function sample(i) {
    const nsfw = chance(NSFW);
    const count = chance(0.5) ? 1 : chance(0.8) ? 2 : 3;
    const v2 = chance(V2);
    const named = v2 ? chance(0.75) : chance(0.3);
    const refs = ['@1', '@2', '@3'].slice(0, count);
    const cast = chance(0.7); // {ref, tags} entries; otherwise plain strings
    const chars = refs.map(() => character(named && chance(0.7), nsfw, v2 && chance(0.7)));
    const characterEntries = cast ? chars.map((tags, k) => ({ ref: refs[k], tags })) : chars;
    const countTag = count === 1 ? pick(COUNTS_ONE) : count === 2 ? pick(COUNTS_TWO) : pick(COUNTS_THREE);
    const commonParts = [nsfw ? pick(NSFW_QUALITY) : pick(QUALITY), countTag];
    if (chance(0.2)) commonParts.push(`@${pick(artists)}`);
    const view = chance(0.85) ? some(VIEWS, 1, 2).join(', ') : '';
    const background = chance(0.75) ? [pick(BACKGROUNDS), pick(BG_TIME)].filter(Boolean).join(', ') : '';
    const style = chance(0.35) ? some(STYLES, 1, 3).join(', ') : '';
    const positiveParts = chance(0.55) ? some(nsfw ? NSFW_POSITIVE : POSITIVES, 1, 3) : [];
    if (chance(0.12)) positiveParts.push(`(${pick(POSITIVES)}:${(1 + Math.round(rnd() * 5) / 10).toFixed(1)})`);
    if (chance(0.08)) positiveParts.push(pick(LORA_WORDS));
    const lang = chance(0.5) ? 'ja' : 'en';
    let action = '';
    const wantAction = count === 1 ? chance(v2 ? 0.8 : 0.4) : chance(0.85);
    if (wantAction && v2 && (count === 1 || chance(0.5))) {
        // the v2 shape: state sentences about one character, alone or after one act
        const who = cast ? pick(refs) : (lang === 'ja' ? '一人目の少女' : 'the first girl');
        const state = stateAction(lang, who);
        if (count === 1) action = state;
        else {
            const t = pick(nsfw ? NSFW_TWO : TWO);
            const plainNames = lang === 'ja' ? ['一人目の少女', '二人目の少女'] : ['the first girl', 'the second girl'];
            action = refOf(t[lang === 'ja' ? 1 : 0], cast ? refs : plainNames) + (lang === 'ja' ? '。' : '.') + (chance(0.5) ? '\n' : ' ') + state;
        }
    } else if (wantAction) {
        const t = pick(count === 1 ? (nsfw ? NSFW_ONE : ONE) : count === 2 ? (nsfw ? NSFW_TWO : TWO) : THREE);
        const plainNames = lang === 'ja' ? ['一人目の少女', '二人目の少女', '三人目の少女'] : ['the first girl', 'the second girl', 'the third girl'];
        action = refOf(t[lang === 'ja' ? 1 : 0], cast ? refs : plainNames.slice(0, count));
        // without a cast SAA still sends the action; refs then read as plain words
    }
    const scope = pick(['all', 'all', 'scene', 'cast']);
    let fields = { common: commonParts.join(', '), characters: characterEntries, view, background, style, positive: positiveParts.join(', '), action };
    if (chance(0.08)) {
        // the Refine fallback: everything already flattened into positive
        const flat = [fields.common, ...chars, view, background, style, fields.positive].filter(Boolean).join(', ');
        fields = { common: '', characters: [], view: '', background: '', style: '', positive: flat, action };
    } else {
        const keep = { cast: ['view', 'background', 'style', 'positive'], scene: ['view', 'positive'], all: [] }[scope];
        const kept = [fields.common, ...keep.map(k => fields[k])].filter(Boolean).join(', ');
        for (const k of keep) fields[k] = '';
        fields.common = kept;
    }
    return { id: OFFSET + i, lang, count, scope, nsfw, v2, fields };
}

mkdirSync(HERE, { recursive: true });
const lines = [];
for (let i = 0; i < N; i++) lines.push(JSON.stringify(sample(i)));
writeFileSync(OUT, lines.join('\n') + '\n');
console.log(`wrote ${N} inputs to ${OUT} (hair ${HAIR_COL.length}, eyes ${EYES.length}, tops ${TOPS.length}, bottoms ${BOTTOMS.length}, dresses ${DRESSES.length}, extras ${EXTRAS.length}, characters ${characters.length}, artists ${artists.length})`);
