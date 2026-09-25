// @ts-check

import { diffPaths, isPlainObject } from './json.js';

/**
 * How much of an entry must still match the caller's baseline before a write.
 * - 'entry' (default): any change to the entry blocks the write, except changes
 *   the host makes on its own (see `ignore`). This is PRODUCT_PLAN §44: if another
 *   script changed the same entry, do not overwrite silently.
 * - 'fields': only changes to the paths the write touches block it. Other changes
 *   survive the targeted patch and are reported.
 * @typedef {'entry' | 'fields'} ConflictScope
 */

/**
 * Decides whether a change to one top-level field was made by the host itself
 * (for SillyTavern: its editor normalizing values) rather than by someone editing.
 * @typedef {(field: string, before: unknown, after: unknown, context: { hadBefore: boolean, hasAfter: boolean, entryAfter: Record<string, any> }) => boolean} IgnoreChange
 */

/**
 * @typedef {object} ConflictCheck
 * @property {boolean} conflict
 * @property {boolean} deleted The entry no longer exists.
 * @property {string[][]} changedPaths Every path that differs between baseline and current.
 * @property {string[][]} overlappingPaths Changed paths that block the write.
 * @property {string[]} ignoredFields Top-level fields whose change was attributed to the host.
 */

/**
 * Compares the entry as the caller last saw it (`baseline`) with the entry as
 * it is now (`current`).
 * @param {object} input
 * @param {Record<string, any>} input.baseline
 * @param {Record<string, any> | null | undefined} input.current `null`/`undefined` when the entry is gone.
 * @param {string[][]} [input.writePaths] Paths the pending write changes (used by scope 'fields').
 * @param {ConflictScope} [input.scope]
 * @param {IgnoreChange} [input.ignore]
 * @returns {ConflictCheck}
 */
export function detectEntryConflict({ baseline, current, writePaths = [], scope = 'entry', ignore }) {
    if (current === null || current === undefined) {
        return { conflict: true, deleted: true, changedPaths: [[]], overlappingPaths: [[]], ignoredFields: [] };
    }
    const changedPaths = diffPaths(baseline, current);
    /** @type {Set<string>} */
    const ignoredFields = new Set();
    if (ignore && isPlainObject(baseline) && isPlainObject(current)) {
        for (const field of new Set(changedPaths.map((path) => path[0]))) {
            const context = { hadBefore: Object.hasOwn(baseline, field), hasAfter: Object.hasOwn(current, field), entryAfter: current };
            if (ignore(field, baseline[field], current[field], context)) {
                ignoredFields.add(field);
            }
        }
    }
    const relevant = changedPaths.filter((path) => !ignoredFields.has(path[0]));
    const overlappingPaths = scope === 'fields'
        ? relevant.filter((changed) => writePaths.some((written) => isPrefix(changed, written) || isPrefix(written, changed)))
        : relevant;
    return {
        conflict: overlappingPaths.length > 0,
        deleted: false,
        changedPaths,
        overlappingPaths,
        ignoredFields: [...ignoredFields],
    };
}

/**
 * @param {string[]} prefix
 * @param {string[]} path
 */
function isPrefix(prefix, path) {
    return prefix.length <= path.length && prefix.every((segment, i) => segment === path[i]);
}
