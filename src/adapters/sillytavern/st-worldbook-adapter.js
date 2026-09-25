// @ts-check

import { detectEntryConflict } from '../../core/entry-compare.js';
import { applyEntryPatch, normalizePatch } from '../../core/entry-patch.js';
import { WorldbookConflictError, WorldbookError, WorldbookErrorCode } from '../../core/errors.js';
import { canonicalJson, cloneDeep, fingerprint, isPlainObject, jsonEqual, toJsonValue } from '../../core/json.js';
import { createKeyedLock } from '../../core/keyed-lock.js';
import { DEFAULT_ORDER_RANGE, planOrderPlacement, resolveTargetIndex, sortForDisplay } from '../../core/order.js';
import { WorldbookHandle } from '../../core/worldbook-port.js';
import { createStHost } from './st-host.js';
import { CHAT_METADATA_KEY, MAX_UID, ST_BASELINE, isHostNormalization, newEntryTemplate, validateEntryField } from './st-schema.js';

/**
 * SillyTavern implementation of the WorldbookPort (src/core/worldbook-port.js).
 *
 * Data path (see docs/compatibility/sillytavern-1.19.0.md for the evidence):
 * - Reads come from the stored file (POST /api/worldinfo/get), the same endpoint
 *   ST's loadWorldInfo uses, so results do not depend on ST's page cache.
 * - Writes take the stored book, patch only the targeted fields of the raw
 *   entry, and save the whole raw book with `saveWorldInfo(name, book, true)`,
 *   which keeps ST's page cache in step. Book-level keys and unknown fields are
 *   carried over untouched.
 * - ST's save resolves even when the server rejects the write, so every write
 *   is read back and compared before it is reported as successful.
 * - If ST's in-memory copy of the book differs from the file in a way ST's editor
 *   does not produce by itself, the write is refused (HOST_UNSAVED_CHANGES) until
 *   the caller picks a version, so unsaved changes in the page are never dropped
 *   silently.
 * - Tavern Helper's worldbook writers are not used: they rebuild every entry
 *   from a fixed field list and drop unknown data.
 */

/**
 * @typedef {object} AdapterOptions
 * @property {import('./st-host.js').StHost} [host] Pre-built host (tests); otherwise built from the options below.
 * @property {() => any} [getContext]
 * @property {typeof fetch} [fetch]
 * @property {any} [tavernHelper]
 * @property {Document | null} [document]
 * @property {import('../../core/order.js').OrderRange} [orderRange] Values the adapter may assign to Order. Default 0..9999 (ST editor input range).
 * @property {number} [settleTimeoutMs] How long to wait for a pending ST save before writing. Default 1500 (ST debounces saves by 1000 ms).
 * @property {() => number} [now]
 * @property {import('./st-host.js').SharedAdapterState} [sharedState] Locks and own-save records; default: shared by all adapters in the ST page.
 */

const SETTLE_ATTEMPTS = 20;

/**
 * @param {AdapterOptions} [options]
 */
