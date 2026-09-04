// Context menu. Every entry is scoped to what was right-clicked (a tag capsule, a prompt
// field, an image, the gallery, the AI prompt); nothing is shown everywhere. Scoped
// handlers are { selector, func, visible?, label?, items? }: `visible(scope)` gates the
// entry, `label(scope)` overrides its text, and `items(scope)` turns it into an accordion
// submenu (expands in place — the menu box clips flyouts).
import { getAiPrompt } from '../remoteAI.js';
import { sendWebSocketMessage } from '../../webserver/front/wsRequest.js';
import { appendTagsToText, removeTagsFromText } from './tagCapsuleLogic.js';

function debounce(func, wait) {
    let timeout;
    return function (...args) {
        clearTimeout(timeout);
        timeout = setTimeout(() => func.apply(this, args), wait);
    };
}

let menuBox = null;
let currentSelectedText = '';
let currentMenuX = 0;
let currentMenuY = 0;

const PROMPT_TEXTAREA = /(^|\s)myTextbox-prompt-[\w-]+-textarea(\s|$)/;

function lang() {
    const SETTINGS = globalThis.globalSettings;
    const FILES = globalThis.cachedFiles;
    return FILES?.language?.[SETTINGS?.language] ?? {};
}

function styleMenuItem(menuItem) {
    menuItem.className = 'menu-item';
    menuItem.style.padding = '6px 12px';
    menuItem.style.cursor = 'pointer';
    menuItem.style.fontSize = '14px';
    menuItem.style.userSelect = 'none';
    menuItem.addEventListener('mouseenter', () => {
        if (!menuItem.classList.contains('is-disabled')) menuItem.style.background = 'rgba(192, 192, 192, 0.5)';
    });
    menuItem.addEventListener('mouseleave', () => {
        menuItem.style.background = 'none';
    });
    return menuItem;
}

function closeMenu() {
    if (!menuBox) return;
    menuBox.style.display = 'none';
    currentSelectedText = '';
}

export function addSpellCheckSuggestions(suggestions, word) {
    if (menuBox?.style.display === 'none') {
        // Menu is closed, ignoring spellcheck suggestions
        return;
    }

    if (currentSelectedText && word !== currentSelectedText) {
        // Selected text changed, ignoring spellcheck suggestions
        return;
    }

    const spellCheckFragment = document.createDocumentFragment();
    let maxWidth = Number.parseInt(menuBox.style.width, 10) - 24 || 200;

    const tempDiv = document.createElement('div');
    tempDiv.style.position = 'absolute';
    tempDiv.style.visibility = 'hidden';
    tempDiv.style.whiteSpace = 'nowrap';
    document.body.appendChild(tempDiv);

    if (suggestions.length > 0) {
        let index = 0;
        for (const suggestion of suggestions) {
            const menuItem = styleMenuItem(document.createElement('div'));
            menuItem.textContent = suggestion;
            menuItem.dataset.index = `spellcheck_${index}`;
            menuItem.addEventListener('click', async () => {
                try {
                    await globalThis.api.replaceMisspelling(suggestion);
                    closeMenu();
                } catch (error) {
                    console.error('Error replacing misspelling:', error);
                }
            });
            tempDiv.textContent = suggestion;
            maxWidth = Math.max(maxWidth, tempDiv.offsetWidth);
            spellCheckFragment.appendChild(menuItem);
            index++;
        }

        const addToDictItem = styleMenuItem(document.createElement('div'));
        addToDictItem.textContent = 'Add to dictionary';
        addToDictItem.dataset.index = 'spellcheck_add_to_dict';
        addToDictItem.addEventListener('click', async () => {
            try {
                await globalThis.api.addToDictionary(word);
                closeMenu();
            } catch (error) {
                console.error('Error adding to dictionary:', error);
            }
        });
        tempDiv.textContent = 'Add to dictionary';
        maxWidth = Math.max(maxWidth, tempDiv.offsetWidth);
        spellCheckFragment.appendChild(addToDictItem);

        const separator = document.createElement('div');
        separator.className = 'menu-separator';
        spellCheckFragment.appendChild(separator);
    }

    tempDiv.remove();

    // insert the spell check suggestions at the top of the menu
    const currentChildren = Array.from(menuBox.children);
    menuBox.innerHTML = '';
    menuBox.appendChild(spellCheckFragment);
    for (const child of currentChildren) {
        menuBox.appendChild(child);
    }

    menuBox.style.width = `${Math.min(maxWidth + 24, 300)}px`;
    updateMenuPosition(currentMenuX, currentMenuY);
}

