// @ts-check

/**
 * SillyTavern World Info facts this adapter relies on, pinned to the release it
 * was verified against. Values are copied from SillyTavern source for
 * interoperability; see docs/compatibility/sillytavern-1.19.0.md for the map.
 */

export const ST_BASELINE = Object.freeze({
    version: '1.19.0',
    commit: '7e8663cd9c184a550b37238218bdd32c6efc68e9',
});

/** public/scripts/world-info.js `world_info_position` */
export const WORLD_INFO_POSITION = Object.freeze({
    before: 0,
    after: 1,
    ANTop: 2,
    ANBottom: 3,
    atDepth: 4,
    EMTop: 5,
    EMBottom: 6,
    outlet: 7,
});

/** public/scripts/world-info.js `world_info_logic` (selectiveLogic) */
export const WORLD_INFO_LOGIC = Object.freeze({
    AND_ANY: 0,
    NOT_ALL: 1,
    NOT_ANY: 2,
    AND_ALL: 3,
});

/** public/script.js `extension_prompt_roles` (role) */
export const EXTENSION_PROMPT_ROLES = Object.freeze({
    SYSTEM: 0,
    USER: 1,
    ASSISTANT: 2,
});

/** public/scripts/constants.js `GENERATION_TYPE_TRIGGERS` (triggers) */
export const GENERATION_TYPE_TRIGGERS = Object.freeze(['normal', 'continue', 'impersonate', 'swipe', 'regenerate', 'quiet']);

/** public/scripts/world-info.js `DEFAULT_DEPTH`, `DEFAULT_WEIGHT` */
export const DEFAULT_DEPTH = 4;
export const DEFAULT_WEIGHT = 100;

/** `getFreeWorldEntryUid` searches uids below this bound. */
export const MAX_UID = 1_000_000;

/** Book key that binds a book to a chat: `chat_metadata[METADATA_KEY]`. */
export const CHAT_METADATA_KEY = 'world_info';

/**
 * `newWorldInfoEntryDefinition` (world-info.js:4082-4125). `template: false`
 * marks the three virtual slash-command fields excluded from the template.
 * @type {Readonly<Record<string, { default: unknown, type: string, template?: false }>>}
 */
export const ENTRY_FIELD_DEFINITION = Object.freeze({
    key: { default: [], type: 'array' },
    keysecondary: { default: [], type: 'array' },
    comment: { default: '', type: 'string' },
    content: { default: '', type: 'string' },
    constant: { default: false, type: 'boolean' },
    vectorized: { default: false, type: 'boolean' },
    selective: { default: true, type: 'boolean' },
    selectiveLogic: { default: WORLD_INFO_LOGIC.AND_ANY, type: 'enum' },
    addMemo: { default: false, type: 'boolean' },
    order: { default: 100, type: 'number' },
    position: { default: 0, type: 'number' },
    disable: { default: false, type: 'boolean' },
    ignoreBudget: { default: false, type: 'boolean' },
    excludeRecursion: { default: false, type: 'boolean' },
    preventRecursion: { default: false, type: 'boolean' },
    matchPersonaDescription: { default: false, type: 'boolean' },
    matchCharacterDescription: { default: false, type: 'boolean' },
    matchCharacterPersonality: { default: false, type: 'boolean' },
    matchCharacterDepthPrompt: { default: false, type: 'boolean' },
    matchScenario: { default: false, type: 'boolean' },
    matchCreatorNotes: { default: false, type: 'boolean' },
    delayUntilRecursion: { default: 0, type: 'number' },
    probability: { default: 100, type: 'number' },
    useProbability: { default: true, type: 'boolean' },
    depth: { default: DEFAULT_DEPTH, type: 'number' },
    outletName: { default: '', type: 'string' },
    group: { default: '', type: 'string' },
    groupOverride: { default: false, type: 'boolean' },
    groupWeight: { default: DEFAULT_WEIGHT, type: 'number' },
    scanDepth: { default: null, type: 'number?' },
    caseSensitive: { default: null, type: 'boolean?' },
    matchWholeWords: { default: null, type: 'boolean?' },
    useGroupScoring: { default: null, type: 'boolean?' },
    automationId: { default: '', type: 'string' },
    role: { default: 0, type: 'enum' },
    sticky: { default: null, type: 'number?' },
    cooldown: { default: null, type: 'number?' },
    delay: { default: null, type: 'number?' },
    characterFilterNames: { default: [], type: 'array', template: false },
    characterFilterTags: { default: [], type: 'array', template: false },
    characterFilterExclude: { default: false, type: 'boolean', template: false },
    triggers: { default: [], type: 'array' },
});

/**
 * `newWorldInfoEntryTemplate`: what `createWorldInfoEntry` spreads after `uid`.
 * @returns {Record<string, unknown>} A fresh copy.
 */
