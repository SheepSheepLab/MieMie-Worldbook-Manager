// @ts-check

import { WorldbookError, WorldbookErrorCode } from '../../core/errors.js';
import { cloneDeep, isPlainObject } from '../../core/json.js';

/**
 * Thin wrapper around the SillyTavern page. Everything host-specific the
 * adapter touches goes through here, so the rest of the code never reaches
 * into ST globals, ST internals or the DOM directly.
 *
 * Works from a native ST extension (main window) and from a Tavern Helper
 * script iframe (where `SillyTavern.getContext()` and `TavernHelper` are
 * provided by Tavern Helper and the ST page is `window.parent`).
 */

/**
 * @typedef {object} StHostOptions
 * @property {() => any} [getContext] Returns the SillyTavern context. Default: `SillyTavern.getContext()`.
 * @property {typeof fetch} [fetch] Default: global fetch.
 * @property {any} [tavernHelper] Tavern Helper API object. Default: global `TavernHelper` if present.
 * @property {Document | null} [document] ST page document (used only to read which book the ST editor shows). Default: detected.
 */

/**
 * @typedef {ReturnType<typeof createStHost>} StHost
 */

/**
 * @typedef {object} SharedAdapterState
 * @property {Map<string, Promise<unknown>>} tails Per-book lock queue tails.
 * @property {WeakSet<object>} ownSaves Objects adapters passed to saveWorldInfo.
 */

/**
 * @param {StHostOptions} [options]
 */
