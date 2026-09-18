// A small CSS reader for the stylesheet tests. Matching the text of a rule with a
// `[^}]*` chain breaks as soon as two declarations swap places and passes on the wrong
// value; these helpers hand a test the rules of a stylesheet, so it can ask for one
// property by name and compare the value it actually has.

function parseDeclarations(block) {
    const declarations = new Map();
    let depth = 0;
    let quote = '';
    let current = '';
    const flush = () => {
        const text = current.trim();
        current = '';
        const colon = text.indexOf(':');
        if (colon < 0) return;
        declarations.set(text.slice(0, colon).trim().toLowerCase(), text.slice(colon + 1).trim());
    };
    for (const char of block) {
        if (quote) {
            current += char;
            if (char === quote) quote = '';
            continue;
        }
        if (char === '"' || char === "'") { quote = char; current += char; continue; }
        if (char === '(') depth += 1;
        if (char === ')') depth -= 1;
        if (char === ';' && depth === 0) { flush(); continue; }
        current += char;
    }
    flush();
    return declarations;
}

// [{ selectors: ['#left', '#right'], declarations: Map, at: '@media (max-width: 900px)' | null }]
export function parseStylesheet(text) {
    const source = String(text).replaceAll(/\/\*[\s\S]*?\*\//g, '');
    const rules = [];
    const readBlock = (body, at) => {
        let index = 0;
        let prelude = '';
        while (index < body.length) {
            const char = body[index];
            if (char === '{') {
                const start = index + 1;
                let depth = 1;
                index += 1;
                while (index < body.length && depth > 0) {
                    if (body[index] === '{') depth += 1;
                    else if (body[index] === '}') depth -= 1;
                    index += 1;
                }
                const block = body.slice(start, index - 1);
                const head = prelude.trim();
                prelude = '';
                if (head.startsWith('@')) {
                    // a conditional group carries rules of its own; anything else (@font-face,
                    // @keyframes) is not a rule a test asks about
                    if (/^@(media|supports|layer|container|scope)\b/.test(head)) readBlock(block, at ? `${at} ${head}` : head);
                } else if (head) {
                    rules.push({ selectors: head.split(',').map(part => part.trim()).filter(Boolean), declarations: parseDeclarations(block), at: at ?? null });
                }
                continue;
            }
            if (char === '}' || (char === ';' && prelude.trim().startsWith('@'))) { prelude = ''; index += 1; continue; }
            prelude += char;
            index += 1;
        }
    };
    readBlock(source, null);
    return rules;
}

// Every declaration that reaches `selector`, later rules winning, as the cascade does for
// rules of equal specificity.
export function declarationsFor(rules, selector, { at = null } = {}) {
    const merged = new Map();
    for (const rule of rules) {
        if (rule.at !== at || !rule.selectors.includes(selector)) continue;
        for (const [name, value] of rule.declarations) merged.set(name, value);
    }
    return merged;
}

export function hasSelector(rules, selector) {
    return rules.some(rule => rule.selectors.includes(selector));
}

// Flat view for "no rule anywhere says this", where the selector does not matter.
export function allDeclarations(rules) {
    return rules.flatMap(rule => [...rule.declarations].map(([name, value]) => ({ selectors: rule.selectors, at: rule.at, name, value })));
}