export function newEntryTemplate() {
    /** @type {Record<string, unknown>} */
    const template = {};
    for (const [key, field] of Object.entries(ENTRY_FIELD_DEFINITION)) {
        if (field.template !== false) {
            template[key] = structuredClone(field.default);
        }
    }
    return template;
}

/**
 * Fields stored on entries that are not part of the definition.
 * `characterFilter` is created by the editor, `displayIndex` by the editor's
 * custom sort, `extensions` by character-card import, `extra` by Tavern Helper.
 */
export const STORED_FIELDS_OUTSIDE_DEFINITION = Object.freeze(['uid', 'displayIndex', 'characterFilter', 'extensions', 'extra']);

/** Slash-command aliases that are never stored on entries. */
const VIRTUAL_FIELDS = new Set(['characterFilterNames', 'characterFilterTags', 'characterFilterExclude']);

/** public/script.js `MAX_INJECTION_DEPTH`: @D entries are injected only at integer depths 0..10000. */
export const MAX_INJECTION_DEPTH = 10000;
/** public/scripts/world-info.js `MAX_SCAN_DEPTH`. */
export const MAX_SCAN_DEPTH = 1000;

/**
 * Checks the value a top-level field will have after a write (`undefined` when the
 * write removes it). Known SillyTavern fields must have a type and range ST 1.19.0
 * can use without rewriting or ignoring the entry; unknown fields are never
 * checked, so data this project does not understand is not rejected.
 * @param {string[]} path `[field]`
 * @param {unknown} value
 * @returns {string | null} Problem description, or null when acceptable.
 */
export function validateEntryField(path, value) {
    const [field] = path;
    if (VIRTUAL_FIELDS.has(field)) {
        return `"${field}" is a slash-command alias, not a stored field; patch "characterFilter" instead.`;
    }
    if (value === undefined) {
        return field in ENTRY_FIELD_DEFINITION
            ? `"${field}" is read by SillyTavern without a fallback; set a value instead of removing it.`
            : null;
    }
    const integerIn = (/** @type {number} */ min, /** @type {number} */ max) => Number.isInteger(value) && /** @type {number} */ (value) >= min && /** @type {number} */ (value) <= max;
    switch (field) {
        case 'characterFilter':
            if (!isPlainObject(value)
                || typeof value.isExclude !== 'boolean'
                || !isStringArray(value.names)
                || !isStringArray(value.tags)) {
                return '"characterFilter" must be { isExclude: boolean, names: string[], tags: string[] }.';
            }
            return null;
        case 'delayUntilRecursion':
            // false/true or a recursion level (world-info.js:3780-3801).
            return typeof value === 'boolean' || (isFiniteNumber(value) && value >= 0) ? null : '"delayUntilRecursion" must be a boolean or a level number >= 0.';
        case 'displayIndex':
            return isFiniteNumber(value) ? null : '"displayIndex" must be a number.';
        case 'position':
            return Object.values(WORLD_INFO_POSITION).includes(/** @type {number} */ (value)) ? null : '"position" must be one of 0-7.';
        case 'depth':
            return integerIn(0, MAX_INJECTION_DEPTH) ? null : `"depth" must be an integer 0-${MAX_INJECTION_DEPTH}.`;
        case 'scanDepth':
            return value === null || integerIn(0, MAX_SCAN_DEPTH) ? null : `"scanDepth" must be null or an integer 0-${MAX_SCAN_DEPTH}.`;
        case 'probability':
            return isFiniteNumber(value) && value >= 0 && value <= 100 ? null : '"probability" must be a number 0-100.';
        case 'groupWeight':
            return isFiniteNumber(value) && value >= 1 && value <= 10000 ? null : '"groupWeight" must be a number 1-10000.';
        case 'sticky':
        case 'cooldown':
        case 'delay':
            return value === null || integerIn(0, Number.MAX_SAFE_INTEGER) ? null : `"${field}" must be null or an integer >= 0.`;
        default:
            break;
    }
    const definition = ENTRY_FIELD_DEFINITION[field];
    if (!definition) {
        return null;
    }
    switch (definition.type) {
        case 'string':
            return typeof value === 'string' ? null : `"${field}" must be a string.`;
        case 'boolean':
            return typeof value === 'boolean' ? null : `"${field}" must be a boolean.`;
        case 'boolean?':
            return value === null || typeof value === 'boolean' ? null : `"${field}" must be a boolean or null.`;
        case 'number':
            return isFiniteNumber(value) ? null : `"${field}" must be a finite number.`;
        case 'number?':
            return value === null || isFiniteNumber(value) ? null : `"${field}" must be a finite number or null.`;
        case 'enum':
            if (field === 'role') {
                return value === null || Object.values(EXTENSION_PROMPT_ROLES).includes(/** @type {number} */ (value)) ? null : '"role" must be 0, 1, 2 or null.';
            }
            if (field === 'selectiveLogic') {
                return Object.values(WORLD_INFO_LOGIC).includes(/** @type {number} */ (value)) ? null : '"selectiveLogic" must be 0, 1, 2 or 3.';
            }
            return isFiniteNumber(value) ? null : `"${field}" must be a number.`;
        case 'array':
            if (!Array.isArray(value)) return `"${field}" must be an array.`;
            if ((field === 'key' || field === 'keysecondary') && !value.every((item) => typeof item === 'string')) {
                return `"${field}" must contain strings only (regex keys are stored as "/pattern/flags" strings).`;
            }
            if (field === 'triggers' && !value.every((item) => GENERATION_TYPE_TRIGGERS.includes(item))) {
                return `"triggers" accepts only: ${GENERATION_TYPE_TRIGGERS.join(', ')}.`;
            }
            return null;
        default:
            return null;
    }
}