export function createSillyTavernWorldbookAdapter(options = {}) {
    options = options ?? {};
    const host = options.host ?? createStHost(options);
    const orderRange = options.orderRange ?? DEFAULT_ORDER_RANGE;
    const settleTimeoutMs = options.settleTimeoutMs ?? 1500;
    const now = options.now ?? (() => Date.now());
    const shared = options.sharedState ?? host.sharedState();
    const runExclusive = createKeyedLock(shared.tails);

    /**
     * WORLDINFO_UPDATED carries the object passed to saveWorldInfo, so a save made
     * by any adapter in this page is recognised by identity, not by book name.
     * @param {unknown} data
     */
    const isOwnSave = (data) => data !== null && typeof data === 'object' && shared.ownSaves.has(data);
    /** Cache/stored differences that outlived a full settle window (not a pending save). */
    /** @type {Map<string, string>} */
    const stableDrift = new Map();

    // ---------------------------------------------------------------- books

    /**
     * @param {unknown} name
     * @returns {asserts name is string}
     */
    function assertName(name) {
        if (typeof name !== 'string' || name === '') {
            throw new WorldbookError(WorldbookErrorCode.INVALID_ARGUMENT, 'Worldbook name must be a non-empty string.', { worldbook: name });
        }
    }

    /**
     * The name must be in ST's book list. The server answers a missing book with an
     * empty dummy and would create it on save, so this check guards every call.
     * @param {string} name
     */
    async function requireBook(name) {
        assertName(name);
        if (host.listNames().includes(name)) return;
        await host.refreshNames();
        if (!host.listNames().includes(name)) {
            throw new WorldbookError(WorldbookErrorCode.WORLDBOOK_NOT_FOUND, `Worldbook "${name}" does not exist.`, { worldbook: name });
        }
    }

    /**
     * A stored read that returned `{ entries: {} }` may be the server's dummy for a
     * file deleted elsewhere. Re-check the list before trusting it.
     * @param {string} name
     * @param {Record<string, any>} data
     */
    async function confirmNotDeleted(name, data) {
        if (!isDummyBook(data)) return;
        await host.refreshNames();
        if (!host.listNames().includes(name)) {
            throw new WorldbookError(WorldbookErrorCode.WORLDBOOK_NOT_FOUND, `Worldbook "${name}" does not exist.`, { worldbook: name });
        }
    }

    /**
     * @param {string} name
     * @param {Record<string, any>} data
     * @param {'stored' | 'cache'} source
     * @returns {import('../../core/worldbook-port.js').WorldbookSnapshot}
     */
    function describe(name, data, source) {
        const { entries, anomalies } = inspectEntries(name, data);
        return {
            name,
            source,
            data,
            entries: sortForDisplay(entries.map(({ entry }) => entry)),
            anomalies,
            fingerprint: fingerprint(data),
        };
    }

    /**
     * Installed characters' avatar names without extension, as ST's character filter stores them.
     * @returns {Set<string> | undefined}
     */
    function installedCharacters() {
        try {
            const characters = host.context().characters;
            if (!Array.isArray(characters)) return undefined;
            return new Set(characters
                .map((/** @type {any} */ c) => (typeof c?.avatar === 'string' ? c.avatar.replace(/\.[^/.]+$/, '') : null))
                .filter((/** @type {string | null} */ name) => name !== null));
        } catch {
            return undefined;
        }
    }

    /** @returns {import('../../core/entry-compare.js').IgnoreChange} */
    function hostNormalizationCheck() {
        const knownCharacters = installedCharacters();
        return (field, before, after, context) => isHostNormalization(field, before, after, { ...context, knownCharacters });
    }

    // --------------------------------------------------------- read / settle

    /**
     * @typedef {object} HostDrift How ST's in-memory copy differs from the stored file.
     * @property {'none' | 'normalized' | 'substantive'} kind
     *   'normalized': only rewrites ST's editor makes by itself; 'substantive': anything else.
     * @property {Array<{ uid: number | string, fields: string[] | null }>} entries Entries with substantive differences (`fields: null` = entry exists on one side only).
     * @property {string[]} bookKeys Book-level keys that differ.
     */

    /**
     * @param {Record<string, any>} stored
     * @param {Record<string, any> | null} cached
     * @returns {HostDrift}
     */
    function classifyDrift(stored, cached) {
        /** @type {HostDrift} */
        const drift = { kind: 'none', entries: [], bookKeys: [] };
        if (cached === null || jsonEqual(stored, cached)) return drift;
        drift.kind = 'normalized';
        for (const key of new Set([...Object.keys(stored), ...Object.keys(cached)])) {
            if (key !== 'entries' && !jsonEqual(stored[key], cached[key])) drift.bookKeys.push(key);
        }
        const storedEntries = isPlainObject(stored.entries) ? stored.entries : {};
        const cachedEntries = isPlainObject(cached.entries) ? cached.entries : {};
        const knownCharacters = installedCharacters();
        for (const key of new Set([...Object.keys(storedEntries), ...Object.keys(cachedEntries)])) {
            const before = storedEntries[key];
            const after = cachedEntries[key];
            if (jsonEqual(before, after)) continue;
            const uid = /^\d+$/.test(key) ? Number(key) : key;
            if (!isPlainObject(before) || !isPlainObject(after)) {
                drift.entries.push({ uid, fields: null });
                continue;
            }
            const fields = [...new Set([...Object.keys(before), ...Object.keys(after)])]
                .filter((field) => !jsonEqual(before[field], after[field]))
                .filter((field) => !isHostNormalization(field, before[field], after[field], {
                    hadBefore: Object.hasOwn(before, field), hasAfter: Object.hasOwn(after, field), entryAfter: after, knownCharacters,
                }));
            if (fields.length) drift.entries.push({ uid, fields });
        }
        if (drift.entries.length || drift.bookKeys.length) drift.kind = 'substantive';
        return drift;
    }

    /**
     * Reads the stored book once ST has finished any pending save of it.
     *
     * ST saves most edits through a shared 1 s debounce, and its page cache holds
     * such an edit before the file does. If cache and file differ substantively,
     * wait (up to `settleTimeoutMs`) for ST's WORLDINFO_UPDATED of this book and
     * re-read. Differences that are only ST editor normalization need no wait.
     *
     * @param {string} name
     * @returns {Promise<{ stored: Record<string, any>, cached: Record<string, any> | null, drift: HostDrift }>}
     */
    async function readSettled(name) {
        let externalSaves = 0;
        /** @type {(() => void) | null} */
        let wake = null;
        const unsubscribe = host.onBookSaved((book, data) => {
            if (book === name && !isOwnSave(data)) {
                externalSaves++;
                if (wake) wake();
            }
        });
        try {
            const deadline = now() + settleTimeoutMs;
            for (let attempt = 0; attempt < SETTLE_ATTEMPTS; attempt++) {
                const cachedBefore = await host.readCached(name);
                const savesBefore = externalSaves;
                const stored = await host.readStored(name);
                const cached = await host.readCached(name);
                if (externalSaves !== savesBefore || !jsonEqual(cachedBefore, cached)) {
                    continue; // something in the page saved this book while we were reading
                }
                const drift = classifyDrift(stored, cached);
                if (drift.kind !== 'substantive') {
                    stableDrift.delete(name);
                    return { stored, cached, drift };
                }
                const signature = `${fingerprint(cached)}|${fingerprint(stored)}`;
                if (stableDrift.get(name) === signature) {
                    return { stored, cached, drift };
                }
                const remaining = deadline - now();
                if (remaining <= 0) {
                    stableDrift.set(name, signature);
                    return { stored, cached, drift };
                }
                await new Promise((resolve) => {
                    const timer = setTimeout(resolve, remaining);
                    wake = () => {
                        clearTimeout(timer);
                        resolve(undefined);
                    };
                });
                wake = null;
            }
            throw new WorldbookError(WorldbookErrorCode.READ_FAILED, `Worldbook "${name}" kept changing while it was being read.`, { worldbook: name });
        } finally {
            unsubscribe();
        }
    }

    /**
     * An immediate save cancels ST's pending debounced save of any other book
     * (world-info.js:4153). Before saving `name`, give the book open in ST's editor
     * the chance to finish such a save. Returns books that still hold unsaved
     * changes in the page afterwards.
     * @param {string} name
     * @returns {Promise<string[]>}
     */
    async function settleEditorBook(name) {
        const open = host.editorBook();
        if (typeof open !== 'string' || open === name || !host.listNames().includes(open)) return [];
        try {
            const { drift } = await readSettled(open);
            return drift.kind === 'substantive' ? [open] : [];
        } catch {
            return [];
        }
    }

    // ------------------------------------------------------------ write path

    /**
     * @typedef {object} MutationPlan
     * @property {boolean} [skipWrite] Nothing changed; do not save.
     * @property {Map<string, Record<string, any> | null>} [expect] Entry key -> expected stored entry (null = must be absent).
     * @property {Record<string, any>} result
     */

    /**
     * What to do when ST's in-memory copy differs substantively from the file:
     * 'reject' (default) refuses with HOST_UNSAVED_CHANGES; 'use-stored' writes on
     * top of the file and replaces ST's copy (its differences are discarded).
     * @typedef {'reject' | 'use-stored'} HostDriftPolicy
     */

    /**
     * Serialized read → patch → save → verify for one book.
     * @param {string} name
     * @param {(book: Record<string, any>, context: { cached: Record<string, any> | null }) => MutationPlan} mutate
     *   Receives a private copy of the stored book and changes it in place.
     * @param {{ onHostDrift?: HostDriftPolicy }} [options]
     */
    function commit(name, mutate, { onHostDrift = 'reject' } = {}) {
        assertName(name);
        if (onHostDrift !== 'reject' && onHostDrift !== 'use-stored') {
            throw new WorldbookError(WorldbookErrorCode.INVALID_ARGUMENT, 'onHostDrift must be "reject" or "use-stored".', { onHostDrift });
        }
        return runExclusive(name, async () => {
            await requireBook(name);
            // Settle the book open in ST's editor first: waiting after the target was read
            // would widen the read→save window of the target.
            const hostUnsavedBooks = await settleEditorBook(name);
            const { stored, cached, drift } = await readSettled(name);
            await confirmNotDeleted(name, stored);
            if (!isPlainObject(stored.entries)) {
                throw new WorldbookError(WorldbookErrorCode.MALFORMED_DATA, `Worldbook "${name}" has no entries object.`, { worldbook: name });
            }
            // The mutation is pure (it works on a copy), so its own checks (missing entry,
            // baseline conflict, invalid patch) run first and report the more specific error.
            const book = cloneDeep(stored);
            const plan = mutate(book, { cached });
            const meta = {
                worldbook: name,
                hostDrift: drift.kind,
                hostChangesDiscarded: false,
                hostUnsavedBooks,
            };
            if (plan.skipWrite) {
                return { ...plan.result, ...meta, written: false, verified: true };
            }
            if (drift.kind === 'substantive' && onHostDrift === 'reject') {
                throw new WorldbookError(
                    WorldbookErrorCode.HOST_UNSAVED_CHANGES,
                    `SillyTavern's copy of "${name}" differs from the stored file (unsaved changes in the page, or the file was changed elsewhere).`,
                    { worldbook: name, entries: drift.entries, bookKeys: drift.bookKeys, storedFingerprint: fingerprint(stored) },
                );
            }
            const expect = /** @type {Map<string, Record<string, any> | null>} */ (plan.expect);
            if (drift.kind === 'normalized' && cached) {
                keepHostRewrites(book, cached, expect);
            }
            await persist(name, book, expect);
            meta.hostChangesDiscarded = drift.kind === 'substantive';
            return { ...plan.result, ...meta, written: true, verified: true };
        });
    }

    /**
     * Saves through ST and confirms the result by reading the file back.
     * On failure ST's page cache is put back to what the file holds (unless
     * `restoreOnFailure` is false), so ST does not keep using a change that was
     * never stored.
     * @param {string} name
     * @param {Record<string, any>} book Handed to ST; ST keeps it as its cache entry, so it is only touched again to undo a failed write.
     * @param {Map<string, Record<string, any> | null>} expect
     * @param {{ restoreOnFailure?: boolean }} [options]
     */
    async function persist(name, book, expect, { restoreOnFailure = true } = {}) {
        // Snapshot what must be stored before ST gets the objects: ST passes them to
        // WORLDINFO_UPDATED listeners, which may change them.
        /** @type {Map<string, string | null>} */
        const expected = new Map([...expect].map(([key, value]) => [key, value === null ? null : canonicalJson(value)]));
        /** @type {unknown} */
        let saveError = null;
        try {
            await saveAsOwn(name, book);
        } catch (error) {
            saveError = error;
        }

        let stored;
        try {
            stored = await host.readStored(name);
        } catch (error) {
            reloadEditorIfShowing(name);
            throw new WorldbookError(
                WorldbookErrorCode.WRITE_NOT_CONFIRMED,
                `Saving "${name}" could not be confirmed: the file could not be read back. Reload SillyTavern before editing again.`,
                { worldbook: name, cacheRestored: false, saveError: describeError(saveError) },
                { cause: error },
            );
        }

        const mismatched = [];
        for (const [key, json] of expected) {
            const actual = isPlainObject(stored.entries) ? stored.entries[key] : undefined;
            const ok = json === null ? actual === undefined : actual !== undefined && canonicalJson(actual) === json;
            if (!ok) mismatched.push(key);
        }

        if (mismatched.length === 0) {
            stableDrift.delete(name);
            reloadEditorIfShowing(name);
            return;
        }

        let cacheRestored = false;
        if (restoreOnFailure) {
            cacheRestored = await restoreHostCopy(name, book);
        }
        reloadEditorIfShowing(name);
        throw new WorldbookError(
            saveError ? WorldbookErrorCode.WRITE_FAILED : WorldbookErrorCode.WRITE_NOT_CONFIRMED,
            saveError
                ? `Saving "${name}" failed.`
                : `Saving "${name}" was not confirmed: the stored file does not contain the change.`,
            { worldbook: name, mismatchedEntries: mismatched, cacheRestored, saveError: describeError(saveError) },
            saveError ? { cause: saveError } : {},
        );
    }

    /**
     * Puts ST's page copy of `name` back to what the file holds after a failed write,
     * without writing to the server. ST keeps the object passed to saveWorldInfo as
     * its cache entry (by reference, world-info.js:4183), so that object is
     * overwritten in place with the file's latest content. If something else has
     * saved the book since, ST's cache holds that save instead and is left as it is.
     * A book that is no longer in the list is left alone.
     * @param {string} name
     * @param {Record<string, any>} saved The object handed to saveWorldInfo.
     * @returns {Promise<boolean>} Whether the page copy now matches the file.
     */
    async function restoreHostCopy(name, saved) {
        try {
            const latest = await host.readStored(name);
            if (isDummyBook(latest)) {
                await host.refreshNames();
                if (!host.listNames().includes(name)) return false;
            }
            for (const key of Object.keys(saved)) delete saved[key];
            Object.assign(saved, cloneDeep(latest));
            return jsonEqual(await host.readCached(name), latest);
        } catch {
            return false;
        }
    }

    /**
     * Asks ST's World Info editor to re-read `name` when it is showing that book,
     * so it cannot later save its stale copy over this write. ST's reloadEditor
     * treats "no book open" as index 0 (Number('') === 0) and would open the first
     * book, so it is only called when the editor is known to show `name`, or
     * when the editor state cannot be read at all.
     * @param {string} name
     */
    function reloadEditorIfShowing(name) {
        const open = host.editorBook();
        if (open === null) return;
        if (open !== undefined && open !== name) return;
        host.reloadEditor(name);
    }

    /**
     * Saves through ST, marking the object so the WORLDINFO_UPDATED it causes is
     * known to come from an adapter.
     * @param {string} name
     * @param {Record<string, any>} data
     */
    async function saveAsOwn(name, data) {
        shared.ownSaves.add(data);
        await host.save(name, data);
    }

    /**
     * @param {Record<string, any>} book
     * @param {string} key
     * @param {string} name
     */
    function requireEntry(book, key, name) {
        const entry = book.entries[key];
        if (entry === undefined) {
            throw new WorldbookError(WorldbookErrorCode.ENTRY_NOT_FOUND, `Entry ${key} does not exist in "${name}".`, { worldbook: name, uid: Number(key) });
        }
        assertWritableEntry(name, key, entry);
        return entry;
    }

    /**
     * Applies planned Order changes to the book (only the `order` field of each entry).
     * @param {Record<string, any>} book
     * @param {import('../../core/order.js').OrderChange[]} changes
     * @param {Map<string, Record<string, any> | null>} expect
     * @param {string} name
     */
    function applyOrderChanges(book, changes, expect, name) {
        for (const change of changes) {
            const key = String(change.uid);
            const entry = requireEntry(book, key, name);
            const { entry: next } = applyEntryPatch(entry, { order: change.to });
            book.entries[key] = next;
            expect.set(key, next);
        }
    }

    // ------------------------------------------------------------ public API

    /** @type {import('../../core/worldbook-port.js').WorldbookPort & Record<string, any>} */
    const adapter = {
        /**
         * @param {{ refresh?: boolean }} [options] refresh: re-read the list from the server first.
         */
        async listWorldbooks(options) {
            const { refresh = false } = options ?? {};
            if (refresh) await host.refreshNames();
            return host.listNames();
        },

        /**
         * Which books SillyTavern currently uses, read without side effects.
         * @returns {Promise<import('../../core/worldbook-port.js').ActiveWorldbooks>}
         */
        async getActiveWorldbooks() {
            const names = host.listNames();
            const ctx = host.context();
            const th = host.tavernHelper();

            const global = await readGlobalBooks(host, th);
            const character = await readCharacterBooks(host, ctx, th);
            const groupMembers = await readGroupMembers(host, ctx, th);

            const chatName = typeof ctx.chatMetadata?.[CHAT_METADATA_KEY] === 'string' && ctx.chatMetadata[CHAT_METADATA_KEY] !== ''
                ? ctx.chatMetadata[CHAT_METADATA_KEY]
                : null;
            const personaName = typeof ctx.powerUserSettings?.persona_description_lorebook === 'string' && ctx.powerUserSettings.persona_description_lorebook !== ''
                ? ctx.powerUserSettings.persona_description_lorebook
                : null;
            const editorName = host.editorBook();

            const referenced = [
                ...(global.names ?? []),
                character?.primary, ...(character?.additional ?? []),
                ...(groupMembers ?? []).flatMap((m) => [m.primary, ...(m.additional ?? [])]),
                chatName, personaName,
            ].filter((n) => typeof n === 'string' && n !== '');

            return {
                global,
                character,
                groupMembers,
                chat: { name: chatName, dangling: chatName !== null && !names.includes(chatName), source: 'context' },
                persona: { name: personaName, source: 'context' },
                editor: { name: editorName ?? null, source: editorName === undefined ? 'unavailable' : 'dom' },
                missing: [...new Set(referenced.filter((n) => !names.includes(/** @type {string} */ (n))))],
            };
        },

        /**
         * @param {string} name
         * @param {{ source?: 'stored' | 'cache' }} [options] 'stored' (default) reads the file; 'cache' reads ST's in-memory copy.
         */
        async getWorldbook(name, options) {
            const { source = 'stored' } = options ?? {};
            if (source !== 'stored' && source !== 'cache') {
                throw new WorldbookError(WorldbookErrorCode.INVALID_ARGUMENT, 'source must be "stored" or "cache".', { source });
            }
            await requireBook(name);
            if (source === 'cache') {
                const cached = await host.readCached(name);
                if (!cached) {
                    throw new WorldbookError(WorldbookErrorCode.READ_FAILED, `Worldbook "${name}" could not be loaded.`, { worldbook: name });
                }
                return describe(name, cached, 'cache');
            }
            const stored = await host.readStored(name);
            await confirmNotDeleted(name, stored);
            return describe(name, stored, 'stored');
        },

        /**
         * @param {string} name
         * @param {number} uid
         * @param {{ source?: 'stored' | 'cache' }} [options]
         */
        async getEntry(name, uid, options) {
            const key = entryKey(uid);
            const snapshot = await adapter.getWorldbook(name, options);
            const entry = snapshot.data.entries[key];
            return isPlainObject(entry) ? entry : null;
        },

        /**
         * Creates an entry from SillyTavern's new-entry template plus `fields`.
         * Placement defaults to the top of the list (highest Order + 1), unless
         * `fields` sets `order` explicitly.
         * @param {string} name
         * @param {{ fields?: import('../../core/entry-patch.js').EntryPatch, placement?: import('../../core/order.js').Placement, onHostDrift?: HostDriftPolicy }} [options]
         */
        async createEntry(name, options) {
            const { fields, placement, onHostDrift } = options ?? {};
            const hasFields = fields !== undefined && !(isPlainObject(fields) && Object.keys(fields).length === 0);
            const ops = hasFields ? normalizePatch(/** @type {any} */ (fields)) : [];
            const explicitOrder = ops.some((op) => op.path.length === 1 && op.path[0] === 'order');
            if (explicitOrder && placement !== undefined) {
                throw new WorldbookError(WorldbookErrorCode.INVALID_ARGUMENT, 'Pass either fields.order or placement, not both.');
            }
            return commit(name, (book, { cached }) => {
                const uid = freeUid(book, cached);
                const key = String(uid);
                let entry = /** @type {Record<string, any>} */ ({ uid, ...newEntryTemplate() });
                if (hasFields) {
                    entry = applyEntryPatch(entry, /** @type {any} */ (fields), { validate: validateEntryField }).entry;
                }

                /** @type {Map<string, Record<string, any> | null>} */
                const expect = new Map();
                /** @type {import('../../core/order.js').OrderChange[]} */
                let orderChanges = [];
                if (!explicitOrder) {
                    const items = orderItems(name, book);
                    const targetIndex = resolveTargetIndex(items, null, placement ?? 'top');
                    const plan = planOrderPlacement(items, { targetIndex, range: orderRange });
                    entry.order = plan.order;
                    orderChanges = plan.changes;
                    applyOrderChanges(book, orderChanges, expect, name);
                }

                book.entries[key] = entry;
                expect.set(key, entry);
                return { expect, result: { uid, entry: cloneDeep(entry), orderChanges } };
            }, { onHostDrift });
        },

        /**
         * Targeted patch of one entry. Fields the patch does not name are kept as stored.
         * With `baseline`, the write is refused if the entry changed since the baseline
         * (conflictScope 'entry', default) or if the fields being written changed
         * (conflictScope 'fields'). Rewrites ST's editor makes by itself do not count.
         * @param {string} name
         * @param {number} uid
         * @param {import('../../core/entry-patch.js').EntryPatch} patch
         * @param {import('../../core/worldbook-port.js').UpdateOptions & { onHostDrift?: HostDriftPolicy }} [options]
         */
        async updateEntry(name, uid, patch, options) {
            const { baseline, conflictScope = 'entry', onHostDrift } = options ?? {};
            if (conflictScope !== 'entry' && conflictScope !== 'fields') {
                throw new WorldbookError(WorldbookErrorCode.INVALID_ARGUMENT, 'conflictScope must be "entry" or "fields".', { conflictScope });
            }
            const key = entryKey(uid);
            const ops = normalizePatch(patch);
            return commit(name, (book) => {
                const current = book.entries[key];
                if (current === undefined && baseline) {
                    throw conflictError(name, key, baseline, null, [[]], 'was deleted');
                }
                const entry = requireEntry(book, key, name);
                const { entry: next, changedPaths } = applyEntryPatch(entry, ops, { validate: validateEntryField });

                /** @type {string[][]} */
                let externalChanges = [];
                if (baseline) {
                    const check = detectEntryConflict({
                        baseline, current: entry, writePaths: ops.map((op) => op.path), scope: conflictScope, ignore: hostNormalizationCheck(),
                    });
                    if (check.conflict) {
                        throw conflictError(name, key, baseline, entry, check.overlappingPaths, 'changed since it was read', next);
                    }
                    if (looksReplaced(baseline, entry)) {
                        throw conflictError(name, key, baseline, entry, [['comment'], ['key'], ['content']], 'was replaced by a different entry', next);
                    }
                    externalChanges = check.changedPaths;
                }

                if (changedPaths.length === 0) {
                    return { skipWrite: true, result: { uid: Number(key), entry: cloneDeep(entry), changedPaths, externalChanges } };
                }
                book.entries[key] = next;
                return { expect: new Map([[key, next]]), result: { uid: Number(key), entry: cloneDeep(next), changedPaths, externalChanges } };
            }, { onHostDrift });
        },

        /**
         * Removes one entry. With `baseline`, refused if the entry changed at all.
         * Book-level data (including `originalData`) is left as stored.
         * @param {string} name
         * @param {number} uid
         * @param {{ baseline?: Record<string, any>, onHostDrift?: HostDriftPolicy }} [options]
         */
        async deleteEntry(name, uid, options) {
            const { baseline, onHostDrift } = options ?? {};
            const key = entryKey(uid);
            return commit(name, (book) => {
                const entry = requireEntry(book, key, name);
                if (baseline) {
                    const check = detectEntryConflict({ baseline, current: entry, scope: 'entry', ignore: hostNormalizationCheck() });
                    if (check.conflict) {
                        throw conflictError(name, key, baseline, entry, check.overlappingPaths, 'changed since it was read');
                    }
                }
                delete book.entries[key];
                return { expect: new Map([[key, null]]), result: { uid: Number(key), deleted: cloneDeep(entry) } };
            }, { onHostDrift });
        },

        /**
         * Moves an entry in the display list by changing Order values only, touching
         * as few entries as possible (see src/core/order.js).
         * @param {string} name
         * @param {number} uid
         * @param {import('../../core/order.js').Placement} placement
         * @param {{ expectedSequence?: number[], onHostDrift?: HostDriftPolicy }} [options] expectedSequence: the display order (UIDs) the caller based the move on; refused if the list changed.
         */
        async moveEntry(name, uid, placement, options) {
            const { expectedSequence, onHostDrift } = options ?? {};
            const key = entryKey(uid);
            return commit(name, (book) => {
                requireEntry(book, key, name);
                const items = orderItems(name, book);
                const currentSequence = sortForDisplay(items).map((item) => Number(item.uid));
                if (expectedSequence && !sameSequence(expectedSequence, currentSequence)) {
                    throw new WorldbookConflictError(`The entry list of "${name}" changed since it was read.`, {
                        worldbook: name, uid: Number(key), baseline: expectedSequence, current: currentSequence, changedPaths: [['order']],
                    });
                }
                const targetIndex = resolveTargetIndex(items, Number(key), placement);
                const plan = planOrderPlacement(items, { movingUid: Number(key), targetIndex, range: orderRange });
                const result = { uid: Number(key), order: plan.order, orderChanges: plan.changes, sequence: plan.sequence };
                if (plan.changes.length === 0) {
                    return { skipWrite: true, result };
                }
                /** @type {Map<string, Record<string, any> | null>} */
                const expect = new Map();
                applyOrderChanges(book, plan.changes, expect, name);
                return { expect, result };
            }, { onHostDrift });
        },

        /**
         * Stores SillyTavern's in-memory copy of the book as the file. This is the
         * "keep SillyTavern's version" answer to HOST_UNSAVED_CHANGES: it writes what
         * the page holds (including changes that never reached the file) and is
         * verified like every other write. On failure ST's copy is left as it is.
         * Pass `expectedStoredFingerprint` from the HOST_UNSAVED_CHANGES details to refuse
         * (CONFLICT) if the file changed again after the person looked at the difference.
         * @param {string} name
         * @param {{ expectedStoredFingerprint?: string }} [options]
         */
        async saveHostCopy(name, options) {
            const { expectedStoredFingerprint } = options ?? {};
            assertName(name);
            return runExclusive(name, async () => {
                await requireBook(name);
                const cached = await host.readCached(name);
                if (!cached || !isPlainObject(cached.entries)) {
                    throw new WorldbookError(WorldbookErrorCode.READ_FAILED, `SillyTavern has no usable copy of "${name}".`, { worldbook: name });
                }
                const stored = await host.readStored(name);
                await confirmNotDeleted(name, stored);
                if (expectedStoredFingerprint !== undefined && fingerprint(stored) !== expectedStoredFingerprint) {
                    throw new WorldbookConflictError(`The stored file of "${name}" changed after the difference was reported.`, {
                        worldbook: name, uid: -1, baseline: null, current: null, changedPaths: [],
                    });
                }
                if (jsonEqual(stored, cached)) {
                    return { worldbook: name, written: false, verified: true };
                }
                /** @type {Map<string, Record<string, any> | null>} */
                const expect = new Map();
                for (const key of new Set([...Object.keys(isPlainObject(stored.entries) ? stored.entries : {}), ...Object.keys(cached.entries)])) {
                    expect.set(key, key in cached.entries ? cached.entries[key] : null);
                }
                await persist(name, cloneDeep(cached), expect, { restoreOnFailure: false });
                return { worldbook: name, written: true, verified: true };
            });
        },

        /**
         * Notifies about saves of any book made by something else in the ST page
         * (ST's editor, Tavern Helper, other extensions). Other tabs and devices are
         * not visible here; conflict checks at write time cover them.
         * @param {(event: { worldbook: string }) => void} listener
         */
        watchWorldbooks(listener) {
            return host.onBookSaved((book, data) => {
                if (!isOwnSave(data)) listener({ worldbook: book });
            });
        },

        /**
         * A handle bound to one book.
         * @param {string} name
         */
        worldbook(name) {
            return new WorldbookHandle(adapter, name);
        },

        /** Versions and available host functions, for diagnostics. */
        async describeHost() {
            const ctx = host.context();
            const th = host.tavernHelper();
            const version = await host.serverVersion();
            return {
                baseline: ST_BASELINE,
                sillyTavernVersion: version?.pkgVersion ?? null,
                sillyTavernRevision: version?.gitRevision ?? null,
                tavernHelperVersion: typeof th?.getTavernHelperVersion === 'function' ? th.getTavernHelperVersion() : null,
                contextApis: Object.fromEntries(['loadWorldInfo', 'saveWorldInfo', 'getWorldInfoNames', 'updateWorldInfoList', 'reloadWorldInfoEditor', 'getRequestHeaders', 'executeSlashCommandsWithOptions']
                    .map((fn) => [fn, typeof ctx[fn] === 'function'])),
                eventSource: typeof ctx.eventSource?.on === 'function',
                editorDom: host.editorBook() !== undefined,
            };
        },
    };

    host.assertReady();
    return adapter;
}

