// @ts-check

import { WorldbookError, WorldbookErrorCode } from './errors.js';

/**
 * Order ("Insertion Order") planning.
 *
 * Values are read the way SillyTavern 1.19.0 treats them (see
 * docs/compatibility/sillytavern-1.19.0.md §3.5): numbers as they are, numeric
 * strings as numbers, a missing `order` as 100 (ST's editor fills in that
 * default), and null, '' or non-numeric values as 0 (ST's editor turns them into
 * 0; its prompt sort `b.order - a.order` also coerces null to 0).
 *
 * Display rule used by MieMie (same as ST's "Order ↘" editor sort): higher Order
 * first, ties by UID ascending.
 *
 * Placement rule: to put an entry at a display position, only the entries right
 * around that position are touched. The placed entry gets a value strictly between
 * its neighbours (SillyTavern does not break Order ties deterministically when it
 * builds the prompt). If there is no room there, the nearest neighbours are pushed
 * up or down just far enough, choosing the side and value that move existing Order
 * values the least. No new ties are created and the book is never renumbered as a
 * whole.
 *
 * Why only the run around the insertion point: the list without the placed entry is
 * already correctly ordered, so any change outside the contiguous run touching the
 * insertion point can be reverted without breaking the order. Minimal plans therefore
 * consist of that run alone.
 */

/**
 * @typedef {object} OrderItem
 * @property {number} uid
 * @property {unknown} order Raw `order` value from the entry (undefined when the entry has none).
 */

/**
 * @typedef {object} OrderRange
 * @property {number} min Smallest Order value the planner may assign.
 * @property {number} max Largest Order value the planner may assign.
 */

/**
 * @typedef {object} OrderChange
 * @property {number} uid
 * @property {unknown} from
 * @property {number} to
 */

/**
 * @typedef {object} OrderPlan
 * @property {number} order Order of the placed entry after the plan.
 * @property {OrderChange[]} changes Existing entries whose Order changes (the moved entry is included when its value changes).
 * @property {number[]} sequence Display order of UIDs after the plan; a new entry appears as `NEW_ENTRY_UID`.
 */

/** Values the SillyTavern 1.19.0 editor accepts for Order (index.html `min="0" max="9999"`). */
export const DEFAULT_ORDER_RANGE = Object.freeze({ min: 0, max: 9999 });

/** SillyTavern's Order for a new or order-less entry (newWorldInfoEntryTemplate). */
export const DEFAULT_ORDER = 100;

/** UID placeholder for a not-yet-created entry inside `sequence`. */
export const NEW_ENTRY_UID = -1;

/**
 * The Order SillyTavern effectively uses for a raw `order` value.
 * @param {unknown} value
 * @returns {number}
 */
export function readOrder(value) {
    if (value === undefined) return DEFAULT_ORDER;
    if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
    if (typeof value === 'boolean') return Number(value);
    if (typeof value === 'string') {
        const n = Number(value);
        return Number.isFinite(n) ? n : 0;
    }
    return 0;
}

/**
 * Comparator for MieMie display order.
 * @param {OrderItem} a
 * @param {OrderItem} b
 * @returns {number}
 */
export function compareForDisplay(a, b) {
    return (readOrder(b.order) - readOrder(a.order)) || (Number(a.uid) - Number(b.uid));
}

/**
 * @template {OrderItem} T
 * @param {T[]} items
 * @returns {T[]} New array in display order.
 */
export function sortForDisplay(items) {
    return [...items].sort(compareForDisplay);
}

/**
 * Plans the Order values needed to place an entry at `targetIndex` of the display list.
 *
 * @param {OrderItem[]} items Entries of the worldbook (the moving entry may be included; it is taken out first).
 * @param {object} options
 * @param {number | null} [options.movingUid] UID of the entry being moved; null/undefined to place a new entry.
 * @param {number} options.targetIndex Index in the display list *without* the moving entry (0 = top).
 * @param {OrderRange} [options.range]
 * @param {number} [options.fallbackOrder] Order used when the list is empty.
 * @returns {OrderPlan}
 */
