import { sendWebSocketMessage } from '../webserver/front/wsRequest.js';
import { COARSE_GROUP_FILTERS } from '../main/tagCategoryConstants.js';
import { pagedCountText } from './components/tagUiText.js';

export const TAG_FILTERS = Object.freeze([
    { value: 'all', label: 'All' },
    { value: 'general', label: 'General', options: { groupIds: COARSE_GROUP_FILTERS.general } },
    { value: 'character', label: 'Character', options: { groupIds: COARSE_GROUP_FILTERS.character } },
    { value: 'work', label: 'Work', options: { groupIds: COARSE_GROUP_FILTERS.work } },
    { value: 'artist', label: 'Artist', options: { groupIds: COARSE_GROUP_FILTERS.artist } },
    { value: 'species', label: 'Species', options: { groupIds: COARSE_GROUP_FILTERS.species } },
    { value: 'meta', label: 'Meta', options: { groupIds: COARSE_GROUP_FILTERS.meta } },
    { value: 'lore', label: 'Lore', options: { groupIds: COARSE_GROUP_FILTERS.lore } },
    { value: 'pose_action', label: 'Pose / Action', options: { category: 'pose_action' } },
    { value: 'clothing', label: 'Clothing', options: { category: 'clothing' } },
    { value: 'appearance', label: 'Appearance', options: { category: 'appearance' } },
    { value: 'object', label: 'Object', options: { category: 'object' } },
    { value: 'scenery', label: 'Scenery / Background', options: { category: 'scenery' } },
    { value: 'composition_quality', label: 'Composition / Quality', options: { category: 'composition_quality' } },
]);

export function getTagFilterOptions(filterValue) {
    const filter = TAG_FILTERS.find(item => item.value === filterValue);
    if (!filter?.options) return undefined;
    return filter.options.groupIds
        ? { groupIds: [...filter.options.groupIds] }
        : { category: filter.options.category };
}

export function extractPromptKeyFromSuggestion(suggestionHtml) {
    return /^\s*<b>(.*?)<\/b>/.exec(suggestionHtml)?.[1] || '';
}

// Rows per page of the suggestion box and of the tag picker; the next page is
// fetched when the list is scrolled to its end.
export const PAGE_SIZE = 50;

function createTagFilterControl(textbox) {
    const wrapper = textbox.closest('.myTextbox-wrapper') || textbox.parentElement;
    const relativeContainer = textbox.parentElement;
    if (!wrapper || !relativeContainer) return null;

    const control = document.createElement('label');
    control.className = 'tag-filter-control';
    control.textContent = 'Filter';

    const select = document.createElement('select');
    select.className = 'tag-filter-select';
    select.setAttribute('aria-label', 'Tag filter');
    for (const filter of TAG_FILTERS) {
        const option = document.createElement('option');
        option.value = filter.value;
        option.textContent = filter.label;
        select.appendChild(option);
    }
    control.appendChild(select);
    wrapper.insertBefore(control, relativeContainer);
    return select;
}

function debounce(func, wait) {
    let timeout;
    return function (...args) {
        clearTimeout(timeout);
        timeout = setTimeout(() => func.apply(this, args), wait);
    };
}

function extractCurrentWeight(targetText) {
    const weightMatch = targetText.match(/^\((.+):(\d*\.?\d+)\)$/); //NOSONAR S8786
    return weightMatch ? Number.parseFloat(weightMatch[2]) : 1;
}

function calculateNewWeight(currentWeight, isIncrease) {
    const step = 0.05;
    const newWeight = isIncrease ? currentWeight + step : currentWeight - step;
    if (newWeight < 0 || newWeight > 3) return null;
    return Number.parseFloat(newWeight.toFixed(2));
}

function formatNewTag(targetText, newWeight) {
    const baseText = targetText.match(/^\((.+):\d*\.?\d+\)$/)?.[1] || targetText;    //NOSONAR S8786
    return newWeight === 1 ? baseText : `(${baseText}:${newWeight})`;
}

