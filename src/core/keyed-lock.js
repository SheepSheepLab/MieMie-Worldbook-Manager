// @ts-check

/**
 * Serializes async tasks per key (one worldbook at a time), so read-modify-write
 * sequences on the same book never interleave. Locks created over the same
 * `tails` map share their queues (e.g. several adapter instances in one page).
 * @param {Map<string, Promise<unknown>>} [tails]
 * @returns {<T>(key: string, task: () => Promise<T>) => Promise<T>}
 */
export function createKeyedLock(tails = new Map()) {
    return function runExclusive(key, task) {
        const previous = tails.get(key) ?? Promise.resolve();
        const run = previous.then(task, task);
        const tail = run.then(() => undefined, () => undefined);
        tails.set(key, tail);
        tail.then(() => {
            if (tails.get(key) === tail) {
                tails.delete(key);
            }
        });
        return run;
    };
}