export function planOrderPlacement(items, { movingUid = null, targetIndex, range = DEFAULT_ORDER_RANGE, fallbackOrder = DEFAULT_ORDER }) {
    validateRange(range);
    const isNew = movingUid === null || movingUid === undefined;
    const moving = isNew ? null : findItem(items, /** @type {number} */ (movingUid));
    const others = sortForDisplay(isNew ? items : items.filter((item) => Number(item.uid) !== Number(movingUid)));
    if (!Number.isInteger(targetIndex) || targetIndex < 0 || targetIndex > others.length) {
        throw new WorldbookError(WorldbookErrorCode.INVALID_ARGUMENT, `targetIndex must be an integer between 0 and ${others.length}.`, { targetIndex });
    }

    const above = groupRun(others.slice(0, targetIndex).reverse());
    const below = groupRun(others.slice(targetIndex));
    const current = moving ? readOrder(moving.order) : null;
    const best = chooseValue({ above, below, current, range: widenToExisting(range, items), fallbackOrder });

    /** @type {OrderChange[]} */
    const changes = [];
    // A value that stays numerically the same is not rewritten (keeps e.g. a stored "50" string as is).
    if (moving && current !== best.value) {
        changes.push({ uid: Number(moving.uid), from: moving.order, to: best.value });
    }
    for (const { group, to } of [...best.up.assigned, ...best.down.assigned]) {
        for (const item of group.items) {
            changes.push({ uid: Number(item.uid), from: item.order, to });
        }
    }

    return {
        order: best.value,
        changes,
        sequence: [
            ...others.slice(0, targetIndex).map((item) => Number(item.uid)),
            moving ? Number(moving.uid) : NEW_ENTRY_UID,
            ...others.slice(targetIndex).map((item) => Number(item.uid)),
        ],
    };
}

/**
 * Where an entry should land in the display list.
 * - 'top' / 'bottom'
 * - `{ index }`: position in the list without the moving entry (0 = top)
 * - `{ aboveUid }` / `{ belowUid }` (or both, which must be adjacent): the neighbours after the move
 * @typedef {'top' | 'bottom' | { index: number } | { aboveUid?: number | null, belowUid?: number | null }} Placement
 */

/**
 * @param {OrderItem[]} items
 * @param {number | null} movingUid
 * @param {Placement} placement
 * @returns {number}
 */
export function resolveTargetIndex(items, movingUid, placement) {
    const count = items.filter((item) => movingUid === null || Number(item.uid) !== Number(movingUid)).length;
    if (placement === 'top') return 0;
    if (placement === 'bottom') return count;
    if (placement && typeof placement === 'object') {
        if ('index' in placement) {
            return /** @type {{ index: number }} */ (placement).index;
        }
        const { aboveUid = null, belowUid = null } = /** @type {{ aboveUid?: number | null, belowUid?: number | null }} */ (placement);
        const isMoving = (/** @type {number | null} */ uid) => movingUid !== null && uid !== null && Number(uid) === Number(movingUid);
        if (isMoving(aboveUid) || isMoving(belowUid)) {
            throw new WorldbookError(WorldbookErrorCode.INVALID_ARGUMENT, 'An entry cannot be placed relative to itself.', { placement });
        }
        return targetIndexFromNeighbours(items, { movingUid, aboveUid, belowUid });
    }
    throw new WorldbookError(WorldbookErrorCode.INVALID_ARGUMENT, 'Unknown placement.', { placement });
}

/**
 * Resolves a drop position given by neighbour UIDs into a `targetIndex`.
 * `aboveUid` is the entry that should end up directly above; `belowUid` directly below.
 * @param {OrderItem[]} items
 * @param {{ movingUid?: number | null, aboveUid?: number | null, belowUid?: number | null }} where
 * @returns {number}
 */
export function targetIndexFromNeighbours(items, { movingUid = null, aboveUid = null, belowUid = null }) {
    const others = sortForDisplay(items.filter((item) => movingUid === null || movingUid === undefined || Number(item.uid) !== Number(movingUid)));
    const indexOf = (/** @type {number} */ uid) => others.findIndex((item) => Number(item.uid) === Number(uid));
    const hasAbove = aboveUid !== null && aboveUid !== undefined;
    const hasBelow = belowUid !== null && belowUid !== undefined;
    if (hasAbove) {
        const index = indexOf(/** @type {number} */ (aboveUid));
        if (index === -1) {
            throw new WorldbookError(WorldbookErrorCode.ENTRY_NOT_FOUND, `Entry ${aboveUid} is not in the list.`, { uid: aboveUid });
        }
        if (hasBelow && indexOf(/** @type {number} */ (belowUid)) !== index + 1) {
            throw new WorldbookError(WorldbookErrorCode.INVALID_ARGUMENT, `Entries ${aboveUid} and ${belowUid} are not adjacent.`, { aboveUid, belowUid });
        }
        return index + 1;
    }
    if (hasBelow) {
        const index = indexOf(/** @type {number} */ (belowUid));
        if (index === -1) {
            throw new WorldbookError(WorldbookErrorCode.ENTRY_NOT_FOUND, `Entry ${belowUid} is not in the list.`, { uid: belowUid });
        }
        return index;
    }
    throw new WorldbookError(WorldbookErrorCode.INVALID_ARGUMENT, 'Either aboveUid or belowUid is required.');
}

/**
 * @param {OrderItem[]} items
 * @param {number} uid
 */
function findItem(items, uid) {
    const found = items.find((item) => Number(item.uid) === Number(uid));
    if (!found) {
        throw new WorldbookError(WorldbookErrorCode.ENTRY_NOT_FOUND, `Entry ${uid} is not in the list.`, { uid });
    }
    return found;
}