function updateTextboxValue(textbox, value, start, end, newTag) {
    textbox.value = value.slice(0, start) + newTag + value.slice(end);
    const newCursorPos = start + newTag.length;
    textbox.setSelectionRange(newCursorPos, newCursorPos);
    textbox.dispatchEvent(new Event('input', { bubbles: true }));
}

function findBracketedTag(beforeCursor, afterCursor) {
    const fullText = beforeCursor + afterCursor;
    const cursorPos = beforeCursor.length;

    const bracketRegex = /\(([^()]+:\d*\.?\d+)\)/g;  //NOSONAR S8786
    let match;
    while ((match = bracketRegex.exec(fullText)) !== null) {
        const start = match.index;
        const end = start + match[0].length;
        if (start <= cursorPos && cursorPos <= end) {
            return {
                text: match[0],
                start: start,
                end: end
            };
        }
    }
    return null;
}

function extractTargetText(value, startPos, endPos) {
    if (startPos !== endPos) {
        return { targetText: value.slice(startPos, endPos), start: startPos, end: endPos };
    }

    const beforeCursor = value.slice(0, startPos);
    const afterCursor = value.slice(startPos);
    const bracketMatch = findBracketedTag(beforeCursor, afterCursor);

    if (bracketMatch) {
        return { targetText: bracketMatch.text, start: bracketMatch.start, end: bracketMatch.end };
    }

    const lastSeparatorBefore = Math.max(beforeCursor.lastIndexOf(','), beforeCursor.lastIndexOf('\n'));
    const firstSeparatorAfter = afterCursor.includes(',') ? afterCursor.indexOf(',') : afterCursor.indexOf('\n');
    const start = lastSeparatorBefore >= 0 ? lastSeparatorBefore + 1 : 0;
    const end = firstSeparatorAfter >= 0 ? startPos + firstSeparatorAfter : value.length;

    return { targetText: value.slice(start, end).trim(), start, end };
}

function formatSuggestion(suggestion) {
    const withoutHeat = suggestion.replace(/\s\(\d+\)$/, '');

    // AS IS: wildcards like __my_special_tag__
    if (/^__.*__$/.test(withoutHeat)) {
        return withoutHeat;
    }

    // otherwise, format the suggestion
    if (withoutHeat.startsWith(':') || withoutHeat.endsWith(':')) {
        return withoutHeat;
    }

    let formatted = withoutHeat.replaceAll('_', ' ');
    formatted = formatted.replaceAll(/[\\()]/g, String.raw`\$&`);

    return formatted;
}


function adjustWeight(isIncrease, textbox) {
    const { value, selectionStart: startPos, selectionEnd: endPos } = textbox;

    const { targetText, start, end } = extractTargetText(value, startPos, endPos);
    if (!targetText) return;

    const currentWeight = extractCurrentWeight(targetText);
    const newWeight = calculateNewWeight(currentWeight, isIncrease);
    if (newWeight === null) return;

    const newTag = formatNewTag(targetText, newWeight);
    updateTextboxValue(textbox, value, start, end, newTag);
}

function extractWordToSend(value, cursorPosition) {
    const beforeCursor = value.slice(0, cursorPosition);
    const afterCursor = value.slice(cursorPosition);                
    const lastCommaBefore = beforeCursor.lastIndexOf(',');
    const lastNewlineBefore = beforeCursor.lastIndexOf('\n');
    const start = Math.max(lastCommaBefore, lastNewlineBefore) >= 0 
        ? Math.max(lastCommaBefore, lastNewlineBefore) + 1 
        : 0;        
    const firstCommaAfter = afterCursor.indexOf(',');
    const firstNewlineAfter = afterCursor.indexOf('\n');
    
    let end;
    if (firstNewlineAfter === 0) {
        end = cursorPosition;
    } else if (firstCommaAfter >= 0 || firstNewlineAfter >= 0) {
        end = firstCommaAfter >= 0 && (firstNewlineAfter < 0 || firstCommaAfter < firstNewlineAfter)
            ? cursorPosition + firstCommaAfter
            : (() => {
                if (firstNewlineAfter >= 0) {
                    return cursorPosition + firstNewlineAfter;
                }
                return value.length;
            })();
    } else {
        end = value.length;
    }

    const extracted = value.slice(start, end).trim();
    return extracted.endsWith(',') || extracted === '' ? '' : extracted;
}