export function setupRightClickMenu() {
    if (globalThis.rightClick?.initialized) {
        console.log('RightClickMenu already initialized');
        return;
    }

    console.log('Initializing RightClickMenu system');

    menuBox = document.createElement('div');
    menuBox.className = 'right-click-menu';
    menuBox.style.zIndex = '10002';
    menuBox.style.display = 'none';
    document.body.appendChild(menuBox);

    let menuConfig = [];
    let rightClickStartX, rightClickStartY, rightClickStartTime;
    let allowMenu = false;
    let isMoved = false;

    globalThis.rightClick = {
        initialized: true,
        push: (index, displayName, handler) => {
            if (typeof index !== 'string' && typeof index !== 'number') {
                console.error('Invalid index:', index);
                return;
            }
            if (menuConfig.some(item => item.index === index)) {
                console.warn(`Index ${index} already exists, use update or remove first`);
                return;
            }
            const newItem = { index, displayName, handler };
            if (menuConfig.length === 0 || !displayName) {
                menuConfig.push(newItem);
            } else {
                menuConfig.unshift(newItem); // Insert at start
            }
        },
        append: (index, displayName, handler) => {
            if (typeof index !== 'string' && typeof index !== 'number') {
                console.error('Invalid index:', index);
                return;
            }
            if (menuConfig.some(item => item.index === index)) {
                console.warn(`Index ${index} already exists, use update or remove first`);
                return;
            }
            menuConfig.push({ index, displayName, handler });
        },
        remove: (index) => {
            const itemIndex = menuConfig.findIndex(item => item.index === index);
            if (itemIndex === -1) {
                console.warn(`No menu item found with index ${index}`);
                return;
            }
            menuConfig.splice(itemIndex, 1);
        },
        setTitle: (index, newDisplayName) => {
            const item = menuConfig.find(item => item.index === index);
            if (!item) {
                console.warn(`No menu item found with index ${index}`);
                return;
            }
            if (item.displayName === null) {
                console.warn(`Cannot update display name for separator at index ${index}`);
                return;
            }
            item.displayName = newDisplayName;
        },
        updateLanguage: () => {
            updateRightClickMenu();
        },
        close: closeMenu,
    };

    if (!globalThis.inBrowser) {
        // global spellcheck API
        globalThis.api.onSpellCheckSuggestions?.((suggestions, word) => {
            addSpellCheckSuggestions(suggestions, word);
        });
    }

    document.addEventListener('mousedown', (e) => {
        if (e.button === 2 && !allowMenu && !isMoved) { // Right-click
            rightClickStartX = e.clientX;
            rightClickStartY = e.clientY;
            rightClickStartTime = Date.now();
            allowMenu = true;
        }
    });

    document.addEventListener('mousemove', (e) => {
        if (typeof rightClickStartX === 'number' && typeof rightClickStartY === 'number' && allowMenu) {
            const deltaX = Math.abs(e.clientX - rightClickStartX);
            const deltaY = Math.abs(e.clientY - rightClickStartY);
            if (deltaX > 5 || deltaY > 5) {
                allowMenu = false; // Significant movement, likely resizing
                isMoved = true;
            }
        }
    });

    document.addEventListener('contextmenu', async (e) => {
        // If menu is already visible, prevent opening a new one
        if (menuBox.style.display !== 'none') {
            e.preventDefault();
            return;
        }

        //e.preventDefault(); // Keep commented to allow main process context-menu
        if (!menuConfig.length) return;

        const duration = Date.now() - rightClickStartTime;
        if (allowMenu && duration > 300 || isMoved) {
            rightClickStartX = undefined;
            rightClickStartY = undefined;
            rightClickStartTime = undefined;
            allowMenu = false;
            isMoved = false;
            return; // Suppress entire menu
        }

        const targetElement = e.target;
        if (globalThis.inBrowser) {
            // Move my right click menu a little left
            await renderMenu(e.clientX - 128, e.clientY, targetElement);
        } else {
            await renderMenu(e.clientX, e.clientY, targetElement);
        }
        rightClickStartX = undefined;
        rightClickStartY = undefined;
        rightClickStartTime = undefined;
        allowMenu = false;
        isMoved = false;
    });

    document.addEventListener('click', (e) => {
        if (!menuBox.contains(e.target)) closeMenu();
    });
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && menuBox.style.display !== 'none') closeMenu();
    });

    document.addEventListener('scroll', debounce(() => {
        if (menuBox.style.display !== 'none') {
            updateMenuPosition();
        }
    }, 100), true);

    // Prevent right-click on the menu itself from triggering a new menu
    menuBox.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        e.stopPropagation();
    });

    // eslint-disable-next-line sonarjs/cognitive-complexity
    async function renderMenu(x, y, targetElement) {
        const fragment = document.createDocumentFragment();
        let maxWidth = 0;
        const tempDiv = document.createElement('div');
        tempDiv.style.position = 'absolute';
        tempDiv.style.visibility = 'hidden';
        tempDiv.style.whiteSpace = 'nowrap';
        document.body.appendChild(tempDiv);
        const measure = title => {
            tempDiv.textContent = title;
            maxWidth = Math.max(maxWidth, tempDiv.offsetWidth);
        };

        const isTextInput = targetElement instanceof HTMLTextAreaElement && PROMPT_TEXTAREA.test(targetElement.className);

        // update currentSelectedText (the main process answers with spellcheck suggestions)
        currentSelectedText = '';
        if (isTextInput) {
            if (targetElement.selectionStart === targetElement.selectionEnd) {
                // cursor word
                const text = targetElement.value;
                const cursorPos = targetElement.selectionStart;
                const wordRegex = /\b[\w,]+\b/g;
                let word = '';
                let match;
                while ((match = wordRegex.exec(text)) !== null) {
                    if (match.index <= cursorPos && cursorPos <= match.index + match[0].length) {
                        word = match[0];
                        break;
                    }
                }
                currentSelectedText = word;
            } else {
                // selected text
                currentSelectedText = targetElement.value.slice(targetElement.selectionStart, targetElement.selectionEnd).trim();
            }
        }
        currentMenuX = x;
        currentMenuY = y;

        // render menu items
        for (const item of menuConfig) {
            const handler = item.handler;
            const scoped = Boolean(handler && typeof handler === 'object' && handler.selector);
            const scope = scoped ? targetElement.closest(handler.selector) : null;
            if (scoped && !scope) continue;
            if (scoped && typeof handler.visible === 'function' && !handler.visible(scope, targetElement)) continue;

            if (item.displayName === null || handler === null) {
                const separator = document.createElement('div');
                separator.className = 'menu-separator';
                fragment.appendChild(separator);
                continue;
            }

            const title = scoped && typeof handler.label === 'function' ? handler.label(scope, targetElement) : item.displayName;
            const menuItem = styleMenuItem(document.createElement('div'));
            menuItem.textContent = title;
            menuItem.dataset.index = item.index;
            measure(title);

            if (scoped && typeof handler.items === 'function') {
                // accordion submenu; entries with func === null render disabled
                menuItem.classList.add('has-submenu');
                const submenu = document.createElement('div');
                submenu.className = 'menu-submenu';
                submenu.hidden = true;
                const entries = handler.items(scope, targetElement) ?? [];
                for (const entry of entries) {
                    const subItem = styleMenuItem(document.createElement('div'));
                    subItem.classList.add('menu-subitem');
                    subItem.textContent = entry.label;
                    measure(`    ${entry.label}`);
                    if (typeof entry.func !== 'function') {
                        subItem.classList.add('is-disabled');
                        subItem.style.cursor = 'default';
                        subItem.style.opacity = '0.6';
                    } else {
                        subItem.addEventListener('click', () => {
                            try {
                                entry.func(scope, targetElement);
                            } catch (error) {
                                console.error('Error executing menu action:', error);
                            }
                            closeMenu();
                        });
                    }
                    submenu.appendChild(subItem);
                }
                menuItem.addEventListener('click', () => {
                    submenu.hidden = !submenu.hidden;
                    menuItem.classList.toggle('is-open', !submenu.hidden);
                    updateMenuPosition();
                });
                fragment.append(menuItem, submenu);
                continue;
            }

            menuItem.addEventListener('click', () => {
                executeMenuAction(handler, targetElement);
                closeMenu();
            });
            fragment.appendChild(menuItem);
        }

        tempDiv.remove();

        // no leading / trailing / doubled separators once scoping has thinned the list
        const children = Array.from(fragment.children);
        let previousWasSeparator = true;
        for (const child of children) {
            const isSeparator = child.classList.contains('menu-separator');
            if (isSeparator && previousWasSeparator) child.remove();
            previousWasSeparator = isSeparator;
        }
        if (fragment.lastElementChild?.classList.contains('menu-separator')) fragment.lastElementChild.remove();

        if (!fragment.children.length && !currentSelectedText) {
            menuBox.style.display = 'none';
            return;
        }

        menuBox.innerHTML = '';
        menuBox.appendChild(fragment);
        menuBox.style.width = `${Math.min(maxWidth + 24, 300)}px`;
        updateMenuPosition(x, y);
        menuBox.style.display = 'block';
    }

    registerDefaultMenuItems();
}