/**
 * If the book already holds Order values outside `range`, allow one step beyond
 * them, so a placement next to such a value does not pull existing entries back
 * into the range (that would change their priority against other books).
 * @param {OrderRange} range
 * @param {OrderItem[]} items
 * @returns {OrderRange}
 */
function widenToExisting(range, items) {
    let min = range.min;
    let max = range.max;
    for (const item of items) {
        const value = readOrder(item.order);
        if (value < range.min) min = Math.min(min, Math.floor(value) - 1);
        if (value > range.max) max = Math.max(max, Math.ceil(value) + 1);
    }
    return { min, max };
}

/**
 * @param {OrderRange} range
 */
function validateRange(range) {
    if (!range || !Number.isInteger(range.min) || !Number.isInteger(range.max) || range.min > range.max) {
        throw new WorldbookError(WorldbookErrorCode.INVALID_ARGUMENT, 'Order range must have integer min <= max.', { range });
    }
}

/**
 * @typedef {object} Group Consecutive entries sharing one Order value (a tie stays a tie).
 * @property {OrderItem[]} items
 * @property {number} value
 */

/**
 * Groups a run of display-ordered items (already arranged nearest-first) into ties.
 * @param {OrderItem[]} run
 * @returns {Group[]}
 */
function groupRun(run) {
    /** @type {Group[]} */
    const groups = [];
    for (const item of run) {
        const value = readOrder(item.order);
        const last = groups[groups.length - 1];
        if (last && last.value === value) {
            last.items.push(item);
        } else {
            groups.push({ items: [item], value });
        }
    }
    return groups;
}

/**
 * @typedef {object} SideResult
 * @property {boolean} feasible
 * @property {number} cost Sum of |new - old| over changed entries.
 * @property {number} count Entries changed.
 * @property {Array<{ group: Group, to: number }>} assigned
 */

/**
 * Entries above the placed value `m` must end up > m. Walk upward; each group that
 * is not already above the value below it gets the next integer above that value.
 * @param {Group[]} above Nearest first.
 * @param {number} m
 * @param {OrderRange} range
 * @returns {SideResult}
 */
function pushUp(above, m, range) {
    /** @type {SideResult} */
    const result = { feasible: true, cost: 0, count: 0, assigned: [] };
    let below = m;
    for (const group of above) {
        if (group.value > below) break;
        const required = Math.floor(below) + 1;
        if (required > range.max) return { ...result, feasible: false };
        result.cost += (required - group.value) * group.items.length;
        result.count += group.items.length;
        result.assigned.push({ group, to: required });
        below = required;
    }
    return result;
}

/**
 * Entries below `m` must end up < m. Walk downward; each group that is not already
 * below the value above it gets the next integer below that value.
 * @param {Group[]} below Nearest first.
 * @param {number} m
 * @param {OrderRange} range
 * @returns {SideResult}
 */
function pushDown(below, m, range) {
    /** @type {SideResult} */
    const result = { feasible: true, cost: 0, count: 0, assigned: [] };
    let above = m;
    for (const group of below) {
        if (group.value < above) break;
        const required = Math.ceil(above) - 1;
        if (required < range.min) return { ...result, feasible: false };
        result.cost += (group.value - required) * group.items.length;
        result.count += group.items.length;
        result.assigned.push({ group, to: required });
        above = required;
    }
    return result;
}

/**
 * Picks the placed entry's value. Primary goal: least total movement of existing
 * Order values; then fewest changed entries; then closeness to a natural value
 * (between the neighbours, or max + 1 at the top); then the lower value, which
 * keeps higher-priority entries stable.
 *
 * The moving entry may keep its current value (whatever it is); otherwise it gets
 * an integer inside `range`. With integer Orders the movement cost is convex in m
 * and a ternary search finds its minimum; with non-integer Orders it is only
 * piecewise linear, so the breakpoints are evaluated instead.
 *
 * @param {{ above: Group[], below: Group[], current: number | null, range: OrderRange, fallbackOrder: number }} input
 * @returns {{ value: number, up: SideResult, down: SideResult }}
 */
