// The LoRA card's LoRAs ride on the positive prompt as its last line of <lora:…> tags
// (generate.js getLoRAs). A Same run keeps the last prompt but takes the LoRA card as it
// is now: the last run's line comes off and the current one goes on. Kept with the old
// line, a LoRA added since was not loaded, one switched off still was, and a new weight
// never reached the run. Pure, no I/O.

const LAST_LINE_OF_LORAS = /\n(?:<lora:[^>]*>)+\s*$/;

/** The prompt with the slots' LoRA line after it ('' adds none). */
export function withSlotLoras(prompt, lora) {
    const line = String(lora ?? '');
    return line ? `${prompt ?? ''}\n${line}` : String(prompt ?? '');
}

/**
 * The last run's positive prompt with its LoRA line (`previous`, as withSlotLoras added
 * it) swapped for `lora`. Without `previous` (a prompt kept from before it was recorded),
 * a last line of LoRA tags alone is taken for it.
 */
export function swapSlotLoras(positive, previous, lora) {
    const text = String(positive ?? '');
    const old = String(previous ?? '');
    let prompt;
    if (old && text.endsWith(`\n${old}`)) prompt = text.slice(0, text.length - old.length - 1);
    else if (old && text === old) prompt = '';
    else prompt = text.replace(LAST_LINE_OF_LORAS, '');
    return withSlotLoras(prompt, lora);
}