// ------------------------------------------------------------------ helpers

/**
 * @param {unknown} uid
 * @returns {string}
 */
function entryKey(uid) {
    const n = typeof uid === 'string' && /^\d+$/.test(uid) ? Number(uid) : uid;
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 0) {
        throw new WorldbookError(WorldbookErrorCode.INVALID_ARGUMENT, 'Entry uid must be a non-negative integer.', { uid });
    }
    return String(n);
}

/**
 * @param {string} name
 * @param {Record<string, any>} data
 */
function inspectEntries(name, data) {
    if (!isPlainObject(data.entries)) {
        throw new WorldbookError(WorldbookErrorCode.MALFORMED_DATA, `Worldbook "${name}" has no entries object.`, { worldbook: name });
    }
    /** @type {{ key: string, entry: Record<string, any> }[]} */
    const entries = [];
    /** @type {import('../../core/worldbook-port.js').EntryAnomaly[]} */
    const anomalies = [];
    for (const [key, entry] of Object.entries(data.entries)) {
        const problem = identityProblem(key, entry);
        if (problem) {
            anomalies.push({ key, problem });
            continue;
        }
        entries.push({ key, entry: /** @type {Record<string, any>} */ (entry) });
    }
    return { entries, anomalies };
}

/**
 * SillyTavern looks entries up both by key and by `entry.uid` (a number), so the
 * two must agree and the key must be a canonical integer ("5", not "05").
 * @param {string} key
 * @param {unknown} entry
 * @returns {string | null}
 */
