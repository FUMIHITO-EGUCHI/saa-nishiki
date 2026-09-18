// Image Info on a gallery image: the overlay opens a data: URL image the same way a drop
// or a paste does, the gallery's Info button hands it the shown image, and the image
// context menus (split, grid, full screen) open it too.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { setupGallery } from '../scripts/renderer/customGallery.js';
import { setupImageUploadOverlay } from '../scripts/renderer/imageInfo.js';
import { withFakeDom } from './helpers/fakeDom.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const language = JSON.parse(fs.readFileSync(path.join(root, 'data/language.json'), 'utf8'));

// the textbox measures itself on a timer that outlives the fake document
globalThis.getComputedStyle = () => ({ lineHeight: '20px' });

const flush = () => new Promise(resolve => setTimeout(resolve, 0));
const PIXELS = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).toString('base64');

// The preview is drawn from a FileReader result; the fake one answers with the bytes it
// was given, so the preview src can be checked against what was decoded.
class FakeFileReader {
    readAsDataURL(file) {
        file.arrayBuffer().then(buffer => {
            const base64 = Buffer.from(new Uint8Array(buffer)).toString('base64');
            this.onload?.({ target: { result: `data:${file.type};base64,${base64}` } });
        });
    }
}

const extras = {
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    getComputedStyle: () => ({ lineHeight: '20px' }),
    addEventListener() {}, removeEventListener() {},
    FileReader: FakeFileReader,
    HTMLTextAreaElement: class {},
    IntersectionObserver: class { observe() {} unobserve() {} disconnect() {} },
    Image: class { set src(value) { this._src = value; } },
    navigator: { clipboard: { writeText: async () => {} } },
};

function baseGlobals() {
    globalThis.globalSettings = { language: 'en-US', css_style: 'dark', api_interface: 'ComfyUI', scroll_to_last: false };
    globalThis.cachedFiles = {
        language, controlnetList: [], aDetailerList: [],
        imageTaggerModels: ['wd-vit-tagger-v3'], ONNXList: ['wd-vit-tagger-v3'],
    };
    globalThis.generate = { api_interface: { getValue: () => 'ComfyUI' } };
    globalThis.dropdownList = { model_type: { getValue: () => 'Checkpoint' } };
    globalThis.inBrowser = false;
    globalThis.overlay = { custom: { createCustomOverlay() {}, closeCustomOverlaysByGroup() {} } };
}

// The menu keeps one instance per module, bound to the document it was built on, so
// every test gets its own copy of the module.
let menuCase = 0;

async function withMenu(body) {
    menuCase += 1;
    return withFakeDom(async document => {
        baseGlobals();
        const opened = [];
        globalThis.api = {};
        globalThis.rightClick = undefined;
        globalThis.imageInfo = { openImage: async (...args) => { opened.push(args); return true; } };
        const { setupRightClickMenu } = await import(`../scripts/renderer/components/myRightClickMenu.js?case=${menuCase}`);
        setupRightClickMenu();

        const menu = document.querySelector('.right-click-menu');
        const openOn = (className, src) => {
            const host = document.createElement('div');
            host.className = className;
            const image = document.createElement('img');
            image.src = src;
            host.appendChild(image);
            document.body.appendChild(host);
            document.dispatchEvent({ type: 'contextmenu', target: host, clientX: 10, clientY: 10, preventDefault() {}, stopPropagation() {} });
            const item = menu.querySelectorAll('div').find(entry => entry.dataset.index?.startsWith('open_image_info'));
            return { host, item };
        };
        return body({ document, opened, openOn });
    }, extras);
}

async function withImageInfo(body) {
    return withFakeDom(async document => {
        baseGlobals();
        const read = [];
        globalThis.api = {
            readImage: async (bytes, name, type) => {
                read.push({ bytes, name, type });
                return { metadata: { parameters: '1girl\nSteps: 28' } };
            },
        };
        const fullBody = document.createElement('div');
        fullBody.id = 'full-body';
        document.body.appendChild(fullBody);
        const overlay = setupImageUploadOverlay();
        globalThis.imageInfo = overlay;
        return body({ document, overlay, read });
    }, extras);
}

