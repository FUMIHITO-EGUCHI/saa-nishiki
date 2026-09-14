// Negative prompts are assembled from ordered units, exactly like the positive chain:
// the built-in Negative field, the custom negative fields, and - while Regional
// Condition is on - the per-side Negative (left / right). Each side's character
// negatives come last. Generation and AI Refine's recomposition both go through here
// so the same units always produce the same text.

const clean = value => String(value ?? '').trim();

export function joinNegativeParts(parts) {
    return parts.map(clean).filter(Boolean).join(', ').trim();
}

function unitTexts(chain, texts) {
    return (Array.isArray(chain) ? chain : []).map(id => clean(texts?.[id])).filter(Boolean);
}

export function composeNegativeChain({ chain = [], texts = {}, characterNegative = '' } = {}) {
    return joinNegativeParts([...unitTexts(chain, texts), characterNegative]);
}

// A "both" unit is written into the left and the right prompt, so a side unit repeating
// it is dropped from that side. `merged` is the single negative for backends without
// regional negatives (Forge Neo).
export function composeRegionalNegatives({ chains = {}, texts = {}, characterLeft = '', characterRight = '' } = {}) {
    const both = unitTexts(chains.both, texts);
    const sideOnly = side => unitTexts(chains[side], texts).filter(part => !both.includes(part));
    const left = sideOnly('left');
    const right = sideOnly('right');
    return {
        left: joinNegativeParts([...both, ...left, characterLeft]),
        right: joinNegativeParts([...both, ...right, characterRight]),
        merged: joinNegativeParts([...both, ...left, ...right, characterLeft, characterRight]),
    };
}
