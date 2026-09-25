// @ts-check

import { WorldbookError, WorldbookErrorCode } from './errors.js';
import { cloneDeep, isPlainObject, jsonEqual, toJsonValue } from './json.js';

/**
 * A targeted change to one entry.
 *
 * - Plain object form: `{ content: 'new text' }` sets top-level fields.
 * - Operation list form: `[{ path: ['characterFilter', 'names'], value: ['Alice'] }, { op: 'unset', path: 'automationId' }]`.
 *   A string path is always one top-level key (dots are not split, so unknown keys containing dots stay addressable).
 *
 * @typedef {Record<string, unknown> | EntryPatchOp[]} EntryPatch
 */

/**
 * @typedef {object} EntryPatchOp
 * @property {'set' | 'unset'} [op] Defaults to 'set'.
 * @property {string | Array<string | number>} path
 * @property {unknown} [value]
 */

/**
 * @typedef {object} NormalizedOp
 * @property {'set' | 'unset'} op
 * @property {string[]} path
 * @property {unknown} [value]
 */

/**
 * Optional check supplied by a host adapter (for example SillyTavern field types).
 * Called once per changed top-level field with the field's value after the whole
 * patch (`undefined` when the patch removed it), so nested writes are checked like
 * whole-field writes. Returns an error message or null.
 * @typedef {(path: string[], value: unknown) => string | null} FieldValidator
 */

const FORBIDDEN_SEGMENTS = new Set(['__proto__', 'prototype', 'constructor']);
const CANONICAL_INDEX = /^(0|[1-9]\d*)$/;

/** Fields that identify an entry and must never change through a patch. */
export const PROTECTED_FIELDS = Object.freeze(['uid']);

/**
 * @param {EntryPatch} patch
 * @returns {NormalizedOp[]}
 */
export function normalizePatch(patch) {
    /** @type {EntryPatchOp[]} */
    let ops;
    if (Array.isArray(patch)) {
        ops = patch;
    } else if (isPlainObject(patch)) {
        ops = Object.keys(patch).map((key) => ({ op: 'set', path: key, value: patch[key] }));
    } else {
        throw invalid('Patch must be a plain object or an array of operations.');
    }

    if (ops.length === 0) {
        throw invalid('Patch is empty.');
    }

    return ops.map((raw, index) => {
        if (!isPlainObject(raw)) {
            throw invalid(`Patch operation #${index} must be an object.`);
        }
        const op = raw.op ?? 'set';
        if (op !== 'set' && op !== 'unset') {
            throw invalid(`Patch operation #${index} has unknown op "${String(op)}".`);
        }
        const path = normalizePath(raw.path, index);
        if (PROTECTED_FIELDS.includes(path[0])) {
            throw invalid(`Field "${path[0]}" identifies the entry and cannot be patched.`, { path });
        }
        if (op === 'set') {
            if (!('value' in raw) || raw.value === undefined) {
                throw invalid(`Patch operation #${index} sets "${path.join('.')}" to undefined; use op "unset" to remove a field.`, { path });
            }
            return { op, path, value: raw.value };
        }
        return { op, path };
    });
}

/**
 * @param {unknown} path
 * @param {number} index
 * @returns {string[]}
 */
function normalizePath(path, index) {
    /** @type {Array<string | number>} */
    let segments;
    if (typeof path === 'string') {
        segments = [path];
    } else if (Array.isArray(path)) {
        segments = path;
    } else {
        throw invalid(`Patch operation #${index} needs a string or array path.`);
    }
    if (segments.length === 0) {
        throw invalid(`Patch operation #${index} has an empty path.`);
    }
    return segments.map((segment) => {
        if (typeof segment === 'number' && Number.isInteger(segment) && segment >= 0) {
            return String(segment);
        }
        if (typeof segment !== 'string' || segment === '') {
            throw invalid(`Patch operation #${index} has an invalid path segment.`, { path: segments });
        }
        if (FORBIDDEN_SEGMENTS.has(segment)) {
            throw invalid(`Patch path segment "${segment}" is not allowed.`, { path: segments });
        }
        return segment;
    });
}

/**
 * Applies a patch to a copy of `entry`. Every field the patch does not name is
 * carried over from the original object as-is, including fields this project
 * does not know about. Key order of existing fields is preserved.
 *
 * @param {Record<string, any>} entry Original raw entry (not mutated).
 * @param {EntryPatch} patch
 * @param {{ validate?: FieldValidator }} [options]
 * @returns {{ entry: Record<string, any>, changedPaths: string[][] }}
 */
