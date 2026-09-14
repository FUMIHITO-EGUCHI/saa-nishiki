// Which region a Characters slot is drawn in while Regional Condition is on
// (pure, shared by the renderer and tests).
//
// A slot carries `side: 'left' | 'right'`; a slot without a side (the "·" column)
// stays out of both regions. The regional generator draws one character per
// region, so at most one slot holds each side: choosing L on a slot takes L away
// from the slot that had it. The side ids follow regionalSides.js (left = the
// first region, left or top; right = the second).

export const SLOT_SIDES = Object.freeze(['left', 'right', 'both']);

export function slotSide(slot) {
    return slot?.side === 'left' || slot?.side === 'right' ? slot.side : 'both';
}

function isNone(key) {
    return typeof key !== 'string' || key.trim() === '' || key.trim().toLowerCase() === 'none';
}

// The slot each region draws: { left: { index, key, weight } | null, right: ... }.
export function regionalSlots(slots = []) {
    const result = { left: null, right: null };
    (Array.isArray(slots) ? slots : []).forEach((slot, index) => {
        const side = slotSide(slot);
        if (side === 'both' || result[side]) return;
        const weight = Number.parseFloat(slot.weight);
        result[side] = { index, key: slot.key ?? 'None', weight: Number.isFinite(weight) ? weight : 1 };
    });
    return result;
}

// A copy of `slots` with slot `index` on `side` ('both' clears it); the same side is
// taken away from every other slot.
export function assignSlotSide(slots = [], index, side) {
    const next = side === 'left' || side === 'right' ? side : 'both';
    return (Array.isArray(slots) ? slots : []).map((slot, position) => {
        const copy = { ...slot };
        if (position === index) {
            if (next === 'both') delete copy.side; else copy.side = next;
        } else if (next !== 'both' && slotSide(slot) === next) {
            delete copy.side;
        }
        return copy;
    });
}

// Left ↔ right on every slot (the Swap button).
export function swapSlotSides(slots = []) {
    return (Array.isArray(slots) ? slots : []).map(slot => {
        const side = slotSide(slot);
        if (side === 'both') return { ...slot };
        return { ...slot, side: side === 'left' ? 'right' : 'left' };
    });
}

// Settings written before the side column kept the regional characters in
// `character_left` / `character_right`. When no slot carries a side, the slot with
// that key takes it; a character that is not among the slots becomes a new slot
// (up to `maxSlots`). Slots that already carry a side are returned as they are.
export function migrateSlotSides(slots = [], left = 'None', right = 'None', { maxSlots = 6, weights = [1, 1] } = {}) {
    const list = (Array.isArray(slots) ? slots : []).map(slot => ({ ...slot }));
    if (list.some(slot => slotSide(slot) !== 'both')) return list;
    [['left', left, weights[0]], ['right', right, weights[1]]].forEach(([side, key, weight]) => {
        if (isNone(key)) return;
        const existing = list.find(slot => slot.key === key && slotSide(slot) === 'both');
        if (existing) { existing.side = side; return; }
        const parsed = Number.parseFloat(weight);
        if (list.length < maxSlots) list.push({ key, weight: Number.isFinite(parsed) ? parsed : 1, side });
    });
    return list;
}

// The column's short labels for the current split: L / R / · or T / B / ·.
export function slotSideLabels(split) {
    const topBottom = split === 'top-bottom';
    return { left: topBottom ? 'T' : 'L', right: topBottom ? 'B' : 'R', both: '·' };
}
