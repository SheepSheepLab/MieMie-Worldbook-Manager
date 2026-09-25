// @ts-check

/**
 * MieMie Worldbook Manager — worldbook data layer.
 *
 * core/      host-independent: patching, comparison, Order planning, errors, the port contract
 * adapters/  host-specific implementations of the port (SillyTavern)
 */

export { WorldbookError, WorldbookConflictError, WorldbookErrorCode, isWorldbookError } from './core/errors.js';
export { applyEntryPatch, normalizePatch, readPath, PROTECTED_FIELDS } from './core/entry-patch.js';
export { detectEntryConflict } from './core/entry-compare.js';
export { cloneDeep, canonicalJson, jsonEqual, diffPaths, fingerprint } from './core/json.js';
export {
    DEFAULT_ORDER,
    DEFAULT_ORDER_RANGE,
    NEW_ENTRY_UID,
    compareForDisplay,
    planOrderPlacement,
    readOrder,
    resolveTargetIndex,
    sortForDisplay,
    targetIndexFromNeighbours,
} from './core/order.js';
export { WorldbookHandle } from './core/worldbook-port.js';

export { createSillyTavernWorldbookAdapter } from './adapters/sillytavern/st-worldbook-adapter.js';
export { createStHost } from './adapters/sillytavern/st-host.js';
export {
    ST_BASELINE,
    WORLD_INFO_POSITION,
    WORLD_INFO_LOGIC,
    EXTENSION_PROMPT_ROLES,
    GENERATION_TYPE_TRIGGERS,
    ENTRY_FIELD_DEFINITION,
    newEntryTemplate,
    readStrategy,
    strategyPatch,
    validateEntryField,
} from './adapters/sillytavern/st-schema.js';