function identityProblem(key, entry) {
    if (!isPlainObject(entry)) return 'entry is not an object';
    if (!/^(0|[1-9]\d*)$/.test(key)) return `key "${key}" is not a canonical integer`;
    if (typeof entry.uid !== 'number' || String(entry.uid) !== key) return `entry.uid (${JSON.stringify(entry.uid)}) does not match its key`;
    return null;
}

/**
 * @param {string} name
 * @param {string} key
 * @param {unknown} entry
 */
function assertWritableEntry(name, key, entry) {
    const problem = identityProblem(key, entry);
    if (problem) {
        throw new WorldbookError(
            WorldbookErrorCode.MALFORMED_DATA,
            `Entry ${key} in "${name}" is malformed (${problem}); it is left untouched.`,
            { worldbook: name, uid: Number(key), problem },
        );
    }
}

/**
 * @param {string} name
 * @param {Record<string, any>} book
 * @returns {import('../../core/order.js').OrderItem[]}
 */
function orderItems(name, book) {
    return inspectEntries(name, book).entries.map(({ key, entry }) => ({ uid: Number(key), order: entry.order }));
}

/**
 * Lowest free uid, like ST's getFreeWorldEntryUid, but also avoiding uids that
 * exist only in ST's page copy or appear as values, so a new entry never shares
 * an identity with anything ST may still hold.
 * @param {Record<string, any>} book
 * @param {Record<string, any> | null} cached
 */
