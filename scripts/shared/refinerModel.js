// The refiner's checkpoint setting (api_refiner_model). Pure, no I/O.
//
// "Default", the setting's default and the first entry of the refiner list, is the run's
// own checkpoint: the refiner pass samples on with the base model, no second checkpoint.
// Until 2026-10-15 the list held only the model files, so a stored "Default" showed and
// ran whichever file came first, and a reload of the model lists put that first file
// back over any choice: a second checkpoint nobody chose. Next to the base one it does
// not fit a 12 GB card, and was read from disk again for every image (~5 GB, ~50 s from
// a hard disk).

export const REFINER_SAME_AS_BASE = 'Default';

/** The refiner list: "Default" first, then the model files. */
export function refinerModelOptions(models) {
    const files = (Array.isArray(models) ? models : []).filter(name => name && name !== REFINER_SAME_AS_BASE);
    return [REFINER_SAME_AS_BASE, ...files];
}

/** The checkpoint the refiner pass runs: the chosen file, or the base model for "Default". */
export function resolveRefinerModel(refinerModel, baseModel) {
    return !refinerModel || refinerModel === REFINER_SAME_AS_BASE ? baseModel : refinerModel;
}
