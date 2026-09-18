// The text a JSON slot contributes to the prompt (pure, shared by the standard
// and regional generators and their tests). A slot row is [prompt, strength,
// regional, method] (myJsonSlot.js getValue). An empty or missing prompt yields
// nothing: it used to yield ", " and leave a stray ", ," in the final prompt.

export function escapeJsonSlotPrompt(prompt) {
    return String(prompt ?? '')
        .replaceAll('\\', '\\\\')
        .replaceAll('(', String.raw`\(`)
        .replaceAll(')', String.raw`\)`)
        .replaceAll(':', ' ');
}

// "tag, " or "(tag:0.8), "; '' when the prompt is blank.
export function jsonSlotFragment(prompt, strength) {
    const escaped = escapeJsonSlotPrompt(prompt).trim();
    if (escaped === '') return '';
    const weight = Number.parseFloat(strength);
    if (!Number.isFinite(weight) || weight === 1) return `${escaped}, `;
    return `(${escaped}:${strength}), `;
}
