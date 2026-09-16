// Builds data/artist_profiles.txt: for every Danbooru artist tag above a post threshold,
// the tags that artist draws far more often than the site average plus the series they
// draw. Not run at app start — rerun when the threshold changes or the data goes stale:
//
//   node scripts/buildArtistProfiles.mjs [--min-heat 500] [--out data/artist_profiles.txt]
//                                        [--delay 300] [--limit 50] [--restart]
//
// The co-occurrence dictionary behind data/tag_related.txt carries no artist tags at all
// (its source CSV only has general, copyright and character tags), so the numbers come
// from Danbooru's related_tag endpoint, two requests per artist, no API key. The run is
// resumable: every finished artist is appended immediately and a rerun skips the artists
// already in the output file.
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { formatArtistProfileLine, parseArtistProfileLine, profileLift } from './shared/artistProfiles.js';

const API = 'https://danbooru.donmai.us';
const USER_AGENT = 'SAA-artist-profiles/1.0 (Stand Alone App tag dictionary build)';
// Danbooru's own artist category, as used in data/danbooru_e621_merged.csv.
const ARTIST_CATEGORY = 1;
const GENERAL_CATEGORY = 0;
const COPYRIGHT_CATEGORY = 3;
// How many related tags to ask for. The endpoint answers ordered by frequency, so the
// distinctive ones are always inside the first few dozen.
const GENERAL_LIMIT = 80;
const COPYRIGHT_LIMIT = 8;
// What reaches the profile.
const MAX_DRAWS = 10;
const MAX_SERIES = 4;
const MIN_DRAW_FREQUENCY = 0.06;
const MIN_DRAW_LIFT = 1.25;
const MIN_SERIES_FREQUENCY = 0.04;
// Only used if /counts/posts.json cannot be reached (site-wide post count, 2026-09).
const FALLBACK_TOTAL_POSTS = 12_154_612;
// General tags that describe the upload rather than the picture. They score a high lift
// for artists who always sign or always post from Twitter, and say nothing about a style.
const METADATA_TAGS = new Set([
    'artist_name', 'signature', 'artist_logo', 'watermark', 'web_address', 'twitter_username',
    'patreon_username', 'pixiv_id', 'weibo_username', 'bilibili_username', 'instagram_username',
    'tumblr_username', 'twitter_logo', 'dated', 'character_name', 'copyright_name', 'logo',
    'commentary', 'commentary_request', 'translation_request', 'one-hour_drawing_challenge',
    'photo_inset', 'md5_mismatch', 'bad_id', 'bad_link', 'content_rating',
    'page_number', 'watermark_grid', 'sample_watermark', 'request_inset',
]);
// The same thing by shape: every site's handle and logo tag (patreon_logo, pixiv_username,
// weibo_watermark, ...). An artist who always stamps their page scores a huge lift on these.
const METADATA_SUFFIXES = ['_username', '_logo', '_watermark'];

function isMetadataTag(tag) {
    return METADATA_TAGS.has(tag) || METADATA_SUFFIXES.some(suffix => tag.endsWith(suffix));
}

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(scriptDir, '..');

function parseArgs(argv) {
    const options = {
        minHeat: 500,
        out: path.join(repoRoot, 'data', 'artist_profiles.txt'),
        source: path.join(repoRoot, 'data', 'danbooru_e621_merged.csv'),
        delay: 300,
        limit: 0,
        concurrency: 1,
        restart: false,
    };
    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];
        const next = () => argv[i += 1];
        if (arg === '--min-heat') options.minHeat = Number.parseInt(next(), 10);
        else if (arg === '--out') options.out = path.resolve(next());
        else if (arg === '--source') options.source = path.resolve(next());
        else if (arg === '--delay') options.delay = Number.parseInt(next(), 10);
        else if (arg === '--limit') options.limit = Number.parseInt(next(), 10);
        else if (arg === '--concurrency') options.concurrency = Number.parseInt(next(), 10);
        else if (arg === '--restart') options.restart = true;
        else {
            console.error(`[buildArtistProfiles] unknown argument: ${arg}`);
            process.exit(1);
        }
    }
    return options;
}

const sleep = ms => new Promise(resolve => { setTimeout(resolve, ms); });

// tag,category,heat,"alias,alias" — the alias field is quoted and may contain commas,
// so only the first three fields are read.
function parseCsvLine(line) {
    const first = line.indexOf(',');
    const second = line.indexOf(',', first + 1);
    if (first <= 0 || second <= first) return null;
    const tag = line.slice(0, first).trim();
    const category = Number.parseInt(line.slice(first + 1, second), 10);
    const third = line.indexOf(',', second + 1);
    const heat = Number.parseInt(third < 0 ? line.slice(second + 1) : line.slice(second + 1, third), 10);
    if (!tag || !Number.isFinite(category) || !Number.isFinite(heat)) return null;
    return { tag, category, heat };
}

async function readArtists(sourcePath, minHeat) {
    const artists = [];
    const reader = readline.createInterface({ input: fs.createReadStream(sourcePath, 'utf8'), crlfDelay: Infinity });
    for await (const line of reader) {
        const parsed = parseCsvLine(line);
        if (!parsed || parsed.category !== ARTIST_CATEGORY || parsed.heat < minHeat) continue;
        artists.push(parsed);
    }
    artists.sort((a, b) => b.heat - a.heat);
    return artists;
}

function readDone(outPath) {
    const done = new Set();
    if (!fs.existsSync(outPath)) return done;
    for (const line of fs.readFileSync(outPath, 'utf8').split('\n')) {
        const profile = parseArtistProfileLine(line);
        if (profile) done.add(profile.artist);
    }
    return done;
}