function executeMenuAction(handler, targetElement) {
    try {
        if (typeof handler === 'function') {
            handler();
        } else if (typeof handler === 'object' && handler.func && handler.selector) {
            const element = targetElement.closest(handler.selector);
            if (element) {
                handler.func(element, targetElement);
            }
        } else {
            console.warn('Invalid handler:', handler);
        }
    } catch (error) {
        console.error('Error executing menu action:', error);
    }
}

function updateMenuPosition(x = currentMenuX, y = currentMenuY) {
    const menuWidth = menuBox.offsetWidth || 200;
    const menuHeight = menuBox.offsetHeight || 100;
    const windowWidth = globalThis.innerWidth;
    const windowHeight = globalThis.innerHeight;
    const paddingX = 10;
    const paddingY = 10;

    let newLeft = x;
    let newTop = y;

    if (newLeft + menuWidth > windowWidth - paddingX) {
        newLeft = Math.max(0, windowWidth - menuWidth - paddingX);
    }
    if (newTop + menuHeight > windowHeight - paddingY) {
        newTop = Math.max(0, Math.min(y, windowHeight - menuHeight - paddingY));
    }

    menuBox.style.left = `${newLeft}px`;
    menuBox.style.top = `${newTop}px`;
}

// index → language key; labels are refreshed on language change through setTitle
const MENU_TITLES = Object.freeze({
    copy_image: 'right_menu_copy_image',
    copy_image_metadata: 'right_menu_copy_image_metadata',
    copy_image_grid: 'right_menu_copy_image',
    copy_image_metadata_grid: 'right_menu_copy_image_metadata',
    copy_image_full_screen: 'right_menu_copy_image',
    copy_image_metadata_full_screen: 'right_menu_copy_image_metadata',
    copy_image_preview: 'right_menu_copy_image',
    copy_image_preview_grid: 'right_menu_copy_image',
    remove_current_image: 'right_menu_remove_current_image',
    remove_current_image_grid: 'right_menu_remove_current_image',
    clear_gallery: 'right_menu_clear_gallery',
    tag_edit_weight: 'right_menu_edit_weight',
    tag_toggle: 'right_menu_disable_tag',
    tag_related: 'right_menu_related_tags',
    tag_move_to: 'right_menu_move_to',
    tag_copy_to: 'right_menu_copy_to',
    tag_copy_text: 'right_menu_copy_tag',
    tag_remove: 'right_menu_remove_tag',
    field_enable_all: 'right_menu_enable_all',
    field_disable_all: 'right_menu_disable_all',
    field_move_selection: 'right_menu_move_selection_to',
    field_copy_selection: 'right_menu_copy_selection_to',
    field_lora_to_slot: 'right_menu_send_lora_to_slot',
    field_copy_text: 'right_menu_copy_field',
    field_clear: 'right_menu_clear_field',
    test_ai_generate: 'right_menu_test_ai_generate',
});