export function createStHost(options = {}) {
    const getContextFn = options.getContext ?? defaultGetContext;
    const fetchFn = options.fetch ?? (typeof fetch === 'function' ? fetch.bind(globalThis) : null);
    // Resolved lazily: Tavern Helper and the ST DOM may appear after this module loads.
    const tavernHelper = () => (options.tavernHelper !== undefined ? options.tavernHelper : detectTavernHelper());
    const pageDocument = () => (options.document !== undefined ? options.document : detectPageDocument());

    /** Fresh context on every call: ST reassigns chat_metadata and friends. */
    function context() {
        let ctx;
        try {
            ctx = getContextFn();
        } catch (error) {
            throw new WorldbookError(WorldbookErrorCode.HOST_UNAVAILABLE, 'SillyTavern context is not available.', {}, { cause: error });
        }
        if (!ctx || typeof ctx !== 'object') {
            throw new WorldbookError(WorldbookErrorCode.HOST_UNAVAILABLE, 'SillyTavern context is not available.');
        }
        return ctx;
    }

    /**
     * @param {string} name
     */
    function requireFunction(name) {
        const fn = context()[name];
        if (typeof fn !== 'function') {
            throw new WorldbookError(WorldbookErrorCode.HOST_UNAVAILABLE, `SillyTavern context has no ${name}().`, { missing: name });
        }
        return fn;
    }

    return {
        /** Tavern Helper API object, or null when it is not installed. */
        tavernHelper,

        /** Throws HOST_UNAVAILABLE unless every function the adapter needs exists. */
        assertReady() {
            for (const name of ['loadWorldInfo', 'saveWorldInfo', 'getRequestHeaders']) {
                requireFunction(name);
            }
            if (!fetchFn) {
                throw new WorldbookError(WorldbookErrorCode.HOST_UNAVAILABLE, 'fetch is not available.');
            }
            this.listNames();
        },

        /**
         * Book names as the ST page currently knows them (world_names copy).
         * @returns {string[]}
         */
        listNames() {
            const ctx = context();
            if (typeof ctx.getWorldInfoNames === 'function') {
                return [...ctx.getWorldInfoNames()];
            }
            const th = tavernHelper();
            if (th && typeof th.getWorldbookNames === 'function') {
                return [...th.getWorldbookNames()];
            }
            throw new WorldbookError(WorldbookErrorCode.HOST_UNAVAILABLE, 'No way to list worldbooks (getContext().getWorldInfoNames, added in SillyTavern 1.18.0, is missing).');
        },

        /** Re-reads the book list from the server (ST `updateWorldInfoList`). */
        async refreshNames() {
            const ctx = context();
            if (typeof ctx.updateWorldInfoList === 'function') {
                await ctx.updateWorldInfoList();
            }
        },

        /**
         * The book as the ST page holds it in memory (worldInfoCache). Always a
         * private copy: on a cache miss ST returns its live cached object.
         * @param {string} name
         * @returns {Promise<Record<string, any> | null>}
         */
        async readCached(name) {
            const loadWorldInfo = requireFunction('loadWorldInfo');
            let data;
            try {
                data = await loadWorldInfo(name);
            } catch (error) {
                throw new WorldbookError(WorldbookErrorCode.READ_FAILED, `Loading worldbook "${name}" failed.`, { worldbook: name }, { cause: error });
            }
            return data ? cloneDeep(data) : null;
        },

        /**
         * The book as stored on the server, bypassing ST's page cache.
         * Uses the same endpoint ST's own loadWorldInfo uses.
         * @param {string} name
         * @returns {Promise<Record<string, any>>}
         */
        async readStored(name) {
            const headers = requireFunction('getRequestHeaders')();
            let response;
            try {
                response = await /** @type {typeof fetch} */ (fetchFn)('/api/worldinfo/get', {
                    method: 'POST',
                    headers,
                    body: JSON.stringify({ name }),
                    cache: 'no-cache',
                });
            } catch (error) {
                throw new WorldbookError(WorldbookErrorCode.READ_FAILED, `Reading worldbook "${name}" from the server failed.`, { worldbook: name }, { cause: error });
            }
            if (!response.ok) {
                throw new WorldbookError(WorldbookErrorCode.READ_FAILED, `Server returned HTTP ${response.status} for worldbook "${name}".`, { worldbook: name, status: response.status });
            }
            let data;
            try {
                data = await response.json();
            } catch (error) {
                throw new WorldbookError(WorldbookErrorCode.READ_FAILED, `Worldbook "${name}" is not valid JSON.`, { worldbook: name }, { cause: error });
            }
            if (!isPlainObject(data)) {
                throw new WorldbookError(WorldbookErrorCode.READ_FAILED, `Worldbook "${name}" is not an object.`, { worldbook: name });
            }
            return data;
        },

        /**
         * Immediate save through ST (updates ST's page cache and fires WORLDINFO_UPDATED).
         * ST resolves this even when the server rejects the write, so callers must verify.
         * ST keeps `data` by reference as its cache entry: mutate it afterwards only to
         * undo a failed write.
         * @param {string} name
         * @param {Record<string, any>} data
         */
        async save(name, data) {
            const saveWorldInfo = requireFunction('saveWorldInfo');
            await saveWorldInfo(name, data, true);
        },

        /**
         * Makes an open ST World Info editor re-read `name`, so it does not later
         * save its stale copy over ours. No-op when the editor shows another book.
         * @param {string} name
         */
        reloadEditor(name) {
            const ctx = context();
            if (typeof ctx.reloadWorldInfoEditor === 'function') {
                try {
                    ctx.reloadWorldInfoEditor(name, false);
                } catch {
                    // UI refresh only; the data write already happened.
                }
            }
        },

        /**
         * Subscribes to ST's WORLDINFO_UPDATED(name, data) event. `data` is the object
         * that was passed to saveWorldInfo (ST emits the same reference).
         * @param {(name: string, data: unknown) => void} listener
         * @returns {() => void} unsubscribe
         */
        onBookSaved(listener) {
            const ctx = context();
            const source = ctx.eventSource;
            const type = ctx.eventTypes?.WORLDINFO_UPDATED ?? 'worldinfo_updated';
            if (!source || typeof source.on !== 'function') {
                return () => {};
            }
            const handler = (/** @type {string} */ name, /** @type {unknown} */ data) => listener(name, data);
            source.on(type, handler);
            return () => {
                if (typeof source.removeListener === 'function') {
                    source.removeListener(type, handler);
                }
            };
        },

        /**
         * Runs a read-only STscript command and returns its pipe value.
         * @param {string} command
         * @returns {Promise<string | null>} null when slash commands are unavailable.
         */
        async runSlashCommand(command) {
            const ctx = context();
            if (typeof ctx.executeSlashCommandsWithOptions !== 'function') {
                return null;
            }
            const result = await ctx.executeSlashCommandsWithOptions(command, { handleParserErrors: false, handleExecutionErrors: false });
            if (!result || result.isError) {
                return null;
            }
            return typeof result.pipe === 'string' ? result.pipe : String(result.pipe ?? '');
        },

        /** Raw context accessor for read-only lookups (chat metadata, characters, persona). */
        context,

        /**
         * State shared by every adapter in this SillyTavern page, including adapters
         * loaded in separate Tavern Helper script iframes: per-book locks and the
         * objects adapters handed to saveWorldInfo. Kept on the ST page window.
         * @returns {SharedAdapterState}
         */
        sharedState() {
            const win = /** @type {any} */ (detectPageWindow());
            const key = Symbol.for('miemie.worldbook-manager.shared-state');
            if (!win[key]) {
                Object.defineProperty(win, key, { value: { tails: new Map(), ownSaves: new WeakSet() }, configurable: true });
            }
            return win[key];
        },

        /**
         * Name of the book the ST World Info editor currently shows, read from the
         * editor's <select> (ST has no API or event for this). Option values are
         * indexes into ST's book list, which is how ST itself resolves them
         * (world-info.js:6213-6224).
         * @returns {string | null | undefined} undefined when the DOM is not reachable.
         */
        editorBook() {
            const doc = pageDocument();
            if (!doc) return undefined;
            const select = /** @type {HTMLSelectElement | null} */ (doc.getElementById('world_editor_select'));
            if (!select) return undefined;
            const value = select.value;
            if (value === '' || value === null || value === undefined) return null;
            const byIndex = this.listNames()[Number(value)];
            if (typeof byIndex === 'string') return byIndex;
            const option = select.selectedOptions?.[0];
            return option?.textContent ?? null;
        },

        /**
         * GET /version, used only for diagnostics.
         * @returns {Promise<Record<string, any> | null>}
         */
        async serverVersion() {
            if (!fetchFn) return null;
            try {
                const response = await fetchFn('/version', { method: 'GET', headers: requireFunction('getRequestHeaders')() });
                return response.ok ? await response.json() : null;
            } catch {
                return null;
            }
        },
    };
}