async function getJson(url, { retries = 4 } = {}) {
    let wait = 2000;
    for (let attempt = 0; ; attempt += 1) {
        let response;
        try {
            response = await fetch(url, { headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' } });
        } catch (error) {
            if (attempt >= retries) throw error;
            await sleep(wait);
            wait *= 2;
            continue;
        }
        if (response.ok) return response.json();
        // 429 = too fast, 5xx = the site is having a moment. Anything else is final.
        if (response.status !== 429 && response.status < 500) {
            throw new Error(`HTTP ${response.status} for ${url}`);
        }
        if (attempt >= retries) throw new Error(`HTTP ${response.status} for ${url} (gave up)`);
        const retryAfter = Number.parseInt(response.headers.get('retry-after') ?? '', 10);
        await sleep(Number.isFinite(retryAfter) ? retryAfter * 1000 : wait);
        wait *= 2;
    }
}

function relatedUrl(artist, category, limit) {
    const params = new URLSearchParams();
    params.set('search[query]', artist);
    params.set('search[category]', String(category));
    params.set('limit', String(limit));
    return `${API}/related_tag.json?${params}`;
}

async function fetchProfile(artist, totalPosts) {
    const general = await getJson(relatedUrl(artist, GENERAL_CATEGORY, GENERAL_LIMIT));
    const posts = Number.parseInt(general?.post_count ?? 0, 10) || 0;
    const draws = [];
    for (const entry of general?.related_tags ?? []) {
        const tag = entry?.tag?.name;
        const frequency = Number(entry?.frequency) || 0;
        if (!tag || frequency < MIN_DRAW_FREQUENCY || isMetadataTag(tag)) continue;
        const lift = profileLift(frequency, entry?.tag?.post_count, totalPosts);
        if (lift < MIN_DRAW_LIFT) continue;
        draws.push({ tag, percent: frequency * 100, lift });
    }
    draws.sort((a, b) => b.lift - a.lift);

    const copyright = await getJson(relatedUrl(artist, COPYRIGHT_CATEGORY, COPYRIGHT_LIMIT));
    const series = [];
    for (const entry of copyright?.related_tags ?? []) {
        const tag = entry?.tag?.name;
        const frequency = Number(entry?.frequency) || 0;
        if (!tag || frequency < MIN_SERIES_FREQUENCY) continue;
        series.push({ tag, percent: frequency * 100 });
    }
    series.sort((a, b) => b.percent - a.percent);

    return { artist, posts, draws: draws.slice(0, MAX_DRAWS), series: series.slice(0, MAX_SERIES) };
}

async function main() {
    const options = parseArgs(process.argv.slice(2));
    if (!Number.isFinite(options.minHeat) || !Number.isFinite(options.delay)) {
        console.error('[buildArtistProfiles] --min-heat and --delay take numbers');
        process.exit(1);
    }
    if (options.restart && fs.existsSync(options.out)) fs.rmSync(options.out);

    let totalPosts = FALLBACK_TOTAL_POSTS;
    try {
        const counts = await getJson(`${API}/counts/posts.json`);
        const value = Number(counts?.counts?.posts);
        if (value > 0) totalPosts = value;
    } catch (error) {
        console.warn(`[buildArtistProfiles] post count unavailable (${error.message}), using ${FALLBACK_TOTAL_POSTS}`);
    }

    const artists = await readArtists(options.source, options.minHeat);
    const done = readDone(options.out);
    const todo = artists.filter(entry => !done.has(entry.tag));
    const planned = options.limit > 0 ? todo.slice(0, options.limit) : todo;
    console.log(`[buildArtistProfiles] ${artists.length} artists with heat >= ${options.minHeat}, ${done.size} already done, fetching ${planned.length} (total posts ${totalPosts})`);

    fs.mkdirSync(path.dirname(options.out), { recursive: true });
    const started = Date.now();
    let written = 0;
    let failed = 0;
    let handled = 0;
    let cursor = 0;
    // A small pool of workers, each taking the next artist off the list. Node runs them
    // on one thread, so the appends below cannot interleave mid-line.
    const worker = async () => {
        for (;;) {
            const index = cursor;
            cursor += 1;
            const entry = planned[index];
            if (!entry) return;
            try {
                const profile = await fetchProfile(entry.tag, totalPosts);
                fs.appendFileSync(options.out, `${formatArtistProfileLine(profile)}\n`, 'utf8');
                written += 1;
            } catch (error) {
                failed += 1;
                console.warn(`[buildArtistProfiles] ${entry.tag} failed: ${error.message}`);
            }
            handled += 1;
            if (handled % 50 === 0 || handled === planned.length) {
                const elapsed = (Date.now() - started) / 1000;
                const rate = handled / Math.max(elapsed, 1);
                const left = Math.round((planned.length - handled) / Math.max(rate, 0.001));
                console.log(`[buildArtistProfiles] ${handled}/${planned.length} · ${written} written · ${failed} failed · ~${Math.round(left / 60)} min left`);
            }
            if (options.delay > 0) await sleep(options.delay);
        }
    };
    const workers = Math.max(1, Math.min(options.concurrency || 1, 8));
    await Promise.all(Array.from({ length: workers }, () => worker()));

    const size = fs.existsSync(options.out) ? fs.statSync(options.out).size : 0;
    console.log(`[buildArtistProfiles] done: ${written} written, ${failed} failed, file ${(size / 1024 / 1024).toFixed(2)} MB → ${options.out}`);
}

main().catch(error => {
    console.error('[buildArtistProfiles] failed:', error);
    process.exit(1);
});