/**
 * @param {unknown} value
 */
function isStringArray(value) {
    return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

const EMPTY_CHARACTER_FILTER = Object.freeze({ isExclude: false, names: [], tags: [] });
const BOOLEAN_CHECKBOX_FIELDS = new Set([
    'groupOverride', 'ignoreBudget', 'excludeRecursion', 'preventRecursion',
    'matchPersonaDescription', 'matchCharacterDescription', 'matchCharacterPersonality',
    'matchCharacterDepthPrompt', 'matchScenario', 'matchCreatorNotes',
]);
const TRI_STATE_FIELDS = new Set(['caseSensitive', 'matchWholeWords', 'useGroupScoring']);
const FORCED_TRUE_FIELDS = new Set(['addMemo', 'selective', 'useProbability']);
const NUMBER_OR_ZERO_FIELDS = new Set(['depth', 'sticky', 'cooldown', 'delay']);
const EMPTY_STRING_FIELDS = new Set(['outletName', 'automationId']);

/**
 * True when a change to one top-level field is something SillyTavern 1.19.0's
 * World Info editor does by itself when it displays a book (and persists on its
 * next save), rather than a deliberate edit. Used to keep such rewrites from
 * being reported as conflicts or as unsaved changes.
 *
 * Covered rewrites (public/scripts/world-info.js):
 * - template backfill, non-array keys → [], missing characterFilter (2104-2136); displayIndex ??= uid (2365)
 * - header render: comment \r stripped, order/probability/depth Number()-ed (null → 0), probability
 *   clamped 0..100, role null for non-@D and 0 for @D with null role, strict constant/vectorized (3371-3452, 3173-3190, 3255-3316)
 * - entry drawer: addMemo/selective/useProbability forced true, checkbox fields !!-ed, tri-state
 *   selects, groupWeight null → 1 clamped 1..10000, scanDepth normalized, group trimmed, unknown
 *   triggers dropped, characterFilter emptied/pruned, delayUntilRecursion normalized (3555-3868)
 *
 * @param {string} field Top-level field name.
 * @param {unknown} before Value before (undefined when absent).
 * @param {unknown} after Value after (undefined when absent).
 * @param {{ hadBefore: boolean, hasAfter: boolean, entryAfter: Record<string, any>, knownCharacters?: Set<string> }} context
 *   knownCharacters: installed characters' avatar file names without extension; without it,
 *   a shorter characterFilter.names list always counts as an edit.
 * @returns {boolean}
 */
export function isHostNormalization(field, before, after, { hadBefore, hasAfter, entryAfter, knownCharacters }) {
    const template = newEntryTemplate();

    if (!hadBefore && hasAfter) {
        // Backfilled from the template, possibly rewritten again when the entry was rendered.
        if (field in template) {
            return jsonEquals(after, template[field])
                || isHostNormalization(field, template[field], after, { hadBefore: true, hasAfter: true, entryAfter, knownCharacters });
        }
        if (field === 'displayIndex') return after === entryAfter.uid;
        if (field === 'characterFilter') return jsonEquals(after, EMPTY_CHARACTER_FILTER);
        return false;
    }
    if (hadBefore && !hasAfter) {
        // The drawer deletes a characterFilter that excludes nothing and lists nothing.
        return field === 'characterFilter' && isRecord(before) && !before.isExclude
            && isEmptyArray(before.names) && isEmptyArray(before.tags);
    }
    if (!hadBefore || !hasAfter) return false;

    switch (field) {
        case 'comment':
        case 'content':
            return typeof before === 'string' && after === before.replace(/\r/g, '');
        case 'order': {
            const n = inputNumber(before);
            return after === (Number.isNaN(n) ? 0 : n);
        }
        case 'probability': {
            const n = inputNumber(before);
            return after === (Number.isNaN(n) ? null : Math.min(100, Math.max(0, n)));
        }
        case 'groupWeight': {
            const n = inputNumber(before ?? 1);
            return after === (Number.isNaN(n) ? null : Math.min(10000, Math.max(1, n)));
        }
        case 'scanDepth': {
            if (before === null || before === '') return after === null;
            const n = Number(before);
            if (Number.isNaN(n)) return after === null;
            return after === (n < 0 ? 0 : n > 1000 ? 1000 : Math.floor(n));
        }
        case 'position':
            return typeof before === 'string' && after === Number(before);
        case 'role': {
            const position = entryAfter.position;
            if (!Object.values(WORLD_INFO_POSITION).includes(position)) return false;
            if (position === WORLD_INFO_POSITION.atDepth) return after === Number(before ?? EXTENSION_PROMPT_ROLES.SYSTEM);
            return after === null;
        }
        case 'constant':
            return after === (before === true);
        case 'vectorized':
            // Tri-state: constant wins; only a strict `true` survives as vectorized.
            return after === (entryAfter.constant !== true && before === true);
        case 'selectiveLogic':
            return typeof before === 'string' && after === Number(before) && Object.values(WORLD_INFO_LOGIC).includes(after);
        case 'group':
            return after === String(before ?? '').trim();
        case 'key':
        case 'keysecondary':
            return !Array.isArray(before) && jsonEquals(after, []);
        case 'triggers':
            return Array.isArray(after) && Array.isArray(before)
                && after.every((t) => before.includes(t) && GENERATION_TYPE_TRIGGERS.includes(t))
                && before.filter((t) => GENERATION_TYPE_TRIGGERS.includes(t)).length === after.length;
        case 'characterFilter': {
            if (!isRecord(before)) return jsonEquals(after, EMPTY_CHARACTER_FILTER);
            if (!isRecord(after) || after.isExclude !== (before.isExclude ?? false) || !jsonEquals(after.tags, before.tags)) return false;
            if (!Array.isArray(after.names) || !Array.isArray(before.names)) return false;
            // The drawer drops only names of characters that are not installed (3650-3656).
            const removed = before.names.filter((name) => !after.names.includes(name));
            return after.names.every((name) => before.names.includes(name))
                && knownCharacters !== undefined
                && removed.every((name) => !knownCharacters.has(name));
        }
        case 'delayUntilRecursion': {
            // Checkbox handler, then level input reading the value the first step wrote (3780-3801).
            if (!before) return after === false;
            if (typeof before === 'number') return after === before;
            if (typeof before === 'string') return after === (Number.isNaN(Number(before)) ? false : Number(before));
            return after === true;
        }
        default:
            break;
    }
    if (FORCED_TRUE_FIELDS.has(field)) return after === true;
    if (BOOLEAN_CHECKBOX_FIELDS.has(field)) return after === Boolean(before);
    if (TRI_STATE_FIELDS.has(field)) return after === (before === null || before === undefined ? null : Boolean(before));
    if (NUMBER_OR_ZERO_FIELDS.has(field)) {
        const n = inputNumber(before);
        return after === (Number.isNaN(n) ? null : n);
    }
    if (EMPTY_STRING_FIELDS.has(field)) return (before === null) && after === '';
    return false;
}

/**
 * Number() of a value after it went through an <input>: null/undefined become ''.
 * @param {unknown} value
 */
function inputNumber(value) {
    return Number(value === null || value === undefined ? '' : value);
}

/**
 * @param {unknown} a
 * @param {unknown} b
 */
function jsonEquals(a, b) {
    return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * @param {unknown} value
 */
function isEmptyArray(value) {
    return Array.isArray(value) && value.length === 0;
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, any>}
 */
function isRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Strategy as the ST editor shows it. ST stores it as two booleans; `constant` wins
 * when both are true (world-info.js:3284-3316). `selective` is unrelated: it only
 * gates the optional filters.
 * @param {Record<string, any>} entry
 * @returns {'constant' | 'vectorized' | 'normal'}
 */
export function readStrategy(entry) {
    if (entry.constant === true) return 'constant';
    if (entry.vectorized === true) return 'vectorized';
    return 'normal';
}

/**
 * The two fields the ST editor writes when the strategy selector changes.
 * @param {'constant' | 'vectorized' | 'normal'} strategy
 * @returns {{ constant: boolean, vectorized: boolean }}
 */
export function strategyPatch(strategy) {
    switch (strategy) {
        case 'constant': return { constant: true, vectorized: false };
        case 'vectorized': return { constant: false, vectorized: true };
        case 'normal': return { constant: false, vectorized: false };
        default: throw new TypeError(`Unknown strategy "${String(strategy)}".`);
    }
}

/**
 * @param {unknown} value
 * @returns {value is number}
 */
function isFiniteNumber(value) {
    return typeof value === 'number' && Number.isFinite(value);
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isPlainObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}