function defaultGetContext() {
    const st = /** @type {any} */ (globalThis).SillyTavern;
    if (!st || typeof st.getContext !== 'function') {
        throw new Error('SillyTavern global is missing.');
    }
    return st.getContext();
}

/**
 * The SillyTavern page window: this one, or the parent when running inside a
 * same-origin Tavern Helper iframe.
 */
function detectPageWindow() {
    const g = /** @type {any} */ (globalThis);
    try {
        if (g.parent && g.parent !== g && g.parent.SillyTavern) return g.parent;
    } catch {
        // Cross-origin parent: not the ST page.
    }
    return g;
}

function detectTavernHelper() {
    const g = /** @type {any} */ (globalThis);
    return g.TavernHelper ?? null;
}

/**
 * The ST page document: this window's, or the parent's when running inside a
 * same-origin Tavern Helper iframe.
 * @returns {Document | null}
 */
function detectPageDocument() {
    const g = /** @type {any} */ (globalThis);
    const candidates = [];
    if (g.document) candidates.push(g.document);
    try {
        if (g.parent && g.parent !== g && g.parent.document) candidates.push(g.parent.document);
    } catch {
        // Cross-origin parent: not the ST page.
    }
    return candidates.find((doc) => doc.getElementById?.('world_editor_select')) ?? null;
}