function freeUid(book, cached) {
    const used = new Set();
    for (const data of [book, cached]) {
        if (!data || !isPlainObject(data.entries)) continue;
        for (const [key, entry] of Object.entries(data.entries)) {
            used.add(key);
            if (isPlainObject(entry) && entry.uid !== undefined) used.add(String(entry.uid));
        }
    }
    for (let uid = 0; uid < MAX_UID; uid++) {
        if (!used.has(String(uid))) return uid;
    }
    throw new WorldbookError(WorldbookErrorCode.INVALID_ARGUMENT, `No free uid below ${MAX_UID}.`);
}

/**
 * When ST's page copy differs from the file only by its editor's own rewrites, the
 * entries this write does not touch are saved as ST holds them (which is what ST's
 * next save would store anyway). ST matches running sticky/cooldown effects by the
 * JSON of the entry in its page copy (world-info.js:4627-4634), so those entries keep
 * their effects.
 * @param {Record<string, any>} book
 * @param {Record<string, any>} cached
 * @param {Map<string, Record<string, any> | null>} touched
 */
function keepHostRewrites(book, cached, touched) {
    if (!isPlainObject(cached.entries)) return;
    for (const key of Object.keys(book.entries)) {
        if (touched.has(key) || !isPlainObject(cached.entries[key])) continue;
        book.entries[key] = cloneDeep(cached.entries[key]);
    }
}