test('the overlay opens a data: URL image as if it had been dropped', async () => {
    await withImageInfo(async ({ document, overlay, read }) => {
        assert.equal(overlay.style.display, 'none');

        assert.equal(await overlay.openImage(`data:image/png;base64,${PIXELS}`, 'gallery_4242.png'), true);
        await flush();

        assert.equal(overlay.style.display, 'flex', 'the overlay is up');
        assert.equal(read.length, 1, 'the bytes went to the main process, not through fetch()');
        assert.deepEqual(read[0].bytes, [137, 80, 78, 71, 13, 10, 26, 10], 'decoded from base64 by hand');
        assert.equal(read[0].name, 'gallery_4242.png', 'under the name the caller gave it');
        assert.equal(read[0].type, 'image/png', 'with the type the data: URL declared');

        const preview = document.getElementById('preview-image');
        assert.equal(preview.src, `data:image/png;base64,${PIXELS}`, 'and the same bytes are what is shown');
        assert.equal(document.querySelector('.drag-hint-container').style.display, 'none', 'the drop hint is out of the way');
    });
});

test('a jpeg keeps its own type, and anything that is not an image data: URL is refused', async () => {
    await withImageInfo(async ({ overlay, read }) => {
        assert.equal(await overlay.openImage(`data:image/jpeg;base64,${PIXELS}`, 'gallery.jpg'), true);
        await flush();
        assert.equal(read.at(-1).type, 'image/jpeg');

        for (const value of ['', 'gallery.png', 'https://example.invalid/a.png', 'data:text/plain;base64,QQ==', null, undefined]) {
            assert.equal(await overlay.openImage(value), false, String(value));
        }
        assert.equal(read.length, 1, 'nothing was read for any of them');
    });
});

test('the gallery Info button opens Image Info on the selected image, named after its seed', async () => {
    await withFakeDom(async document => {
        baseGlobals();
        const opened = [];
        const shown = [];
        globalThis.api = { readBase64Image: async () => ({ metadata: { parameters: 'embedded' } }) };
        globalThis.infoBox = { image: { setValue() {} } };
        globalThis.imageInfo = { openImage: async (...args) => { opened.push(args); return true; } };
        globalThis.overlay = {
            custom: { createCustomOverlay: (...args) => shown.push(args), closeCustomOverlaysByGroup() {} },
        };

        const container = document.createElement('div');
        container.className = 'custom-gallery';
        document.body.appendChild(container);
        globalThis.mainGallery = {};
        setupGallery('custom-gallery');
        globalThis.mainGallery.appendImageData(`data:image/png;base64,${PIXELS}`, '4242', '', 'True', true);

        document.getElementById('cg-info-button').click();
        await flush();
        assert.deepEqual(opened, [[`data:image/png;base64,${PIXELS}`, 'gallery_4242.png']]);
        assert.deepEqual(shown, [], 'Image Info took it: no metadata text overlay');

        // Image Info could not take it: the metadata text is shown instead
        globalThis.imageInfo.openImage = async () => { throw new Error('no window'); };
        document.getElementById('cg-info-button').click();
        await flush();
        assert.equal(shown.length, 1);
        assert.equal(shown[0][1], '\n\nembedded');
    }, extras);
});

test('the image context menus open Image Info in split, grid and full screen', async () => {
    await withMenu(async ({ opened, openOn }) => {
        for (const [className, expected] of [
            ['cg-main-image-container', 'open_image_info'],
            ['cg-gallery-item', 'open_image_info_grid'],
            ['cg-fullscreen-overlay', 'open_image_info_full_screen'],
        ]) {
            const { host, item } = openOn(className, `data:image/png;base64,${className}`);
            assert.ok(item, `${className} offers Image Info`);
            assert.equal(item.dataset.index, expected);
            assert.equal(item.textContent, language['en-US'].right_menu_image_info);
            item.dispatchEvent({ type: 'click', target: item, bubbles: false, preventDefault() {}, stopPropagation() {} });
            await flush();
            assert.deepEqual(opened.at(-1), [`data:image/png;base64,${className}`, 'gallery.png']);
            host.remove();
        }

        assert.equal(opened.length, 3);
        for (const locale of ['en-US', 'zh-CN']) {
            assert.equal(typeof language[locale].right_menu_image_info, 'string', locale);
        }
    });
});

test('the context menu leaves an image it cannot read alone', async () => {
    await withMenu(async ({ opened, openOn }) => {
        // a lazy placeholder, not an image the app holds
        const { item } = openOn('cg-gallery-item', 'scripts/svg/add.svg');
        item.dispatchEvent({ type: 'click', target: item, bubbles: false, preventDefault() {}, stopPropagation() {} });
        await flush();
        assert.deepEqual(opened, []);
    });
});
