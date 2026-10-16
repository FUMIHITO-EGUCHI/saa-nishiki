// The gallery (customGallery.js) driven on the in-memory DOM: what an arriving image
// keeps of the run that made it, what the selection then shows, what a removal leaves
// behind, and the loading / error overlay the queue puts over it.
import assert from 'node:assert/strict';
import test from 'node:test';

import { setupGallery, VIEWER_SELECT_EVENT } from '../scripts/renderer/customGallery.js';
import { withFakeDom } from './helpers/fakeDom.mjs';

const flush = () => new Promise(resolve => setTimeout(resolve, 0));
const png = name => `data:image/png;base64,${name}`;

function fakeStorage() {
    const store = new Map();
    return {
        getItem: key => (store.has(key) ? store.get(key) : null),
        setItem: (key, value) => store.set(key, String(value)),
        removeItem: key => store.delete(key),
        clear: () => store.clear(),
    };
}

// Lazy loading: the gallery hands every image container to an observer and only sets the
// real src once one reports itself visible. `show()` is that report.
function observerFactory(observers) {
    return class FakeIntersectionObserver {
        constructor(callback) {
            this.callback = callback;
            this.targets = [];
            observers.push(this);
        }
        observe(target) { this.targets.push(target); }
        unobserve(target) { this.targets = this.targets.filter(entry => entry !== target); }
        disconnect() { this.targets = []; }
        show() { this.callback(this.targets.map(target => ({ target, isIntersecting: true })), this); }
    };
}