/**
 * @param {Record<string, any>} data
 */
function isDummyBook(data) {
    return isPlainObject(data) && Object.keys(data).length === 1 && isPlainObject(data.entries) && Object.keys(data.entries).length === 0;
}

/**
 * @param {number[]} a
 * @param {number[]} b
 */
function sameSequence(a, b) {
    return a.length === b.length && a.every((uid, i) => Number(uid) === b[i]);
}

/**
 * @param {string} name
 * @param {string} key
 * @param {Record<string, any>} baseline
 * @param {Record<string, any> | null} current
 * @param {string[][]} changedPaths
 * @param {string} what
 * @param {Record<string, any>} [attempted]
 */
function conflictError(name, key, baseline, current, changedPaths, what, attempted) {
    return new WorldbookConflictError(`Entry ${key} in "${name}" ${what}.`, {
        worldbook: name,
        uid: Number(key),
        baseline: toJsonValue(baseline),
        current: current === null ? null : cloneDeep(current),
        changedPaths,
        attempted: attempted === undefined ? undefined : cloneDeep(attempted),
    });
}

/**
 * ST reuses the lowest free uid, so an entry deleted and replaced by a new one keeps
 * the uid. Treat the entry as a different one when title, keys and content all changed.
 * @param {Record<string, any>} baseline
 * @param {Record<string, any>} current
 */