export function applyEntryPatch(entry, patch, options = {}) {
    if (!isPlainObject(entry)) {
        throw new WorldbookError(WorldbookErrorCode.INVALID_ARGUMENT, 'Entry must be an object.');
    }
    const ops = normalizePatch(patch);
    const next = cloneDeep(entry);
    /** @type {string[][]} */
    const changedPaths = [];

    for (const op of ops) {
        if (op.op === 'set' && !isJsonValue(op.value)) {
            throw invalid(`Value for "${op.path.join('.')}" cannot be stored as JSON (allowed: plain objects, arrays without gaps, strings, finite numbers, booleans, null).`, { path: op.path });
        }
        const before = readPath(next, op.path);
        if (op.op === 'set') {
            // A JSON round trip copies any plain value, including proxies of reactive UI state.
            writePath(next, op.path, toJsonValue(op.value));
        } else {
            removePath(next, op.path);
        }
        const after = readPath(next, op.path);
        if (!(before.found === after.found && jsonEqual(before.value, after.value))) {
            if (!changedPaths.some((p) => samePath(p, op.path))) {
                changedPaths.push(op.path);
            }
        }
    }

    if (options.validate) {
        for (const field of new Set(changedPaths.map((path) => path[0]))) {
            const problem = options.validate([field], Object.hasOwn(next, field) ? next[field] : undefined);
            if (problem) {
                throw invalid(problem, { path: [field] });
            }
        }
    }

    return { entry: next, changedPaths };
}

/**
 * True for values JSON stores unchanged: null, booleans, strings, finite numbers,
 * arrays without gaps and plain objects (from any realm) made of those.
 * @param {unknown} value
 * @param {Set<object>} [seen] Objects on the current path (cycle check).
 * @returns {boolean}
 */
export function isJsonValue(value, seen = new Set()) {
    if (value === null || typeof value === 'boolean' || typeof value === 'string') return true;
    if (typeof value === 'number') return Number.isFinite(value);
    if (typeof value !== 'object' || seen.has(value)) return false; // functions, symbols, cycles
    seen.add(value);
    try {
        if (Array.isArray(value)) {
            for (let i = 0; i < value.length; i++) {
                if (!(i in value) || !isJsonValue(value[i], seen)) return false;
            }
            return Object.keys(value).length === value.length;
        }
        if (Object.prototype.toString.call(value) === '[object Object]') {
            return Object.values(value).every((item) => isJsonValue(item, seen));
        }
        return false;
    } finally {
        seen.delete(value);
    }
}

/**
 * @param {any} target
 * @param {string[]} path
 * @returns {{ found: boolean, value: any }}
 */
export function readPath(target, path) {
    let node = target;
    for (const segment of path) {
        if (node === null || typeof node !== 'object' || !Object.prototype.hasOwnProperty.call(node, segment)) {
            return { found: false, value: undefined };
        }
        node = node[segment];
    }
    return { found: true, value: node };
}

/**
 * @param {any} target
 * @param {string[]} path
 * @param {unknown} value
 */
function writePath(target, path, value) {
    let node = target;
    for (let i = 0; i < path.length; i++) {
        const segment = path[i];
        if (Array.isArray(node) && (!CANONICAL_INDEX.test(segment) || Number(segment) > node.length)) {
            throw invalid(`Cannot set "${path.join('.')}": "${segment}" is not an index inside or right after the array.`, { path });
        }
        if (i === path.length - 1) {
            node[segment] = value;
            return;
        }
        const child = Object.prototype.hasOwnProperty.call(node, segment) ? node[segment] : undefined;
        if (child === undefined || child === null) {
            node[segment] = CANONICAL_INDEX.test(path[i + 1]) ? [] : {};
        } else if (typeof child !== 'object') {
            throw invalid(`Cannot set "${path.join('.')}": "${path.slice(0, i + 1).join('.')}" is not an object.`, { path });
        }
        node = node[segment];
    }
}

/**
 * @param {any} target
 * @param {string[]} path
 */
function removePath(target, path) {
    const parent = readPath(target, path.slice(0, -1));
    if (!parent.found || parent.value === null || typeof parent.value !== 'object') {
        return;
    }
    const last = path[path.length - 1];
    if (Array.isArray(parent.value)) {
        throw invalid(`Cannot unset "${path.join('.')}": removing array items is not supported; set the whole array instead.`, { path });
    }
    delete parent.value[last];
}

/**
 * @param {string[]} a
 * @param {string[]} b
 */
function samePath(a, b) {
    return a.length === b.length && a.every((segment, i) => segment === b[i]);
}

/**
 * @param {string} message
 * @param {Record<string, any>} [details]
 */
function invalid(message, details) {
    return new WorldbookError(WorldbookErrorCode.INVALID_PATCH, message, details);
}