function updateRightClickMenu() {
    const LANG = lang();
    for (const [index, key] of Object.entries(MENU_TITLES)) {
        if (typeof LANG[key] === 'string') globalThis.rightClick.setTitle(index, LANG[key]);
    }
}

// ---------------------------------------------------------------- prompt-field helpers

function fieldSet() {
    return globalThis.prompt?.tagCapsuleFields ?? null;
}

function fieldKeyOf(scope) {
    return scope?.dataset?.fieldKey ?? null;
}

function fieldApi(scope) {
    const key = fieldKeyOf(scope);
    return key ? fieldSet()?.get?.(key) ?? null : null;
}

function fieldControl(key) {
    return key ? globalThis.prompt?.[key] ?? null : null;
}

// Other prompt fields, in chain order, that can receive tags from `key`.
function transferTargets(key) {
    const set = fieldSet();
    const listed = globalThis.prompt?.fieldManager?.listFields?.();
    const entries = Array.isArray(listed) && listed.length > 0
        ? listed
        : [...(set?.fields?.keys() ?? [])].map(id => ({ id, label: set.get(id)?.getLabel?.() ?? id }));
    return entries.filter(entry => entry.id !== key && set?.get?.(entry.id) && fieldControl(entry.id));
}

function targetEntries(key, apply) {
    const targets = transferTargets(key);
    if (targets.length === 0) return [{ label: lang().right_menu_no_target ?? '(no other field)', func: null }];
    return targets.map(target => ({ label: target.label, func: () => apply(target.id) }));
}