function chooseValue({ above, below, current, range, fallbackOrder }) {
    const evaluate = (/** @type {number} */ m) => {
        const up = pushUp(above, m, range);
        const down = pushDown(below, m, range);
        return { value: m, up, down, feasible: up.feasible && down.feasible, cost: up.cost + down.cost };
    };

    // Keeping the current value is always best when it already fits.
    if (current !== null) {
        const stay = evaluate(current);
        if (stay.feasible && stay.cost === 0) {
            return stay;
        }
    }

    /** @type {Set<number>} */
    const candidates = new Set();
    if (current !== null && evaluate(current).feasible) candidates.add(current);

    // Feasible integer values form an interval: pushing up fails for large m, pushing down for small m.
    const hiM = lastTrue(range.min, range.max, (m) => pushUp(above, m, range).feasible);
    const loM = firstTrue(range.min, range.max, (m) => pushDown(below, m, range).feasible);
    const preferred = naturalValue(above, below, current, fallbackOrder);

    if (hiM !== null && loM !== null && loM <= hiM) {
        const allIntegers = [...above, ...below].every((group) => Number.isInteger(group.value));
        if (allIntegers) {
            const cost = (/** @type {number} */ m) => evaluate(m).cost;
            let lo = loM;
            let hi = hiM;
            while (hi - lo > 2) {
                const m1 = lo + Math.floor((hi - lo) / 3);
                const m2 = hi - Math.floor((hi - lo) / 3);
                if (cost(m1) <= cost(m2)) hi = m2; else lo = m1;
            }
            let bestM = lo;
            for (let m = lo + 1; m <= hi; m++) {
                if (cost(m) < cost(bestM)) bestM = m;
            }
            const minCost = cost(bestM);
            const plateauLo = firstTrue(loM, bestM, (m) => cost(m) === minCost) ?? bestM;
            const plateauHi = lastTrue(bestM, hiM, (m) => cost(m) === minCost) ?? bestM;
            candidates.add(plateauLo).add(plateauHi).add(clamp(Math.round(preferred), plateauLo, plateauHi));
            for (const group of [...above, ...below]) {
                for (const edge of [group.value - 1, group.value, group.value + 1]) {
                    if (edge >= plateauLo && edge <= plateauHi) candidates.add(edge);
                }
            }
        } else {
            candidates.add(loM).add(hiM).add(clamp(Math.round(preferred), loM, hiM));
            above.forEach((group, j) => {
                for (let d = -1; d <= 1; d++) candidates.add(clamp(Math.floor(group.value) - j + d, loM, hiM));
            });
            below.forEach((group, j) => {
                for (let d = -1; d <= 1; d++) candidates.add(clamp(Math.ceil(group.value) + j + d, loM, hiM));
            });
        }
    }

    let chosen = null;
    for (const m of [...candidates].sort((a, b) => a - b)) {
        const option = evaluate(m);
        if (!option.feasible) continue;
        const count = option.up.count + option.down.count + (current === m ? 0 : 1);
        const distance = Math.abs(m - preferred);
        if (!chosen
            || option.cost < chosen.option.cost
            || (option.cost === chosen.option.cost && (count < chosen.count || (count === chosen.count && distance < chosen.distance)))) {
            chosen = { option, count, distance };
        }
    }
    if (!chosen) {
        throw new WorldbookError(WorldbookErrorCode.ORDER_SPACE_EXHAUSTED, `No Order value in ${range.min}..${range.max} fits this position.`, { range });
    }
    return { value: chosen.option.value, up: chosen.option.up, down: chosen.option.down };
}

/**
 * The value a person would expect: midway between the neighbours, one above the
 * neighbour below at the top of the list, one below the neighbour above at the bottom.
 * @param {Group[]} above
 * @param {Group[]} below
 * @param {number | null} current
 * @param {number} fallbackOrder
 */
function naturalValue(above, below, current, fallbackOrder) {
    const upper = above.length ? above[0].value : null;
    const lower = below.length ? below[0].value : null;
    if (upper !== null && lower !== null) return Math.floor((upper + lower) / 2);
    if (lower !== null) return Math.floor(lower) + 1;
    if (upper !== null) return Math.ceil(upper) - 1;
    return current ?? fallbackOrder;
}

/**
 * @param {number} value
 * @param {number} lo
 * @param {number} hi
 */
function clamp(value, lo, hi) {
    return Math.max(lo, Math.min(hi, value));
}

/**
 * Smallest integer in [lo, hi] where a monotone false→true predicate holds.
 * @param {number} lo
 * @param {number} hi
 * @param {(m: number) => boolean} predicate
 * @returns {number | null}
 */
function firstTrue(lo, hi, predicate) {
    if (lo > hi || !predicate(hi)) return null;
    while (lo < hi) {
        const mid = Math.floor((lo + hi) / 2);
        if (predicate(mid)) hi = mid; else lo = mid + 1;
    }
    return lo;
}

/**
 * Largest integer in [lo, hi] where a monotone true→false predicate holds.
 * @param {number} lo
 * @param {number} hi
 * @param {(m: number) => boolean} predicate
 * @returns {number | null}
 */
function lastTrue(lo, hi, predicate) {
    if (lo > hi || !predicate(lo)) return null;
    while (lo < hi) {
        const mid = Math.ceil((lo + hi) / 2);
        if (predicate(mid)) lo = mid; else hi = mid - 1;
    }
    return lo;
}
