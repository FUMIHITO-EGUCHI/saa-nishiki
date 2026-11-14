import { customCommonOverlay, addDragFunctionality } from './customOverlay.js';
import { sendWebSocketMessage } from '../webserver/front/wsRequest.js';
import { parseLoadingMessage } from './components/runProgress.js';
import { FAVORITES_CHANGED_EVENT, isFavorite, loadFavorites, setFavorite } from './libraryClient.js';

// fired with the image on show (mainGallery.currentEntry()) whenever the selection changes
export const VIEWER_SELECT_EVENT = 'saa:viewer-select';

function setupScrollableContainer(container) {
    let isDragging = false, startX, scrollLeft;
    container.addEventListener('mousedown', (e) => {
        e.preventDefault();
        isDragging = true;
        container.style.cursor = 'grabbing';
        startX = e.pageX - container.offsetLeft;
        scrollLeft = container.scrollLeft;
        document.body.style.userSelect = 'none';
    });
    container.addEventListener('mouseleave', () => {
        isDragging = false;
        container.style.cursor = 'grab';
        document.body.style.userSelect = '';
    });
    container.addEventListener('mouseup', () => {
        isDragging = false;
        container.style.cursor = 'grab';
        document.body.style.userSelect = '';
    });
    container.addEventListener('mousemove', (e) => {
        if (!isDragging) return;
        e.preventDefault();
        const x = e.pageX - container.offsetLeft;
        const walk = (x - startX) * 1;
        container.scrollLeft = scrollLeft - walk;
    });
}

function process_oberserver(entries, observer) {
    for (const entry of entries) {
        if (entry.isIntersecting) {
            const imgContainer = entry.target;
            const img = imgContainer.querySelector('img');
            img.src = img.dataset.src; 
            imgContainer.classList.add('visible');
            observer.unobserve(imgContainer);
        }
    }
}