function chipContext(chip) {
    const key = fieldKeyOf(chip.closest('[data-field-key]'));
    const field = key ? fieldSet()?.get?.(key) ?? null : null;
    const capsule = field?.findCapsule?.(chip.dataset.capsuleId) ?? null;
    return { key, field, capsule };
}

function textareaSelection(scope) {
    if (!(scope instanceof HTMLTextAreaElement)) return [];
    if (scope.selectionStart === scope.selectionEnd) return [];
    return scope.value.slice(scope.selectionStart, scope.selectionEnd)
        .split(/[,\n]/).map(token => token.trim()).filter(Boolean);
}

function transferSelection(scope, targetId, { copy }) {
    const key = fieldKeyOf(scope);
    const tokens = textareaSelection(scope);
    const target = fieldControl(targetId);
    const source = fieldControl(key);
    if (tokens.length === 0 || !target || !source) return;
    const mutate = () => {
        target.commitValue(appendTagsToText(target.getValue(), tokens));
        if (!copy) source.commitValue(removeTagsFromText(source.getValue(), tokens));
    };
    if (globalThis.settingsPersistence?.runEditTransaction) {
        globalThis.settingsPersistence.runEditTransaction({ source: 'move-selection', sections: ['prompt'] }, mutate);
    } else {
        mutate();
    }
}

async function copyText(value) {
    try {
        await navigator.clipboard.writeText(String(value ?? ''));
    } catch (error) {
        console.warn('Failed to copy text to clipboard:', error);
    }
}

