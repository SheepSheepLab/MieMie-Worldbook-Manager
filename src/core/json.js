// @ts-check

/**
 * JSON helpers. Worldbooks travel to the SillyTavern server as JSON
 * (JSON.stringify on POST), so equality is defined on the JSON form:
 * key order is ignored and `undefined` members are treated as absent.
 */

/**
 * Deep clone for local mutation. Keeps the caller's object untouched.
 * @template T
 * @param {T} value
 * @returns {T}
 */
export function cloneDeep(value) {
    return structuredClone(value);
}

/**
 * Normalizes a value to exactly what JSON serialization would persist.
 * @param {unknown} value
 * @returns {any}
 */
export function toJsonValue(value) {
    if (value === undefined) {
        return undefined;
    }
    return JSON.parse(JSON.stringify(value));
}

/**
 * Serializes with object keys sorted, so equal content gives equal strings.
 * @param {unknown} value
 * @returns {string}
 */
export function canonicalJson(value) {
    return JSON.stringify(sortKeysDeep(toJsonValue(value)));
}

/**
 * @param {any} value
 * @returns {any}
 */
function sortKeysDeep(value) {
    if (Array.isArray(value)) {
        return value.map(sortKeysDeep);
    }
    if (value !== null && typeof value === 'object') {
        /** @type {Record<string, any>} */
        const sorted = {};
        for (const key of Object.keys(value).sort()) {
            sorted[key] = sortKeysDeep(value[key]);
        }
        return sorted;
    }
    return value;
}

/**
 * @param {unknown} a
 * @param {unknown} b
 * @returns {boolean}
 */
export function jsonEqual(a, b) {
    return canonicalJson(a) === canonicalJson(b);
}

/**
 * Lists the paths whose JSON values differ between `a` and `b`.
 * Recurses into plain objects; arrays and scalars are compared whole.
 * @param {unknown} a
 * @param {unknown} b
 * @returns {string[][]}
 */
export function diffPaths(a, b) {
    /** @type {string[][]} */
    const out = [];
    walkDiff(toJsonValue(a), toJsonValue(b), [], out);
    return out;
}

/**
 * @param {any} a
 * @param {any} b
 * @param {string[]} path
 * @param {string[][]} out
 */
function walkDiff(a, b, path, out) {
    if (isPlainObject(a) && isPlainObject(b)) {
        const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
        for (const key of [...keys].sort()) {
            walkDiff(a[key], b[key], [...path, key], out);
        }
        return;
    }
    if (canonicalJson(a) !== canonicalJson(b)) {
        out.push(path);
    }
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, any>}
 */
export function isPlainObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Short content fingerprint (cyrb53 over the canonical JSON).
 * Used to notice that a stored worldbook changed; not a security hash.
 * @param {unknown} value
 * @returns {string}
 */
export function fingerprint(value) {
    const text = canonicalJson(value) ?? 'undefined';
    let h1 = 0xdeadbeef;
    let h2 = 0x41c6ce57;
    for (let i = 0; i < text.length; i++) {
        const ch = text.charCodeAt(i);
        h1 = Math.imul(h1 ^ ch, 2654435761);
        h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    const hash = 4294967296 * (2097151 & h2) + (h1 >>> 0);
    return `${hash.toString(36)}:${text.length.toString(36)}`;
}