export function setupGallery(containerId) {
    if (globalThis.mainGallery.isGallerySetup) return;
    globalThis.mainGallery.isGallerySetup = true;
    globalThis.mainGallery.isLoading = false;

    let isGridMode = false;
    let currentIndex = 0;
    let privacyBalls = [];
    let images = [];
    let seeds = [];
    let tags = [];
    let infos = [];   // per-image generation info (BBCode) shown in the Info panel
    let records = []; // per-image { recipe, timing, path, interface } (imageRecipe.js), or null
let renderedImageCount = 0;

    const container = document.querySelector(`.${containerId}`);
    if (!container) {
        console.error('Gallery container not found', containerId);
        return;
    }

    globalThis.mainGallery.clearGallery = function () {
        images = [];
        seeds = [];
        tags = [];
        infos = [];
        records = [];
        renderedImageCount = 0;
        currentIndex = 0;
        container.innerHTML = '';
    };

    globalThis.mainGallery.removeCurrentImage = function (element = null) {
        if(isGridMode) {
            const index = images.indexOf(element);
            if (index !== -1) {
                images.splice(index, 1);
                seeds.splice(index, 1);
                tags.splice(index, 1);
                infos.splice(index, 1);
                records.splice(index, 1);

                renderedImageCount = images.length;
                currentIndex = 0;
                gallery_renderGridMode(false);
            }
        } else {
            images.splice(currentIndex, 1);
            seeds.splice(currentIndex, 1);
            tags.splice(currentIndex, 1);
            infos.splice(currentIndex, 1);
            records.splice(currentIndex, 1);
renderedImageCount = images.length;
            currentIndex = currentIndex - 1;
            if(currentIndex < 0)
                currentIndex = 0;
            gallery_renderSplitMode(false);
        }            
    };

    // `record` is what the run knows of the image beyond its pixels: its recipe, timing
    // and saved file (imageRecipe.js imageRecord); null for an image from elsewhere.
    globalThis.mainGallery.appendImageData = function (base64, seed, tagsString, keep_gallery, switchToLatest = false, info = '', record = null) {
        if ('False' === keep_gallery) {
            globalThis.mainGallery.clearGallery();
        }

        images.push(base64);
        seeds.push(seed);
        tags.push(tagsString || '');
        // The run's own info (BBCode, generate.js) is keyed by seed while the image is
        // in flight; every arrival path (IPC, ComfyUI websocket, regional) lands here, so
        // the lookup lives here rather than in each caller. Without it the Info panel
        // falls back to the file's raw parameter text once the selection syncs.
        // `null` opts out of the lookup (MiraITU output shares the seed box with a
        // txt2img run but is a different image): the embedded parameters are shown.
        let ownInfo = '';
        if (typeof info === 'string' && info !== '') ownInfo = info;
        else if (info !== null) ownInfo = globalThis.generate?.infoBySeed?.get?.(String(seed)) ?? '';
        infos.push(ownInfo);
        records.push(record && typeof record === 'object' ? record : null);

        if (seeds.length !== tags.length || images.length !== seeds.length) {
            console.warn('[appendImageData] Mismatch: images:', images.length, 'seeds:', seeds.length, 'tags:', tags.length);
        }

        let incremental = true;
        if (switchToLatest && !isGridMode) {
            currentIndex = images.length - 1;
            incremental = false;
        }
        // Every image is a data URL held in memory; a long session with Keep Gallery on
        // used to grow without bound. The oldest go first, never the one on show, and the
        // thumbnails are rebuilt since their indices shifted.
        if (trimToLimit()) incremental = false;

        if (isGridMode) {
            gallery_renderGridMode(true);
        } else {
            gallery_renderSplitMode(incremental);
        }
    };

    function galleryLimit() {
        const raw = Number.parseInt(globalThis.globalSettings?.gallery_max_images, 10);
        return Number.isFinite(raw) && raw >= 1 ? raw : 200;
    }

    // Drops the oldest images beyond the limit, keeping the current one; true when
    // anything was dropped (the rendered thumbnails then no longer match the indices).
    function trimToLimit() {
        const limit = galleryLimit();
        let dropped = 0;
        while (images.length > limit) {
            const victim = currentIndex === 0 ? 1 : 0;
            if (victim >= images.length) break;
            images.splice(victim, 1);
            seeds.splice(victim, 1);
            tags.splice(victim, 1);
            infos.splice(victim, 1);
            records.splice(victim, 1);
if (victim < currentIndex) currentIndex -= 1;
            dropped += 1;
        }
        if (dropped > 0) renderedImageCount = 0;
        return dropped > 0;
    }
    globalThis.mainGallery.imageCount = () => images.length;

    // A star: a saved image keeps it in the Library store (by its path); one that was
    // never saved (WebUI, a browser client) keeps it for the session in its record.
    function isStarred(index) {
        const record = records[index];
        return record?.path ? isFavorite(record.path) : record?.starred === true;
    }

    async function toggleStar(index) {
        const record = records[index];
        if (record?.path) {
            await setFavorite(record.path, !isFavorite(record.path));
        } else if (index >= 0 && index < images.length) {
            records[index] = { ...(record ?? {}), starred: !(record?.starred === true) };
        }
        paintStars();
    }

    function paintStars() {
        const star = container.querySelector('.cg-star-button');
        if (star) {
            const on = isStarred(currentIndex);
            star.classList.toggle('is-on', on);
            star.setAttribute('aria-pressed', String(on));
        }
        for (const tile of container.querySelectorAll('.cg-preview-tile')) {
            const index = images.length - 1 - Number.parseInt(tile.querySelector('.cg-preview-image')?.dataset.domIndex ?? '-1', 10);
            tile.classList.toggle('is-starred', isStarred(index));
        }
    }
    document.addEventListener(FAVORITES_CHANGED_EVENT, paintStars);
    loadFavorites();
    globalThis.mainGallery.isStarred = isStarred;
    // the saved files of this session's images, newest first (the Library's "This session")
    globalThis.mainGallery.sessionPaths = () => records.map(record => record?.path).filter(Boolean).reverse();
    globalThis.mainGallery.toggleStar = () => toggleStar(currentIndex);

    // Grid or the single image with its strip; the viewer header's grid button flips it.
    const gridToggle = document.getElementById('viewer-grid-toggle');
    function paintGridToggle() {
        gridToggle?.setAttribute('aria-pressed', String(isGridMode));
        gridToggle?.classList.toggle('is-active', isGridMode);
    }
    globalThis.mainGallery.setGridMode = function (on) {
        isGridMode = on === true;
        currentIndex = images.length - 1;
        paintGridToggle();
        if (isGridMode) gallery_renderGridMode();
        else gallery_renderSplitMode();
    };
    globalThis.mainGallery.isGridMode = () => isGridMode;
    gridToggle?.addEventListener('click', () => globalThis.mainGallery.setGridMode(!isGridMode));
    paintGridToggle();

    // Newer is the higher index (the newest image is the last one)
    function step(delta) {
        if (images.length < 2) return;
        currentIndex = (currentIndex + delta + images.length) % images.length;
        const mainImage = container.querySelector('.cg-main-image');
        if (mainImage) mainImage.src = images[currentIndex];
        updatePreviewBorders();
    }
    globalThis.mainGallery.showNewer = () => step(1);
    globalThis.mainGallery.showOlder = () => step(-1);

    // While a run is on, the strip starts with a tile for the image on its way.
    let progressTimer = null;
    function paintProgressTile() {
        const strip = container.querySelector('.cg-preview-container');
        let tile = container.querySelector('.cg-progress-tile');
        if (!globalThis.mainGallery.isLoading || !strip) {
            tile?.remove();
            return;
        }
        if (!tile) {
            tile = document.createElement('div');
            tile.className = 'cg-progress-tile';
            tile.setAttribute('role', 'progressbar');
            tile.setAttribute('aria-valuemin', '0');
            tile.setAttribute('aria-valuemax', '100');
            tile.innerHTML = '<span class="cg-progress-percent"></span><span class="cg-progress-track"><i></i></span>';
        }
        if (strip.firstElementChild !== tile) strip.prepend(tile);
        const { step: done, total } = parseLoadingMessage(globalThis.generate?.loadingMessage);
        const percent = Number.isFinite(done) && Number.isFinite(total) && total > 0 ? Math.round((done / total) * 100) : null;
        tile.querySelector('.cg-progress-percent').textContent = percent === null ? '…' : `${percent}%`;
        tile.querySelector('.cg-progress-track i').style.width = `${percent ?? 0}%`;
        if (percent === null) tile.removeAttribute('aria-valuenow');
        else tile.setAttribute('aria-valuenow', String(percent));
    }
    function startProgressTile() {
        paintProgressTile();
        if (!progressTimer) progressTimer = setInterval(paintProgressTile, 250);
    }
    function stopProgressTile() {
        if (progressTimer) clearInterval(progressTimer);
        progressTimer = null;
        paintProgressTile();
    }
    // the image on show, with everything the gallery keeps of it; null when empty
    globalThis.mainGallery.currentEntry = () => (images.length === 0 ? null : {
        index: currentIndex,
        image: images[currentIndex],
        seed: seeds[currentIndex],
        tags: tags[currentIndex],
        info: infos[currentIndex],
        record: records[currentIndex] ?? null,
    });

    globalThis.mainGallery.showLoading = function (loadingMEssage, elapsedTimePrefix, elapsedTimeSuffix) {
        // A new run supersedes any earlier failure; otherwise the error overlay
        // (and the run bar banner mirroring it) would outlive successful retries.
        document.getElementById('cg-error-overlay')?.remove();
        const loadingOverlay = customCommonOverlay().createLoadingOverlay(loadingMEssage, elapsedTimePrefix, elapsedTimeSuffix);
        const buttonOverlay = document.getElementById('cg-button-overlay');
        const savedPosition = JSON.parse(localStorage.getItem('overlayPosition'));
        if (savedPosition?.top !== undefined && savedPosition.left !== undefined) {
            loadingOverlay.style.top = `${savedPosition.top}px`;
            loadingOverlay.style.left = `${savedPosition.left}px`;
            loadingOverlay.style.transform = 'none';
        } else if (buttonOverlay) {
            const rect = buttonOverlay.getBoundingClientRect();
            loadingOverlay.style.top = `${rect.top}px`;
            loadingOverlay.style.left = `${rect.left}px`;
            loadingOverlay.style.transform = 'none';
        } else {
            loadingOverlay.style.top = '20%';
            loadingOverlay.style.left = '50%';
            loadingOverlay.style.transform = 'translate(-50%, -20%)';
        }
        addDragFunctionality(loadingOverlay, buttonOverlay);
        globalThis.mainGallery.isLoading = true;
        startProgressTile();
    };

    globalThis.mainGallery.hideLoading = function (errorMessage, copyMessage) {
        const loadingOverlay = document.getElementById('cg-loading-overlay');
        const buttonOverlay = document.getElementById('cg-button-overlay');
        if (loadingOverlay) {
            if (loadingOverlay.dataset.timerInterval) {
                clearInterval(loadingOverlay.dataset.timerInterval);
            }
            if (buttonOverlay && !buttonOverlay.classList.contains('minimized')) {
                const rect = loadingOverlay.getBoundingClientRect();
                buttonOverlay.style.left = '0';
                buttonOverlay.style.top = '0';
                buttonOverlay.style.transform = `translate(${rect.left}px, ${rect.top}px)`;
                if (buttonOverlay.updateDragPosition) {
                    buttonOverlay.updateDragPosition(rect.left, rect.top);
                }
            }
            loadingOverlay.remove();
        }
        if ('success' !== errorMessage) {
            console.error('Got Error from backend:', copyMessage);
            customCommonOverlay().createErrorOverlay(errorMessage, copyMessage);
        } else {
            document.getElementById('cg-error-overlay')?.remove();
        }
        globalThis.mainGallery.isLoading = false;
        stopProgressTile();
    };

    function ensurePrivacyButton() {
        let privacyButton = document.getElementById('cg-privacy-button');
        if (!privacyButton) {
            privacyButton = document.createElement('button');
            privacyButton.id = 'cg-privacy-button';
            privacyButton.className = 'cg-button';
            privacyButton.textContent = '(X)';
            privacyButton.style.top = '50px';
            privacyButton.style.left = '10px';
            privacyButton.style.background = 'linear-gradient(45deg, red, orange, yellow, green, blue, indigo, violet)';
            privacyButton.addEventListener('click', () => {
                if (privacyBalls.length >= 5) {
                    console.log('Maximum 5 privacy balls reached');
                    return;
                }
                createPrivacyBall();
            });
            container.appendChild(privacyButton);
        }
    }

    function createPrivacyBall() {
        const ball = document.createElement('div');
        ball.className = 'cg-privacy-ball';
        const galleryRect = container.getBoundingClientRect();
        const left = galleryRect.left + galleryRect.width / 2 - 50;
        const top = galleryRect.top + galleryRect.height / 2 - 50;
        ball.style.left = `${left}px`;
        ball.style.top = `${top}px`;
        ball.style.width = '100px';
        ball.style.height = '100px';

        // Apply base64 PNG as background image if available
        if (globalThis.cachedFiles?.privacyBall) {
            ball.style.backgroundImage = `url(${globalThis.cachedFiles.privacyBall})`;
            ball.style.backgroundSize = 'cover';
            ball.style.backgroundPosition = 'center';
            ball.style.backgroundRepeat = 'no-repeat';
        } else {
            // Fallback to original styling with SAA text
            console.warn('Privacy ball image not found in globalThis.cachedFiles.privacyBall');
            ball.innerHTML = 'SAA';
            ball.style.background = 'linear-gradient(45deg, red, orange, yellow, green, blue, indigo, violet)';
        }

        let isDragging = false, startX, startY;
        ball.addEventListener('mousedown', (e) => {
            if (e.button === 0) { 
                e.preventDefault();
                isDragging = true;
                startX = e.clientX - Number.parseFloat(ball.style.left || 0);
                startY = e.clientY - Number.parseFloat(ball.style.top || 0);
                ball.style.cursor = 'grabbing'; 
                document.body.style.userSelect = 'none';
            } else if (e.button === 2) { 
                e.preventDefault();
                const startY = e.clientY;
                const startSize = Number.parseFloat(ball.style.width || 100);

                const onMouseMove = (moveEvent) => {
                    const deltaY = moveEvent.clientY - startY;
                    let newSize = startSize + deltaY;
                    newSize = Math.min(Math.max(newSize, 20), 300); 
                    ball.style.width = `${newSize}px`;
                    ball.style.height = `${newSize}px`;
                    if (!globalThis.cachedFiles?.privacyBall) {
                        ball.style.fontSize = `${newSize * 0.2}px`; 
                    }
                };

                const onMouseUp = () => {
                    document.removeEventListener('mousemove', onMouseMove);
                    document.removeEventListener('mouseup', onMouseUp);
                };

                document.addEventListener('mousemove', onMouseMove);
                document.addEventListener('mouseup', onMouseUp);
            }
        });

        document.addEventListener('mousemove', (e) => {
            if (!isDragging) return;
            e.preventDefault();
            ball.style.left = `${e.clientX - startX}px`;
            ball.style.top = `${e.clientY - startY}px`;
        });

        document.addEventListener('mouseup', () => {
            if (isDragging) {
                isDragging = false;
                ball.style.cursor = 'grab'; 
                document.body.style.userSelect = '';
            }
        });

        ball.addEventListener('contextmenu', (e) => {
            e.preventDefault();
        });

        ball.addEventListener('dblclick', () => {
            ball.remove();
            privacyBalls = privacyBalls.filter(b => b !== ball);
        });

        document.body.appendChild(ball);
        privacyBalls.push(ball);
    }

    function enterFullscreen(index) {
        const imgUrl = images[index];
        if (!imgUrl) {
            console.error('Invalid image index:', index);
            return;
        }

        const overlay = document.createElement('div');
        overlay.className = 'cg-fullscreen-overlay';

        const fullScreenImg = document.createElement('img');
        fullScreenImg.src = imgUrl;
        fullScreenImg.className = 'cg-fullscreen-image';

        let isDragging = false, startX = 0, startY = 0, translateX = 0, translateY = 0;

        fullScreenImg.addEventListener('mousedown', (e) => {
            if (e.button !== 0) return;
            e.preventDefault();
            isDragging = true;
            startX = e.clientX;
            startY = e.clientY;
            fullScreenImg.style.cursor = 'grabbing';
            document.addEventListener('mousemove', onMouseMove);
            document.addEventListener('mouseup', onMouseUp);
        });

        function onMouseMove(e) {
            if (!isDragging) return;
            e.preventDefault();
            e.stopPropagation();

            const deltaX = e.clientX - startX;
            const deltaY = e.clientY - startY;
            translateX += deltaX;
            translateY += deltaY;
            fullScreenImg.style.transform = `translate(${translateX}px, ${translateY}px) scale(${scale})`;
            startX = e.clientX;
            startY = e.clientY;
        }

        function onMouseUp() {
            isDragging = false;
            fullScreenImg.style.cursor = 'grab';
            document.removeEventListener('mousemove', onMouseMove);
            document.removeEventListener('mouseup', onMouseUp);
        }

        let scale = 1;
        fullScreenImg.addEventListener('wheel', (e) => {
            e.preventDefault();
            scale += e.deltaY * -0.001;
            scale = Math.min(Math.max(0.5, scale), 4);
            fullScreenImg.style.transform = `translate(${translateX}px, ${translateY}px) scale(${scale})`;
        });

        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) exitFullscreen();
        });

        document.addEventListener('keydown', handleFullscreenKeyDown);
        overlay.appendChild(fullScreenImg);
        document.body.appendChild(overlay);

        function handleFullscreenKeyDown(e) {
            if (e.key === 'Escape') {
                exitFullscreen();
            } else if (e.key === 'ArrowRight' || e.key === ' ') {
                currentIndex = (currentIndex - 1 + images.length) % images.length;
                fullScreenImg.src = images[currentIndex];
                syncInfoPanel();
            } else if (e.key === 'ArrowLeft') {
                currentIndex = (currentIndex + 1) % images.length;
                fullScreenImg.src = images[currentIndex];
                syncInfoPanel();
            }
        }

        function exitFullscreen() {
            overlay.remove();
            document.removeEventListener('keydown', handleFullscreenKeyDown);
            
            if (!isGridMode) {
                let mainImage = document.createElement('img');
                mainImage.src = images[currentIndex];
                updatePreviewBorders();

                let mainImageContainer = container.querySelector('.cg-main-image-container');
                mainImage = mainImageContainer.querySelector('img')
                if (mainImage.src !== images[currentIndex]) {
                    mainImage.src = images[currentIndex];
                }
            }
        }
    }

    function gallery_renderGridMode(incremental = false) {        
        if (!images || images.length === 0) {
            container.innerHTML = '';
            renderedImageCount = 0;
            currentIndex = 0;
            return;
        }
            
        let gallery = container.querySelector('.cg-gallery-grid-container');
        let lastAspectRatio = Number.parseFloat(localStorage.getItem('gridAspectRatio') || '0');
    
        const containerWidth = container.offsetWidth;
        const firstImage = new Image();
        firstImage.src = images.at(-1);
        firstImage.onload = () => {
            const aspectRatio = firstImage.width / firstImage.height;
            const needsRedraw = !incremental || Math.abs(aspectRatio - lastAspectRatio) > 0.001;
    
            if (!gallery || needsRedraw) {
                container.innerHTML = '';
                gallery = document.createElement('div');
                gallery.className = 'cg-gallery-grid-container scroll-container';
                container.appendChild(gallery);
                renderedImageCount = 0;
                gallery.addEventListener('click', (e) => {
                    const imgContainer = e.target.closest('.cg-gallery-item');
                    if (imgContainer) {
                        const index = Number.parseInt(imgContainer.dataset.index);
                        currentIndex = index;
                        syncInfoPanel();
                        enterFullscreen(index);
                    }
                });
            }
    
            const targetHeight = 200;
            const targetWidth = targetHeight * aspectRatio;
            const itemsPerRow = Math.floor(containerWidth / (targetWidth + 10));
            gallery.style.gridTemplateColumns = `repeat(${itemsPerRow}, ${targetWidth}px)`;
    
            const fragment = document.createDocumentFragment();
            const observer = new IntersectionObserver((entries, observer) => {
                process_oberserver(entries, observer);
            }, { root: gallery, threshold: 0.1 });
    
            for (let i = images.length - 1; i >= renderedImageCount; i--) {
                const imgContainer = document.createElement('div');
                imgContainer.className = `cg-gallery-item ${i}`;
                imgContainer.style.width = `${targetWidth}px`;
                imgContainer.style.height = `${targetHeight}px`;
                imgContainer.dataset.index = i;
                const img = document.createElement('img');
                img.className = 'cg-gallery-image';
                img.dataset.src = images[i]; 
                img.src = 'data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs='; 
                img.loading = 'lazy';
                imgContainer.appendChild(img);
                fragment.appendChild(imgContainer);
                observer.observe(imgContainer); 
            }
            gallery.prepend(fragment);
            renderedImageCount = images.length;
    
            localStorage.setItem('gridAspectRatio', aspectRatio.toString());
            ensurePrivacyButton();
        };
        firstImage.onerror = () => {
            console.error('Failed to load latest image for grid mode');
            container.innerHTML = '';
            renderedImageCount = 0;
            currentIndex = 0;
        };
    }
    
    function gallery_renderSplitMode(incremental = false) {
        if (!images || images.length === 0) {
            container.innerHTML = '';
            renderedImageCount = 0;
            currentIndex = 0;
            return;
        }

        let mainImageContainer = container.querySelector('.cg-main-image-container');
        let previewContainer = container.querySelector('.cg-preview-container');

        if (!mainImageContainer || !previewContainer || !incremental) {
            container.innerHTML = '';
            mainImageContainer = document.createElement('div');
            mainImageContainer.className = 'cg-main-image-container';
            const mainImage = document.createElement('img');
            mainImage.src = images[currentIndex];
            mainImage.className = 'cg-main-image';
            mainImage.addEventListener('click', () => enterFullscreen(currentIndex));
            mainImageContainer.appendChild(mainImage);
            mainImageContainer.append(
                viewerButton('cg-nav-button cg-nav-newer', '\u2039', 'viewer_newer', 'Newer image', () => step(1)),
                viewerButton('cg-nav-button cg-nav-older', '\u203a', 'viewer_older', 'Older image', () => step(-1)),
                viewerButton('cg-star-button', '\u2605', 'viewer_favourite', 'Favourite', () => toggleStar(currentIndex)),
            );
            container.appendChild(mainImageContainer);

            mainImageContainer.addEventListener('click', (e) => {
                e.preventDefault();
                const rect = mainImageContainer.getBoundingClientRect();
                const clickX = e.clientX - rect.left;
                const isLeft = clickX < rect.width / 2;
                if (e.target === mainImageContainer && images.length > 1) {
                    if (isLeft) {
                        currentIndex = (currentIndex + 1) % images.length;
                    } else {
                        currentIndex = (currentIndex - 1 + images.length) % images.length;
                    }
                    mainImage.src = images[currentIndex];
                    updatePreviewBorders();
                }
            });

            previewContainer = document.createElement('div');
            previewContainer.className = 'cg-preview-container scroll-container';
            setupScrollableContainer(previewContainer);
            container.appendChild(previewContainer);
            renderedImageCount = 0;

            previewContainer.addEventListener('click', (e) => {
                const previewImage = e.target.closest('.cg-preview-image');
                if (previewImage) {
                    e.preventDefault();
                    const domIndex = Number.parseInt(previewImage.dataset.domIndex);
                    currentIndex = images.length - 1 - domIndex;
                    mainImage.src = images[currentIndex];
                    updatePreviewBorders();
                    previewImage.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
                }
            });
        }

        const fragment = document.createDocumentFragment();
        const observer = new IntersectionObserver((entries, observer) => {
            for (const entry of entries) {
                if (entry.isIntersecting) {
                    const img = entry.target;
                    img.src = img.dataset.src;
                    img.classList.add('visible');
                    observer.unobserve(img);
                }
            }
        }, { root: previewContainer, threshold: 0.1 });

        if (incremental && renderedImageCount < images.length) {
            for (let i = renderedImageCount; i < images.length; i++) {
                fragment.appendChild(previewTile(i, observer));
            }
        } else {
            for (let i = images.length - 1; i >= 0; i--) {
                fragment.appendChild(previewTile(i, observer));
            }
        }

        previewContainer.prepend(fragment);
        container.querySelector('.cg-progress-tile')?.remove();
        paintProgressTile();
        renderedImageCount = images.length;

        updatePreviewBorders();
        const currentPreview = previewContainer.querySelector(`.cg-preview-image[data-domIndex="${images.length - 1 - currentIndex}"]`);
        if (currentPreview) {
            currentPreview.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
        }

        ensurePrivacyButton();
    }

    function viewerButton(className, glyph, langKey, fallback, onClick) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = className;
        button.textContent = glyph;
        const language = globalThis.cachedFiles?.language?.[globalThis.globalSettings?.language] ?? {};
        const label = typeof language[langKey] === 'string' && language[langKey] ? language[langKey] : fallback;
        button.setAttribute('aria-label', label);
        button.title = label;
        button.addEventListener('click', event => {
            event.stopPropagation();
            onClick();
        });
        return button;
    }

    // One thumbnail of the strip: the image (lazy, `observer` fills its src on screen)
    // in a tile that carries the star mark.
    function previewTile(index, observer) {
        const tile = document.createElement('span');
        tile.className = 'cg-preview-tile';
        const previewImage = document.createElement('img');
        previewImage.className = 'cg-preview-image';
        previewImage.dataset.src = images[index];
        previewImage.src = 'data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=';
        previewImage.loading = 'lazy';
        previewImage.dataset.domIndex = images.length - 1 - index;
        tile.appendChild(previewImage);
        observer.observe(previewImage);
        return tile;
    }
    
    function updatePreviewBorders() {
        const previewImages = container.querySelectorAll('.cg-preview-image');
        for (const [domIndex, child] of [...previewImages].entries()) {
            const index = images.length - 1 - domIndex;
            child.dataset.domIndex = domIndex;
            child.parentElement?.classList?.toggle('is-current', index === currentIndex);
        }
        paintStars();
        const domIndex = images.length - 1 - currentIndex;
        if (domIndex >= 0 && domIndex < previewImages.length) {
            previewImages[domIndex].scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
        }
        syncInfoPanel();
    }

    // The Info panel follows the selected image: the run's own info when the gallery
    // has it, otherwise the parameters embedded in the file (loaded / older images).
    let infoSyncToken = 0;
    function syncInfoPanel() {
        document.dispatchEvent(new CustomEvent(VIEWER_SELECT_EVENT, { detail: globalThis.mainGallery.currentEntry() }));
        const box = globalThis.infoBox?.image;
        if (!box?.setValue || images.length === 0) return;
        const index = currentIndex;
        const token = ++infoSyncToken;
        const stored = infos[index];
        if (stored) {
            box.setValue(stored);
            return;
        }
        const dataUrl = images[index];
        if (!dataUrl?.startsWith?.('data:image/')) return;
        const seedLine = seeds[index] ? `Seed: [${seeds[index]}]\n` : '';
        box.setValue(seedLine);
        (async () => {
            try {
                const result = globalThis.inBrowser
                    ? await sendWebSocketMessage({ type: 'API', method: 'readBase64Image', params: [dataUrl] })
                    : await globalThis.api.readBase64Image(dataUrl);
                const text = result?.metadata?.parameters || result?.metadata?.data || '';
                if (token !== infoSyncToken || currentIndex !== index) return; // selection moved on
                if (text) box.setValue(`${seedLine}${text}`);
            } catch (error) {
                console.warn('[gallery] embedded metadata read failed:', error?.message ?? error);
            }
        })();
    }
}
