// Image Info on a gallery image: the overlay exposes openImage(dataUrl), the
// gallery Info button and the image context menus call it.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8').replace(/\r\n/g, '\n');

test('the overlay opens a data: URL image through the same path as a drop or paste', () => {
    const source = read('scripts/renderer/imageInfo.js');
    assert.match(source, /async function openImage\(dataUrl, fileName = 'gallery\.png'\)/);
    assert.match(source, /uploadOverlay\.openImage = openImage;/);
    assert.match(source, /Uint8Array\.from\(atob\(match\[2\]\)/, 'decoded without fetch(): CSP blocks data: fetches in the renderer');
    assert.equal((source.match(/await loadImageFile\(file/g) ?? []).length, 3, 'paste, drop and openImage share loadImageFile');
    assert.equal((source.match(/const fallbackMetadata = \{/g) ?? []).length, 1, 'no duplicated metadata handling is left');
});

test('the gallery Info button and the image context menus open Image Info', () => {
    const gallery = read('scripts/renderer/customGallery.js');
    assert.match(gallery, /await globalThis\.imageInfo\?\.openImage\?\.\(dataUrl, seed \? `gallery_\$\{seed\}\.png` : 'gallery\.png'\)/);
    const menu = read('scripts/renderer/components/myRightClickMenu.js');
    assert.match(menu, /async function menu_openImageInfo\(element\)/);
    for (const [index, selector] of [['open_image_info', '.cg-main-image-container'], ['open_image_info_grid', '.cg-gallery-item'], ['open_image_info_full_screen', '.cg-fullscreen-overlay']]) {
        assert.match(menu, new RegExp(`rc\\.append\\('${index}', LANG\\.right_menu_image_info, \\{\\n\\s*selector: '${selector.replace('.', '\\.')}'`), index);
        assert.match(menu, new RegExp(`${index}: 'right_menu_image_info',`), `${index} title key`);
    }
    const language = JSON.parse(read('data/language.json'));
    for (const locale of ['en-US', 'zh-CN']) assert.equal(typeof language[locale].right_menu_image_info, 'string', locale);
});