export function setupSuggestionSystem() {
    const textboxes = document.querySelectorAll(
        '.myTextbox-prompt-common-textarea, .myTextbox-prompt-background-textarea, .myTextbox-prompt-style-textarea, .myTextbox-prompt-positive-textarea, .myTextbox-prompt-positive-right-textarea, .myTextbox-prompt-negative-textarea, .myTextbox-prompt-exclude-textarea'
        //'.myTextbox-prompt-ai-textarea',
    );

    for(const textbox of textboxes) {
        if (textbox.dataset.suggestionSetup) continue;

        console.log('Setting up the Suggestion System for ', textbox);

        const suggestionBox = document.createElement('div');
        suggestionBox.className = 'suggestion-box scroll-container';
        suggestionBox.style.display = 'none';
        document.body.appendChild(suggestionBox);

        const filterSelect = createTagFilterControl(textbox);
        let lastWordSent = '';
        let skipSuggestion = false;

        let selectedIndex = -1;
        let currentSuggestions = [];
        const textboxWidth = textbox.offsetWidth;

        suggestionBox.addEventListener('click', (e) => {
            const item = e.target.closest('.suggestion-item');
            if (item) applySuggestion(item.dataset.value);
        });

        textbox.addEventListener('input', debounce(async (event) => {
            // text rewritten by the capsule field (chip toggle, weight, order): nothing was typed;
            // a hidden textarea (the field shows capsules, e.g. after "+ Add tag") has no caret to follow
            if (event?.detail?.source === 'capsules' || textbox.getClientRects().length === 0) {
                suggestionBox.style.display = 'none';
                return;
            }
            if (skipSuggestion) {
                skipSuggestion = false;
                return; 
            }

            updateSuggestionBoxPosition();

            const value = textbox.value;
            const cursorPosition = textbox.selectionStart;
            let wordToSend = extractWordToSend(value, cursorPosition);

            if (!wordToSend || wordToSend === lastWordSent) {
                suggestionBox.style.display = 'none';
                return;
            }
            wordToSend = wordToSend.replaceAll(' ', '_');
            lastWordSent = wordToSend;

            try {
                const page = await searchPage(wordToSend, 0);
                if (page.items.length === 0) {
                    suggestionBox.style.display = 'none';
                    return;
                }

                currentSuggestions = [];
                suggestionBox.innerHTML = '';
                suggestionBox.appendChild(suggestionRows(page.items));
                pageState = { word: wordToSend, total: page.total, loading: false };
                renderMoreLine();
                suggestionBox.style.width = `${Math.min(maxRowWidth + 20, 300)}px`;
                suggestionBox.style.display = 'block';
                suggestionBox.scrollTop = 0;
                selectedIndex = -1;

            } catch (error) {
                console.error('Suggestion system error:', error);
                suggestionBox.style.display = 'none';
            }
        }, 50));

        // The list is paged: PAGE_SIZE rows come at a time, the next page is fetched
        // when the box is scrolled near its end, and the last line says how many of
        // the matches are on screen.
        let pageState = { word: '', total: 0, loading: false };
        let maxRowWidth = 0;
        const moreLine = document.createElement('div');
        moreLine.className = 'suggestion-more';

        async function searchPage(word, offset) {
            const filterOptions = getTagFilterOptions(filterSelect?.value || 'all') || {};
            const params = [word, { ...filterOptions, offset, limit: PAGE_SIZE }];
            const answer = globalThis.inBrowser
                ? await sendWebSocketMessage({ type: 'API', method: 'tagSearch', params })
                : await globalThis.api.tagSearch(...params);
            const items = Array.isArray(answer?.items) ? answer.items : [];
            return { items, total: Number.isInteger(answer?.total) ? answer.total : items.length };
        }

        // Rows for one page of answers; currentSuggestions grows with them.
        function suggestionRows(items) {
            const fragment = document.createDocumentFragment();
            const tempDiv = document.createElement('div');
            tempDiv.style.position = 'absolute';
            tempDiv.style.visibility = 'hidden';
            tempDiv.style.whiteSpace = 'nowrap';
            document.body.appendChild(tempDiv);
            if (currentSuggestions.length === 0) maxRowWidth = 0;
            for (const [index, suggestion] of items.entries()) {
                if (!Array.isArray(suggestion) || suggestion.length === 0) {
                    console.warn('Invalid suggestion format at index', index, suggestion);
                    continue;
                }
                const element = suggestion[0];
                if (typeof element !== 'string') {
                    console.error('Unexpected element type at index', index, ':', typeof element, element);
                    continue;
                }
                const item = document.createElement('div');
                item.className = 'suggestion-item';
                item.innerHTML = element;
                const promptMatch = extractPromptKeyFromSuggestion(element);
                // Read the value back from the DOM so escaped display text
                // such as &lt;o&gt; is inserted as the original tag.
                item.dataset.value = promptMatch
                    ? (item.querySelector('b')?.textContent || '')
                    : element.split(':')[0].trim();
                let sanitizedElement = element;
                let previousElement;
                do {
                    previousElement = sanitizedElement;
                    sanitizedElement = sanitizedElement.replaceAll(/<[^>]+>/g, '');  //NOSONAR S8786
                } while (sanitizedElement !== previousElement);
                tempDiv.textContent = sanitizedElement;
                maxRowWidth = Math.max(maxRowWidth, tempDiv.offsetWidth);
                currentSuggestions.push({ prompt: element, value: item.dataset.value });
                fragment.appendChild(item);
            }
            tempDiv.remove();
            return fragment;
        }

        function renderMoreLine() {
            moreLine.textContent = pagedCountText(currentSuggestions.length, pageState.total);
            suggestionBox.appendChild(moreLine);
        }

        async function loadNextPage() {
            if (pageState.loading || currentSuggestions.length >= pageState.total) return;
            pageState.loading = true;
            const word = pageState.word;
            try {
                const page = await searchPage(word, currentSuggestions.length);
                // the word changed while the page was on its way: that answer is for another list
                if (pageState.word !== word || suggestionBox.style.display === 'none') return;
                pageState.total = page.total;
                moreLine.remove();
                suggestionBox.appendChild(suggestionRows(page.items));
                renderMoreLine();
            } catch (error) {
                console.error('Suggestion paging error:', error);
            } finally {
                if (pageState.word === word) pageState.loading = false;
            }
        }

        suggestionBox.addEventListener('scroll', () => {
            if (suggestionBox.scrollTop + suggestionBox.clientHeight >= suggestionBox.scrollHeight - 24) loadNextPage();
        });

        textbox.addEventListener('keydown', (e) => {
            if (suggestionBox.style.display !== 'none') {

                const items = suggestionBox.querySelectorAll('.suggestion-item');
                if (items.length === 0) return;

                if (e.key === 'Tab' || e.key === 'Enter') {
                    e.preventDefault();
                    if (selectedIndex >= 0 && selectedIndex < currentSuggestions.length) {
                        applySuggestion(currentSuggestions[selectedIndex].value);
                    } else if (items.length > 0) {
                        applySuggestion(currentSuggestions[0].value);
                    }
                } else if (e.key === 'ArrowDown') {
                    e.preventDefault();
                    selectedIndex = Math.min(selectedIndex + 1, items.length - 1);
                    updateSelection(items);
                    // the highlight reached the last row: fetch the next page so it can go on
                    if (selectedIndex === items.length - 1) loadNextPage();
                } else if (e.key === 'ArrowUp') {
                    e.preventDefault();
                    selectedIndex = Math.max(selectedIndex - 1, 0);
                    updateSelection(items);
                } else if (e.key === 'Escape') {
                    suggestionBox.style.display = 'none';
                }
            }

            if (e.ctrlKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
                e.preventDefault();
                adjustWeight(e.key === 'ArrowUp', textbox);
            }
        });

        filterSelect?.addEventListener('change', () => {
            lastWordSent = '';
            selectedIndex = -1;
            if (textbox.value.trim()) {
                textbox.dispatchEvent(new Event('input', { bubbles: true }));
            } else {
                suggestionBox.style.display = 'none';
            }
        });

        document.addEventListener('click', (e) => {
            if (!suggestionBox.contains(e.target) && e.target !== textbox) {
                suggestionBox.style.display = 'none';
            }
        });

        document.addEventListener('scroll', debounce(() => {
            if (suggestionBox.style.display !== 'none') {
                updateSuggestionBoxPosition();
            }
        }, 100), true);

        function updateSelection(items) {
            for (const [idx, item] of items.entries()) {
                item.classList.toggle('selected', idx === selectedIndex);
            }
            if (selectedIndex >= 0) items[selectedIndex].scrollIntoView({ block: 'nearest' });
            textbox.focus();
        }

        function applySuggestion(promptText) {
            const promptMatch = promptText.match(/<b>(.*?)<\/b>/);
            let formattedText = '';
        
            if (promptMatch) {
                formattedText = formatSuggestion(promptMatch[1]);
            } 
            // :3 or 3:
            else if (promptText.startsWith(':') || promptText.endsWith(':')) {
                formattedText = promptText.trim();
            } 
            // 1:1, 4:3, 16:9 ....
            else if (/^\d+:\d+$/.test(promptText.trim())) {
                formattedText = promptText.trim();
            } 
            // Other cases
            else {
                formattedText = formatSuggestion(promptText.replace(':', ' '));
            }

        
            const value = textbox.value;
            const cursorPosition = textbox.selectionStart;
        
            const beforeCursor = value.slice(0, cursorPosition);
            const afterCursor = value.slice(cursorPosition);
            const lastSeparatorBefore = Math.max(beforeCursor.lastIndexOf(','), beforeCursor.lastIndexOf('\n'));
            const firstCommaAfter = afterCursor.indexOf(',');
            const firstNewlineAfter = afterCursor.indexOf('\n');
            const start = lastSeparatorBefore >= 0 ? lastSeparatorBefore + 1 : 0;
            let end = cursorPosition;
            let suffix = ', ';
        
            if (firstNewlineAfter === 0) {
                end = cursorPosition;
                suffix = ',';
            } else if (firstCommaAfter >= 0 || firstNewlineAfter >= 0) {
                end = firstCommaAfter >= 0 && (firstNewlineAfter < 0 || firstCommaAfter < firstNewlineAfter)
                    ? cursorPosition + firstCommaAfter
                    : (() => {
                        if (firstNewlineAfter >= 0) {
                            return cursorPosition + firstNewlineAfter;
                        }
                        return value.length;
                    })();
                if (firstCommaAfter >= 0) {
                    suffix = '';
                } else if (firstNewlineAfter >= 0) {
                    suffix = ',';
                }
            }
        
            const isFirstWordInLine = start === 0 || value[start - 1] === '\n';
            const prefix = isFirstWordInLine ? '' : ' ';
            const newValue = value.slice(0, start) + prefix + formattedText + suffix + value.slice(end);
            textbox.value = newValue.trim();
        
            const newCursorPosition = start + prefix.length + formattedText.length + (suffix.startsWith(',') ? 1 : 0);
            textbox.setSelectionRange(newCursorPosition, newCursorPosition);
        
            currentSuggestions = [];
            suggestionBox.innerHTML = '';
            suggestionBox.style.display = 'none';
        
            const inputEvent = new Event('input', { bubbles: true });
            skipSuggestion = true;
            textbox.dispatchEvent(inputEvent);
            textbox.focus();
        }

        // Off-screen mirror of the textarea used to locate the caret. Created
        // lazily and reused: one node per textbox, one layout per measurement.
        let caretMirror = null;
        let caretMarker = null;

        function getCaretMirror() {
            if (caretMirror) return caretMirror;
            caretMirror = document.createElement('div');
            caretMirror.setAttribute('aria-hidden', 'true');
            const style = caretMirror.style;
            style.position = 'absolute';
            style.top = '0';
            style.left = '-9999px';
            style.visibility = 'hidden';
            style.pointerEvents = 'none';
            style.overflow = 'hidden';
            style.boxSizing = 'border-box';
            style.whiteSpace = 'pre-wrap';
            caretMarker = document.createElement('span');
            caretMarker.textContent = '\u200b';
            document.body.appendChild(caretMirror);
            return caretMirror;
        }

        // Horizontal offset (px) of the caret from the start of its visual line,
        // measured from the mirror: the text before the caret followed by a
        // zero-width marker, read once via the marker's offsetLeft.
        function measureCaretOffset(width) {
            const cursorPosition = Math.min(textbox.selectionStart, textbox.value.length);
            const textBeforeCursor = textbox.value.substring(0, cursorPosition);

            const mirror = getCaretMirror();
            const computed = globalThis.getComputedStyle(textbox);
            const style = mirror.style;
            style.font = computed.font;
            style.letterSpacing = computed.letterSpacing;
            style.tabSize = computed.tabSize;
            style.wordWrap = computed.wordWrap;
            style.overflowWrap = computed.overflowWrap;
            style.wordBreak = computed.wordBreak;
            style.paddingTop = computed.paddingTop;
            style.paddingRight = computed.paddingRight;
            style.paddingBottom = computed.paddingBottom;
            style.paddingLeft = computed.paddingLeft;
            // The mirror has no scrollbar (overflow hidden), the textarea does once it scrolls:
            // wrap at the textarea's clientWidth (padding box without the scrollbar) with no
            // border, so both break lines at the same width.
            style.borderWidth = '0';
            style.width = `${textbox.clientWidth > 0 ? textbox.clientWidth : width}px`;

            mirror.textContent = textBeforeCursor;
            mirror.appendChild(caretMarker);

            // offsetLeft is relative to the mirror's padding edge; strip the
            // padding so the value is the width of the caret line's text.
            const paddingLeft = Number.parseFloat(computed.paddingLeft) || 0;
            return Math.max(0, caretMarker.offsetLeft - paddingLeft);
        }

        function updateSuggestionBoxPosition() {
            const rect = textbox.getBoundingClientRect();
            const textboxTop = rect.top + globalThis.scrollY;
            const textboxBottom = rect.bottom + globalThis.scrollY;
            const textboxLeft = rect.left + globalThis.scrollX;

            // A textarea that has not been laid out yet has no width to wrap
            // against; place the box at its left edge instead of measuring.
            const wrapWidth = rect.width || textboxWidth;
            const cursorOffset = wrapWidth > 0 ? measureCaretOffset(wrapWidth) : 0;

            suggestionBox.style.display = 'block';
            const suggestionWidth = suggestionBox.offsetWidth || 200;
            const suggestionHeight = suggestionBox.offsetHeight || 100;
            if (!suggestionBox.innerHTML) suggestionBox.style.display = 'none';

            let newLeft = textboxLeft + cursorOffset;
            let newTop = textboxBottom;
            const windowWidth = globalThis.innerWidth;
            const windowHeight = globalThis.innerHeight;
            const paddingX = 24;
            const paddingY = 12;

            if (newLeft + suggestionWidth > windowWidth - paddingX) {
                newLeft = Math.max(0, windowWidth - suggestionWidth - paddingX);
            }
            if (newLeft < textboxLeft) newLeft = textboxLeft;

            if (newTop + suggestionHeight > windowHeight + globalThis.scrollY - paddingY) {
                newTop = textboxTop - suggestionHeight - paddingY;
                if (newTop < globalThis.scrollY) newTop = textboxBottom;
            }

            suggestionBox.style.left = `${newLeft}px`;
            suggestionBox.style.top = `${newTop}px`;
            suggestionBox.style.zIndex = '10002';
            suggestionBox.style.transform = 'translateZ(0)';
        }

        textbox.dataset.suggestionSetup = 'true';
    }
}