function registerDefaultMenuItems() {
    const LANG = lang();
    const rc = globalThis.rightClick;

    // ---------------------------------------------------------------- tag capsule
    rc.append('tag_edit_weight', LANG.right_menu_edit_weight, {
        selector: '.tag-capsule-chip',
        func: (chip) => chip.click(),
    });
    rc.append('tag_toggle', LANG.right_menu_disable_tag, {
        selector: '.tag-capsule-chip',
        label: chip => (chip.classList.contains('is-disabled') ? lang().right_menu_enable_tag : lang().right_menu_disable_tag),
        func: (chip) => chip.querySelector('.tag-capsule-chip-toggle')?.click(),
    });
    rc.append('tag_related', LANG.right_menu_related_tags, {
        selector: '.tag-capsule-chip',
        visible: () => Boolean(fieldSet()?.hasRelated),
        func: (chip) => {
            const { field, capsule } = chipContext(chip);
            if (field && capsule) field.showRelated(capsule.id);
        },
    });
    rc.append('separator_tag_1', null, { selector: '.tag-capsule-chip' });
    rc.append('tag_move_to', LANG.right_menu_move_to, {
        selector: '.tag-capsule-chip',
        items: chip => {
            const { key, capsule } = chipContext(chip);
            return targetEntries(key, targetId => fieldSet()?.transfer(key, capsule?.id, targetId, { copy: false }));
        },
    });
    rc.append('tag_copy_to', LANG.right_menu_copy_to, {
        selector: '.tag-capsule-chip',
        items: chip => {
            const { key, capsule } = chipContext(chip);
            return targetEntries(key, targetId => fieldSet()?.transfer(key, capsule?.id, targetId, { copy: true }));
        },
    });
    rc.append('separator_tag_2', null, { selector: '.tag-capsule-chip' });
    rc.append('tag_copy_text', LANG.right_menu_copy_tag, {
        selector: '.tag-capsule-chip',
        func: (chip) => copyText(chipContext(chip).capsule?.value ?? chip.querySelector('.tag-capsule-chip-name')?.textContent ?? ''),
    });
    rc.append('tag_remove', LANG.right_menu_remove_tag, {
        selector: '.tag-capsule-chip',
        func: (chip) => chip.querySelector('.tag-capsule-chip-remove')?.click(),
    });
    rc.append('separator_tag_3', null, { selector: '.tag-capsule-chip' });

    // ---------------------------------------------------------------- prompt field
    // (textarea in text mode, chip row / capsule view in capsule mode; custom fields included)
    const FIELD = '[data-field-key]';
    rc.append('field_move_selection', LANG.right_menu_move_selection_to, {
        selector: FIELD,
        visible: scope => textareaSelection(scope).length > 0,
        items: scope => targetEntries(fieldKeyOf(scope), targetId => transferSelection(scope, targetId, { copy: false })),
    });
    rc.append('field_copy_selection', LANG.right_menu_copy_selection_to, {
        selector: FIELD,
        visible: scope => textareaSelection(scope).length > 0,
        items: scope => targetEntries(fieldKeyOf(scope), targetId => transferSelection(scope, targetId, { copy: true })),
    });
    rc.append('separator_field_1', null, { selector: FIELD });
    rc.append('field_enable_all', LANG.right_menu_enable_all, {
        selector: FIELD,
        visible: scope => (fieldApi(scope)?.getCapsules?.() ?? []).some(capsule => capsule.disabled),
        func: scope => fieldApi(scope)?.setAllDisabled(false),
    });
    rc.append('field_disable_all', LANG.right_menu_disable_all, {
        selector: FIELD,
        visible: scope => (fieldApi(scope)?.getCapsules?.() ?? []).some(capsule => !capsule.disabled),
        func: scope => fieldApi(scope)?.setAllDisabled(true),
    });
    rc.append('field_lora_to_slot', LANG.right_menu_send_lora_to_slot, {
        selector: FIELD,
        visible: scope => {
            const key = fieldKeyOf(scope);
            if (key === 'negative' || key === 'exclude') return false;
            return /<lora:[^>]+>/.test(String(fieldControl(key)?.getValue?.() ?? ''));
        },
        func: scope => {
            const key = fieldKeyOf(scope);
            runSendLoraTransaction(() => {
                const textPrompt = prompt_sendLoRAtoSlot(fieldControl(key));
                if (textPrompt !== null) {
                    fieldControl(key).commitValue(textPrompt.trim());
                    globalThis.collapsedTabs?.lora?.setCollapsed?.(false);
                }
            });
        },
    });
    rc.append('separator_field_2', null, { selector: FIELD });
    rc.append('field_copy_text', LANG.right_menu_copy_field, {
        selector: FIELD,
        visible: scope => String(fieldControl(fieldKeyOf(scope))?.getValue?.() ?? '').trim() !== '',
        func: scope => copyText(fieldControl(fieldKeyOf(scope))?.getValue?.() ?? ''),
    });
    rc.append('field_clear', LANG.right_menu_clear_field, {
        selector: FIELD,
        visible: scope => String(fieldControl(fieldKeyOf(scope))?.getValue?.() ?? '').trim() !== '',
        func: scope => fieldControl(fieldKeyOf(scope))?.commitValue(''),
    });

    // ---------------------------------------------------------------- AI prompt
    rc.append('test_ai_generate', LANG.right_menu_test_ai_generate, {
        selector: '.prompt-ai',
        func: async (element) => await prompt_testAIgenerate(element)
    });

    // ---------------------------------------------------------------- images
    // split mode
    rc.append('copy_image', LANG.right_menu_copy_image, {
        selector: '.cg-main-image-container',
        func: (element) => menu_copyImage(element)
    });
    rc.append('copy_image_metadata', LANG.right_menu_copy_image_metadata, {
        selector: '.cg-main-image-container',
        func: async (element) => await menu_copyImageMetadata(element)
    });
    rc.append('separator_split_mode', null, { selector: '.cg-main-image-container' });
    rc.append('remove_current_image', LANG.right_menu_remove_current_image, {
        selector: '.cg-main-image-container',
        func: (element) => { globalThis.mainGallery.removeCurrentImage(element); }
    });

    // grid mode
    rc.append('copy_image_grid', LANG.right_menu_copy_image, {
        selector: '.cg-gallery-item',
        func: (element) => menu_copyImage(element)
    });
    rc.append('copy_image_metadata_grid', LANG.right_menu_copy_image_metadata, {
        selector: '.cg-gallery-item',
        func: async (element) => await menu_copyImageMetadata(element)
    });
    rc.append('separator_grid_mode', null, { selector: '.cg-gallery-item' });
    rc.append('remove_current_image_grid', LANG.right_menu_remove_current_image, {
        selector: '.cg-gallery-item',
        func: (element) => {
            const img = element.querySelector('img');
            globalThis.mainGallery.removeCurrentImage(img.src);
        }
    });

    // full screen mode
    rc.append('copy_image_full_screen', LANG.right_menu_copy_image, {
        selector: '.cg-fullscreen-overlay',
        func: (element) => menu_copyImage(element)
    });
    rc.append('copy_image_metadata_full_screen', LANG.right_menu_copy_image_metadata, {
        selector: '.cg-fullscreen-overlay',
        func: async (element) => await menu_copyImageMetadata(element)
    });

    // thumb strip
    rc.append('copy_image_preview', LANG.right_menu_copy_image, {
        selector: '.cg-thumb-scroll-container',
        func: (element) => menu_copyImage(element)
    });
    rc.append('copy_image_preview_grid', LANG.right_menu_copy_image, {
        selector: '.cg-thumb-item',
        func: (element) => menu_copyImage(element)
    });

    // ---------------------------------------------------------------- gallery
    // Clear gallery only where the gallery is (it used to sit in every menu).
    rc.append('separator_gallery', null, { selector: '.gallery-main-main' });
    rc.append('clear_gallery', LANG.right_menu_clear_gallery, {
        selector: '.gallery-main-main',
        func: () => { globalThis.mainGallery.clearGallery(); }
    });
}

