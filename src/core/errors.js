// @ts-check

/**
 * Stable error codes. UI layers localize by code; messages are for logs.
 */
export const WorldbookErrorCode = Object.freeze({
    /** The host (SillyTavern context) or a required host function is unavailable. */
    HOST_UNAVAILABLE: 'HOST_UNAVAILABLE',
    /** An argument is missing or has the wrong shape. */
    INVALID_ARGUMENT: 'INVALID_ARGUMENT',
    /** A patch is malformed, targets a protected field, or has an invalid value. */
    INVALID_PATCH: 'INVALID_PATCH',
    /** The named worldbook does not exist on the host. */
    WORLDBOOK_NOT_FOUND: 'WORLDBOOK_NOT_FOUND',
    /** The entry does not exist in the named worldbook. */
    ENTRY_NOT_FOUND: 'ENTRY_NOT_FOUND',
    /** Reading the worldbook failed or returned malformed data. */
    READ_FAILED: 'READ_FAILED',
    /** Stored data breaks a SillyTavern invariant (e.g. entry key differs from entry.uid); the write is refused. */
    MALFORMED_DATA: 'MALFORMED_DATA',
    /** The host save call rejected. */
    WRITE_FAILED: 'WRITE_FAILED',
    /** The save call returned, but the saved file does not contain the intended change. */
    WRITE_NOT_CONFIRMED: 'WRITE_NOT_CONFIRMED',
    /** The target entry changed after the caller's baseline was taken. */
    CONFLICT: 'CONFLICT',
    /**
     * The host page's in-memory copy of the book differs from the stored file in a way
     * the host does not produce by itself: unsaved changes in the page, or the file was
     * changed elsewhere. The write is refused until the caller chooses a version.
     */
    HOST_UNSAVED_CHANGES: 'HOST_UNSAVED_CHANGES',
    /** No valid Order assignment exists inside the allowed Order range. */
    ORDER_SPACE_EXHAUSTED: 'ORDER_SPACE_EXHAUSTED',
});

/**
 * @typedef {typeof WorldbookErrorCode[keyof typeof WorldbookErrorCode]} WorldbookErrorCodeValue
 */

export class WorldbookError extends Error {
    /**
     * @param {WorldbookErrorCodeValue} code
     * @param {string} message
     * @param {Record<string, any>} [details]
     * @param {{ cause?: unknown }} [options]
     */
    constructor(code, message, details = {}, options = {}) {
        super(message, options.cause === undefined ? undefined : { cause: options.cause });
        this.name = 'WorldbookError';
        /** @type {WorldbookErrorCodeValue} */
        this.code = code;
        /** @type {Record<string, any>} */
        this.details = details;
    }
}

/**
 * Thrown when the entry being written no longer matches the caller's baseline.
 * Carries both versions so a later conflict UI can show "latest" vs "yours".
 */
export class WorldbookConflictError extends WorldbookError {
    /**
     * @param {string} message
     * @param {{ worldbook: string, uid: number, baseline: any, current: any, changedPaths: string[][], attempted?: any }} details
     */
    constructor(message, details) {
        super(WorldbookErrorCode.CONFLICT, message, details);
        this.name = 'WorldbookConflictError';
    }
}

/**
 * @param {unknown} error
 * @returns {error is WorldbookError}
 */
export function isWorldbookError(error) {
    return error instanceof WorldbookError;
}