function looksReplaced(baseline, current) {
    return ['comment', 'key', 'content'].every((field) => !jsonEqual(baseline?.[field], current?.[field]));
}

/**
 * @param {unknown} error
 */
function describeError(error) {
    if (!error) return null;
    return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

// ------------------------------------------------------- active book reads

/**
 * @param {import('./st-host.js').StHost} host
 * @param {any} th
 */
async function readGlobalBooks(host, th) {
    try {
        const pipe = await host.runSlashCommand('/getglobalbooks');
        if (pipe !== null) {
            const parsed = JSON.parse(pipe || '[]');
            if (Array.isArray(parsed)) return { names: parsed.map(String), source: 'slash-command' };
        }
    } catch {
        // fall through
    }
    if (th && typeof th.getGlobalWorldbookNames === 'function') {
        return { names: [...th.getGlobalWorldbookNames()], source: 'tavern-helper' };
    }
    return { names: null, source: 'unavailable' };
}

/**
 * @param {import('./st-host.js').StHost} host
 * @param {any} ctx
 * @param {any} th
 */
async function readCharacterBooks(host, ctx, th) {
    if (ctx.groupId || ctx.characterId === undefined || ctx.characterId === null) {
        return null;
    }
    const character = ctx.characters?.[ctx.characterId];
    if (!character) return null;
    const primary = character.data?.extensions?.world || null;

    /** @type {string[] | null} */
    let additional = null;
    let source = 'context';
    try {
        const pipe = await host.runSlashCommand('/getcharbook type=additional');
        if (pipe !== null) {
            const parsed = JSON.parse(pipe || '[]');
            if (Array.isArray(parsed)) {
                additional = parsed.map(String);
                source = 'context+slash-command';
            }
        }
    } catch {
        additional = null;
    }
    if (additional === null && th && typeof th.getCharWorldbookNames === 'function') {
        try {
            additional = [...(th.getCharWorldbookNames('current')?.additional ?? [])];
            source = 'context+tavern-helper';
        } catch {
            additional = null;
        }
    }
    return { primary, additional, source };
}

/**
 * Group chat members and their books. Additional books come from
 * `/getcharbook type=additional "<avatar>"` (read-only when a character is named,
 * world-info.js:1115-1152), falling back to Tavern Helper. Members that are not
 * installed, or whose avatar name cannot be quoted safely, are not queried:
 * ST would show an error toast for them.
 * @param {import('./st-host.js').StHost} host
 * @param {any} ctx
 * @param {any} th
 */
async function readGroupMembers(host, ctx, th) {
    if (!ctx.groupId) return null;
    const group = Array.isArray(ctx.groups) ? ctx.groups.find((/** @type {any} */ g) => g.id === ctx.groupId) : null;
    if (!group || !Array.isArray(group.members)) return [];
    const members = [];
    for (const avatar of /** @type {string[]} */ (group.members)) {
        const character = Array.isArray(ctx.characters) ? ctx.characters.find((/** @type {any} */ c) => c.avatar === avatar) : null;
        /** @type {string[] | null} */
        let additional = null;
        if (character && typeof avatar === 'string' && /^[^"\\|{}]+$/.test(avatar)) {
            try {
                const pipe = await host.runSlashCommand(`/getcharbook type=additional "${avatar}"`);
                const parsed = pipe === null ? null : JSON.parse(pipe || '[]');
                if (Array.isArray(parsed)) additional = parsed.map(String);
            } catch {
                additional = null;
            }
        }
        if (additional === null && th && typeof th.getCharWorldbookNames === 'function') {
            try {
                additional = [...(th.getCharWorldbookNames(avatar)?.additional ?? [])];
            } catch {
                additional = null;
            }
        }
        members.push({
            avatar,
            name: character?.name ?? null,
            primary: character?.data?.extensions?.world || null,
            additional,
        });
    }
    return members;
}