function runSendLoraTransaction(mutation) {
    if (globalThis.settingsPersistence?.runEditTransaction) {
        return globalThis.settingsPersistence.runEditTransaction({
            source: 'send-lora-to-slot',
            sections: ['prompt', 'lora'],
        }, mutation);
    }
    return mutation();
}

function menu_copyImage(element) {
    const img = element.querySelector('img');
    if (img?.src.startsWith('data:image/')) {
        try {
            // Check if the document is focused
            if (document.hasFocus()) {
                proceedWithCopy(img);
            } else {
                console.log('Document is not focused, attempting to focus the window');
                globalThis.focus(); // Attempt to bring the window into focus
                // Add a small delay to ensure focus is applied before clipboard access
                setTimeout(() => {
                    proceedWithCopy(img);
                }, 100); // 100ms delay to allow focus to take effect
            }
        } catch (err) {
            console.error('Error processing image:', err);
        }
    }
}

function proceedWithCopy(img) {
    try {
        const image = new Image();
        image.src = img.src;
        image.onload = () => {
            const canvas = document.createElement('canvas');
            canvas.width = image.width;
            canvas.height = image.height;
            const ctx = canvas.getContext('2d');
            ctx.drawImage(image, 0, 0);
            canvas.toBlob(async (blob) => {
                if (blob) {
                    try {
                        await navigator.clipboard.write([
                            new ClipboardItem({ 'image/png': blob })
                        ]);
                        console.log('Image successfully copied to clipboard');
                    } catch (err) {
                        console.warn('Failed to copy PNG image to clipboard (first attempt):', err);

                        // wait 1000ms then retry once
                        await new Promise(resolve => setTimeout(resolve, 1000));

                        try {
                        await navigator.clipboard.write([
                            new ClipboardItem({ 'image/png': blob })
                        ]);
                            console.log('Image successfully copied to clipboard (retry succeeded)');
                        } catch (error) {
                            console.warn('Failed to copy PNG image to clipboard (retry also failed):', error);
                            const LANG = lang();
                            globalThis.overlay.custom.createCustomOverlay(
                                'none',
                                LANG.saac_macos_copy_image,
                                384,
                                'center',
                                'left',
                                null,
                                'Clipboard'
                            );
                        }
                    }
                    }
            }, 'image/png');
        };
        image.onerror = () => {
            console.error('Failed to load image for conversion');
        };
    } catch (err) {
        console.error('Error in proceedWithCopy:', err);
    }
}