// `new Image()` in grid mode: the layout waits for the newest image to report its size.
class FakeImage {
    #src = '';
    constructor() { this.width = 512; this.height = 512; this.onload = null; this.onerror = null; }
    get src() { return this.#src; }
    set src(value) { this.#src = String(value); queueMicrotask(() => this.onload?.()); }
}

async function withGallery(body) {
    const state = { info: [], copied: [], observers: [], storage: fakeStorage() };
    return withFakeDom(async document => {
        const container = document.createElement('div');
        container.className = 'custom-gallery';
        document.body.appendChild(container);

        globalThis.mainGallery = {};
        globalThis.generate = { infoBySeed: new Map(), loadingMessage: '' };
        globalThis.infoBox = { image: { setValue: value => state.info.push(value) } };
        globalThis.globalSettings = { language: 'en-US', css_style: 'dark' };
        globalThis.cachedFiles = {
            language: { 'en-US': { saac_macos_clipboard: 'copy {0}' } },
            loadingWait: png('wait'), loadingFailed: png('failed'),
        };
        globalThis.inBrowser = false;
        globalThis.api = { readBase64Image: async () => ({ metadata: {} }) };

        setupGallery('custom-gallery');
        state.document = document;
        state.container = container;
        state.gallery = globalThis.mainGallery;
        try {
            return await body(state);
        } finally {
            // the loading overlay ticks every 100ms; a failed assertion would leave that
            // timer running and the test process would never exit
            document.getElementById('cg-loading-overlay')?._cleanup?.();
        }
    }, {
        localStorage: state.storage,
        IntersectionObserver: observerFactory(state.observers),
        Image: FakeImage,
        navigator: { clipboard: { writeText: async text => { state.copied.push(text); } } },
    });
}

// Several gallery buttons reset themselves seconds later, and the mode switch leaves a
// 10s overlay cleanup behind. Those timers would outlive the test, so the long ones are
// dropped while `body` runs.
async function withoutLongTimers(body) {
    const realSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = (callback, ms, ...rest) => (ms >= 1000 ? 0 : realSetTimeout(callback, ms, ...rest));
    try {
        return await body();
    } finally {
        globalThis.setTimeout = realSetTimeout;
    }
}

const previews = container => container.querySelectorAll('.cg-preview-image');

// A click on a preview thumbnail: the handler sits on the preview container and reads
// e.target, so the event has to name the thumbnail that was hit.
function clickPreview(container, preview) {
    container.querySelector('.cg-preview-container').dispatchEvent({
        type: 'click', target: preview, bubbles: false,
        preventDefault() {}, stopPropagation() {},
    });
}

test('an arriving image takes the info its seed carried, and keeps it when the next run reuses the seed', async () => {
    await withGallery(async ({ container, gallery, info }) => {
        // batch_size 2 on ComfyUI: both images of a run carry the same seed
        globalThis.generate.infoBySeed.set('77', 'run one');
        gallery.appendImageData(png('a'), '77', 'tag a', 'True', true);
        globalThis.generate.infoBySeed.set('77', 'run two');   // the next run reuses the seed
        gallery.appendImageData(png('b'), '77', 'tag b', 'True', true);

        assert.equal(info.at(-1), 'run two', 'the newest image shows its own run');
        const thumbs = previews(container);
        assert.equal(thumbs.length, 2);
        clickPreview(container, thumbs[1]);   // newest first: [1] is the first image
        assert.equal(info.at(-1), 'run one', 'the earlier image kept the info it arrived with');
    });
});

test('the gallery keeps only the newest images, and never drops the one on show', async () => {
    await withGallery(async ({ container, gallery }) => {
        globalThis.globalSettings.gallery_max_images = 3;
        for (const name of ['a', 'b', 'c', 'd', 'e']) gallery.appendImageData(png(name), name, '', 'True', true);
        assert.equal(gallery.imageCount(), 3, 'two were dropped');
        const shown = [...previews(container)].map(thumb => thumb.dataset.src);
        assert.deepEqual(shown, [png('e'), png('d'), png('c')], 'the oldest went first, and the thumbnails were rebuilt');
        assert.equal(container.querySelector('.cg-main-image').src, png('e'));

        // the oldest is selected; the next arrival drops the one after it instead
        clickPreview(container, previews(container)[2]);
        assert.equal(container.querySelector('.cg-main-image').src, png('c'));
        gallery.appendImageData(png('f'), 'f', '', 'True', false);
        assert.deepEqual([...previews(container)].map(thumb => thumb.dataset.src), [png('f'), png('e'), png('c')]);
        assert.equal(container.querySelector('.cg-main-image').src, png('c'), 'still on show');

        // a setting that is not a number falls back to the default, so nothing is lost by mistake
        globalThis.globalSettings.gallery_max_images = 'many';
        for (let i = 0; i < 10; i++) gallery.appendImageData(png(`x${i}`), `x${i}`, '', 'True', true);
        assert.equal(gallery.imageCount(), 13);
    });
});

test('an explicit info wins over the seed lookup, and null opts out of it', async () => {
    await withGallery(async ({ container, gallery, info }) => {
        globalThis.generate.infoBySeed.set('42', 'txt2img run');
        globalThis.api.readBase64Image = async () => ({ metadata: { parameters: 'embedded parameters' } });

        gallery.appendImageData(png('own'), '42', '', 'True', true, 'this image only');
        assert.equal(info.at(-1), 'this image only');

        // MiraITU output shares the seed box with a txt2img run but is a different image
        gallery.appendImageData(png('itu'), '42', '', 'True', true, null);
        assert.equal(info.at(-1), 'Seed: [42]\n', 'no run info: the seed line goes up first');
        await flush();
        assert.equal(info.at(-1), 'Seed: [42]\nembedded parameters', 'then the file\'s own parameters');

        clickPreview(container, previews(container)[1]);
        assert.equal(info.at(-1), 'this image only', 'the opt-out did not touch the other image');
    });
});

test('keep_gallery "False" clears what was there before the new image lands', async () => {
    await withGallery(async ({ container, gallery }) => {
        gallery.appendImageData(png('old'), '1', 'old', 'True', true);
        gallery.appendImageData(png('new'), '2', 'new', 'False', true);

        const thumbs = previews(container);
        assert.equal(thumbs.length, 1);
        assert.equal(thumbs[0].dataset.src, png('new'));
    });
});

test('a lazy thumbnail only gets its real src once it is on screen', async () => {
    await withGallery(async ({ container, gallery, observers }) => {
        gallery.appendImageData(png('a'), '1', '', 'True', true);
        const [thumb] = previews(container);
        assert.equal(thumb.dataset.src, png('a'));
        assert.match(thumb.src, /^data:image\/gif;base64,/, 'a placeholder until it is seen');
        for (const observer of observers) observer.show();
        assert.equal(thumb.src, png('a'));
        assert.ok(thumb.classList.contains('visible'));
    });
});

test('removing the selected image keeps seeds, tags and info lined up and steps back', async () => {
    await withGallery(async ({ container, gallery, info }) => {
        for (const [index, name] of ['a', 'b', 'c'].entries()) {
            globalThis.generate.infoBySeed.set(`${index}`, `info ${name}`);
            gallery.appendImageData(png(name), `${index}`, `tag ${name}`, 'True', true, '', { recipe: null, timing: null, path: '', note: name });
        }
        assert.equal(info.at(-1), 'info c');

        // remove the oldest, not the newest: everything behind it has to move up with it
        clickPreview(container, previews(container)[2]);
        gallery.removeCurrentImage();
        assert.deepEqual(previews(container).map(image => image.dataset.src), [png('c'), png('b')]);
        assert.equal(info.at(-1), 'info b', 'the image now selected shows its own info');
        const shown = gallery.currentEntry();
        assert.deepEqual([shown.seed, shown.tags, shown.record.note], ['1', 'tag b', 'b'], 'its seed, tags and record moved up with it');

        gallery.removeCurrentImage();   // b, the selection steps back to what is left
        assert.equal(info.at(-1), 'info c');
        gallery.removeCurrentImage();
        assert.equal(previews(container).length, 0, 'the last removal empties the gallery');
        assert.equal(container.children.length, 0);
    });
});

test('clearGallery drops the images and the info behind them', async () => {
    await withGallery(async ({ container, gallery, info }) => {
        globalThis.generate.infoBySeed.set('5', 'info');
        gallery.appendImageData(png('a'), '5', 'tag', 'True', true);
        gallery.clearGallery();
        assert.equal(container.children.length, 0);

        globalThis.api.readBase64Image = async () => ({ metadata: { parameters: 'from the file' } });
        gallery.appendImageData(png('b'), '6', 'tag', 'True', true);
        await flush();
        assert.equal(info.at(-1), 'Seed: [6]\nfrom the file', 'the cleared info is not reused');
    });
});

test('the image carries no Seed, Tags or Info buttons: the Info tab and the context menu have them', async () => {
    await withGallery(async ({ document, container, gallery }) => {
        gallery.appendImageData(png('a'), '4242', 'blonde hair, smile', 'True', true);
        for (const id of ['cg-seed-button', 'cg-tag-button', 'cg-info-button', 'cg-switch-mode-button']) {
            assert.equal(document.getElementById(id), null, `${id} is gone`);
        }
        const buttons = container.querySelectorAll('.cg-main-image-container button').map(button => button.getAttribute('aria-label'));
        assert.deepEqual(buttons, ['Newer image', 'Older image', 'Favourite']);
    });
});

test('the arrows step through the images, newer to the left, and wrap', async () => {
    await withGallery(async ({ container, gallery }) => {
        for (const name of ['a', 'b', 'c']) gallery.appendImageData(png(name), name, '', 'True', true);
        const [newer, older] = container.querySelectorAll('.cg-nav-button');
        older.click();
        assert.equal(gallery.currentEntry().seed, 'b');
        older.click();
        assert.equal(gallery.currentEntry().seed, 'a');
        newer.click();
        assert.equal(gallery.currentEntry().seed, 'b');
        newer.click();
        newer.click();
        assert.equal(gallery.currentEntry().seed, 'a', 'past the newest it wraps to the oldest');
        assert.equal(container.querySelector('.cg-main-image').src, png('a'));
        assert.ok(previews(container)[2].parentElement.classList.contains('is-current'), 'the strip marks the image on show');
    });
});

test('a star on an image that was never saved stays with it for the session', async () => {
    await withGallery(async ({ container, gallery }) => {
        gallery.appendImageData(png('a'), '1', '', 'True', true);
        gallery.appendImageData(png('b'), '2', '', 'True', true);
        const star = container.querySelector('.cg-star-button');
        star.click();
        await flush();
        assert.equal(star.getAttribute('aria-pressed'), 'true');
        assert.ok(previews(container)[0].parentElement.classList.contains('is-starred'));
        clickPreview(container, previews(container)[1]);
        assert.equal(star.getAttribute('aria-pressed'), 'false', 'the other image has none');
        assert.equal(gallery.isStarred(1), true);
    });
});

test('while a run is on, the strip starts with a tile for the image on its way', async () => {
    await withGallery(async ({ container, gallery }) => {
        gallery.appendImageData(png('a'), '1', '', 'True', true);
        globalThis.generate.loadingMessage = 'Rice Shower\n[1/4] <3/8>';
        gallery.showLoading('Now generating...', 'Elapsed time:', 'seconds');
        const tile = container.querySelector('.cg-preview-container').firstElementChild;
        assert.ok(tile.classList.contains('cg-progress-tile'));
        assert.equal(tile.querySelector('.cg-progress-percent').textContent, '38%');
        gallery.appendImageData(png('b'), '2', '', 'True', true);
        assert.ok(container.querySelector('.cg-preview-container').firstElementChild.classList.contains('cg-progress-tile'), 'it stays first');
        gallery.hideLoading('success', '');
        assert.equal(container.querySelector('.cg-progress-tile'), null);
    });
});

test('showLoading raises the loading overlay and drops an error left by an earlier run', async () => {
    await withGallery(async ({ document, gallery }) => {
        gallery.hideLoading('Error: backend refused', 'the stack');
        assert.ok(document.getElementById('cg-error-overlay'), 'the failure is on screen');

        gallery.showLoading('Now generating...', 'Elapsed time:', 'seconds');
        assert.equal(document.getElementById('cg-error-overlay'), null, 'a new run supersedes it');
        assert.ok(document.getElementById('cg-loading-overlay'));
        assert.equal(gallery.isLoading, true);

        gallery.hideLoading('success', '');
        assert.equal(document.getElementById('cg-loading-overlay'), null);
        assert.equal(document.getElementById('cg-error-overlay'), null);
        assert.equal(gallery.isLoading, false);
    });
});

test('hideLoading with anything but "success" shows the error, and a click copies it', async () => {
    await withGallery(async ({ document, gallery, copied }) => {
        gallery.showLoading('Now generating...', 'Elapsed time:', 'seconds');
        gallery.hideLoading('Error: cancel', 'Error: cancel\n  at queue');

        assert.equal(document.getElementById('cg-loading-overlay'), null, 'the run is over either way');
        const error = document.getElementById('cg-error-overlay');
        assert.ok(error);
        assert.equal(gallery.isLoading, false);

        await error.onclick({ target: { tagName: 'PRE' }, stopPropagation() {} });
        assert.deepEqual(copied, ['Error: cancel\n  at queue'], 'the copy text is the one the queue passed');
        assert.equal(document.getElementById('cg-error-overlay'), null, 'copying closes it');

        gallery.hideLoading('Error: again', 'again');
        assert.ok(document.getElementById('cg-error-overlay'));
        gallery.hideLoading('success', '');
        assert.equal(document.getElementById('cg-error-overlay'), null, 'a run that ends well takes it down');
    });
});

test('grid mode lays the images out newest first and removes the one that was right-clicked', async () => {
    await withGallery(async ({ container, gallery }) => {
        for (const name of ['a', 'b', 'c']) gallery.appendImageData(png(name), '1', '', 'True', true);

        // the viewer header's grid button
        gallery.setGridMode(true);
        await flush();
        assert.equal(gallery.isGridMode(), true);

        const items = container.querySelectorAll('.cg-gallery-item');
        assert.deepEqual(items.map(item => item.querySelector('img').dataset.src), [png('c'), png('b'), png('a')]);

        gallery.removeCurrentImage(png('b'));   // myRightClickMenu passes the image's src
        await flush();
        assert.deepEqual(
            container.querySelectorAll('.cg-gallery-item').map(item => item.querySelector('img').dataset.src),
            [png('c'), png('a')]);
    });
});

test('an image keeps its record, and every selection announces the image on show', async () => {
    await withGallery(async ({ container, gallery, document }) => {
        const seen = [];
        document.addEventListener(VIEWER_SELECT_EVENT, event => seen.push(event.detail));
        const record = { recipe: { v: 1 }, timing: { total: 10200, segments: [] }, path: 'C:\out\a.png', interface: 'ComfyUI' };
        gallery.appendImageData(png('a'), '7', 'tag a', 'True', true, '', record);
        gallery.appendImageData(png('b'), '8', 'tag b', 'True', true);
        assert.equal(gallery.currentEntry().record, null, 'an image from elsewhere has no record');
        assert.equal(seen.at(-1).seed, '8');

        clickPreview(container, previews(container)[1]);
        assert.equal(gallery.currentEntry().record, record);
        assert.equal(seen.at(-1).record, record);
        assert.equal(seen.at(-1).image, png('a'));

        gallery.clearGallery();
        assert.equal(gallery.currentEntry(), null);
    });
});
