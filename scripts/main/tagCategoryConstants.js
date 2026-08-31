// Browser-safe constants shared by the renderer and the main-process loader.
// Keep Node-only file I/O in tagCategories.js so the renderer CSP can load this module.
// E621 uses its own group numbering; these IDs are intentionally centralized
// because the numbering is not a uniform offset after the added groups.
// Unmapped secondary groups remain available through All only by design.
export const E621_GROUP_IDS = Object.freeze({
    general: 7,
    artist: 8,
    work: 10,
    character: 11,
    species: 12,
    meta: 14,
    lore: 15,
});

const pairedGroups = (danbooru, e621) => Object.freeze([danbooru, e621]);

export const COARSE_GROUP_FILTERS = Object.freeze({
    all: null,
    general: pairedGroups(0, E621_GROUP_IDS.general),
    character: pairedGroups(4, E621_GROUP_IDS.character),
    work: pairedGroups(3, E621_GROUP_IDS.work),
    artist: pairedGroups(1, E621_GROUP_IDS.artist),
    species: Object.freeze([E621_GROUP_IDS.species]),
    meta: pairedGroups(5, E621_GROUP_IDS.meta),
    lore: Object.freeze([E621_GROUP_IDS.lore]),
});