async function menu_copyImageMetadata(element) {
    const img = element.querySelector('img');
    if (img?.src.startsWith('data:image/')) {
        try {
            let result;
            if (globalThis.inBrowser) {
                result = await sendWebSocketMessage({ type: 'API', method: 'readBase64Image', params: [img.src] });
            } else {
                result = await globalThis.api.readBase64Image(img.src);
            }
            if (result.error || !result.metadata) {
                return ;
            }
            try {
                await navigator.clipboard.writeText(result.metadata?.parameters || result.metadata?.data);
            } catch (err){
                console.warn('Failed to copy PNG image metadata to clipboard:', err);
                const LANG = lang();
                globalThis.overlay.custom.createCustomOverlay(
                    'none', LANG.saac_macos_clipboard.replace('{0}', result.metadata),
                    384, 'center', 'left', null, 'Clipboard');
            }

        } catch (error) {
            throw new Error(`Metadata extraction failed: ${error.message}`);
        }
    }
}

// Pulls every <lora:…> out of a prompt field control, loads them into the LoRA slot and
// returns the remaining prompt text (null when the field is empty / missing).
function prompt_sendLoRAtoSlot(control) {
    try {
        const text = String(control?.getValue?.() ?? '').trim();
        if (!text) {
            console.warn('Prompt field is empty');
            return null;
        }

        const loraRegex = /<lora:[^>]+>/g;
        const loraMatches = text.match(loraRegex) || [];
        const allLora = loraMatches.join(' ');
        const allPrompt = text.replaceAll(loraRegex, '').replaceAll(/,\s*,/g, ',').replaceAll(/^,\s+|,\s+$/gm, '').trim();

        if (allLora.trim() === '') {
            console.warn('No LoRA in prompt field');
        } else {
            globalThis.lora.flushSlot(allLora);
        }

        return `${allPrompt} `;
    } catch (err) {
        console.error('Error on get prompt field text:', err);
        return null;
    }
}

async function prompt_testAIgenerate(element){
    try {
        const textarea = element.querySelector('.myTextbox-prompt-ai-textarea');
        if (!textarea) {
            console.warn('No textarea found with class myTextbox-prompt-ai-textarea');
            return;
        }

        const text = textarea.value.trim();
        if (!text) {
            console.warn('Textarea is empty');
            return;
        }

        const aiText = await getAiPrompt(0, text);
        globalThis.overlay.custom.closeCustomOverlaysByGroup('aiText'); // close exist
        globalThis.overlay.custom.createCustomOverlay('none', `\n\n\n${aiText}`,
                                                    384, 'center', 'left', null, 'aiText');
    } catch (err) {
        console.error('Error on get AI prompt:', err);
    }
}
