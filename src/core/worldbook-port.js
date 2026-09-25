// @ts-check

import { WorldbookError, WorldbookErrorCode } from './errors.js';

/**
 * The contract between the Worldbook Manager Core (UI, AI workflows in later
 * phases) and a host adapter. Core code depends on this shape only; the
 * SillyTavern adapter in src/adapters/sillytavern implements it.
 *
 * Entries are always the host's raw objects (for SillyTavern: the stored
 * World Info entry, every field included). Nothing is reshaped into a smaller
 * project-specific model, so unknown fields survive every read and write.
 */

/**
 * @typedef {Record<string, any>} RawEntry
 */

/**
 * @typedef {object} EntryAnomaly
 * @property {string} key Key inside `entries`.
 * @property {string} problem
 */

/**
 * @typedef {object} WorldbookSnapshot
 * @property {string} name
 * @property {'stored' | 'cache'} source Where the data came from (server file, or the host page's in-memory copy).
 * @property {Record<string, any>} data The whole book object, every top-level key included (private copy).
 * @property {RawEntry[]} entries Valid entries in display order (higher Order first, ties by UID).
 * @property {EntryAnomaly[]} anomalies Entries that break host invariants; kept in `data` untouched.
 * @property {string} fingerprint Content fingerprint of `data`.
 */

/**
 * @typedef {object} ActiveWorldbooks
 * @property {{ names: string[] | null, source: string }} global
 * @property {{ primary: string | null, additional: string[] | null, source: string } | null} character Solo chat character, null when none.
 * @property {Array<{ avatar: string, name: string | null, primary: string | null, additional: string[] | null }> | null} groupMembers Group chat members, null outside groups.
 * @property {{ name: string | null, dangling: boolean, source: string }} chat
 * @property {{ name: string | null, source: string }} persona
 * @property {{ name: string | null, source: string }} editor The book open in the host's own World Info editor.
 * @property {string[]} missing Names referenced by bindings that are not in the book list.
 */

/**
 * @typedef {object} WriteMeta
 * @property {string} worldbook
 * @property {boolean} written False when the request changed nothing and no save was made.
 * @property {boolean} verified The saved file was read back and contains the change.
 * @property {'none' | 'normalized' | 'substantive'} hostDrift How the host page's in-memory copy differed from the stored file:
 *   not at all, only by rewrites the host makes by itself, or otherwise.
 * @property {boolean} hostChangesDiscarded The write replaced a substantively different page copy (only with onHostDrift 'use-stored').
 * @property {string[]} hostUnsavedBooks Other books that still held unsaved changes in the page when this write was saved.
 */

/**
 * What a write does when the host page's copy differs substantively from the stored
 * file: 'reject' (default) fails with HOST_UNSAVED_CHANGES; 'use-stored' writes on
 * top of the stored file and discards the page copy's differences.
 * @typedef {'reject' | 'use-stored'} HostDriftPolicy
 */

/**
 * @typedef {object} UpdateOptions
 * @property {RawEntry} [baseline] The entry as the caller saw it; enables conflict detection.
 * @property {import('./entry-compare.js').ConflictScope} [conflictScope] Default 'entry'.
 * @property {HostDriftPolicy} [onHostDrift]
 */

/**
 * @typedef {object} WorldbookPort
 * @property {(options?: { refresh?: boolean }) => Promise<string[]>} listWorldbooks
 * @property {() => Promise<ActiveWorldbooks>} getActiveWorldbooks
 * @property {(name: string, options?: { source?: 'stored' | 'cache' }) => Promise<WorldbookSnapshot>} getWorldbook
 * @property {(name: string, uid: number, options?: { source?: 'stored' | 'cache' }) => Promise<RawEntry | null>} getEntry
 * @property {(name: string, options?: { fields?: import('./entry-patch.js').EntryPatch, placement?: import('./order.js').Placement, onHostDrift?: HostDriftPolicy }) => Promise<WriteMeta & { uid: number, entry: RawEntry, orderChanges: import('./order.js').OrderChange[] }>} createEntry
 * @property {(name: string, uid: number, patch: import('./entry-patch.js').EntryPatch, options?: UpdateOptions) => Promise<WriteMeta & { uid: number, entry: RawEntry, changedPaths: string[][], externalChanges: string[][] }>} updateEntry
 * @property {(name: string, uid: number, options?: { baseline?: RawEntry, onHostDrift?: HostDriftPolicy }) => Promise<WriteMeta & { uid: number, deleted: RawEntry }>} deleteEntry
 * @property {(name: string, uid: number, placement: import('./order.js').Placement, options?: { expectedSequence?: number[], onHostDrift?: HostDriftPolicy }) => Promise<WriteMeta & { uid: number, order: number, orderChanges: import('./order.js').OrderChange[], sequence: number[] }>} moveEntry
 * @property {(name: string, options?: { expectedStoredFingerprint?: string }) => Promise<{ worldbook: string, written: boolean, verified: boolean }>} saveHostCopy
 * @property {(listener: (event: { worldbook: string }) => void) => () => void} watchWorldbooks
 */

/**
 * A worldbook chosen by name. Every call goes to that book only, which makes
 * "an edit for book A lands in book B" impossible by construction.
 */
export class WorldbookHandle {
    /**
     * @param {WorldbookPort} port
     * @param {string} name
     */
    constructor(port, name) {
        if (typeof name !== 'string' || name === '') {
            throw new WorldbookError(WorldbookErrorCode.INVALID_ARGUMENT, 'Worldbook name must be a non-empty string.', { worldbook: name });
        }
        /** @readonly */
        this.name = name;
        /** @private */
        this.port = port;
        Object.freeze(this);
    }

    /** @param {{ source?: 'stored' | 'cache' }} [options] */
    read(options) {
        return this.port.getWorldbook(this.name, options);
    }

    /**
     * @param {number} uid
     * @param {{ source?: 'stored' | 'cache' }} [options]
     */
    getEntry(uid, options) {
        return this.port.getEntry(this.name, uid, options);
    }

    /** @param {{ fields?: import('./entry-patch.js').EntryPatch, placement?: import('./order.js').Placement, onHostDrift?: HostDriftPolicy }} [options] */
    createEntry(options) {
        return this.port.createEntry(this.name, options);
    }

    /**
     * @param {number} uid
     * @param {import('./entry-patch.js').EntryPatch} patch
     * @param {UpdateOptions} [options]
     */
    updateEntry(uid, patch, options) {
        return this.port.updateEntry(this.name, uid, patch, options);
    }

    /**
     * @param {number} uid
     * @param {{ baseline?: RawEntry, onHostDrift?: HostDriftPolicy }} [options]
     */
    deleteEntry(uid, options) {
        return this.port.deleteEntry(this.name, uid, options);
    }

    /**
     * @param {number} uid
     * @param {import('./order.js').Placement} placement
     * @param {{ expectedSequence?: number[], onHostDrift?: HostDriftPolicy }} [options]
     */
    moveEntry(uid, placement, options) {
        return this.port.moveEntry(this.name, uid, placement, options);
    }

    /** @param {{ expectedStoredFingerprint?: string }} [options] */
    saveHostCopy(options) {
        return this.port.saveHostCopy(this.name, options);
    }
}
