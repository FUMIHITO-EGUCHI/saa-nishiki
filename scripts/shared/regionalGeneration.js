// Regional Condition generation helpers (pure, shared by the renderer, the WebUI
// backend and tests): the prompt text each region is sent, and where the two
// regions lie in the image.

// A newline separates tags like a comma. A regional prompt goes out as one line
// (Forge Couple splits the regions on "\n"); dropping the newline used to glue
// "1girl\nsmile" into "1girlsmile" while the Final prompt preview showed
// "1girl, smile". Newlines at either end go away with the separators around them.
export function singleLinePrompt(text) {
    const value = String(text ?? '');
    if (!value.includes('\n')) return value;
    return value
        .replace(/^[\s,]*\n[\s,]*/, '')
        .replace(/[\s,]*\n[\s,]*$/, '')
        .replaceAll(/[\s,]*\n[\s,]*/g, ', ');
}

// A side's prompt is assembled without a trailing separator; an end-of-prompt
// JSON slot (EOP) follows it with one ("outdoors, red dress", not "outdoorsred dress").
export function appendPromptEnd(text, end) {
    const head = String(text ?? '');
    const tail = String(end ?? '');
    if (head === '' || tail === '') return `${head}${tail}`;
    // already separated: a trailing newline is a separator (singleLinePrompt), a trailing comma gets its space
    if (/\n\s*$/.test(head)) return `${head}${tail}`;
    if (/,\s*$/.test(head)) return `${head.trimEnd()} ${tail}`;
    return `${head}, ${tail}`;
}

// The `ratio` of the regional data from the Image Ratio (10-90: the first region's
// share) and Overlap Ratio (0-200) sliders.
//
// ComfyUI is the reference: Mira's CreateTillingPNGMask cuts Layout "a,b,c" into three
// strips in that proportion; the first region is strips a + b and the second b + c
// (b is the overlap, never 0). WebUI (Forge Couple) is sent the same two regions as
// fractions of the image: "where the first region ends,where the second starts"
// (see forgeCoupleMapping). It used to be sent (a+b)/2,(c-b)/2, which only matched at
// an Image Ratio of 50: at 30 no region covered the middle 30% of the image.
export function regionalRatio(imageRatio, overlapRatio, apiInterface) {
    const a = imageRatio / 50;
    const c = 2 - a;
    const b = overlapRatio / 100;
    const overlap = (b === 0) ? 0.01 : b;
    if (apiInterface === 'WebUI') {
        const total = a + overlap + c;
        return `${(a + overlap) / total},${a / total}`;
    }
    return `${a},${overlap},${c}`;
}

// Forge Couple Advanced-mode mapping rows [x1, x2, y1, y2, weight] for the regional
// data: the first region (the "left" prompt) is the left part, or the top part for a
// top-bottom split.
export function forgeCoupleMapping(regional = {}) {
    const [end, start] = String(regional.ratio ?? '').split(',').map(value => Number.parseFloat(value));
    const topBottom = regional.split === 'top-bottom';
    const region = (from, to, weight) => topBottom ? [0.0, 1.0, from, to, weight] : [from, to, 0.0, 1.0, weight];
    return [
        region(0.0, end, Number.parseFloat(regional.str_left)),
        region(start, 1.0, Number.parseFloat(regional.str_right)),
    ];
}

// The Forge Couple prompt: one line per region, first region first.
export function forgeCouplePrompt(positiveLeft, positiveRight) {
    return `${singleLinePrompt(positiveLeft).trim()}\n${singleLinePrompt(positiveRight).trim()}`;
}
